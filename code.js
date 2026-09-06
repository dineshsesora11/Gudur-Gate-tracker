const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else {
    serviceAccount = require("./serviceAccountKey.json");
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    "Use FIREBASE_SERVICE_ACCOUNT GitHub Secret or place serviceAccountKey.json beside code.js."
  );

  console.error(error.message);

  process.exit(1);
}

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");

const trackingRef =
  db.ref("gudur_gate_tracking");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR / GATE COORDINATES
// ============================================================

const GDR_LAT = 14.1451694;
const GDR_LNG = 79.8443472;

const TIRUPATI_GATE_LAT = 14.1402028;
const TIRUPATI_GATE_LNG = 79.8435972;

const CHENNAI_GATE_LAT = 14.1396667;
const CHENNAI_GATE_LNG = 79.8441278;

// ============================================================
// DISTANCE SETTINGS
// ============================================================

const TRACKING_DISTANCE_KM = 1.00;

const GATE_DISTANCE_KM = 0.52;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

const UPCOMING_MAX_ETA_MINUTES = 360;

const UPCOMING_DISPLAY_LIMIT = 15;

// IMPORTANT:
// Keep this at 1 because the station board already consumes
// most of the monthly free RailRadar request allowance.
const MAX_LIVE_CALLS = 1;

const TRACKING_RETENTION_MINUTES = 45;

// ============================================================
// TEXT HELPERS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function containsAny(text, values) {
  const normalized =
    normalizeText(text);

  return values.some((value) =>
    normalized.includes(
      normalizeText(value)
    )
  );
}

// ============================================================
// SAFE VALUE HELPERS
// ============================================================

function safeString(value, fallback = "") {
  if (
    value === undefined ||
    value === null
  ) {
    return fallback;
  }

  const text =
    String(value).trim();

  return text || fallback;
}

function safeNumber(
  value,
  fallback = null
) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function safeNullableNumber(
  value
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// ============================================================
// TRAIN FIELD HELPERS
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return safeString(
    train?.number ||
      train?.trainNumber ||
      item?.trainNumber ||
      item?.number,
    ""
  );
}

function getTrainName(
  train,
  item,
  trainNo
) {
  return safeString(
    train?.name ||
      train?.trainName ||
      item?.trainName,
    `Express ${trainNo}`
  );
}

function getStationCode(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return value
      .trim()
      .toUpperCase();
  }

  return safeString(
    value.code ||
      value.stationCode,
    ""
  ).toUpperCase();
}

function getStationName(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return value;
  }

  return safeString(
    value.name ||
      value.stationName,
    ""
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const source =
    train?.source ||
    item?.source;

  if (source) {
    return safeString(
      source.name ||
        source.code ||
        source.stationName ||
        source.stationCode,
      ""
    );
  }

  return safeString(
    train?.origin?.name ||
      train?.origin?.code ||
      train?.origin ||
      train?.fromStation?.name ||
      train?.fromStation?.code ||
      train?.fromStation ||
      train?.from ||
      item?.origin?.name ||
      item?.origin?.code ||
      item?.origin ||
      item?.fromStation?.name ||
      item?.fromStation?.code ||
      item?.fromStation ||
      item?.from,
    ""
  );
}

// ============================================================
// DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const destination =
    train?.destination ||
    item?.destination;

  if (destination) {
    return safeString(
      destination.name ||
        destination.code ||
        destination.stationName ||
        destination.stationCode,
      ""
    );
  }

  return safeString(
    train?.toStation?.name ||
      train?.toStation?.code ||
      train?.toStation ||
      train?.to ||
      train?.destinationStation?.name ||
      train?.destinationStation?.code ||
      train?.destinationStation ||
      item?.toStation?.name ||
      item?.toStation?.code ||
      item?.toStation ||
      item?.to,
    ""
  );
}

// ============================================================
// COORDINATES
// ============================================================

function getCoordinates(
  location
) {
  if (!location) {
    return null;
  }

  const coordinates =
    location.coordinates ||
    location.coordinate ||
    location.position ||
    null;

  if (
    coordinates &&
    Number.isFinite(
      Number(coordinates.lat)
    ) &&
    Number.isFinite(
      Number(coordinates.lng)
    )
  ) {
    return {
      lat:
        Number(coordinates.lat),
      lng:
        Number(coordinates.lng)
    };
  }

  if (
    Number.isFinite(
      Number(location.lat)
    ) &&
    Number.isFinite(
      Number(location.lng)
    )
  ) {
    return {
      lat:
        Number(location.lat),
      lng:
        Number(location.lng)
    };
  }

  return null;
}

// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

  const dLat =
    (lat2 - lat1) *
    Math.PI /
    180;

  const dLon =
    (lon2 - lon1) *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 * Math.PI / 180
    ) *
      Math.cos(
        lat2 * Math.PI / 180
      ) *
      Math.sin(
        dLon / 2
      ) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function distanceFromGudur(
  coords
) {
  if (!coords) {
    return null;
  }

  return distanceKm(
    coords.lat,
    coords.lng,
    GDR_LAT,
    GDR_LNG
  );
}

function distanceFromGate(
  coords,
  gate
) {
  if (
    !coords ||
    !gate
  ) {
    return null;
  }

  return distanceKm(
    coords.lat,
    coords.lng,
    gate.lat,
    gate.lng
  );
}

// ============================================================
// GATE DEFINITIONS
// ============================================================

const GATES = {
  MAS: {
    name: "Chennai Gate",
    lat:
      CHENNAI_GATE_LAT,
    lng:
      CHENNAI_GATE_LNG
  },

  TPTY: {
    name: "Tirupati Gate",
    lat:
      TIRUPATI_GATE_LAT,
    lng:
      TIRUPATI_GATE_LNG
  }
};

// ============================================================
// KNOWN TIRUPATI TRAINS
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
// CORRIDOR DETECTION
// ============================================================

function isChennaiSideOrigin(
  origin
) {
  return containsAny(
    origin,
    [
      "CHENNAI",
      "MAS",
      "CHENNAI CENTRAL",
      "MGR CHENNAI CENTRAL",
      "PURATCHI THALAIVAR DR MGR CENTRAL",
      "AVADI",
      "PERAMBUR",
      "SULLURUPETA",
      "NAYUDUPETA"
    ]
  );
}

function isTirupatiSideOrigin(
  origin
) {
  return containsAny(
    origin,
    [
      "TIRUPATI",
      "TPTY",
      "TIRUPATI MAIN",
      "RENIGUNTA",
      "RU",
      "KATPAD",
      "KATPADI"
    ]
  );
}

function getRouteStationCodes(
  live
) {
  const result = [];

  const route =
    Array.isArray(
      live?.route
    )
      ? live.route
      : [];

  for (
    const station of
      route
  ) {
    const code =
      getStationCode(
        station
      );

    if (code) {
      result.push(code);
    }
  }

  return result;
}

function detectCorridor(
  train,
  item,
  live
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  const origin =
    getOrigin(
      train,
      item
    );

  // ----------------------------------------------------------
  // Explicit origin
  // ----------------------------------------------------------

  if (
    isTirupatiSideOrigin(
      origin
    )
  ) {
    return "TPTY";
  }

  if (
    isChennaiSideOrigin(
      origin
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Live route clues
  // ----------------------------------------------------------

  const previousCode =
    getStationCode(
      live?.previousHalt
    );

  if (
    [
      "RU",
      "TPTY",
      "KPD",
      "KPDJ",
      "WJR"
    ].includes(
      previousCode
    )
  ) {
    return "TPTY";
  }

  if (
    [
      "SPE",
      "NYP",
      "AKM",
      "AJJ",
      "MAS",
      "MS"
    ].includes(
      previousCode
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Known Tirupati train
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Route codes
  // ----------------------------------------------------------

  const routeCodes =
    getRouteStationCodes(
      live
    );

  if (
    routeCodes.includes(
      "TPTY"
    ) &&
    routeCodes.includes(
      "GDR"
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// LIVE STATUS HELPERS
// ============================================================

function getLiveStatus(
  live
) {
  return normalizeText(
    live?.status ||
      ""
  );
}

function isActualPosition(
  live
) {
  return (
    live?.isActualPosition ===
    true
  );
}

function getLiveSequence(
  live
) {
  const sequence =
    safeNullableNumber(
      live?.sequence
    );

  return sequence;
}

function getPreviousSequence(
  live
) {
  const sequence =
    safeNullableNumber(
      live?.previousHalt
        ?.sequence
    );

  return sequence;
}

function getCurrentStationCode(
  live
) {
  return getStationCode(
    live?.stationCode ||
      live?.station
  );
}

// ============================================================
// DETECT TRAIN PASSED GUDUR
// ============================================================

function hasPassedGudur(
  live
) {
  const previousCode =
    getStationCode(
      live?.previousHalt
    );

  const currentCode =
    getCurrentStationCode(
      live
    );

  const currentSequence =
    getLiveSequence(
      live
    );

  const previousSequence =
    getPreviousSequence(
      live
    );

  // Strong RailRadar proof:
  //
  // previous halt = GDR
  // current sequence > GDR sequence
  //
  if (
    previousCode ===
      "GDR" &&
    currentSequence !==
      null &&
    previousSequence !==
      null &&
    currentSequence >
      previousSequence
  ) {
    return true;
  }

  // Secondary proof.
  if (
    previousCode ===
      "GDR" &&
    currentCode &&
    currentCode !==
      "GDR"
  ) {
    return true;
  }

  return false;
}

// ============================================================
// TRAIN AT GUDUR
// ============================================================

function isAtGudurStation(
  live
) {
  const currentCode =
    getCurrentStationCode(
      live
    );

  const previousCode =
    getStationCode(
      live?.previousHalt
    );

  if (
    currentCode ===
    "GDR"
  ) {
    return true;
  }

  if (
    live?.stationName &&
    containsAny(
      live.stationName,
      [
        "GUDUR",
        "GUDUR JN",
        "GUDUR JUNCTION"
      ]
    )
  ) {
    return true;
  }

  if (
    previousCode ===
      "GDR" &&
    getLiveStatus(
      live
    ).includes(
      "AT STATION"
    )
  ) {
    return true;
  }

  return false;
}

// ============================================================
// TRAIN MOVING
// ============================================================

function isTrainMoving(
  live
) {
  const status =
    getLiveStatus(
      live
    );

  if (
    status.includes(
      "RUNNING"
    ) ||
    status.includes(
      "MOVING"
    ) ||
    status.includes(
      "DEPARTED"
    )
  ) {
    return true;
  }

  const speed =
    safeNumber(
      live?.speedKmh,
      null
    );

  if (
    speed !== null &&
    speed > 2
  ) {
    return true;
  }

  return false;
}

// ============================================================
// TIME PARSING
// ============================================================

function parseTimeToMinutes(
  value
) {
  if (!value) {
    return -1;
  }

  const date =
    new Date(value);

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
    return -1;
  }

  return (
    parseInt(
      match[1],
      10
    ) *
      60 +
    parseInt(
      match[2],
      10
    )
  );
}

function calculateTimeDifference(
  arrivalMinutes,
  currentMinutes
) {
  let diff =
    arrivalMinutes -
    currentMinutes;

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// BOARD ETA
// ============================================================

function getBoardEta(
  train,
  item,
  live,
  stop
) {
  const delay =
    safeNumber(
      live?.delayMinutes ||
        item?.delayMinutes ||
        0,
      0
    );

  const arrival =
    stop?.arrival ||
      live?.expectedArrivalTime ||
      item?.arrival ||
      item?.expectedArrivalTime ||
      "";

  if (!arrival) {
    return null;
  }

  const arrivalMinutes =
    parseTimeToMinutes(
      arrival
    );

  if (
    arrivalMinutes === -1
  ) {
    return null;
  }

  const now =
    new Date();

  const currentMinutes =
    now.getHours() *
      60 +
    now.getMinutes();

  const adjusted =
    arrivalMinutes +
    delay;

  const diff =
    calculateTimeDifference(
      adjusted,
      currentMinutes
    );

  if (
    diff < -15 ||
    diff >
      UPCOMING_MAX_ETA_MINUTES
  ) {
    return null;
  }

  return Math.max(
    0,
    diff
  );
}

// ============================================================
// LIVE TRAIN REQUEST
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${trainNo}/live`,
        {
          params: {
            authoritative:
              "true",
            haltsOnly:
              "false",
            geometry:
              "true",
            format:
              "geojson",
            includeCoordinates:
              "true"
          },

          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,
            Accept:
              "application/json"
          },

          timeout: 15000
        }
      );

    return (
      response.data?.data ||
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
        JSON.stringify(
          error.response.data
        )
      );
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo} ${error.message}`
      );
    }

    return null;
  }
}

// ============================================================
// CREATE TRACKING RECORD
// ============================================================

function createTrackingRecord(
  train,
  item,
  liveData,
  corridor,
  boardEta
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  const name =
    getTrainName(
      train,
      item,
      trainNo
    );

  const origin =
    getOrigin(
      train,
      item
    );

  const destination =
    getDestination(
      train,
      item
    );

  const live =
    liveData?.currentLocation ||
      liveData ||
      {};

  const coords =
    getCoordinates(
      live
    );

  const currentStation =
    getCurrentStationCode(
      live
    );

  const sequence =
    getLiveSequence(
      live
    );

  const previousHaltCode =
    getStationCode(
      live?.previousHalt
    );

  const previousHaltSequence =
    getPreviousSequence(
      live
    );

  return {
    trainNo:
      safeString(
        trainNo
      ),

    name:
      safeString(
        name,
        `Express ${trainNo}`
      ),

    origin:
      safeString(
        origin,
        "Unknown"
      ),

    destination:
      safeString(
        destination,
        "Gudur"
      ),

    corridor:
      safeString(
        corridor
      ),

    direction:
      "TOWARD GUDUR",

    state:
      "APPROACHING_GUDUR",

    boardEta:
      safeNullableNumber(
        boardEta
      ),

    etaMinutes:
      safeNullableNumber(
        boardEta
      ),

    lastUpdated:
      new Date().toISOString(),

    currentStation:
      currentStation ||
      null,

    sequence:
      sequence,

    previousHalt:
      previousHaltCode ||
      null,

    // IMPORTANT:
    // Firebase does NOT accept undefined.
    previousHaltSequence:
      previousHaltSequence !==
        null
        ? previousHaltSequence
        : null,

    actualPosition:
      isActualPosition(
        live
      ),

    coordinates:
      coords
        ? {
            lat:
              coords.lat,
            lng:
              coords.lng
          }
        : null,

    speedKmh:
      safeNullableNumber(
        live?.speedKmh
      )
  };
}

// ============================================================
// UPDATE TRACKING STATE
// ============================================================

function updateTrackingState(
  record,
  liveData
) {
  const live =
    liveData?.currentLocation ||
      liveData ||
      {};

  const coords =
    getCoordinates(
      live
    );

  const currentStation =
    getCurrentStationCode(
      live
    );

  const currentSequence =
    getLiveSequence(
      live
    );

  const previousCode =
    getStationCode(
      live?.previousHalt
    );

  const previousSequence =
    getPreviousSequence(
      live
    );

  record.currentStation =
    currentStation ||
    record.currentStation ||
    null;

  record.sequence =
    currentSequence;

  record.previousHalt =
    previousCode ||
    record.previousHalt ||
    null;

  // IMPORTANT:
  // Never allow undefined into Firebase.
  if (
    previousSequence !==
    null
  ) {
    record.previousHaltSequence =
      previousSequence;
  } else if (
    record.previousHaltSequence ===
      undefined
  ) {
    record.previousHaltSequence =
      null;
  }

  record.actualPosition =
    isActualPosition(
      live
    );

  if (coords) {
    record.coordinates = {
      lat:
        coords.lat,
      lng:
        coords.lng
    };
  } else if (
    record.coordinates ===
    undefined
  ) {
    record.coordinates =
      null;
  }

  const speed =
    safeNullableNumber(
      live?.speedKmh
    );

  record.speedKmh =
    speed;

  record.lastUpdated =
    new Date().toISOString();

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

    return record;
  }

  // ----------------------------------------------------------
  // PASSED GUDUR
  // ----------------------------------------------------------

  if (
    hasPassedGudur(
      live
    )
  ) {
    record.state =
      "DEPARTED_GUDUR";

    record.etaMinutes =
      null;

    return record;
  }

  // ----------------------------------------------------------
  // APPROACHING
  // ----------------------------------------------------------

  record.state =
    "APPROACHING_GUDUR";

  return record;
}

// ============================================================
// GATE FROM CORRIDOR
// ============================================================

function getGateForCorridor(
  corridor
) {
  if (
    corridor ===
    "MAS"
  ) {
    return GATES.MAS;
  }

  if (
    corridor ===
    "TPTY"
  ) {
    return GATES.TPTY;
  }

  return null;
}

// ============================================================
// GATE EVALUATION
// ============================================================

function evaluateGateForTrain(
  record
) {
  const gate =
    getGateForCorridor(
      record.corridor
    );

  if (
    !gate ||
    !record.coordinates
  ) {
    return {
      close:
        false,
      clear:
        false,
      distance:
        null
    };
  }

  const distance =
    distanceFromGate(
      record.coordinates,
      gate
    );

  // ----------------------------------------------------------
  // AT GUDUR PLATFORM = OPEN
  // ----------------------------------------------------------

  if (
    record.state ===
    "AT_GUDUR_STATION"
  ) {
    return {
      close:
        false,
      clear:
        false,
      distance
    };
  }

  // ----------------------------------------------------------
  // CLOSE
  // ----------------------------------------------------------

  if (
    distance <=
    GATE_CLOSE_DISTANCE_KM
  ) {
    return {
      close:
        true,
      clear:
        false,
      distance
    };
  }

  // ----------------------------------------------------------
  // CLEAR
  // ----------------------------------------------------------

  if (
    distance >=
    GATE_CLEAR_DISTANCE_KM
  ) {
    return {
      close:
        false,
      clear:
        true,
      distance
    };
  }

  return {
    close:
      false,
    clear:
      false,
    distance
  };
}

// ============================================================
// REMOVE UNDEFINED VALUES RECURSIVELY
// ============================================================
//
// Firebase Realtime Database rejects undefined values.
// This final sanitizer guarantees that cannot happen.
//
// ============================================================

function sanitizeForFirebase(
  value
) {
  if (
    value === undefined
  ) {
    return null;
  }

  if (
    value === null
  ) {
    return null;
  }

  if (
    Array.isArray(value)
  ) {
    return value.map(
      sanitizeForFirebase
    );
  }

  if (
    typeof value ===
    "object"
  ) {
    const result = {};

    for (
      const [
        key,
        child
      ] of Object.entries(
        value
      )
    ) {
      result[key] =
        sanitizeForFirebase(
          child
        );
    }

    return result;
  }

  return value;
}

// ============================================================
// MAIN MONITOR
// ============================================================

async function updateGateSystem() {
  try {
    const now =
      new Date();

    console.log(
      `\n[${now.toLocaleString()}] Querying RailRadar Live Station Board for GDR...`
    );

    if (
      !RAILRADAR_API_KEY
    ) {
      console.error(
        "❌ RAILRADAR_API_KEY is missing."
      );

      return;
    }

    // ========================================================
    // LOAD TRACKING
    // ========================================================

    const trackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const existingTracking =
      trackingSnapshot.val() ||
      {};

    const tracking = {
      ...existingTracking
    };

    // ========================================================
    // SANITIZE EXISTING RECORDS BEFORE PROCESSING
    // ========================================================

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !record ||
        typeof record !==
          "object"
      ) {
        delete tracking[
          trainNo
        ];

        continue;
      }

      if (
        record.previousHaltSequence ===
        undefined
      ) {
        record.previousHaltSequence =
          null;
      }

      if (
        record.sequence ===
        undefined
      ) {
        record.sequence =
          null;
      }

      if (
        record.coordinates ===
        undefined
      ) {
        record.coordinates =
          null;
      }

      if (
        record.etaMinutes ===
        undefined
      ) {
        record.etaMinutes =
          null;
      }

      if (
        record.boardEta ===
        undefined
      ) {
        record.boardEta =
          null;
      }
    }

    // ========================================================
    // RAILRADAR BOARD
    // ========================================================

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4`,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          timeout: 15000
        }
      );

    const responseBody =
      boardResponse.data;

    const trainsArray =
      responseBody?.data?.trains ||
      [];

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      console.error(
        "❌ RailRadar returned invalid train data."
      );

      return;
    }

    console.log(
      `\nRailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // ARRAYS
    // ========================================================

    const candidateList =
      [];

    const upcomingBoardTrains =
      [];

    // ========================================================
    // PROCESS BOARD
    // ========================================================

    for (
      const item of
        trainsArray
    ) {
      const train =
        item?.train ||
        {};

      const live =
        item?.live ||
        {};

      const stop =
        item?.stop ||
        {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (!trainNo) {
        continue;
      }

      const name =
        getTrainName(
          train,
          item,
          trainNo
        );

      const origin =
        getOrigin(
          train,
          item
        );

      const destination =
        getDestination(
          train,
          item
        );

      const boardEta =
        getBoardEta(
          train,
          item,
          live,
          stop
        );

      const existing =
        tracking[
          trainNo
        ];

      const corridor =
        detectCorridor(
          train,
          item,
          live
        );

      // ------------------------------------------------------
      // If already tracked, retain its corridor even if
      // the current board response lacks corridor clues.
      // ------------------------------------------------------

      const finalCorridor =
        corridor ||
        existing?.corridor ||
        null;

      if (
        !finalCorridor
      ) {
        console.log(
          `[IGNORED] ${trainNo} ${name} | corridor not confirmed`
        );

        continue;
      }

      // ------------------------------------------------------
      // New record
      // ------------------------------------------------------

      if (
        !existing
      ) {
        tracking[
          trainNo
        ] =
          createTrackingRecord(
            train,
            item,
            null,
            finalCorridor,
            boardEta
          );
      } else {
        tracking[
          trainNo
        ].trainNo =
          trainNo;

        tracking[
          trainNo
        ].name =
          safeString(
            name,
            tracking[
              trainNo
            ].name ||
              `Express ${trainNo}`
          );

        tracking[
          trainNo
        ].origin =
          safeString(
            origin,
            tracking[
              trainNo
            ].origin ||
              "Unknown"
          );

        tracking[
          trainNo
        ].destination =
          safeString(
            destination,
            tracking[
              trainNo
            ].destination ||
              "Gudur"
          );

        tracking[
          trainNo
        ].corridor =
          finalCorridor;

        if (
          boardEta !==
            null &&
          tracking[
            trainNo
          ].state ===
            "APPROACHING_GUDUR"
        ) {
          tracking[
            trainNo
          ].boardEta =
            boardEta;

          tracking[
            trainNo
          ].etaMinutes =
            boardEta;
        }
      }

      // ------------------------------------------------------
      // Live candidate
      // ------------------------------------------------------

      const shouldCandidate =
        existing ||
        (
          boardEta !==
            null &&
          boardEta <=
            60
        );

      if (
        shouldCandidate
      ) {
        candidateList.push({
          trainNo,
          name,
          corridor:
            finalCorridor,
          boardEta:
            boardEta !==
            null
              ? boardEta
              : 999999
        });
      }

      // ------------------------------------------------------
      // Board upcoming
      // ------------------------------------------------------

      if (
        boardEta !==
          null &&
        boardEta <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        upcomingBoardTrains.push({
          trainNo,

          name,

          origin:
            origin ||
            "Southern side",

          destination:
            destination ||
            "Gudur",

          etaMinutes:
            boardEta,

          delayMinutes:
            safeNumber(
              live?.delayMinutes ||
                item?.delayMinutes ||
                0,
              0
            ),

          corridor:
            finalCorridor,

          direction:
            "TOWARD GUDUR",

          platform:
            safeString(
              live?.platform ||
                stop?.platform ||
                item?.platform,
              "—"
            )
        });
      }
    }

    // ========================================================
    // EXISTING TRACKING CANDIDATES
    // ========================================================

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !record ||
        !record.corridor
      ) {
        continue;
      }

      const already =
        candidateList.some(
          (candidate) =>
            candidate.trainNo ===
            trainNo
        );

      if (
        already
      ) {
        continue;
      }

      if (
        record.state ===
          "AT_GUDUR_STATION" ||
        record.state ===
          "DEPARTED_GUDUR" ||
        record.state ===
          "APPROACHING_GUDUR" ||
        record.state ===
          "AT_GATE"
      ) {
        candidateList.push({
          trainNo,

          name:
            record.name ||
            `Express ${trainNo}`,

          corridor:
            record.corridor,

          boardEta:
            safeNullableNumber(
              record.etaMinutes
            ) ??
            999999
        });
      }
    }

    // ========================================================
    // SORT CANDIDATES
    // ========================================================

    candidateList.sort(
      (a, b) =>
        a.boardEta -
        b.boardEta
    );

    const uniqueCandidates =
      [];

    for (
      const candidate of
        candidateList
    ) {
      if (
        uniqueCandidates.some(
          (item) =>
            item.trainNo ===
            candidate.trainNo
        )
      ) {
        continue;
      }

      uniqueCandidates.push(
        candidate
      );
    }

    const liveCandidates =
      uniqueCandidates.slice(
        0,
        MAX_LIVE_CALLS
      );

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    for (
      const candidate of
        liveCandidates
    ) {
      const trainNo =
        candidate.trainNo;

      const liveData =
        await fetchLiveTrain(
          trainNo
        );

      if (
        !liveData
      ) {
        console.log(
          `[LIVE UNAVAILABLE] ${trainNo}`
        );

        continue;
      }

      const live =
        liveData.currentLocation ||
        {};

      const record =
        tracking[
          trainNo
        ];

      if (
        !record
      ) {
        continue;
      }

      updateTrackingState(
        record,
        liveData
      );

      // ------------------------------------------------------
      // PASSED GUDUR
      // ------------------------------------------------------

      if (
        hasPassedGudur(
          live
        )
      ) {
        record.state =
          "DEPARTED_GUDUR";

        record.etaMinutes =
          null;

        console.log(
          `[LIVE PASSED GDR] ${trainNo} ${record.name} | previous halt GDR | sequence ${record.sequence}`
        );

        continue;
      }

      // ------------------------------------------------------
      // AT GUDUR
      // ------------------------------------------------------

      if (
        isAtGudurStation(
          live
        )
      ) {
        record.state =
          "AT_GUDUR_STATION";

        record.etaMinutes =
          0;

        console.log(
          `[LIVE AT GUDUR] ${trainNo} ${record.name} | gate remains OPEN`
        );

        continue;
      }

      // ------------------------------------------------------
      // GPS
      // ------------------------------------------------------

      const coords =
        getCoordinates(
          live
        );

      if (
        coords
      ) {
        const gudurDistance =
          distanceFromGudur(
            coords
          );

        const gate =
          getGateForCorridor(
            record.corridor
          );

        const gateDistance =
          gate
            ? distanceFromGate(
                coords,
                gate
              )
            : null;

        console.log(
          `[LIVE POSITION] ${trainNo} ${record.name} | ${record.corridor} | GDR ${gudurDistance?.toFixed(3)} km | gate ${gateDistance?.toFixed(3)} km | speed ${record.speedKmh ?? "unknown"} km/h`
        );

        // ----------------------------------------------------
        // 1 KM TRACKING ZONE
        // ----------------------------------------------------

        if (
          gudurDistance !==
            null &&
          gudurDistance <=
            TRACKING_DISTANCE_KM
        ) {
          record.state =
            "APPROACHING_GUDUR";
        }
      } else {
        console.log(
          `[LIVE POSITION] ${trainNo} ${record.name} | GPS unavailable`
        );
      }

      // ------------------------------------------------------
      // GATE
      // ------------------------------------------------------

      const gateResult =
        evaluateGateForTrain(
          record
        );

      if (
        gateResult.close
      ) {
        record.state =
          "AT_GATE";

        record.gateDistanceKm =
          safeNumber(
            gateResult.distance?.toFixed(
              3
            ),
            null
          );

        record.etaMinutes =
          0;

        console.log(
          `[GATE TRIGGER] ${trainNo} ${record.name} | ${record.corridor} | ${gateResult.distance.toFixed(3)} km from gate`
        );
      }
    }

    // ========================================================
    // CLEAR AT-GATE TRAINS
    // ========================================================

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !record ||
        !record.coordinates
      ) {
        continue;
      }

      if (
        record.state !==
        "AT_GATE"
      ) {
        continue;
      }

      const gateResult =
        evaluateGateForTrain(
          record
        );

      if (
        gateResult.clear
      ) {
        record.state =
          "PASSED_GATE";

        record.etaMinutes =
          null;

        console.log(
          `[GATE CLEAR] ${trainNo} ${record.name} | ${record.corridor} | ${gateResult.distance.toFixed(3)} km from gate`
        );
      }
    }

    // ========================================================
    // GATE DEFAULTS
    // ========================================================

    let masGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "TOWARD GUDUR",

      corridor:
        "MAS"
    };

    let tptyGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "TOWARD GUDUR",

      corridor:
        "TPTY"
    };

    // ========================================================
    // APPLY AT-GATE RECORDS
    // ========================================================

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !record ||
        !record.corridor
      ) {
        continue;
      }

      if (
        record.state !==
        "AT_GATE"
      ) {
        continue;
      }

      const gate =
        getGateForCorridor(
          record.corridor
        );

      if (!gate) {
        continue;
      }

      const distance =
        record.coordinates
          ? distanceFromGate(
              record.coordinates,
              gate
            )
          : null;

      const waitMinutes =
        distance !==
          null
          ? Math.max(
              1,
              Math.ceil(
                (
                  distance *
                  60
                ) /
                  30
              )
            )
          : 3;

      const payload = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          `${trainNo} ${record.name}`,

        direction:
          "TOWARD GUDUR",

        corridor:
          record.corridor
      };

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

    // ========================================================
    // UPCOMING TRAINS
    // ========================================================

    const upcomingMap =
      new Map();

    // Board trains first.
    for (
      const train of
        upcomingBoardTrains
    ) {
      upcomingMap.set(
        train.trainNo,
        train
      );
    }

    // Tracking state has priority.
    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (!record) {
        continue;
      }

      // ------------------------------------------------------
      // Never show trains that already passed Gudur.
      // ------------------------------------------------------

      if (
        record.state ===
          "DEPARTED_GUDUR" ||
        record.state ===
          "PASSED_GATE"
      ) {
        upcomingMap.delete(
          trainNo
        );

        continue;
      }

      // ------------------------------------------------------
      // AT GUDUR
      // ------------------------------------------------------

      if (
        record.state ===
        "AT_GUDUR_STATION"
      ) {
        upcomingMap.set(
          trainNo,
          {
            trainNo,

            name:
              record.name,

            origin:
              record.origin ||
              "Southern side",

            destination:
              record.destination ||
              "Gudur",

            etaMinutes:
              0,

            delayMinutes:
              0,

            corridor:
              record.corridor,

            direction:
              "AT GUDUR STATION",

            platform:
              "GDR",

            state:
              "AT_GUDUR_STATION"
          }
        );

        continue;
      }

      // ------------------------------------------------------
      // APPROACHING
      // ------------------------------------------------------

      if (
        record.state ===
        "APPROACHING_GUDUR"
      ) {
        upcomingMap.set(
          trainNo,
          {
            trainNo,

            name:
              record.name,

            origin:
              record.origin ||
              "Southern side",

            destination:
              record.destination ||
              "Gudur",

            etaMinutes:
              safeNullableNumber(
                record.etaMinutes
              ) ??
              safeNullableNumber(
                record.boardEta
              ) ??
              0,

            delayMinutes:
              0,

            corridor:
              record.corridor,

            direction:
              "TOWARD GUDUR",

            platform:
              "—",

            state:
              "APPROACHING_GUDUR"
          }
        );
      }

      // ------------------------------------------------------
      // AT GATE
      // ------------------------------------------------------

      if (
        record.state ===
        "AT_GATE"
      ) {
        upcomingMap.set(
          trainNo,
          {
            trainNo,

            name:
              record.name,

            origin:
              record.origin ||
              "Southern side",

            destination:
              record.destination ||
              "Gudur",

            etaMinutes:
              0,

            delayMinutes:
              0,

            corridor:
              record.corridor,

            direction:
              "TOWARD GUDUR",

            platform:
              "GATE",

            state:
              "AT_GATE"
          }
        );
      }
    }

    // ========================================================
    // SORT
    // ========================================================

    const upcomingList =
      Array.from(
        upcomingMap.values()
      )
        .filter(
          (train) =>
            train.etaMinutes !==
              null &&
            train.etaMinutes !==
              undefined
        )
        .sort(
          (a, b) =>
            Number(
              a.etaMinutes
            ) -
            Number(
              b.etaMinutes
            )
        )
        .slice(
          0,
          UPCOMING_DISPLAY_LIMIT
        );

    // ========================================================
    // CLEAN TRACKING
    // ========================================================

    const nowMs =
      Date.now();

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !record
      ) {
        delete tracking[
          trainNo
        ];

        continue;
      }

      // ------------------------------------------------------
      // PASSED GATE
      // ------------------------------------------------------

      if (
        record.state ===
        "PASSED_GATE"
      ) {
        console.log(
          `[TRACKING REMOVE] ${trainNo} ${record.name} | passed gate`
        );

        delete tracking[
          trainNo
        ];

        continue;
      }

      // ------------------------------------------------------
      // SAFE TIMESTAMP PARSING
      // ------------------------------------------------------

      const updatedMs =
        Date.parse(
          safeString(
            record.lastUpdated,
            ""
          )
        );

      // ------------------------------------------------------
      // INVALID TIMESTAMP
      //
      // Do NOT calculate a giant number such as
      // 29812177 minutes.
      //
      // If the record has an invalid timestamp and
      // is an old/corrupt record, remove it safely.
      // Newly created records always get a valid timestamp.
      // ------------------------------------------------------

      if (
        !Number.isFinite(
          updatedMs
        )
      ) {
        console.log(
          `[TRACKING REMOVE] ${trainNo} ${record.name || ""} | invalid timestamp`
        );

        delete tracking[
          trainNo
        ];

        continue;
      }

      const ageMinutes =
        (
          nowMs -
          updatedMs
        ) /
        60000;

      // ------------------------------------------------------
      // FUTURE TIMESTAMP
      // ------------------------------------------------------

      if (
        ageMinutes <
        -5
      ) {
        record.lastUpdated =
          new Date().toISOString();

        continue;
      }

      // ------------------------------------------------------
      // DEPARTED GUDUR
      // ------------------------------------------------------

      if (
        record.state ===
          "DEPARTED_GUDUR" &&
        ageMinutes >
          TRACKING_RETENTION_MINUTES
      ) {
        console.log(
          `[TRACKING REMOVE] ${trainNo} ${record.name} | departed Gudur ${Math.round(ageMinutes)}m ago`
        );

        delete tracking[
          trainNo
        ];

        continue;
      }

      // ------------------------------------------------------
      // GENERAL STALE RECORD
      // ------------------------------------------------------

      if (
        ageMinutes >
          TRACKING_RETENTION_MINUTES
      ) {
        console.log(
          `[TRACKING REMOVE] ${trainNo} ${record.name} | stale ${Math.round(ageMinutes)}m`
        );

        delete tracking[
          trainNo
        ];
      }
    }

    // ========================================================
    // FINAL FIREBASE SANITIZATION
    // ========================================================

    const safeTracking =
      sanitizeForFirebase(
        tracking
      );

    const safeGates =
      sanitizeForFirebase({
        tirupatiGate:
          tptyGate,

        chennaiGate:
          masGate,

        upcomingTrains:
          upcomingList,

        lastUpdated:
          now.toLocaleTimeString(
            "en-IN"
          ),

        lastUpdatedISO:
          now.toISOString()
      });

    // ========================================================
    // SAVE TRACKING
    // ========================================================

    await trackingRef.set(
      safeTracking
    );

    // ========================================================
    // SAVE GATES
    // ========================================================

    await gateRef.set(
      safeGates
    );

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      `Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );

    console.log(
      `Upcoming trains: ${upcomingList.length}`
    );

    // ========================================================
    // UPCOMING LOG
    // ========================================================

    if (
      upcomingList.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      upcomingList.forEach(
        (
          train,
          index
        ) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | ${train.origin} -> ${train.destination} | state=${train.state || "BOARD"}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    console.log(
      "\n[MONITOR] Run completed successfully."
    );

  } catch (error) {
    console.error(
      "\n❌ MONITOR ERROR"
    );

    if (
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );

      console.error(
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        error.message
      );
    }

    process.exitCode =
      1;
  }
}

// ============================================================
// START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " Gudur Gate RailRadar Monitor "
);

console.log(
  "=========================================="
);

console.log(
  `Gudur Junction : ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  `Chennai Gate   : ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  `Tirupati Gate  : ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  `Tracking radius: ${TRACKING_DISTANCE_KM} km`
);

console.log(
  `Gate close zone: ${GATE_CLOSE_DISTANCE_KM} km`
);

console.log(
  "Direction: verified toward Gudur only"
);

console.log(
  "Execution: one run per GitHub Actions schedule"
);

console.log(
  "Firebase: undefined-value protection ENABLED"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem();
