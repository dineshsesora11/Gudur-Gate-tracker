const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");
const fs = require("fs");

// ============================================================
// GUDUR GATE RAILRADAR MONITOR
// ============================================================
//
// IMPORTANT ETA RULE:
//
// CURRENT LIVE ETA:
//     Numeric ETA is allowed.
//
// NO CURRENT LIVE ETA:
//     Show "--".
//
// SCHEDULED / TIMETABLE ETA:
//     NEVER used as real-time ETA.
//
// OLD FIREBASE ETA:
//     NEVER used as current ETA.
//
// ACTUALLY AT GUDUR:
//     ETA = 0m.
//
// DEPARTED GUDUR:
//     Continue tracking toward gate.
//
// AT_GATE:
//     Gate CLOSED.
//
// PASSED_GATE:
//     Gate OPEN.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
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
  credential:
    cert(serviceAccount),

  databaseURL:
    FIREBASE_DATABASE_URL
});

const db =
  getDatabase();

const gateRef =
  db.ref(
    "gudur_gates"
  );

const trackingRef =
  db.ref(
    "gudur_gates/tracking"
  );


// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

if (
  !RAILRADAR_API_KEY
) {
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
// DISTANCE SETTINGS
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

const UPCOMING_MAX_ETA_MINUTES =
  360;

const UPCOMING_MAX_TRAINS =
  10;


// ============================================================
// LIVE API QUOTA PROTECTION
// ============================================================
//
// One live train API call approximately every 20 minutes.
//
// The station board continues to run every 5 minutes.
//
// IMPORTANT:
//
// When the live API is throttled,
// we DO NOT reuse an old ETA.
//
// ============================================================

const LIVE_CHECK_INTERVAL_MINUTES =
  20;

const LIVE_CHECK_INTERVAL_MS =
  LIVE_CHECK_INTERVAL_MINUTES *
  60 *
  1000;


// ============================================================
// TIRUPATI CORRIDOR TRAIN FALLBACK
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
// GLOBAL LIVE API STATE
// ============================================================

let lastLiveCheckAt = 0;

let lastLiveTrainNumber =
  null;


// ============================================================
// BASIC HELPERS
// ============================================================

function normalizeText(
  value
) {
  return String(
    value || ""
  )
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
    normalizeText(
      text
    );

  return values.some(
    (value) =>
      normalized.includes(
        normalizeText(
          value
        )
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
      String(
        value
      ).trim() !== ""
    ) {
      return value;
    }
  }

  return null;
}


function toNumber(
  value
) {
  const number =
    Number(value);

  return Number.isFinite(
    number
  )
    ? number
    : null;
}


// ============================================================
// HAVERSINE DISTANCE
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
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      lat1 *
        Math.PI /
        180
    ) *
    Math.cos(
      lat2 *
        Math.PI /
        180
    ) *
    Math.sin(
      dLng / 2
    ) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        1 - a
      )
    )
  );
}


// ============================================================
// COORDINATE EXTRACTION
// ============================================================

function getCoordinates(
  ...objects
) {
  for (
    const obj of objects
  ) {
    if (
      !obj ||
      typeof obj !==
        "object"
    ) {
      continue;
    }

    const candidates = [
      obj.coordinates,
      obj.coordinate,
      obj.location,
      obj.position,
      obj.currentLocation,
      obj.currentLocation?.coordinates
    ];

    for (
      const c of candidates
    ) {
      if (
        !c ||
        typeof c !==
          "object"
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
// STATION OBJECT
// ============================================================

function isGudurStationObject(
  obj
) {
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
    name.includes(
      "GUDUR"
    )
  );
}


// ============================================================
// ACTUALLY AT GUDUR
// ============================================================

function isAtGudurStation(
  live
) {
  if (!live) {
    return false;
  }

  const current =
    live.currentLocation ||
    live.location ||
    {};

  return isGudurStationObject(
    current
  );
}


// ============================================================
// SEQUENCE HELPERS
// ============================================================

function getCurrentSequence(
  live
) {
  return toNumber(
    firstValue(
      live?.currentLocation?.sequence,
      live?.sequence
    )
  );
}


function getPreviousHaltSequence(
  live
) {
  return toNumber(
    firstValue(
      live?.previousHalt?.sequence
    )
  );
}


// ============================================================
// DEPARTED GUDUR
// ============================================================

function hasDepartedGudur(
  live
) {
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

  if (
    currentSeq !== null &&
    previousSeq !== null &&
    currentSeq >
      previousSeq &&
    isGudurStationObject(
      live.previousHalt
    )
  ) {
    return true;
  }

  return false;
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
    typeof value ===
    "object"
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
    typeof value ===
    "object"
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
// CORRIDOR
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
        item?.trainNumber
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

  // ----------------------------------------------------------
  // TIRUPATI SIDE
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

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  if (
    containsAny(
      origin,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "CHENNAI CENTRAL",
        "AVADI",
        "PERAMBUR",
        "SULLURUPETA",
        "NAYUDUPETA",
        "ARAKKONAM"
      ]
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // KNOWN TIRUPATI TRAINS
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // DESTINATION HINT
  //
  // This is only for display classification.
  // It must NOT by itself close a gate.
  // ----------------------------------------------------------

  if (
    destination.includes(
      "TIRUPATI"
    ) ||
    destination ===
      "TPTY"
  ) {
    return "TPTY";
  }

  if (
    destination.includes(
      "CHENNAI"
    ) ||
    destination ===
      "MAS"
  ) {
    return "MAS";
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

  const next =
    live.nextHalt ||
    live.nextStation ||
    {};

  return isGudurStationObject(
    next
  );
}


// ============================================================
// DISTANCE FROM GUDUR
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
// DISTANCE FROM GATE
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
    corridor ===
    "TPTY"
  ) {
    return distanceKm(
      coordinates.lat,
      coordinates.lng,
      TPTY_GATE_LAT,
      TPTY_GATE_LNG
    );
  }

  if (
    corridor ===
    "MAS"
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
// TIME HELPERS
// ============================================================

function parseTimeToMinutes(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(
      value
    );

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    return (
      date.getHours() *
        60 +
      date.getMinutes()
    );
  }

  const match =
    String(value)
      .trim()
      .match(
        /(\d{1,2}):(\d{2})/
      );

  if (!match) {
    return null;
  }

  return (
    Number(
      match[1]
    ) *
      60 +
    Number(
      match[2]
    )
  );
}


function currentMinutes() {
  const now =
    new Date();

  return (
    now.getHours() *
      60 +
    now.getMinutes()
  );
}


function calculateTimeDifference(
  arrivalMinutes,
  nowMinutes
) {
  if (
    arrivalMinutes === null ||
    nowMinutes === null
  ) {
    return null;
  }

  let diff =
    arrivalMinutes -
    nowMinutes;

  if (
    diff < -720
  ) {
    diff += 1440;
  }

  if (
    diff > 720
  ) {
    diff -= 1440;
  }

  return diff;
}


// ============================================================
// LIVE ETA
// ============================================================
//
// ONLY live fields.
//
// Scheduled stop.arrival is NEVER used.
//
// ============================================================

function getLiveEtaMinutes(
  live
) {
  if (!live) {
    return null;
  }

  // ----------------------------------------------------------
  // ACTUALLY AT GUDUR
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      live
    )
  ) {
    return 0;
  }

  // ----------------------------------------------------------
  // POSSIBLE LIVE ETA FIELDS
  // ----------------------------------------------------------

  const value =
    firstValue(
      live.expectedArrivalTime,
      live.expectedArrival,
      live.etaMinutes,

      live.currentLocation
        ?.expectedArrivalTime,

      live.nextHalt
        ?.expectedArrivalTime,

      live.nextHalt
        ?.etaMinutes
    );

  if (
    value === null
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // NUMERIC ETA
  // ----------------------------------------------------------

  if (
    typeof value ===
      "number" ||
    (
      typeof value ===
        "string" &&
      /^\d+(\.\d+)?$/.test(
        value.trim()
      )
    )
  ) {
    const eta =
      Number(value);

    if (
      Number.isFinite(
        eta
      ) &&
      eta >= 0 &&
      eta <=
        UPCOMING_MAX_ETA_MINUTES
    ) {
      return Math.round(
        eta
      );
    }

    return null;
  }

  // ----------------------------------------------------------
  // LIVE DATETIME ETA
  // ----------------------------------------------------------

  const parsed =
    parseTimeToMinutes(
      value
    );

  if (
    parsed === null
  ) {
    return null;
  }

  const diff =
    calculateTimeDifference(
      parsed,
      currentMinutes()
    );

  if (
    diff === null ||
    diff < 0 ||
    diff >
      UPCOMING_MAX_ETA_MINUTES
  ) {
    return null;
  }

  return Math.round(
    diff
  );
}


// ============================================================
// TRACKING TIMESTAMP
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
    typeof value ===
    "number"
  ) {
    if (
      value >
      100000000000
    ) {
      return value;
    }

    if (
      value >
      1000000000
    ) {
      return (
        value * 1000
      );
    }

    return null;
  }

  const number =
    Number(value);

  if (
    Number.isFinite(
      number
    ) &&
    number >
      1000000000
  ) {
    return (
      number >
      100000000000
        ? number
        : number * 1000
    );
  }

  const parsed =
    Date.parse(
      String(value)
    );

  return Number.isNaN(
    parsed
  )
    ? null
    : parsed;
}


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
// CREATE TRACKING RECORD
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

    // NEVER assume ETA.
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
// UPDATE TRACKING RECORD
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
    !isRecentRecord(
      record
    )
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

  // ----------------------------------------------------------
  // DO NOT OVERWRITE KNOWN CORRIDOR
  // ----------------------------------------------------------

  if (
    !record.corridor &&
    corridor
  ) {
    record.corridor =
      corridor;
  }

  if (
    trainName
  ) {
    record.trainName =
      trainName;
  }

  if (
    origin
  ) {
    record.origin =
      origin;
  }

  if (
    destination
  ) {
    record.destination =
      destination;
  }

  // ----------------------------------------------------------
  // DISTANCES
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
        distanceGdr.toFixed(
          3
        )
      );
  }

  if (
    distanceGate !== null
  ) {
    record.distanceFromGateKm =
      Number(
        distanceGate.toFixed(
          3
        )
      );
  }

  // ==========================================================
  // 1. AT GUDUR
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
  // 2. DEPARTED GUDUR
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

    // --------------------------------------------------------
    // CHECK ACTUAL GATE POSITION
    // --------------------------------------------------------

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
      `[DEPARTED GDR] ${trainNo} ${trainName} | Gate distance ${
        distanceGate !== null
          ? distanceGate.toFixed(
              3
            )
          : "--"
      } km | state=${record.state}`
    );

    return record;
  }

  // ==========================================================
  // 3. APPROACHING GUDUR
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
      } | GDR ${
        distanceGdr !== null
          ? distanceGdr.toFixed(
              2
            ) + " km"
          : "--"
      }`
    );

    return record;
  }

  // ==========================================================
  // 4. LIVE TRAIN BUT NOT NEXT GDR
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
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    console.log(
      `[LIVE API] Checking train ${trainNo}...`
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

  } catch (
    error
  ) {
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
// FETCH GUDUR BOARD
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
// BOARD TRAIN DETAILS
// ============================================================

function getTrainNumber(
  item
) {
  return String(
    firstValue(
      item?.train?.number,
      item?.trainNumber,
      item?.number
    ) || ""
  ).trim();
}


function getTrainName(
  item
) {
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
// GET BOARD STATUS
// ============================================================

function getBoardStatus(
  item
) {
  const live =
    item?.live ||
    {};

  const status =
    normalizeText(
      firstValue(
        live.status,
        item.status,
        item.train?.status
      )
    );

  return status;
}


// ============================================================
// DETERMINE WHETHER BOARD TRAIN IS RELEVANT
// ============================================================
//
// IMPORTANT:
//
// We DO NOT require item.live.nextHalt = GDR.
//
// RailRadar's GDR station board itself is the source of
// trains associated with the GDR board.
//
// Therefore a board train is allowed into the list.
//
// ETA is separately determined:
//
//     LIVE ETA -> number
//     no LIVE ETA -> --
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

  const live =
    item?.live ||
    null;

  // ----------------------------------------------------------
  // Actual GDR
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      live
    )
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Next halt GDR
  // ----------------------------------------------------------

  if (
    isNextHaltGudur(
      live
    )
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Board itself is already the GDR board.
  //
  // Keep the train visible.
  // ----------------------------------------------------------

  return true;
}


// ============================================================
// BUILD UPCOMING TRAINS
// ============================================================
//
// THIS IS THE MAIN CORRECTED BOARD LOGIC.
//
// Board trains remain visible.
//
// BUT:
//
// NO CURRENT LIVE ETA = "--"
//
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

    const corridor =
      determineCorridor(
        train,
        item,
        live
      );

    const record =
      trackingRecords[
        trainNo
      ];

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Do NOT use record.etaMinutes.
    //
    // It may be 7m or 24m from an earlier live check.
    //
    // --------------------------------------------------------

    let etaMinutes =
      null;

    let etaSource =
      "UNKNOWN";

    let state =
      "APPROACHING_GUDUR";

    // --------------------------------------------------------
    // CURRENT BOARD LIVE DATA
    // --------------------------------------------------------

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
      } else {
        // ----------------------------------------------------
        // NO CURRENT LIVE ETA
        //
        // Keep train visible.
        // Do NOT invent ETA.
        // ----------------------------------------------------

        etaMinutes =
          null;

        etaSource =
          "UNKNOWN";

        state =
          "APPROACHING_GUDUR";
      }
    }

    // --------------------------------------------------------
    // If this train is already being tracked toward the gate,
    // preserve its state, but NOT its old ETA.
    // --------------------------------------------------------

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
      } else if (
        record.state ===
        "APPROACHING_GATE"
      ) {
        state =
          "APPROACHING_GATE";

        etaMinutes =
          null;

        etaSource =
          "GATE_TRACKING";
      } else if (
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
    }

    // --------------------------------------------------------
    // DELAY
    // --------------------------------------------------------

    const delayMinutes =
      Number(
        firstValue(
          live?.delayMinutes,
          item?.delayMinutes,
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
    // DISPLAY
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

      etaMinutes,

      etaDisplay:
        etaMinutes ===
        null
          ? "--"
          : String(
              Math.max(
                0,
                Math.round(
                  etaMinutes
                )
              )
            ),

      etaSource,

      delayMinutes,

      corridor:
        corridor ||
        record?.corridor ||
        "OTHER",

      direction:
        state ===
            "DEPARTED_GUDUR" ||
        state ===
            "APPROACHING_GATE" ||
        state ===
            "AT_GATE"
          ? "AWAY_FROM_GUDUR"
          : "TOWARD_GUDUR",

      state,

      platform
    });
  }

  // ==========================================================
  // SORT
  // ==========================================================
  //
  // Known live ETA first.
  //
  // Unknown ETA after known ETA.
  //
  // ==========================================================

  list.sort(
    (
      a,
      b
    ) => {
      if (
        a.etaMinutes ===
          null &&
        b.etaMinutes !==
          null
      ) {
        return 1;
      }

      if (
        a.etaMinutes !==
          null &&
        b.etaMinutes ===
          null
      ) {
        return -1;
      }

      if (
        a.etaMinutes ===
          null &&
        b.etaMinutes ===
          null
      ) {
        return (
          a.trainNo.localeCompare(
            b.trainNo
          )
        );
      }

      return (
        a.etaMinutes -
        b.etaMinutes
      );
    }
  );

  return list.slice(
    0,
    UPCOMING_MAX_TRAINS
  );
}


// ============================================================
// OPEN GATE
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
// CLOSED GATE
// ============================================================

function closedGate(
  record,
  corridor
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

    corridor
  };
}


// ============================================================
// DETERMINE GATE STATES
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

    const corridor =
      record.corridor;

    if (
      corridor !==
        "MAS" &&
      corridor !==
        "TPTY"
    ) {
      continue;
    }

    // --------------------------------------------------------
    // ONLY AT_GATE CLOSES GATE
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
      gateDistance !==
        null &&
      gateDistance >
        GATE_CLOSE_DISTANCE_KM
    ) {
      continue;
    }

    const payload =
      closedGate(
        {
          trainNo,

          trainName:
            record.trainName ||
            `Train ${trainNo}`
        },

        corridor
      );

    if (
      corridor ===
      "MAS"
    ) {
      masGate =
        payload;
    }

    if (
      corridor ===
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
// SELECT LIVE CANDIDATE
// ============================================================
//
// Only one train gets full live verification.
//
// Existing gate-related trains have priority.
//
// Otherwise choose the first GDR board train.
//
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
// PROCESS LIVE CANDIDATE
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
// MAIN UPDATE
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
    // CLEAN OLD TRACKING RECORDS
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
    // STATION BOARD
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
    // LIVE API QUOTA CHECK
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
          `[LIVE] Quota available. Verifying ${candidateNo} ${getTrainName(candidate)}`
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
            `[LIVE] Verification completed for ${candidateNo}.`
          );
        } else {
          console.log(
            `[LIVE] Verification failed for ${candidateNo}.`
          );
        }
      } else {
        console.log(
          "[LIVE] No candidate available."
        );
      }
    } else {
      const remainingMs =
        LIVE_CHECK_INTERVAL_MS -
        (
          nowMs -
          lastLiveCheckAt
        );

      const remainingMin =
        Math.ceil(
          remainingMs /
            60000
        );

      console.log(
        `[LIVE] Throttled to protect monthly quota. Next live check in approximately ${remainingMin} minute(s).`
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
    // GATE STATES
    // --------------------------------------------------------

    const gateStates =
      determineGateStates(
        trackingRecords
      );

    // --------------------------------------------------------
    // UPCOMING TRAINS
    // --------------------------------------------------------

    const upcomingTrains =
      await buildUpcomingTrains(
        trains,
        trackingRecords
      );

    // --------------------------------------------------------
    // FIREBASE PAYLOAD
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
          : "WAITING"
    });

    // --------------------------------------------------------
    // LOG GATES
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

    // --------------------------------------------------------
    // UPCOMING TRAINS
    // --------------------------------------------------------

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
          `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} | ETA ${train.etaDisplay}m | ${train.origin} -> ${train.destination} | state=${train.state} | source=${train.etaSource}`
        );
      }
    );

    // --------------------------------------------------------
    // UNKNOWN ETA LOG
    // --------------------------------------------------------

    const unknownEtaTrains =
      upcomingTrains.filter(
        (train) =>
          train.etaMinutes ===
          null
      );

    if (
      unknownEtaTrains.length >
      0
    ) {
      console.log(
        `\n[ETA] ${unknownEtaTrains.length} train(s) have no current live ETA. Showing "--" instead of timetable/old ETA.`
      );
    }

    // --------------------------------------------------------
    // PERFORMANCE
    // --------------------------------------------------------

    console.log(
      `\n[MONITOR] Run completed successfully in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );

  } catch (
    error
  ) {
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

    // --------------------------------------------------------
    // Do NOT overwrite gates with fake data.
    // --------------------------------------------------------

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
// START APPLICATION
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
  "Tracking radius: 1.00 km"
);

console.log(
  "Gate close zone: 0.60 km"
);

console.log(
  "Gate clear zone: 0.80 km"
);

console.log(
  "ETA 0 rule     : ONLY when actually at GDR"
);

console.log(
  "AT GUDUR       : GATES OPEN"
);

console.log(
  "AT_GATE        : GATE CLOSED"
);

console.log(
  "PASSED_GATE    : GATE OPEN"
);

console.log(
  "Live API       : 20-minute quota protection"
);

console.log(
  "ETA source     : CURRENT LIVE DATA ONLY"
);

console.log(
  "Scheduled ETA  : NEVER USED"
);

console.log(
  "Old Firebase ETA: NEVER USED"
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
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();


// ============================================================
// RUN EVERY 5 MINUTES
// ============================================================

setInterval(
  updateGateSystem,
  5 * 60 * 1000
);
