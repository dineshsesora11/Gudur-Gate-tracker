const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");
const fs = require("fs");

// ============================================================
// GUDUR GATE RAILRADAR MONITOR
// ============================================================
//
// RULES
//
// 1. GDR station board supplies the upcoming-train LIST.
// 2. Train time is shown when RailRadar supplies a valid time.
// 3. Old Firebase ETA is NEVER reused.
// 4. Timetable arrival is shown as arrivalTime, but is NOT
//    treated as live countdown ETA.
// 5. ETA = 0 ONLY when train is actually at Gudur.
// 6. After Gudur departure, continue tracking toward gate.
// 7. Gate closes only when actual live position reaches gate.
// 8. MAS/TPTY classification is based on route information,
//    train number fallback, and destination.
// 9. Unknown trains remain visible as OTHER LINE.
// 10. One full live-train API call every 20 minutes.
//
// ============================================================


// ============================================================
// FIREBASE
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount =
      JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      );
  } else if (
    fs.existsSync("./serviceAccountKey.json")
  ) {
    serviceAccount =
      require("./serviceAccountKey.json");
  } else {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
    );
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    error.message
  );

  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db =
  getDatabase();

const gateRef =
  db.ref("gudur_gates");

const trackingRef =
  db.ref("gudur_gates/tracking");


// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  process.exit(1);
}


// ============================================================
// GUDUR GEOMETRY
// ============================================================

// Gudur Junction
const GUDUR_LAT =
  14.1451694;

const GUDUR_LNG =
  79.8443472;

// Tirupati Gate
const TPTY_GATE_LAT =
  14.1402028;

const TPTY_GATE_LNG =
  79.8435972;

// Chennai Gate
const MAS_GATE_LAT =
  14.1396667;

const MAS_GATE_LNG =
  79.8441278;


// ============================================================
// DISTANCES
// ============================================================

const TRACKING_DISTANCE_KM =
  1.00;

const GATE_DISTANCE_KM =
  0.52;

const GATE_CLOSE_DISTANCE_KM =
  0.60;

const GATE_CLEAR_DISTANCE_KM =
  0.80;

const TRACKING_RETENTION_MINUTES =
  45;

const UPCOMING_MAX_TRAINS =
  10;

const UPCOMING_MAX_ETA_MINUTES =
  360;


// ============================================================
// LIVE API QUOTA
// ============================================================

const LIVE_CHECK_INTERVAL_MINUTES =
  20;

const LIVE_CHECK_INTERVAL_MS =
  LIVE_CHECK_INTERVAL_MINUTES *
  60 *
  1000;

let lastLiveCheckAt =
  0;

let lastLiveTrainNumber =
  null;


// ============================================================
// TIRUPATI TRAIN FALLBACK
// ============================================================

const TIRUPATI_CORRIDOR_TRAINS =
  new Set([
    "12733",
    "12734",
    "17487",
    "17488",
    "12763",
    "12764",
    "17261",
    "17262",
    "17479",
    "17480",
    "07669",
    "07670"
  ]);


// ============================================================
// CHENNAI / MAS TRAIN FALLBACK
// ============================================================
//
// These are route-specific fallback numbers.
// Destination information is checked first whenever
// RailRadar provides it.
//
// ============================================================

const CHENNAI_CORRIDOR_TRAINS =
  new Set([
    "12621",
    "12622",
    "12623",
    "12624",
    "12625",
    "12626",
    "12627",
    "12628",
    "12639",
    "12640",
    "12641",
    "12642",
    "12643",
    "12644",
    "12645",
    "12646",
    "16031",
    "16032",
    "12603",
    "12604",
    "20625",
    "20626",
    "20627",
    "20628",
    "12295",
    "12296",
    "12077",
    "12078"
  ]);


// ============================================================
// TEXT
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(
      /[^A-Z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    );
}


function containsAny(
  text,
  values
) {
  const normalized =
    normalizeText(text);

  return values.some(
    (value) =>
      normalized.includes(
        normalizeText(value)
      )
  );
}


function firstValue(
  ...values
) {
  for (
    const value of values
  ) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
    }
  }

  return null;
}


function toNumber(value) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// HAVERSINE
// ============================================================

function distanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  if (
    lat1 === null ||
    lng1 === null ||
    lat2 === null ||
    lng2 === null
  ) {
    return null;
  }

  const R =
    6371;

  const dLat =
    (
      (lat2 - lat1) *
      Math.PI
    ) / 180;

  const dLng =
    (
      (lng2 - lng1) *
      Math.PI
    ) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 * Math.PI / 180
    ) *
    Math.cos(
      lat2 * Math.PI / 180
    ) *
    Math.sin(dLng / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}


// ============================================================
// COORDINATES
// ============================================================

function getCoordinates(
  ...objects
) {
  for (
    const obj of objects
  ) {
    if (
      !obj ||
      typeof obj !== "object"
    ) {
      continue;
    }

    const candidates = [
      obj.coordinates,
      obj.coordinate,
      obj.location,
      obj.position,
      obj.currentLocation
    ];

    for (
      const c of candidates
    ) {
      if (
        !c ||
        typeof c !== "object"
      ) {
        continue;
      }

      const lat =
        toNumber(
          firstValue(
            c.lat,
            c.latitude
          )
        );

      const lng =
        toNumber(
          firstValue(
            c.lng,
            c.lon,
            c.longitude
          )
        );

      if (
        lat !== null &&
        lng !== null &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180
      ) {
        return {
          lat,
          lng
        };
      }
    }

    const lat =
      toNumber(
        firstValue(
          obj.lat,
          obj.latitude
        )
      );

    const lng =
      toNumber(
        firstValue(
          obj.lng,
          obj.lon,
          obj.longitude
        )
      );

    if (
      lat !== null &&
      lng !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return {
        lat,
        lng
      };
    }
  }

  return null;
}


// ============================================================
// STATION
// ============================================================

function isGudurStationObject(obj) {
  if (!obj) {
    return false;
  }

  const code =
    normalizeText(
      firstValue(
        obj.stationCode,
        obj.code
      )
    );

  const name =
    normalizeText(
      firstValue(
        obj.stationName,
        obj.name
      )
    );

  return (
    code === "GDR" ||
    name.includes("GUDUR")
  );
}


// ============================================================
// ACTUALLY AT GUDUR
// ============================================================

function isAtGudurStation(live) {
  if (!live) {
    return false;
  }

  return isGudurStationObject(
    live.currentLocation ||
    live.location ||
    {}
  );
}


// ============================================================
// SEQUENCE
// ============================================================

function getCurrentSequence(live) {
  return toNumber(
    firstValue(
      live?.currentLocation?.sequence,
      live?.sequence
    )
  );
}


function getPreviousHaltSequence(live) {
  return toNumber(
    firstValue(
      live?.previousHalt?.sequence
    )
  );
}


// ============================================================
// DEPARTED GUDUR
// ============================================================

function hasDepartedGudur(live) {
  if (!live) {
    return false;
  }

  const currentSeq =
    getCurrentSequence(
      live
    );

  const previousSeq =
    getPreviousHaltSequence(
      live
    );

  return (
    currentSeq !== null &&
    previousSeq !== null &&
    currentSeq > previousSeq &&
    isGudurStationObject(
      live.previousHalt
    )
  );
}


// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item,
  live
) {
  const value =
    firstValue(
      train?.origin,
      train?.source,
      train?.from,
      train?.fromStation,
      train?.startStation,
      train?.start,

      item?.origin,
      item?.source,
      item?.from,
      item?.fromStation,
      item?.startStation,

      live?.train?.origin,
      live?.train?.source
    );

  if (
    typeof value === "object"
  ) {
    return String(
      firstValue(
        value.name,
        value.code
      ) || ""
    );
  }

  return String(
    value || ""
  );
}


// ============================================================
// DESTINATION
// ============================================================

function getDestination(
  train,
  item,
  live
) {
  const value =
    firstValue(
      train?.destination,
      train?.to,
      train?.destinationStation,
      train?.endStation,

      item?.destination,
      item?.to,
      item?.destinationStation,

      live?.train?.destination
    );

  if (
    typeof value === "object"
  ) {
    return String(
      firstValue(
        value.name,
        value.code
      ) || ""
    );
  }

  return String(
    value || ""
  );
}


// ============================================================
// CORRIDOR CLASSIFICATION
// ============================================================
//
// Priority:
//
// 1. Explicit route/source information
// 2. Destination
// 3. Known train number
//
// IMPORTANT:
// This classification is for DISPLAY.
//
// It does NOT by itself close a gate.
//
// ============================================================

function determineCorridor(
  train,
  item,
  live
) {
  const trainNo =
    String(
      firstValue(
        train?.number,
        live?.trainNumber,
        item?.trainNumber,
        item?.number
      ) || ""
    ).trim();

  const origin =
    normalizeText(
      getOrigin(
        train,
        item,
        live
      )
    );

  const destination =
    normalizeText(
      getDestination(
        train,
        item,
        live
      )
    );

  const routeText =
    normalizeText(
      [
        train?.route,
        train?.routeName,
        train?.via,
        train?.viaStations,
        item?.route,
        item?.routeName,
        live?.route,
        live?.routeName
      ]
        .filter(Boolean)
        .join(" ")
    );

  // ----------------------------------------------------------
  // TIRUPATI
  // ----------------------------------------------------------

  if (
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "KATPADI",
        "KATPADDI"
      ]
    )
  ) {
    return "TPTY";
  }

  if (
    containsAny(
      destination,
      [
        "TIRUPATI",
        "TPTY"
      ]
    )
  ) {
    return "TPTY";
  }

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI / MAS
  // ----------------------------------------------------------

  if (
    containsAny(
      origin,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "CHENNAI CENTRAL",
        "PURATCHI THALAIVAR DR MGR CENTRAL",
        "AVADI",
        "PERAMBUR",
        "SULLURUPETA",
        "NAYUDUPETA",
        "ARAKKONAM",
        "MELPAKKAM"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      destination,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "CHENNAI CENTRAL",
        "ARAKKONAM"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      routeText,
      [
        "CHENNAI",
        "MAS",
        "ARAKKONAM"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    CHENNAI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "MAS";
  }

  return null;
}


// ============================================================
// CORRIDOR DISPLAY
// ============================================================

function getCorridorDisplay(
  corridor
) {
  if (
    corridor === "MAS"
  ) {
    return {
      corridor: "MAS",
      corridorLabel: "MAS LINE",
      corridorClass: "corridor-mas"
    };
  }

  if (
    corridor === "TPTY"
  ) {
    return {
      corridor: "TPTY",
      corridorLabel: "TPTY LINE",
      corridorClass: "corridor-tpty"
    };
  }

  return {
    corridor: "OTHER",
    corridorLabel: "OTHER LINE",
    corridorClass: "corridor-other"
  };
}


// ============================================================
// BOARD TRAIN NUMBER
// ============================================================

function getTrainNumber(item) {
  return String(
    firstValue(
      item?.train?.number,
      item?.trainNumber,
      item?.number
    ) || ""
  ).trim();
}


// ============================================================
// BOARD TRAIN NAME
// ============================================================

function getTrainName(item) {
  return String(
    firstValue(
      item?.train?.name,
      item?.trainName,
      item?.name
    ) ||
    `Train ${getTrainNumber(item)}`
  );
}


// ============================================================
// BOARD STATUS
// ============================================================

function getBoardStatus(item) {
  return normalizeText(
    firstValue(
      item?.live?.status,
      item?.status,
      item?.train?.status
    )
  );
}


// ============================================================
// TIME PARSING
// ============================================================

function parseTime(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    return date;
  }

  const match =
    String(value)
      .trim()
      .match(
        /^(\d{1,2}):(\d{2})/
      );

  if (!match) {
    return null;
  }

  const now =
    new Date();

  const d =
    new Date();

  d.setHours(
    Number(match[1]),
    Number(match[2]),
    0,
    0
  );

  // If time already passed by a large amount,
  // assume next day.
  if (
    d.getTime() <
      now.getTime() -
        12 * 60 * 60 * 1000
  ) {
    d.setDate(
      d.getDate() + 1
    );
  }

  return d;
}


// ============================================================
// CURRENT ETA FROM LIVE DATA
// ============================================================
//
// IMPORTANT:
//
// This function only accepts:
//
// - live ETA minutes
// - live expectedArrivalTime
// - live expectedArrival
//
// It does NOT accept:
//
// - stop.arrival
// - scheduled arrival
// - old Firebase ETA
//
// ============================================================

function getLiveEtaMinutes(
  live
) {
  if (!live) {
    return null;
  }

  if (
    isAtGudurStation(
      live
    )
  ) {
    return 0;
  }

  const value =
    firstValue(
      live.expectedArrivalTime,
      live.expectedArrival,
      live.etaMinutes,

      live.currentLocation
        ?.expectedArrivalTime,

      live.currentLocation
        ?.expectedArrival,

      live.nextHalt
        ?.expectedArrivalTime,

      live.nextHalt
        ?.expectedArrival,

      live.nextHalt
        ?.etaMinutes
    );

  if (
    value === null
  ) {
    return null;
  }

  // Numeric ETA
  if (
    typeof value === "number" ||
    (
      typeof value === "string" &&
      /^\d+(\.\d+)?$/.test(
        value.trim()
      )
    )
  ) {
    const eta =
      Number(value);

    if (
      Number.isFinite(eta) &&
      eta >= 0 &&
      eta <= UPCOMING_MAX_ETA_MINUTES
    ) {
      return Math.round(
        eta
      );
    }

    return null;
  }

  // Datetime ETA
  const date =
    parseTime(
      value
    );

  if (!date) {
    return null;
  }

  const diff =
    Math.round(
      (
        date.getTime() -
        Date.now()
      ) / 60000
    );

  if (
    diff < 0 ||
    diff >
      UPCOMING_MAX_ETA_MINUTES
  ) {
    return null;
  }

  return diff;
}


// ============================================================
// BOARD ARRIVAL TIME
// ============================================================
//
// This is displayed as the train's arrival time.
//
// It is NOT converted into a fake live countdown.
//
// ============================================================

function getBoardArrivalTime(
  item
) {
  const value =
    firstValue(
      item?.live?.expectedArrivalTime,
      item?.live?.expectedArrival,

      item?.stop?.arrival,

      item?.arrivalTime,
      item?.expectedArrivalTime
    );

  if (!value) {
    return null;
  }

  const date =
    parseTime(
      value
    );

  if (!date) {
    return null;
  }

  return date;
}


// ============================================================
// FORMAT CLOCK TIME
// ============================================================

function formatClockTime(
  date
) {
  if (!date) {
    return "--";
  }

  return date.toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    }
  );
}


// ============================================================
// STORED TIMESTAMP
// ============================================================

function parseStoredTimestamp(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value === "number"
  ) {
    if (
      value > 100000000000
    ) {
      return value;
    }

    if (
      value > 1000000000
    ) {
      return value * 1000;
    }

    return null;
  }

  const number =
    Number(value);

  if (
    Number.isFinite(number) &&
    number > 1000000000
  ) {
    return number > 100000000000
      ? number
      : number * 1000;
  }

  const parsed =
    Date.parse(
      String(value)
    );

  return Number.isNaN(parsed)
    ? null
    : parsed;
}


// ============================================================
// RECENT RECORD
// ============================================================

function isRecentRecord(
  record
) {
  const timestamp =
    parseStoredTimestamp(
      record?.updatedAt
    );

  if (!timestamp) {
    return false;
  }

  const age =
    Date.now() -
    timestamp;

  return (
    age >= 0 &&
    age <=
      TRACKING_RETENTION_MINUTES *
      60 *
      1000
  );
}


// ============================================================
// TRACKING RECORD
// ============================================================

function createTrackingRecord(
  trainNo,
  trainName,
  corridor,
  origin,
  destination
) {
  return {
    trainNo,

    trainName,

    corridor:
      corridor || null,

    origin:
      origin || "",

    destination:
      destination || "",

    state:
      "APPROACHING_GUDUR",

    etaMinutes:
      null,

    etaVerified:
      false,

    distanceFromGudurKm:
      null,

    distanceFromGateKm:
      null,

    direction:
      "TOWARD_GUDUR",

    updatedAt:
      Date.now()
  };
}


// ============================================================
// UPDATE TRACKING
// ============================================================

async function updateTrackingRecord(
  trainNo,
  trainName,
  corridor,
  origin,
  destination,
  live
) {
  const ref =
    trackingRef.child(
      trainNo
    );

  const snapshot =
    await ref.once(
      "value"
    );

  let record =
    snapshot.val();

  if (
    !record ||
    !isRecentRecord(record)
  ) {
    record =
      createTrackingRecord(
        trainNo,
        trainName,
        corridor,
        origin,
        destination
      );
  }

  if (
    !record.corridor &&
    corridor
  ) {
    record.corridor =
      corridor;
  }

  if (trainName) {
    record.trainName =
      trainName;
  }

  if (origin) {
    record.origin =
      origin;
  }

  if (destination) {
    record.destination =
      destination;
  }

  // ----------------------------------------------------------
  // DISTANCE FROM GUDUR
  // ----------------------------------------------------------

  const distanceGdr =
    getDistanceFromGudur(
      live
    );

  const distanceGate =
    getDistanceFromGate(
      live,
      record.corridor
    );

  if (
    distanceGdr !== null
  ) {
    record.distanceFromGudurKm =
      Number(
        distanceGdr.toFixed(3)
      );
  }

  if (
    distanceGate !== null
  ) {
    record.distanceFromGateKm =
      Number(
        distanceGate.toFixed(3)
      );
  }

  // ==========================================================
  // AT GUDUR
  // ==========================================================

  if (
    isAtGudurStation(
      live
    )
  ) {
    record.state =
      "AT_GUDUR_STATION";

    record.etaMinutes =
      0;

    record.etaVerified =
      true;

    record.direction =
      "AT_GUDUR";

    record.updatedAt =
      Date.now();

    await ref.set(
      record
    );

    console.log(
      `[AT GUDUR] ${trainNo} ${trainName} | ETA 0m`
    );

    return record;
  }

  // ==========================================================
  // DEPARTED GUDUR
  // ==========================================================

  if (
    hasDepartedGudur(
      live
    )
  ) {
    record.direction =
      "AWAY_FROM_GUDUR";

    record.etaMinutes =
      null;

    record.etaVerified =
      false;

    if (
      distanceGate !== null
    ) {
      if (
        distanceGate <=
        GATE_CLOSE_DISTANCE_KM
      ) {
        record.state =
          "AT_GATE";
      } else {
        record.state =
          "APPROACHING_GATE";
      }
    } else {
      record.state =
        "DEPARTED_GUDUR";
    }

    record.updatedAt =
      Date.now();

    await ref.set(
      record
    );

    console.log(
      `[DEPARTED GDR] ${trainNo} ${trainName} | Gate ${
        distanceGate !== null
          ? distanceGate.toFixed(3)
          : "--"
      } km | ${record.state}`
    );

    return record;
  }

  // ==========================================================
  // APPROACHING GUDUR
  // ==========================================================

  if (
    isNextHaltGudur(
      live
    )
  ) {
    record.state =
      "APPROACHING_GUDUR";

    record.direction =
      "TOWARD_GUDUR";

    const eta =
      getLiveEtaMinutes(
        live
      );

    record.etaMinutes =
      eta;

    record.etaVerified =
      eta !== null;

    record.updatedAt =
      Date.now();

    await ref.set(
      record
    );

    console.log(
      `[APPROACHING GDR] ${trainNo} ${trainName} | ETA ${
        eta !== null
          ? eta + "m"
          : "--"
      }`
    );

    return record;
  }

  // ==========================================================
  // UNKNOWN LIVE POSITION
  // ==========================================================

  record.etaMinutes =
    null;

  record.etaVerified =
    false;

  record.updatedAt =
    Date.now();

  await ref.set(
    record
  );

  return record;
}


// ============================================================
// GUDUR DISTANCE
// ============================================================

function getDistanceFromGudur(
  live
) {
  const coordinates =
    getCoordinates(
      live?.currentLocation,
      live?.location,
      live
    );

  if (!coordinates) {
    return null;
  }

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    GUDUR_LAT,
    GUDUR_LNG
  );
}


// ============================================================
// GATE DISTANCE
// ============================================================

function getDistanceFromGate(
  live,
  corridor
) {
  const coordinates =
    getCoordinates(
      live?.currentLocation,
      live?.location,
      live
    );

  if (!coordinates) {
    return null;
  }

  if (
    corridor === "TPTY"
  ) {
    return distanceKm(
      coordinates.lat,
      coordinates.lng,
      TPTY_GATE_LAT,
      TPTY_GATE_LNG
    );
  }

  if (
    corridor === "MAS"
  ) {
    return distanceKm(
      coordinates.lat,
      coordinates.lng,
      MAS_GATE_LAT,
      MAS_GATE_LNG
    );
  }

  return null;
}


// ============================================================
// NEXT HALT GUDUR
// ============================================================

function isNextHaltGudur(
  live
) {
  if (!live) {
    return false;
  }

  return isGudurStationObject(
    live.nextHalt ||
    live.nextStation ||
    {}
  );
}


// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    console.log(
      `[LIVE API] Checking ${trainNo}...`
    );

    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(trainNo)}/live`,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          params: {
            authoritative:
              true,

            includeCoordinates:
              true,

            geometry:
              true
          },

          timeout:
            15000
        }
      );

    return (
      response.data?.data ||
      response.data ||
      null
    );

  } catch (error) {
    if (
      error.response
    ) {
      console.error(
        `[LIVE ERROR] ${trainNo} HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo}: ${error.message}`
      );
    }

    return null;
  }
}


// ============================================================
// FETCH GDR BOARD
// ============================================================

async function fetchStationBoard() {
  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`,
      {
        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,

          Accept:
            "application/json"
        },

        timeout:
          15000
      }
    );

  return (
    response.data?.data?.trains ||
    []
  );
}


// ============================================================
// BOARD TRAIN RELEVANCE
// ============================================================
//
// IMPORTANT:
//
// The API endpoint is GDR.
//
// Therefore board trains are allowed into the upcoming list.
//
// We do NOT require item.live.nextHalt === GDR.
//
// ============================================================

function isBoardTrainRelevant(
  item
) {
  const trainNo =
    getTrainNumber(
      item
    );

  if (!trainNo) {
    return false;
  }

  return true;
}


// ============================================================
// BUILD UPCOMING TRAINS
// ============================================================

async function buildUpcomingTrains(
  trains,
  trackingRecords
) {
  const list =
    [];

  for (
    const item of trains
  ) {
    if (
      !isBoardTrainRelevant(
        item
      )
    ) {
      continue;
    }

    const train =
      item?.train ||
      {};

    const live =
      item?.live ||
      null;

    const trainNo =
      getTrainNumber(
        item
      );

    const trainName =
      getTrainName(
        item
      );

    if (!trainNo) {
      continue;
    }

    const origin =
      getOrigin(
        train,
        item,
        live
      );

    const destination =
      getDestination(
        train,
        item,
        live
      );

    // --------------------------------------------------------
    // CLASSIFY
    // --------------------------------------------------------

    const detectedCorridor =
      determineCorridor(
        train,
        item,
        live
      );

    const storedCorridor =
      trackingRecords[
        trainNo
      ]?.corridor ||
      null;

    const corridor =
      detectedCorridor ||
      storedCorridor ||
      null;

    const corridorInfo =
      getCorridorDisplay(
        corridor
      );

    // --------------------------------------------------------
    // CURRENT LIVE ETA
    // --------------------------------------------------------

    let etaMinutes =
      null;

    let etaSource =
      "UNKNOWN";

    let state =
      "APPROACHING_GUDUR";

    if (
      isAtGudurStation(
        live
      )
    ) {
      etaMinutes =
        0;

      etaSource =
        "LIVE_STATION";

      state =
        "AT_GUDUR_STATION";

    } else if (
      hasDepartedGudur(
        live
      )
    ) {
      etaMinutes =
        null;

      etaSource =
        "DEPARTED";

      state =
        "DEPARTED_GUDUR";

    } else {
      const liveEta =
        getLiveEtaMinutes(
          live
        );

      if (
        liveEta !== null &&
        isNextHaltGudur(
          live
        )
      ) {
        etaMinutes =
          liveEta;

        etaSource =
          "LIVE";

        state =
          "APPROACHING_GUDUR";
      }
    }

    // --------------------------------------------------------
    // TRACKING STATE
    //
    // IMPORTANT:
    //
    // Stored state is okay.
    //
    // Stored OLD ETA is NOT okay.
    //
    // --------------------------------------------------------

    const record =
      trackingRecords[
        trainNo
      ];

    if (
      record &&
      isRecentRecord(
        record
      )
    ) {
      if (
        record.state ===
        "AT_GATE"
      ) {
        state =
          "AT_GATE";

        etaMinutes =
          null;

        etaSource =
          "GATE_TRACKING";
      }

      if (
        record.state ===
        "APPROACHING_GATE"
      ) {
        state =
          "APPROACHING_GATE";

        etaMinutes =
          null;

        etaSource =
          "GATE_TRACKING";
      }

      if (
        record.state ===
        "DEPARTED_GUDUR"
      ) {
        state =
          "DEPARTED_GUDUR";

        etaMinutes =
          null;

        etaSource =
          "GATE_TRACKING";
      }

      if (
        record.state ===
        "AT_GUDUR_STATION" &&
        isAtGudurStation(
          live
        )
      ) {
        state =
          "AT_GUDUR_STATION";

        etaMinutes =
          0;

        etaSource =
          "LIVE_STATION";
      }
    }

    // --------------------------------------------------------
    // ARRIVAL CLOCK TIME
    // --------------------------------------------------------

    const arrivalDate =
      getBoardArrivalTime(
        item
      );

    const arrivalTime =
      formatClockTime(
        arrivalDate
      );

    // --------------------------------------------------------
    // DELAY
    // --------------------------------------------------------

    const delayMinutes =
      Number(
        firstValue(
          live?.delayMinutes,
          item?.delayMinutes,
          item?.train?.delayMinutes,
          0
        )
      ) || 0;

    // --------------------------------------------------------
    // PLATFORM
    // --------------------------------------------------------

    const platform =
      String(
        firstValue(
          live?.platform,
          item?.platform,
          item?.stop?.platform,
          "1"
        ) || "1"
      );

    // --------------------------------------------------------
    // DIRECTION
    // --------------------------------------------------------

    const direction =
      (
        state === "DEPARTED_GUDUR" ||
        state === "APPROACHING_GATE" ||
        state === "AT_GATE"
      )
        ? "AWAY_FROM_GUDUR"
        : "TOWARD_GUDUR";

    // --------------------------------------------------------
    // ETA DISPLAY
    // --------------------------------------------------------
    //
    // This is what the frontend can use.
    //
    // Numeric = verified current live ETA.
    // Otherwise "--".
    //
    // arrivalTime remains available separately.
    //
    // --------------------------------------------------------

    const etaDisplay =
      etaMinutes === null
        ? "--"
        : String(
            Math.max(
              0,
              Math.round(
                etaMinutes
              )
            )
          );

    // --------------------------------------------------------
    // DISPLAY OBJECT
    // --------------------------------------------------------

    list.push({
      trainNo,

      name:
        trainName,

      origin:
        origin ||
        "Unknown",

      destination:
        destination ||
        "Gudur",

      // Current live countdown
      etaMinutes,

      etaDisplay,

      // Clock time
      arrivalTime,

      scheduledTime:
        arrivalTime,

      time:
        arrivalTime,

      // Information about ETA
      etaSource,

      etaVerified:
        etaMinutes !== null,

      delayMinutes,

      platform,

      corridor:
        corridorInfo.corridor,

      corridorLabel:
        corridorInfo.corridorLabel,

      corridorClass:
        corridorInfo.corridorClass,

      direction,

      state
    });
  }

  // ==========================================================
  // SORT
  // ==========================================================
  //
  // Verified live ETA first.
  //
  // Trains without current live ETA next.
  //
  // This prevents fake 7m / 24m values.
  //
  // ==========================================================

  list.sort(
    (
      a,
      b
    ) => {
      if (
        a.etaMinutes !== null &&
        b.etaMinutes === null
      ) {
        return -1;
      }

      if (
        a.etaMinutes === null &&
        b.etaMinutes !== null
      ) {
        return 1;
      }

      if (
        a.etaMinutes !== null &&
        b.etaMinutes !== null
      ) {
        return (
          a.etaMinutes -
          b.etaMinutes
        );
      }

      return a.trainNo.localeCompare(
        b.trainNo
      );
    }
  );

  return list.slice(
    0,
    UPCOMING_MAX_TRAINS
  );
}


// ============================================================
// GATE OPEN
// ============================================================

function openGate() {
  return {
    status:
      "OPEN",

    waitMinutes:
      0,

    activeTrain:
      "Tracks clear",

    direction:
      "CLEAR",

    corridor:
      null
  };
}


// ============================================================
// GATE CLOSED
// ============================================================

function closedGate(
  record
) {
  return {
    status:
      "CLOSED",

    waitMinutes:
      5,

    activeTrain:
      `${record.trainNo} ${record.trainName}`,

    direction:
      "AWAY_FROM_GUDUR",

    corridor:
      record.corridor ||
      null
  };
}


// ============================================================
// GATE STATES
// ============================================================

function determineGateStates(
  trackingRecords
) {
  let masGate =
    openGate();

  let tptyGate =
    openGate();

  for (
    const [
      trainNo,
      record
    ] of Object.entries(
      trackingRecords || {}
    )
  ) {
    if (
      !record ||
      !isRecentRecord(
        record
      )
    ) {
      continue;
    }

    // --------------------------------------------------------
    // ONLY AT_GATE CAN CLOSE
    // --------------------------------------------------------

    if (
      record.state !==
      "AT_GATE"
    ) {
      continue;
    }

    const gateDistance =
      toNumber(
        record.distanceFromGateKm
      );

    if (
      gateDistance !== null &&
      gateDistance >
        GATE_CLOSE_DISTANCE_KM
    ) {
      continue;
    }

    const payload =
      closedGate({
        trainNo,

        trainName:
          record.trainName ||
          `Train ${trainNo}`,

        corridor:
          record.corridor
      });

    if (
      record.corridor ===
      "MAS"
    ) {
      masGate =
        payload;
    }

    if (
      record.corridor ===
      "TPTY"
    ) {
      tptyGate =
        payload;
    }
  }

  return {
    masGate,
    tptyGate
  };
}


// ============================================================
// LIVE CANDIDATE
// ============================================================

function selectLiveCandidate(
  trains,
  trackingRecords
) {
  const candidates =
    [];

  for (
    const item of trains
  ) {
    const trainNo =
      getTrainNumber(
        item
      );

    if (!trainNo) {
      continue;
    }

    const record =
      trackingRecords[
        trainNo
      ];

    let priority =
      50;

    if (
      record?.state ===
      "AT_GATE"
    ) {
      priority =
        0;
    } else if (
      record?.state ===
      "APPROACHING_GATE"
    ) {
      priority =
        1;
    } else if (
      record?.state ===
      "DEPARTED_GUDUR"
    ) {
      priority =
        2;
    } else if (
      record?.state ===
      "AT_GUDUR_STATION"
    ) {
      priority =
        3;
    } else if (
      record?.state ===
      "APPROACHING_GUDUR"
    ) {
      priority =
        4;
    }

    candidates.push({
      item,
      priority
    });
  }

  candidates.sort(
    (
      a,
      b
    ) =>
      a.priority -
      b.priority
  );

  return (
    candidates[0]?.item ||
    null
  );
}


// ============================================================
// PROCESS LIVE
// ============================================================

async function processLiveCandidate(
  item,
  trackingRecords
) {
  if (!item) {
    return false;
  }

  const train =
    item.train ||
    {};

  const trainNo =
    getTrainNumber(
      item
    );

  if (!trainNo) {
    return false;
  }

  const trainName =
    getTrainName(
      item
    );

  const live =
    await fetchLiveTrain(
      trainNo
    );

  if (!live) {
    return false;
  }

  const origin =
    getOrigin(
      train,
      item,
      live
    );

  const destination =
    getDestination(
      train,
      item,
      live
    );

  const corridor =
    determineCorridor(
      train,
      item,
      live
    );

  const record =
    await updateTrackingRecord(
      trainNo,
      trainName,
      corridor,
      origin,
      destination,
      live
    );

  trackingRecords[
    trainNo
  ] =
    record;

  return true;
}


// ============================================================
// MAIN
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  try {
    const now =
      new Date();

    console.log(
      "\n=================================================="
    );

    console.log(
      `[${now.toLocaleString()}] GUDUR GATE MONITOR`
    );

    console.log(
      "=================================================="
    );

    console.log(
      `Gudur Junction : ${GUDUR_LAT}, ${GUDUR_LNG}`
    );

    console.log(
      `Chennai Gate   : ${MAS_GATE_LAT}, ${MAS_GATE_LNG}`
    );

    console.log(
      `Tirupati Gate  : ${TPTY_GATE_LAT}, ${TPTY_GATE_LNG}`
    );

    // --------------------------------------------------------
    // LOAD TRACKING
    // --------------------------------------------------------

    let trackingRecords =
      (
        await trackingRef.once(
          "value"
        )
      ).val() || {};

    // --------------------------------------------------------
    // CLEAN OLD RECORDS
    // --------------------------------------------------------

    const cleanup =
      {};

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        trackingRecords
      )
    ) {
      if (
        !isRecentRecord(
          record
        )
      ) {
        cleanup[
          trainNo
        ] =
          null;
      }
    }

    if (
      Object.keys(
        cleanup
      ).length > 0
    ) {
      await trackingRef.update(
        cleanup
      );
    }

    trackingRecords =
      (
        await trackingRef.once(
          "value"
        )
      ).val() || {};

    // --------------------------------------------------------
    // GDR BOARD
    // --------------------------------------------------------

    console.log(
      "[BOARD] Querying RailRadar GDR live board..."
    );

    const trains =
      await fetchStationBoard();

    console.log(
      `[BOARD] RailRadar returned ${trains.length} trains.`
    );

    // --------------------------------------------------------
    // LIVE API
    // --------------------------------------------------------

    const nowMs =
      Date.now();

    if (
      nowMs -
        lastLiveCheckAt >=
      LIVE_CHECK_INTERVAL_MS
    ) {
      const candidate =
        selectLiveCandidate(
          trains,
          trackingRecords
        );

      if (
        candidate
      ) {
        const candidateNo =
          getTrainNumber(
            candidate
          );

        console.log(
          `[LIVE] Checking ${candidateNo} ${getTrainName(candidate)}`
        );

        const success =
          await processLiveCandidate(
            candidate,
            trackingRecords
          );

        if (
          success
        ) {
          lastLiveCheckAt =
            Date.now();

          lastLiveTrainNumber =
            candidateNo;

          console.log(
            `[LIVE] Verification completed: ${candidateNo}`
          );
        } else {
          console.log(
            `[LIVE] Verification failed: ${candidateNo}`
          );
        }
      } else {
        console.log(
          "[LIVE] No candidate."
        );
      }
    } else {
      const remainingMs =
        LIVE_CHECK_INTERVAL_MS -
        (
          nowMs -
          lastLiveCheckAt
        );

      const remainingMinutes =
        Math.ceil(
          remainingMs /
          60000
        );

      console.log(
        `[LIVE] Throttled to protect monthly quota. Next live check in approximately ${remainingMinutes} minute(s).`
      );
    }

    // --------------------------------------------------------
    // RELOAD TRACKING
    // --------------------------------------------------------

    trackingRecords =
      (
        await trackingRef.once(
          "value"
        )
      ).val() || {};

    // --------------------------------------------------------
    // GATES
    // --------------------------------------------------------

    const gateStates =
      determineGateStates(
        trackingRecords
      );

    // --------------------------------------------------------
    // UPCOMING
    // --------------------------------------------------------

    const upcomingTrains =
      await buildUpcomingTrains(
        trains,
        trackingRecords
      );

    // --------------------------------------------------------
    // FIREBASE
    // --------------------------------------------------------

    await gateRef.set({
      tirupatiGate:
        gateStates.tptyGate,

      chennaiGate:
        gateStates.masGate,

      upcomingTrains,

      lastUpdated:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleTimeString(),

      monitorStatus:
        "ONLINE",

      liveStatus:
        lastLiveCheckAt
          ? "AVAILABLE"
          : "WAITING",

      lastLiveTrain:
        lastLiveTrainNumber ||
        null
    });

    // --------------------------------------------------------
    // LOG
    // --------------------------------------------------------

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      `Chennai Gate  : ${gateStates.masGate.status}`
    );

    console.log(
      `Tirupati Gate : ${gateStates.tptyGate.status}`
    );

    console.log(
      `Upcoming trains: ${upcomingTrains.length}`
    );

    console.log(
      "\n[UPCOMING TRAINS]"
    );

    if (
      upcomingTrains.length ===
      0
    ) {
      console.log(
        "No upcoming trains."
      );
    }

    upcomingTrains.forEach(
      (
        train,
        index
      ) => {
        console.log(
          `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridorLabel} | Time ${train.arrivalTime} | ETA ${train.etaDisplay}m | ${train.origin} -> ${train.destination} | state=${train.state} | source=${train.etaSource}`
        );
      }
    );

    console.log(
      `\n[MONITOR] Run completed successfully in ${(
        (Date.now() - startedAt) /
        1000
      ).toFixed(1)}s`
    );

  } catch (error) {
    console.error(
      "\n=================================================="
    );

    console.error(
      "[MONITOR ERROR]"
    );

    console.error(
      "=================================================="
    );

    if (
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        error.message
      );
    }

    try {
      await gateRef.update({
        monitorStatus:
          "ERROR",

        lastError:
          error.message,

        lastErrorAt:
          new Date().toISOString()
      });
    } catch (
      firebaseError
    ) {
      console.error(
        "[FIREBASE ERROR]",
        firebaseError.message
      );
    }
  }
}


// ============================================================
// START
// ============================================================

console.log(
  "=================================================="
);

console.log(
  " GUDUR GATE RAILRADAR MONITOR"
);

console.log(
  "=================================================="
);

console.log(
  `Gudur Junction : ${GUDUR_LAT}, ${GUDUR_LNG}`
);

console.log(
  `Chennai Gate   : ${MAS_GATE_LAT}, ${MAS_GATE_LNG}`
);

console.log(
  `Tirupati Gate  : ${TPTY_GATE_LAT}, ${TPTY_GATE_LNG}`
);

console.log(
  "Tracking radius : 1.00 km"
);

console.log(
  "Gate close zone : 0.60 km"
);

console.log(
  "Gate clear zone : 0.80 km"
);

console.log(
  "ETA 0 rule      : ONLY at GDR"
);

console.log(
  "Board list      : ALL GDR BOARD TRAINS"
);

console.log(
  "Live ETA        : CURRENT LIVE DATA ONLY"
);

console.log(
  "Old ETA         : NEVER REUSED"
);

console.log(
  "Scheduled time  : SHOWN SEPARATELY"
);

console.log(
  "Live API        : 20-minute protection"
);

console.log(
  "=================================================="
);

console.log(
  "RailRadar API Key: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "=================================================="
);


// ============================================================
// RUN
// ============================================================

updateGateSystem();


// ============================================================
// EVERY 5 MINUTES
// ============================================================

setInterval(
  updateGateSystem,
  5 * 60 * 1000
);
