const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");
const fs = require("fs");

// ============================================================
// GUDUR GATE RAILRADAR MONITOR
// ============================================================
//
// CORE RULE:
//
// NEVER SHOW A NUMERIC ETA UNLESS IT IS CONFIRMED BY
// CURRENT LIVE RAILRADAR DATA.
//
// Scheduled timetable:
//      NOT used for ETA.
//
// Old Firebase ETA:
//      NOT used for ETA.
//
// Board-only train:
//      ETA = --
//
// Actual live train at Gudur:
//      ETA = 0m
//
// Live train approaching Gudur:
//      ETA = current live ETA
//
// After Gudur departure:
//      ETA to Gudur is no longer shown.
//      Train continues through gate tracking.
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
// RAILRADAR
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
// LIVE API QUOTA
// ============================================================
//
// Only one live train request approximately every 20 minutes.
//
// IMPORTANT:
// When live API is throttled, we DO NOT use old ETA values.
//
// ============================================================

const LIVE_CHECK_INTERVAL_MINUTES =
  20;

const LIVE_CHECK_INTERVAL_MS =
  LIVE_CHECK_INTERVAL_MINUTES *
  60 *
  1000;


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
// HELPERS
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
      lng !== null
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
// GUDUR STATION
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
// SEQUENCE
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

  const tirupatiOrigin =
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "KATPADDI",
        "KATPADI"
      ]
    );

  const chennaiOrigin =
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
    );

  if (
    tirupatiOrigin
  ) {
    return "TPTY";
  }

  if (
    chennaiOrigin
  ) {
    return "MAS";
  }

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // Destination alone is NOT sufficient
  // for physical gate closing.

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
// NEXT HALT = GUDUR
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
// TIME
// ============================================================

function parseDateValue(
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
    isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date;
}


function parseTimeToMinutes(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    parseDateValue(
      value
    );

  if (date) {
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
    Number(match[1]) *
      60 +
    Number(match[2])
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
  current
) {
  if (
    arrivalMinutes === null ||
    current === null
  ) {
    return null;
  }

  let diff =
    arrivalMinutes -
    current;

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
// ONLY current live information is allowed.
//
// ============================================================

function getLiveEtaMinutes(
  live
) {
  if (!live) {
    return null;
  }

  // Actual Gudur station
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
      live.eta,
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

  // Numeric ETA
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

  // Date/time ETA
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

    // IMPORTANT:
    // No ETA until live verification.
    etaMinutes:
      null,

    // This tells us whether ETA was actually
    // obtained from a live API response.
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
// RECORD RECENCY
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
  // LIVE DISTANCES
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

  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // DEPARTED GUDUR
  // ----------------------------------------------------------

  if (
    hasDepartedGudur(
      live
    )
  ) {
    record.direction =
      "AWAY_FROM_GUDUR";

    record.state =
      "DEPARTED_GUDUR";

    // ETA to Gudur is no longer meaningful.
    record.etaMinutes =
      null;

    record.etaVerified =
      false;

    // Continue checking actual gate.
    if (
      distanceGate !== null
    ) {
      if (
        distanceGate <=
        GATE_CLOSE_DISTANCE_KM
      ) {
        record.state =
          "AT_GATE";
      } else if (
        distanceGate <=
        GATE_CLEAR_DISTANCE_KM
      ) {
        record.state =
          "APPROACHING_GATE";
      }
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
      } km`
    );

    return record;
  }

  // ----------------------------------------------------------
  // APPROACHING GUDUR
  // ----------------------------------------------------------

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

    // IMPORTANT:
    // A live verification with no ETA still means
    // we do NOT invent an ETA.
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

  // ----------------------------------------------------------
  // LIVE DATA BUT NOT NEXT GDR
  // ----------------------------------------------------------

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
      `[LIVE] Checking ${trainNo}...`
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
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo}: ${error.message}`
      );
    }

    return null;
  }
}


// ============================================================
// STATION BOARD
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
// TRAIN DETAILS
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
// SELECT LIVE CANDIDATE
// ============================================================
//
// Only ONE live request.
//
// Existing gate-related trains have priority.
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
      100;

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
// BUILD UPCOMING LIST
// ============================================================
//
// CRITICAL:
//
// Board data alone DOES NOT get a numeric ETA.
//
// Old Firebase ETA DOES NOT get a numeric ETA.
//
// Only:
//     current live verification
//
// can produce numeric ETA.
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

    if (!trainNo) {
      continue;
    }

    const trainName =
      getTrainName(
        item
      );

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
    // LIVE BOARD DATA
    //
    // IMPORTANT:
    // The board's "live" object is not automatically
    // treated as full live train verification.
    // --------------------------------------------------------

    const boardLiveEta =
      getLiveEtaMinutes(
        live
      );

    const boardAtGudur =
      isAtGudurStation(
        live
      );

    const boardDeparted =
      hasDepartedGudur(
        live
      );

    // --------------------------------------------------------
    // ONLY CURRENT BOARD LIVE DATA CAN GIVE ETA.
    //
    // Do NOT use record.etaMinutes unless it is explicitly
    // marked as a current live verification AND the record
    // is still valid.
    //
    // For safety, persisted ETA is NOT displayed here.
    // --------------------------------------------------------

    let etaMinutes =
      null;

    let etaSource =
      "UNKNOWN";

    let state =
      "APPROACHING_GUDUR";

    if (
      boardAtGudur
    ) {
      etaMinutes =
        0;

      etaSource =
        "LIVE_STATION";

      state =
        "AT_GUDUR_STATION";
    } else if (
      boardDeparted
    ) {
      etaMinutes =
        null;

      etaSource =
        "DEPARTED";

      state =
        "DEPARTED_GUDUR";
    } else if (
      boardLiveEta !== null &&
      isNextHaltGudur(
        live
      )
    ) {
      etaMinutes =
        boardLiveEta;

      etaSource =
        "LIVE";

      state =
        "APPROACHING_GUDUR";
    } else if (
      record?.state ===
        "AT_GATE"
    ) {
      etaMinutes =
        null;

      etaSource =
        "GATE_TRACKING";

      state =
        "AT_GATE";
    } else if (
      record?.state ===
        "APPROACHING_GATE"
    ) {
      etaMinutes =
        null;

      etaSource =
        "GATE_TRACKING";

      state =
        "APPROACHING_GATE";
    } else if (
      record?.state ===
        "DEPARTED_GUDUR"
    ) {
      etaMinutes =
        null;

      etaSource =
        "GATE_TRACKING";

      state =
        "DEPARTED_GUDUR";
    } else {
      // ------------------------------------------------------
      // THIS IS THE IMPORTANT PART.
      //
      // No live confirmation:
      // ETA = null
      //
      // Even if Firebase has old 7m / 24m values.
      // ------------------------------------------------------

      etaMinutes =
        null;

      etaSource =
        "UNKNOWN";

      state =
        "APPROACHING_GUDUR";
    }

    // --------------------------------------------------------
    // INCLUDE ONLY TRAINS WITH ACTUAL GUDUR RELATION
    // --------------------------------------------------------

    const isRelevant =
      isNextHaltGudur(
        live
      ) ||
      boardAtGudur ||
      boardDeparted ||
      (
        record &&
        isRecentRecord(
          record
        ) &&
        (
          record.state ===
            "AT_GATE" ||
          record.state ===
            "APPROACHING_GATE" ||
          record.state ===
            "DEPARTED_GUDUR"
        )
      );

    if (
      !isRelevant
    ) {
      continue;
    }

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

      delayMinutes:
        Number(
          firstValue(
            live?.delayMinutes,
            item?.delayMinutes,
            0
          )
        ) || 0,

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

      platform:
        String(
          firstValue(
            live?.platform,
            item?.platform,
            "1"
          ) || "1"
        )
    });
  }

  // ----------------------------------------------------------
  // SORT
  // ----------------------------------------------------------

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
        return a.trainNo.localeCompare(
          b.trainNo
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
// GATES
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
// DETERMINE GATES
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
      corridor !== "MAS" &&
      corridor !== "TPTY"
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
      gateDistance !== null &&
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
// PROCESS LIVE CANDIDATE
// ============================================================

async function processLiveCandidate(
  item,
  trackingRecords
) {
  if (!item) {
    return;
  }

  const train =
    item.train ||
    {};

  const trainNo =
    getTrainNumber(
      item
    );

  if (!trainNo) {
    return;
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
    return;
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
}


// ============================================================
// MAIN
// ============================================================

async function updateGateSystem() {
  const started =
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
    // LIVE QUOTA
    // --------------------------------------------------------

    console.log(
      "[LIVE] Throttled to protect monthly quota."
    );

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Do NOT use an old persisted ETA to populate
    // upcoming trains.
    //
    // The current run is board-only.
    //
    // --------------------------------------------------------

    const gateStates =
      determineGateStates(
        trackingRecords
      );

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
        "ONLINE"
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

    console.log(
      `\n[MONITOR] Run completed successfully in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );

  } catch (
    error
  ) {
    console.error(
      "\n[MONITOR ERROR]"
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
