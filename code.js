const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

// ------------------------------------------------------------
// GitHub Actions:
// FIREBASE_SERVICE_ACCOUNT should contain the complete JSON.
//
// Local testing:
// serviceAccountKey.json can be placed beside code.js.
// ------------------------------------------------------------

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    console.log(
      "Firebase service account loaded from environment."
    );
  } catch (error) {
    console.error(
      "❌ FIREBASE_SERVICE_ACCOUNT contains invalid JSON."
    );

    console.error(error.message);

    process.exit(1);
  }
} else {
  const localKeyPath = "./serviceAccountKey.json";

  if (fs.existsSync(localKeyPath)) {
    try {
      serviceAccount = require(localKeyPath);

      console.log(
        "Firebase service account loaded from serviceAccountKey.json."
      );
    } catch (error) {
      console.error(
        "❌ Could not load serviceAccountKey.json."
      );

      console.error(error.message);

      process.exit(1);
    }
  } else {
    console.error(
      "❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing."
    );

    console.error(
      "For GitHub Actions, add FIREBASE_SERVICE_ACCOUNT to repository secrets."
    );

    process.exit(1);
  }
}

// ------------------------------------------------------------
// Initialize Firebase
// ------------------------------------------------------------

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = admin.database();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY;

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  process.exit(1);
}

// ============================================================
// GUDUR LOCATION
// ============================================================

const GUDUR = {
  lat: 14.1451694,
  lng: 79.8443472
};

// ============================================================
// GATE LOCATIONS
// ============================================================

const CHENNAI_GATE = {
  lat: 14.1396667,
  lng: 79.8441278
};

const TIRUPATI_GATE = {
  lat: 14.1402028,
  lng: 79.8435972
};

// ============================================================
// DISTANCE SETTINGS
// ============================================================
//
// WARNING:
// Train is within 1.00 km but farther than 0.60 km.
//
// CLOSED:
// Train is within 0.60 km.
//
// IMPORTANT:
// These are GPS-distance rules.
// ETA alone NEVER closes a gate.
//

const APPROACHING_GUDUR_DISTANCE_KM = 1.00;

const GATE_WARNING_DISTANCE_KM = 1.00;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// API / QUEUE SETTINGS
// ============================================================

const MAX_LIVE_REQUESTS = 8;

const UPCOMING_LIMIT = 10;

const UPCOMING_WINDOW_MINUTES = 240;

// ============================================================
// APPROVED TRAIN NUMBERS
// ============================================================
//
// Train number determines which corridor the train belongs to.
//
// TPTY:
// Tirupati side -> Gudur
//
// MAS:
// Chennai side -> Gudur
//
// OTHER:
// Known train but not allowed to control either gate.
//
// Unknown:
// Ignored completely.
//

const TPTY_TRAINS = new Set([
  "03251",
  "05074",
  "04717",
  "07669",
  "07670",
  "12296",
  "12733",
  "12734",
  "12762",
  "12763",
  "12764",
  "14723",
  "17261",
  "17262",
  "17479",
  "17480",
  "17487",
  "17488",
  "22871"
]);

const MAS_TRAINS = new Set([
  "12622",
  "12625",
  "12626",
  "12759",
  "12760",
  "12851",
  "16031",
  "16032",
  "17237"
]);

const OTHER_TRAINS = new Set([
  "12743",
  "12744",
  "20498",
  "67226"
]);

// ============================================================
// CORRIDOR DETECTION
// ============================================================

function determineCorridor(trainNo) {
  const number =
    String(trainNo || "")
      .trim();

  if (TPTY_TRAINS.has(number)) {
    return "TPTY";
  }

  if (MAS_TRAINS.has(number)) {
    return "MAS";
  }

  if (OTHER_TRAINS.has(number)) {
    return "OTHER";
  }

  return null;
}

// ============================================================
// TEXT NORMALIZER
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

// ============================================================
// NUMBER HELPER
// ============================================================

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
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
// COORDINATE PARSER
// ============================================================
//
// RailRadar can return coordinates in different structures.
//
// Supported:
//
// { lat, lng }
// { latitude, longitude }
// { lat, lon }
// [lng, lat]
// GeoJSON:
// { type:"Point", coordinates:[lng,lat] }
// nested coordinates
//

function parseCoordinates(value) {
  if (!value) {
    return null;
  }

  // ----------------------------------------------------------
  // ARRAY
  // ----------------------------------------------------------

  if (Array.isArray(value)) {
    if (value.length >= 2) {
      const first =
        toNumber(value[0]);

      const second =
        toNumber(value[1]);

      if (
        first !== null &&
        second !== null
      ) {
        // GeoJSON is [longitude, latitude]
        if (
          Math.abs(first) <= 180 &&
          Math.abs(second) <= 90
        ) {
          return {
            lat: second,
            lng: first
          };
        }
      }
    }

    return null;
  }

  // ----------------------------------------------------------
  // OBJECT
  // ----------------------------------------------------------

  if (
    typeof value === "object"
  ) {
    // GeoJSON
    if (
      Array.isArray(
        value.coordinates
      )
    ) {
      const geo =
        parseCoordinates(
          value.coordinates
        );

      if (geo) {
        return geo;
      }
    }

    const lat =
      toNumber(
        value.lat ??
        value.latitude
      );

    const lng =
      toNumber(
        value.lng ??
        value.lon ??
        value.longitude
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
// GET GPS COORDINATES
// ============================================================

function getCoordinates(liveData) {
  if (!liveData) {
    return null;
  }

  const candidates = [
    liveData.currentLocation,
    liveData.coordinates,
    liveData.position,

    liveData.live?.currentLocation,
    liveData.live?.coordinates,
    liveData.live?.position,

    liveData.data?.currentLocation,
    liveData.data?.coordinates,
    liveData.data?.position,

    liveData.currentLocation?.coordinates,

    liveData.currentLocation?.position
  ];

  for (const candidate of candidates) {
    const coordinates =
      parseCoordinates(
        candidate
      );

    if (coordinates) {
      return coordinates;
    }
  }

  return null;
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
  const earthRadiusKm =
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
      (lat1 * Math.PI) / 180
    ) *
    Math.cos(
      (lat2 * Math.PI) / 180
    ) *
    Math.sin(dLng / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return earthRadiusKm * c;
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  coordinates
) {
  if (!coordinates) {
    return null;
  }

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    GUDUR.lat,
    GUDUR.lng
  );
}

// ============================================================
// DISTANCE TO CORRESPONDING GATE
// ============================================================

function getDistanceToGate(
  coordinates,
  corridor
) {
  if (
    !coordinates ||
    !corridor
  ) {
    return null;
  }

  let gate;

  if (corridor === "MAS") {
    gate = CHENNAI_GATE;
  } else if (
    corridor === "TPTY"
  ) {
    gate = TIRUPATI_GATE;
  } else {
    return null;
  }

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    gate.lat,
    gate.lng
  );
}

// ============================================================
// GUDUR STATION DETECTION
// ============================================================

function isAtGudur(
  liveData,
  coordinates
) {
  const currentLocation =
    liveData?.currentLocation ||
    {};

  const stationCode =
    normalizeText(
      currentLocation.stationCode ||
      currentLocation.code ||
      liveData?.stationCode
    );

  const stationName =
    normalizeText(
      currentLocation.stationName ||
      currentLocation.name ||
      liveData?.stationName
    );

  if (
    stationCode === "GDR"
  ) {
    return true;
  }

  if (
    stationName.includes("GUDUR")
  ) {
    return true;
  }

  const gudurDistance =
    getDistanceToGudur(
      coordinates
    );

  if (
    gudurDistance !== null &&
    gudurDistance <= 0.20
  ) {
    return true;
  }

  return false;
}

// ============================================================
// PREVIOUS GUDUR DEPARTURE DETECTION
// ============================================================

function hasDepartedGudur(
  liveData
) {
  const previousHalt =
    liveData?.previousHalt;

  const currentLocation =
    liveData?.currentLocation;

  if (
    !previousHalt ||
    !currentLocation
  ) {
    return false;
  }

  const previousStation =
    normalizeText(
      previousHalt.stationCode ||
      previousHalt.code
    );

  if (
    previousStation !== "GDR"
  ) {
    return false;
  }

  const previousSequence =
    toNumber(
      previousHalt.sequence
    );

  const currentSequence =
    toNumber(
      currentLocation.sequence
    );

  if (
    previousSequence !== null &&
    currentSequence !== null &&
    currentSequence >
      previousSequence
  ) {
    return true;
  }

  return false;
}

// ============================================================
// DATE / TIME PARSER
// ============================================================

function parseRailRadarDate(
  value,
  now = new Date()
) {
  if (!value) {
    return null;
  }

  // Already Date
  if (value instanceof Date) {
    if (!isNaN(value.getTime())) {
      return value;
    }

    return null;
  }

  const text =
    String(value).trim();

  if (!text) {
    return null;
  }

  // ----------------------------------------------------------
  // HH:MM
  // ----------------------------------------------------------

  const timeMatch =
    text.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (timeMatch) {
    const hours =
      Number(timeMatch[1]);

    const minutes =
      Number(timeMatch[2]);

    if (
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      return null;
    }

    const date =
      new Date(now);

    date.setHours(
      hours,
      minutes,
      0,
      0
    );

    // If time appears far behind current time,
    // assume it belongs to tomorrow.
    const difference =
      date.getTime() -
      now.getTime();

    if (
      difference <
      -12 * 60 * 60 * 1000
    ) {
      date.setDate(
        date.getDate() + 1
      );
    }

    return date;
  }

  // ----------------------------------------------------------
  // ISO / NORMAL DATE
  // ----------------------------------------------------------

  const parsed =
    new Date(text);

  if (
    !isNaN(parsed.getTime())
  ) {
    return parsed;
  }

  return null;
}

// ============================================================
// ETA FROM ARRIVAL TIME
// ============================================================

function calculateEtaFromArrival(
  arrivalValue,
  now = new Date()
) {
  const arrival =
    parseRailRadarDate(
      arrivalValue,
      now
    );

  if (!arrival) {
    return null;
  }

  const diffMs =
    arrival.getTime() -
    now.getTime();

  const diffMinutes =
    Math.round(
      diffMs / 60000
    );

  // ----------------------------------------------------------
  // Allow trains:
  // 0 -> 240 minutes
  // ----------------------------------------------------------

  if (
    diffMinutes >= 0 &&
    diffMinutes <=
      UPCOMING_WINDOW_MINUTES
  ) {
    return diffMinutes;
  }

  return null;
}

// ============================================================
// LIVE EXPECTED ARRIVAL
// ============================================================

function getLiveExpectedArrival(
  liveData
) {
  return (
    liveData?.expectedArrivalTime ||
    liveData?.expectedArrival ||

    liveData?.currentLocation
      ?.expectedArrivalTime ||

    liveData?.currentLocation
      ?.expectedArrival ||

    liveData?.nextHalt
      ?.expectedArrivalTime ||

    liveData?.nextHalt
      ?.expectedArrival ||

    null
  );
}

// ============================================================
// BOARD ARRIVAL
// ============================================================

function getBoardArrivalTime(
  item
) {
  return (
    item?.live?.expectedArrivalTime ||
    item?.live?.expectedArrival ||

    item?.stop?.expectedArrivalTime ||
    item?.stop?.expectedArrival ||

    item?.stop?.arrival ||

    item?.expectedArrivalTime ||
    item?.expectedArrival ||

    item?.arrivalTime ||
    item?.arrival ||

    null
  );
}

// ============================================================
// SPEED ETA
// ============================================================

function calculateSpeedEta(
  liveData,
  coordinates,
  now = new Date()
) {
  if (!liveData) {
    return null;
  }

  const speed =
    toNumber(
      liveData?.currentLocation
        ?.speedKmh ??
      liveData?.speedKmh
    );

  if (
    speed === null ||
    speed <= 0
  ) {
    return null;
  }

  const distance =
    getDistanceToGudur(
      coordinates
    );

  if (
    distance === null
  ) {
    return null;
  }

  // Do not use speed ETA if train is already
  // effectively at Gudur.
  if (
    distance <= 0.20
  ) {
    return 0;
  }

  const hours =
    distance / speed;

  const minutes =
    Math.round(
      hours * 60
    );

  if (
    minutes >= 0 &&
    minutes <=
      UPCOMING_WINDOW_MINUTES
  ) {
    return minutes;
  }

  return null;
}

// ============================================================
// VERIFIED ETA
// ============================================================
//
// Priority:
//
// 1. At Gudur = 0
// 2. Departed Gudur = null
// 3. Live expected arrival
// 4. Station-board expected arrival
// 5. GPS speed fallback
//
// OTHER trains are not allowed to control gates,
// but can still be displayed if ETA is available.
//

function getVerifiedEta(
  train,
  item,
  liveData,
  coordinates,
  now
) {
  const corridor =
    train.corridor;

  const atGudur =
    isAtGudur(
      liveData,
      coordinates
    );

  if (atGudur) {
    return 0;
  }

  if (
    hasDepartedGudur(
      liveData
    )
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // LIVE ETA
  // ----------------------------------------------------------

  const liveEta =
    calculateEtaFromArrival(
      getLiveExpectedArrival(
        liveData
      ),
      now
    );

  if (
    liveEta !== null
  ) {
    return liveEta;
  }

  // ----------------------------------------------------------
  // BOARD ETA
  // ----------------------------------------------------------

  const boardEta =
    calculateEtaFromArrival(
      getBoardArrivalTime(
        item
      ),
      now
    );

  if (
    boardEta !== null
  ) {
    return boardEta;
  }

  // ----------------------------------------------------------
  // GPS SPEED FALLBACK
  // ----------------------------------------------------------

  const speedEta =
    calculateSpeedEta(
      liveData,
      coordinates,
      now
    );

  if (
    speedEta !== null
  ) {
    return speedEta;
  }

  return null;
}

// ============================================================
// TRAIN ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    train?.origin ||
    train?.source ||
    train?.from ||
    train?.fromStation ||
    train?.startStation ||
    train?.start ||

    item?.origin ||
    item?.source ||
    item?.from ||
    item?.fromStation ||
    item?.startStation ||

    ""
  );
}

// ============================================================
// TRAIN DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  return (
    train?.destination ||
    train?.to ||
    train?.destinationStation ||
    train?.endStation ||

    item?.destination ||
    item?.to ||
    item?.destinationStation ||

    ""
  );
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  train,
  item,
  trainNo
) {
  return (
    train?.name ||
    train?.trainName ||
    item?.name ||
    `Train ${trainNo}`
  );
}

// ============================================================
// LIVE DATA EXTRACTION
// ============================================================

function getEmbeddedLive(
  item
) {
  const candidates = [
    item?.live,
    item?.train?.live,
    item?.live?.data,
    item?.train?.live?.data
  ];

  for (
    const candidate of candidates
  ) {
    if (!candidate) {
      continue;
    }

    const coordinates =
      getCoordinates(
        candidate
      );

    if (coordinates) {
      return candidate;
    }

    // Even without coordinates,
    // live data can contain useful ETA.
    if (
      candidate.expectedArrivalTime ||
      candidate.expectedArrival ||
      candidate.currentLocation
    ) {
      return candidate;
    }
  }

  return null;
}

// ============================================================
// RAILRADAR LIVE TRAIN REQUEST
// ============================================================
//
// IMPORTANT:
// Every workflow run requests fresh authoritative live data.
//
// There is NO 20-minute throttle anymore.
//
// This is the important fix for the Chennai gate issue.
//

async function fetchLiveTrain(
  trainNo
) {
  console.log(
    `[LIVE REQUEST] ${trainNo}`
  );

  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${trainNo}/live`,
        {
          params: {
            authoritative: "true",
            includeCoordinates: "true"
          },

          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          timeout: 12000
        }
      );

    const data =
      response.data?.data ||
      response.data;

    const coordinates =
      getCoordinates(
        data
      );

    if (coordinates) {
      console.log(
        `[LIVE RESULT] ${trainNo} | GPS DATA RECEIVED`
      );
    } else {
      console.log(
        `[LIVE RESULT] ${trainNo} | NO GPS DATA`
      );
    }

    return data;

  } catch (error) {
    if (error.response) {
      console.error(
        `[LIVE ERROR] ${trainNo} | HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo} | ${error.message}`
      );
    }

    return null;
  }
}

// ============================================================
// STATION BOARD REQUEST
// ============================================================
//
// includeIntermediate=true is preserved from V8.
//
// This is useful because the board can contain trains that
// are approaching GDR but are not the immediate station stop.
//

async function fetchStationBoard() {
  console.log(
    "\n[BOARD REQUEST] GDR live station board"
  );

  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live`,
      {
        params: {
          hours: 4,
          includeIntermediate: true
        },

        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,

          Accept:
            "application/json"
        },

        timeout: 12000
      }
    );

  return (
    response.data?.data?.trains ||
    response.data?.trains ||
    []
  );
}

// ============================================================
// DEDUPLICATE BOARD
// ============================================================
//
// Keep only one entry per train number.
//
// Priority:
// AT STATION
// UPCOMING
// SCHEDULED
// DEPARTED
//

function getStatusPriority(
  item
) {
  const status =
    normalizeText(
      item?.live?.status ||
      item?.status ||
      item?.stop?.status
    );

  if (
    status.includes("AT STATION") ||
    status.includes("ARRIVED")
  ) {
    return 4;
  }

  if (
    status.includes("UPCOMING") ||
    status.includes("APPROACH")
  ) {
    return 3;
  }

  if (
    status.includes("SCHEDULED")
  ) {
    return 2;
  }

  if (
    status.includes("DEPARTED")
  ) {
    return 1;
  }

  return 0;
}

function deduplicateBoard(
  trains
) {
  const map =
    new Map();

  for (
    const item of trains
  ) {
    const train =
      item?.train || {};

    const trainNo =
      String(
        train?.number ||
        item?.trainNumber ||
        item?.number ||
        ""
      ).trim();

    if (!trainNo) {
      continue;
    }

    const existing =
      map.get(trainNo);

    if (!existing) {
      map.set(
        trainNo,
        item
      );

      continue;
    }

    if (
      getStatusPriority(item) >
      getStatusPriority(existing)
    ) {
      map.set(
        trainNo,
        item
      );
    }
  }

  return Array.from(
    map.values()
  );
}

// ============================================================
// APPLY LIVE DATA
// ============================================================

function applyLiveData(
  train,
  item,
  liveData,
  now
) {
  train.hasLiveData =
    !!liveData;

  if (!liveData) {
    train.gateWarning = false;
    train.gateClosed = false;
    train.hasPhysicalPosition = false;

    return;
  }

  const coordinates =
    getCoordinates(
      liveData
    );

  train.coordinates =
    coordinates || null;

  train.hasPhysicalPosition =
    !!coordinates;

  const atGudur =
    isAtGudur(
      liveData,
      coordinates
    );

  const departedGudur =
    hasDepartedGudur(
      liveData
    );

  train.atGDR =
    atGudur;

  train.departedGudur =
    departedGudur;

  train.distanceToGudurKm =
    getDistanceToGudur(
      coordinates
    );

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  train.etaMinutes =
    getVerifiedEta(
      train,
      item,
      liveData,
      coordinates,
      now
    );

  // ----------------------------------------------------------
  // Gate distance
  // ----------------------------------------------------------

  const gateDistance =
    getDistanceToGate(
      coordinates,
      train.corridor
    );

  train.gateDistanceKm =
    gateDistance;

  // ----------------------------------------------------------
  // Default gate values
  // ----------------------------------------------------------

  train.gateWarning =
    false;

  train.gateClosed =
    false;

  // ----------------------------------------------------------
  // OTHER trains can never control gates.
  // ----------------------------------------------------------

  if (
    train.corridor === "OTHER"
  ) {
    return;
  }

  // ----------------------------------------------------------
  // No GPS = no gate control.
  // ----------------------------------------------------------

  if (
    !coordinates
  ) {
    return;
  }

  // ----------------------------------------------------------
  // At Gudur = clear.
  //
  // This prevents a train that has already reached
  // the station from closing a gate.
  // ----------------------------------------------------------

  if (
    atGudur
  ) {
    return;
  }

  if (
    gateDistance === null
  ) {
    return;
  }

  // ----------------------------------------------------------
  // Farther than warning distance:
  // no gate action.
  // ----------------------------------------------------------

  if (
    gateDistance >
    GATE_WARNING_DISTANCE_KM
  ) {
    return;
  }

  // ----------------------------------------------------------
  // WARNING
  //
  // 0.60 < distance <= 1.00
  // ----------------------------------------------------------

  if (
    gateDistance <=
      GATE_WARNING_DISTANCE_KM &&
    gateDistance >
      GATE_CLOSE_DISTANCE_KM
  ) {
    train.gateWarning =
      true;

    train.gateClosed =
      false;

    return;
  }

  // ----------------------------------------------------------
  // CLOSED
  //
  // distance <= 0.60 km
  //
  // IMPORTANT:
  // No ETA condition here.
  // No departedGudur condition here.
  // GPS position is the deciding factor.
  // ----------------------------------------------------------

  if (
    gateDistance <=
    GATE_CLOSE_DISTANCE_KM
  ) {
    train.gateWarning =
      false;

    train.gateClosed =
      true;

    return;
  }
}

// ============================================================
// BUILD UPCOMING TRAIN OBJECT
// ============================================================

function createTrainRecord(
  item,
  liveData,
  now
) {
  const train =
    item?.train || {};

  const trainNo =
    String(
      train?.number ||
      item?.trainNumber ||
      item?.number ||
      ""
    ).trim();

  if (!trainNo) {
    return null;
  }

  const corridor =
    determineCorridor(
      trainNo
    );

  if (!corridor) {
    console.log(
      `[IGNORED UNKNOWN] ${trainNo}`
    );

    return null;
  }

  const trainName =
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

  const delayMinutes =
    toNumber(
      liveData?.delayMinutes ??
      item?.live?.delayMinutes ??
      item?.delayMinutes ??
      train?.delayMinutes
    ) || 0;

  const record = {
    trainNo,
    name: trainName,

    origin:
      origin ||
      "Unknown",

    destination:
      destination ||
      "Gudur",

    corridor,

    direction:
      "TOWARD GUDUR",

    etaMinutes:
      null,

    delayMinutes,

    platform:
      String(
        liveData?.platform ||
        item?.live?.platform ||
        item?.platform ||
        "1"
      ),

    hasLiveData:
      false,

    hasPhysicalPosition:
      false,

    atGDR:
      false,

    departedGudur:
      false,

    distanceToGudurKm:
      null,

    gateDistanceKm:
      null,

    gateWarning:
      false,

    gateClosed:
      false
  };

  applyLiveData(
    record,
    item,
    liveData,
    now
  );

  return record;
}

// ============================================================
// SELECT LIVE REQUESTS
// ============================================================
//
// We prioritize MAS/TPTY because only those corridors can
// control the gates.
//
// We also sort by board ETA when available.
//
// Maximum 8 live requests per workflow run.
//

function selectLiveTrainNumbers(
  boardItems
) {
  const candidates = [];

  for (
    const item of boardItems
  ) {
    const train =
      item?.train || {};

    const trainNo =
      String(
        train?.number ||
        item?.trainNumber ||
        item?.number ||
        ""
      ).trim();

    if (!trainNo) {
      continue;
    }

    const corridor =
      determineCorridor(
        trainNo
      );

    if (
      corridor !== "MAS" &&
      corridor !== "TPTY"
    ) {
      continue;
    }

    const boardEta =
      calculateEtaFromArrival(
        getBoardArrivalTime(item)
      );

    candidates.push({
      trainNo,
      boardEta:
        boardEta === null
          ? 9999
          : boardEta
    });
  }

  candidates.sort(
    (a, b) =>
      a.boardEta -
      b.boardEta
  );

  const unique =
    [];

  const seen =
    new Set();

  for (
    const candidate of candidates
  ) {
    if (
      seen.has(
        candidate.trainNo
      )
    ) {
      continue;
    }

    seen.add(
      candidate.trainNo
    );

    unique.push(
      candidate.trainNo
    );

    if (
      unique.length >=
      MAX_LIVE_REQUESTS
    ) {
      break;
    }
  }

  return unique;
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  const now =
    new Date();

  console.log(
    "\n=========================================="
  );

  console.log(
    `[${now.toLocaleTimeString()}] GUDUR GATE MONITOR`
  );

  console.log(
    "=========================================="
  );

  try {
    // ========================================================
    // FETCH BOARD
    // ========================================================

    const rawBoard =
      await fetchStationBoard();

    if (
      !Array.isArray(rawBoard)
    ) {
      throw new Error(
        "RailRadar station board returned invalid data."
      );
    }

    console.log(
      `Raw board trains: ${rawBoard.length}`
    );

    // ========================================================
    // DEDUPLICATE
    // ========================================================

    const board =
      deduplicateBoard(
        rawBoard
      );

    console.log(
      `Unique board trains: ${board.length}`
    );

    // ========================================================
    // SELECT FRESH LIVE REQUESTS
    // ========================================================

    const liveTrainNumbers =
      selectLiveTrainNumbers(
        board
      );

    console.log(
      `Fresh live GPS requests: ${liveTrainNumbers.length}`
    );

    if (
      liveTrainNumbers.length > 0
    ) {
      console.log(
        `Live priority: ${liveTrainNumbers.join(", ")}`
      );
    }

    // ========================================================
    // FETCH LIVE DATA
    // ========================================================

    const liveMap =
      new Map();

    for (
      const trainNo of
      liveTrainNumbers
    ) {
      const liveData =
        await fetchLiveTrain(
          trainNo
        );

      if (liveData) {
        liveMap.set(
          trainNo,
          liveData
        );
      }
    }

    // ========================================================
    // PROCESS TRAINS
    // ========================================================

    const processed =
      [];

    for (
      const item of board
    ) {
      const train =
        item?.train || {};

      const trainNo =
        String(
          train?.number ||
          item?.trainNumber ||
          item?.number ||
          ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const corridor =
        determineCorridor(
          trainNo
        );

      if (!corridor) {
        console.log(
          `[IGNORED UNKNOWN] ${trainNo}`
        );

        continue;
      }

      // ------------------------------------------------------
      // Use fresh live data if available.
      //
      // Embedded live data is only fallback.
      // ------------------------------------------------------

      const liveData =
        liveMap.get(
          trainNo
        ) ||
        getEmbeddedLive(
          item
        );

      const record =
        createTrainRecord(
          item,
          liveData,
          now
        );

      if (!record) {
        continue;
      }

      processed.push(
        record
      );

      const etaText =
        record.etaMinutes === null
          ? "--"
          : `${record.etaMinutes}m`;

      const gateText =
        record.gateDistanceKm === null
          ? "--"
          : `${record.gateDistanceKm.toFixed(3)}km`;

      console.log(
        `[TRAIN] ${record.trainNo} | ${record.name} | ${record.corridor} | ETA=${etaText} | gateDistance=${gateText} | warning=${record.gateWarning} | closed=${record.gateClosed} | atGDR=${record.atGDR} | departed=${record.departedGudur}`
      );
    }

    // ========================================================
    // GATE DEFAULTS
    // ========================================================

    let chennaiGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "MAS"
    };

    let tirupatiGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "TPTY"
    };

    // ========================================================
    // DETERMINE GATE STATES
    // ========================================================

    for (
      const train of
      processed
    ) {
      if (
        !train.gateClosed
      ) {
        continue;
      }

      const distance =
        train.gateDistanceKm;

      let waitMinutes =
        2;

      // ------------------------------------------------------
      // Estimate remaining gate wait.
      //
      // This is only for the UI wait counter.
      // It does NOT decide whether the gate closes.
      // ------------------------------------------------------

      if (
        train.etaMinutes !== null
      ) {
        waitMinutes =
          Math.max(
            1,
            Math.min(
              10,
              Math.round(
                train.etaMinutes
              ) + 2
            )
          );
      }

      const payload = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          `${train.trainNo} ${train.name}`,

        direction:
          "TOWARD GUDUR",

        corridor:
          train.corridor,

        trainNo:
          train.trainNo,

        gateDistanceKm:
          Number(
            distance.toFixed(3)
          ),

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM
      };

      if (
        train.corridor ===
        "MAS"
      ) {
        chennaiGate =
          payload;
      }

      if (
        train.corridor ===
        "TPTY"
      ) {
        tirupatiGate =
          payload;
      }
    }

    // ========================================================
    // WARNING STATE
    // ========================================================
    //
    // WARNING does NOT close the barrier.
    //
    // It is useful for frontend amber warning.
    //

    for (
      const train of
      processed
    ) {
      if (
        !train.gateWarning ||
        train.gateClosed
      ) {
        continue;
      }

      const payload = {
        status:
          "WARNING",

        waitMinutes:
          train.etaMinutes !== null
            ? Math.max(
                1,
                Math.min(
                  10,
                  Math.round(
                    train.etaMinutes
                  ) + 1
                )
              )
            : 2,

        activeTrain:
          `${train.trainNo} ${train.name}`,

        direction:
          "TOWARD GUDUR",

        corridor:
          train.corridor,

        trainNo:
          train.trainNo,

        gateDistanceKm:
          Number(
            train.gateDistanceKm.toFixed(
              3
            )
          ),

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM
      };

      // ------------------------------------------------------
      // Do not replace CLOSED with WARNING.
      // ------------------------------------------------------

      if (
        train.corridor ===
        "MAS" &&
        chennaiGate.status !==
          "CLOSED"
      ) {
        chennaiGate =
          payload;
      }

      if (
        train.corridor ===
        "TPTY" &&
        tirupatiGate.status !==
          "CLOSED"
      ) {
        tirupatiGate =
          payload;
      }
    }

    // ========================================================
    // UPCOMING TRAINS
    // ========================================================
    //
    // Show approved trains with ETA.
    //
    // OTHER trains may appear here but NEVER control a gate.
    //
    // Unknown trains are never shown.
    //

    const upcoming =
      processed
        .filter(
          (train) =>
            train.etaMinutes !==
              null &&
            train.etaMinutes >= 0 &&
            train.etaMinutes <=
              UPCOMING_WINDOW_MINUTES
        )
        .sort(
          (a, b) =>
            a.etaMinutes -
            b.etaMinutes
        )
        .slice(
          0,
          UPCOMING_LIMIT
        );

    // ========================================================
    // FIREBASE UPCOMING OBJECT
    // ========================================================
    //
    // IMPORTANT:
    // Do NOT write [] here.
    //
    // Firebase RTDB can remove an empty array child.
    //
    // Object form keeps the field present:
    //
    // upcomingTrains: {}
    //
    // Frontend can use Object.values().
    //

    const upcomingObject =
      {};

    upcoming.forEach(
      (train, index) => {
        upcomingObject[
          String(index)
        ] = train;
      }
    );

    // ========================================================
    // FIREBASE PAYLOAD
    // ========================================================

    const payload = {
      chennaiGate,

      tirupatiGate,

      upcomingTrains:
        upcomingObject,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedLocal:
        now.toLocaleString(),

      lastUpdatedAt:
        now.toISOString(),

      meta: {
        version:
          "V10",

        source:
          "RailRadar",

        station:
          "GDR",

        gateLogic:
          "GPS_ONLY",

        direction:
          "TOWARD_GUDUR_ONLY",

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        clearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        freshLiveEveryRun:
          true,

        authoritativeLive:
          true,

        includeCoordinates:
          true,

        includeIntermediate:
          true,

        liveRequests:
          liveTrainNumbers.length,

        processedTrains:
          processed.length,

        upcomingCount:
          upcoming.length
      }
    };

    // ========================================================
    // LOG FIREBASE DATA
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "FIREBASE WRITE"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Upcoming trains: ${upcoming.length}`
    );

    console.log(
      `Chennai Gate: ${chennaiGate.status}`
    );

    console.log(
      `Tirupati Gate: ${tirupatiGate.status}`
    );

    // ========================================================
    // WRITE FIREBASE
    // ========================================================

    await gateRef.set(
      payload
    );

    console.log(
      "✅ Firebase write completed."
    );

    // ========================================================
    // FIREBASE VERIFICATION
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "FIREBASE VERIFICATION"
    );

    console.log(
      "=========================================="
    );

    const verifySnapshot =
      await gateRef.once(
        "value"
      );

    const verified =
      verifySnapshot.val();

    if (!verified) {
      throw new Error(
        "Firebase verification returned empty data."
      );
    }

    if (
      !verified.chennaiGate
    ) {
      throw new Error(
        "Firebase verification failed: chennaiGate missing."
      );
    }

    if (
      !verified.tirupatiGate
    ) {
      throw new Error(
        "Firebase verification failed: tirupatiGate missing."
      );
    }

    if (
      verified.upcomingTrains ===
      undefined ||
      verified.upcomingTrains ===
      null
    ) {
      throw new Error(
        "Firebase verification failed: upcomingTrains missing."
      );
    }

    console.log(
      "✅ chennaiGate verified."
    );

    console.log(
      "✅ tirupatiGate verified."
    );

    console.log(
      "✅ upcomingTrains verified."
    );

    console.log(
      `Verified upcoming count: ${Object.keys(
        verified.upcomingTrains
      ).length}`
    );

    console.log(
      "\n=========================================="
    );

    console.log(
      "SYNC SUCCESS"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Chennai Gate : ${verified.chennaiGate.status}`
    );

    console.log(
      `Tirupati Gate: ${verified.tirupatiGate.status}`
    );

    console.log(
      `Upcoming     : ${Object.keys(
        verified.upcomingTrains
      ).length}`
    );

    console.log(
      `Live requests: ${liveTrainNumbers.length}`
    );

    console.log(
      "==========================================\n"
    );

  } catch (error) {
    console.error(
      "\n=========================================="
    );

    console.error(
      "❌ MONITOR RUN FAILED"
    );

    console.error(
      "=========================================="
    );

    console.error(
      error.message
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
    }

    console.error(
      "==========================================\n"
    );

    throw error;

  } finally {
    // ========================================================
    // CLEAN FIREBASE SHUTDOWN
    // ========================================================

    try {
      await admin.app().delete();

      console.log(
        "Firebase connection closed."
      );
    } catch (closeError) {
      console.error(
        "Firebase shutdown warning:",
        closeError.message
      );
    }
  }
}

// ============================================================
// START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor V10 "
);

console.log(
  "=========================================="
);

console.log(
  "Gudur:"
);

console.log(
  "  14.1451694 N, 79.8443472 E"
);

console.log(
  "Chennai Gate:"
);

console.log(
  "  14.1396667 N, 79.8441278 E"
);

console.log(
  "Tirupati Gate:"
);

console.log(
  "  14.1402028 N, 79.8435972 E"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Gate warning distance : 1.00 km"
);

console.log(
  "Gate close distance   : 0.60 km"
);

console.log(
  "Gate clear distance   : 0.80 km"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Direction:"
);

console.log(
  "  Chennai/Tirupati -> Gudur ONLY"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Live GPS:"
);

console.log(
  "  Fresh every workflow run"
);

console.log(
  "  authoritative=true"
);

console.log(
  "  includeCoordinates=true"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Firebase:"
);

console.log(
  "  Configured"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem()
  .then(() => {
    console.log(
      "Monitor finished successfully."
    );

    process.exit(0);
  })
  .catch(() => {
    console.error(
      "Monitor finished with errors."
    );

    process.exit(1);
  });
