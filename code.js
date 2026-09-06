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

// Gudur Junction
const GDR_LAT = 14.1451694;
const GDR_LNG = 79.8443472;

// Tirupati / Gudur Gate
const TIRUPATI_GATE_LAT = 14.1402028;
const TIRUPATI_GATE_LNG = 79.8435972;

// Chennai Gate
const CHENNAI_GATE_LAT = 14.1396667;
const CHENNAI_GATE_LNG = 79.8441278;

// ============================================================
// DISTANCE RULES
// ============================================================

// Start tracking a train when it reaches 1 km
// from the relevant Gudur area.
const TRACKING_DISTANCE_KM = 1.00;

// Physical distance from Gudur Junction to gate.
const GATE_DISTANCE_KM = 0.52;

// Close gate when train is approximately within this
// distance of the gate.
const GATE_CLOSE_DISTANCE_KM = 0.60;

// Consider train clear after it has moved beyond this
// distance from the gate.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Upcoming display limit.
const UPCOMING_MAX_ETA_MINUTES = 360;

// Maximum trains shown in Firebase.
const UPCOMING_DISPLAY_LIMIT = 15;

// Live calls per GitHub Actions run.
// Keep this low because the free RailRadar sandbox
// has a limited monthly request allowance.
const MAX_LIVE_CALLS = 1;

// Tracking record retention.
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
// GENERIC FIELD HELPERS
// ============================================================

function getTrainNumber(train, item) {
  return String(
    train?.number ||
    train?.trainNumber ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}

function getTrainName(train, item, trainNo) {
  return (
    train?.name ||
    train?.trainName ||
    item?.trainName ||
    `Express ${trainNo}`
  );
}

function getStationCode(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim().toUpperCase();
  }

  return String(
    value.code ||
    value.stationCode ||
    ""
  ).trim().toUpperCase();
}

function getStationName(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return (
    value.name ||
    value.stationName ||
    ""
  );
}

// ============================================================
// ORIGIN / DESTINATION
// ============================================================

function getOrigin(train, item) {
  const source =
    train?.source ||
    item?.source;

  if (source) {
    return (
      source.name ||
      source.code ||
      source.stationName ||
      source.stationCode ||
      ""
    );
  }

  return (
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
    item?.from ||
    ""
  );
}

function getDestination(train, item) {
  const destination =
    train?.destination ||
    item?.destination;

  if (destination) {
    return (
      destination.name ||
      destination.code ||
      destination.stationName ||
      destination.stationCode ||
      ""
    );
  }

  return (
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
    item?.to ||
    ""
  );
}

// ============================================================
// COORDINATE HELPERS
// ============================================================

function getCoordinates(location) {
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
      lat: Number(coordinates.lat),
      lng: Number(coordinates.lng)
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
      lat: Number(location.lat),
      lng: Number(location.lng)
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
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function distanceFromGudur(coords) {
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
  if (!coords) {
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
    lat: CHENNAI_GATE_LAT,
    lng: CHENNAI_GATE_LNG
  },

  TPTY: {
    name: "Tirupati Gate",
    lat: TIRUPATI_GATE_LAT,
    lng: TIRUPATI_GATE_LNG
  }
};

// ============================================================
// CORRIDOR DETECTION
// ============================================================
//
// IMPORTANT:
//
// We do NOT classify a train only from destination.
//
// For example:
//
// 12616 NDLS -> MAS
//
// does NOT mean it is using the Tirupati gate.
//
// We prefer:
//
// 1. explicit source/origin
// 2. current/previous/next route information
// 3. known train corridor
//
// Unknown direction = ignore for gate control.
//
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
    Array.isArray(live?.route)
      ? live.route
      : [];

  for (const station of route) {
    const code =
      getStationCode(station);

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
  // First preference: explicit origin
  // ----------------------------------------------------------

  if (
    isTirupatiSideOrigin(origin)
  ) {
    return "TPTY";
  }

  if (
    isChennaiSideOrigin(origin)
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Previous / next halt clues
  // ----------------------------------------------------------

  const previousCode =
    getStationCode(
      live?.previousHalt
    );

  const nextCode =
    getStationCode(
      live?.nextHalt
    );

  // A train approaching GDR from the
  // Tirupati / west side.
  if (
    [
      "RU",
      "TPTY",
      "KPD",
      "KPDJ",
      "WJR"
    ].includes(previousCode)
  ) {
    return "TPTY";
  }

  // A train approaching GDR from the
  // Chennai / south side.
  if (
    [
      "SPE",
      "NYP",
      "AKM",
      "AJJ",
      "MAS",
      "MS"
    ].includes(previousCode)
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Known Tirupati corridor trains
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Route station-code clues
  // ----------------------------------------------------------

  const routeCodes =
    getRouteStationCodes(
      live
    );

  if (
    routeCodes.includes("TPTY") &&
    routeCodes.includes("GDR")
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// RAILRADAR LIVE STATUS
// ============================================================

function getLiveStatus(live) {
  return normalizeText(
    live?.status ||
    ""
  );
}

function isActualPosition(live) {
  return (
    live?.isActualPosition === true
  );
}

function getLiveSequence(live) {
  const sequence =
    Number(
      live?.sequence
    );

  return Number.isFinite(sequence)
    ? sequence
    : null;
}

function getPreviousSequence(live) {
  const sequence =
    Number(
      live?.previousHalt?.sequence
    );

  return Number.isFinite(sequence)
    ? sequence
    : null;
}

function getCurrentStationCode(live) {
  return getStationCode(
    live?.stationCode ||
    live?.station
  );
}

// ============================================================
// DETECT TRAIN AFTER GUDUR
// ============================================================
//
// This is the important fix for 12616.
//
// Example:
//
// previousHalt = GDR
// previousHalt.sequence = 278
// current sequence = 284
//
// Therefore the train has already left Gudur.
//
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

  // ----------------------------------------------------------
  // Strongest signal:
  // previous halt is Gudur and train
  // has moved to a later sequence.
  // ----------------------------------------------------------

  if (
    previousCode === "GDR" &&
    currentSequence !== null &&
    previousSequence !== null &&
    currentSequence >
      previousSequence
  ) {
    return true;
  }

  // If current station itself is after GDR
  // and previous halt was GDR.
  if (
    previousCode === "GDR" &&
    currentCode !== "GDR"
  ) {
    return true;
  }

  return false;
}

// ============================================================
// TRAIN AT GUDUR STATION
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
    currentCode === "GDR"
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
    previousCode === "GDR" &&
    getLiveStatus(live).includes(
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
    getLiveStatus(live);

  if (
    status.includes("RUNNING") ||
    status.includes("MOVING") ||
    status.includes("DEPARTED")
  ) {
    return true;
  }

  const speed =
    Number(
      live?.speedKmh
    );

  if (
    Number.isFinite(speed) &&
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
      date.getHours() * 60 +
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
// STATION BOARD ETA
// ============================================================

function getBoardEta(
  train,
  item,
  live,
  stop
) {
  const delay =
    Number(
      live?.delayMinutes ||
      item?.delayMinutes ||
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
    now.getHours() * 60 +
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
// LIVE TRAIN FETCH
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
            authoritative: "true",
            haltsOnly: "false",
            geometry: "true",
            format: "geojson",
            includeCoordinates: "true"
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
    if (error.response) {
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
// TRACKING RECORD HELPERS
// ============================================================

function createTrackingRecord(
  train,
  item,
  live,
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

  const coords =
    getCoordinates(
      live?.currentLocation ||
      live
    );

  const currentStation =
    getCurrentStationCode(
      live?.currentLocation ||
      live
    );

  const sequence =
    getLiveSequence(
      live?.currentLocation ||
      live
    );

  const previousHaltCode =
    getStationCode(
      live?.currentLocation?.previousHalt ||
      live?.previousHalt
    );

  const previousHaltSequence =
    Number(
      live?.currentLocation?.previousHalt?.sequence ||
      live?.previousHalt?.sequence
    );

  const record = {
    trainNo,
    name,

    origin:
      origin ||
      "Unknown",

    destination:
      destination ||
      "Gudur",

    corridor,

    direction:
      "TOWARD GUDUR",

    state:
      "APPROACHING_GUDUR",

    boardEta:
      boardEta,

    etaMinutes:
      boardEta,

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

    previousHaltSequence:
      Number.isFinite(
        previousHaltSequence
      )
        ? previousHaltSequence
        : null,

    actualPosition:
      isActualPosition(
        live?.currentLocation ||
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
      Number.isFinite(
        Number(
          live?.currentLocation?.speedKmh
        )
      )
        ? Number(
            live.currentLocation.speedKmh
          )
        : null
  };

  return record;
}

// ============================================================
// UPDATE TRACKING STATE FROM LIVE DATA
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

  record.previousHaltSequence =
    previousSequence !== null
      ? previousSequence
      : record.previousHaltSequence;

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
  }

  const speed =
    Number(
      live?.speedKmh
    );

  if (
    Number.isFinite(speed)
  ) {
    record.speedKmh =
      speed;
  }

  record.lastUpdated =
    new Date().toISOString();

  // ----------------------------------------------------------
  // TRAIN IS CURRENTLY AT GUDUR PLATFORM
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
  // TRAIN HAS LEFT GUDUR
  // ----------------------------------------------------------

  if (
    hasPassedGudur(
      live
    )
  ) {
    record.state =
      "DEPARTED_GUDUR";

    return record;
  }

  // ----------------------------------------------------------
  // TRAIN APPROACHING GUDUR
  // ----------------------------------------------------------

  record.state =
    "APPROACHING_GUDUR";

  return record;
}

// ============================================================
// DETERMINE GATE FROM TRACKING RECORD
// ============================================================

function getGateForCorridor(
  corridor
) {
  if (
    corridor === "MAS"
  ) {
    return GATES.MAS;
  }

  if (
    corridor === "TPTY"
  ) {
    return GATES.TPTY;
  }

  return null;
}

// ============================================================
// UPDATE GATE STATE FROM TRAIN POSITION
// ============================================================

function evaluateGateForTrain(
  record
) {
  const gate =
    getGateForCorridor(
      record.corridor
    );

  if (!gate) {
    return {
      close: false,
      clear: false,
      distance: null
    };
  }

  if (
    !record.coordinates
  ) {
    return {
      close: false,
      clear: false,
      distance: null
    };
  }

  const distance =
    distanceFromGate(
      record.coordinates,
      gate
    );

  // ----------------------------------------------------------
  // Train is at Gudur station.
  //
  // NEVER close gate merely because train is
  // at the platform.
  // ----------------------------------------------------------

  if (
    record.state ===
    "AT_GUDUR_STATION"
  ) {
    return {
      close: false,
      clear: false,
      distance
    };
  }

  // ----------------------------------------------------------
  // Gate closure.
  //
  // Once train is approaching/departing and
  // physically reaches the gate zone.
  // ----------------------------------------------------------

  if (
    distance <=
    GATE_CLOSE_DISTANCE_KM
  ) {
    return {
      close: true,
      clear: false,
      distance
    };
  }

  // ----------------------------------------------------------
  // Train has moved beyond gate.
  // ----------------------------------------------------------

  if (
    distance >=
    GATE_CLEAR_DISTANCE_KM
  ) {
    return {
      close: false,
      clear: true,
      distance
    };
  }

  return {
    close: false,
    clear: false,
    distance
  };
}

// ============================================================
// MAIN FUNCTION
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
    // LOAD EXISTING TRACKING STATE
    // ========================================================

    const trackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const existingTracking =
      trackingSnapshot.val() ||
      {};

    // ========================================================
    // RAILRADAR STATION BOARD
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

      console.error(
        JSON.stringify(
          responseBody,
          null,
          2
        )
      );

      return;
    }

    console.log(
      `\nRailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // TRACKING OBJECT
    // ========================================================

    const tracking = {
      ...existingTracking
    };

    const candidateList = [];

    const upcomingBoardTrains = [];

    // ========================================================
    // PROCESS STATION BOARD
    // ========================================================

    for (
      const item of trainsArray
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

      // ------------------------------------------------------
      // If this train already has a tracking record,
      // preserve it even if station board ETA changes.
      // ------------------------------------------------------

      const existing =
        tracking[
          trainNo
        ];

      // ------------------------------------------------------
      // Corridor from board data.
      // ------------------------------------------------------

      const corridor =
        detectCorridor(
          train,
          item,
          live
        );

      if (
        !corridor
      ) {
        console.log(
          `[IGNORED] ${trainNo} ${name} | corridor not confirmed`
        );

        continue;
      }

      // ------------------------------------------------------
      // Create tracking record if needed.
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
            live,
            corridor,
            boardEta
          );
      } else {
        tracking[
          trainNo
        ].name =
          name;

        tracking[
          trainNo
        ].origin =
          origin ||
          tracking[
            trainNo
          ].origin ||
          "Unknown";

        tracking[
          trainNo
        ].destination =
          destination ||
          tracking[
            trainNo
          ].destination ||
          "Gudur";

        tracking[
          trainNo
        ].corridor =
          corridor;

        if (
          boardEta !== null &&
          tracking[
            trainNo
          ].state ===
            "APPROACHING_GUDUR"
        ) {
          tracking[
            trainNo
          ].boardEta =
            boardEta;
        }
      }

      // ------------------------------------------------------
      // Add candidate only when the board says it is
      // reasonably close OR it is already being tracked.
      //
      // Existing tracked trains get priority.
      // ------------------------------------------------------

      const shouldCandidate =
        existing ||
        (
          boardEta !== null &&
          boardEta <= 60
        );

      if (
        shouldCandidate
      ) {
        candidateList.push({
          trainNo,
          name,
          corridor,
          boardEta:
            boardEta !== null
              ? boardEta
              : 999999
        });
      }

      // ------------------------------------------------------
      // Board upcoming data.
      // ------------------------------------------------------

      if (
        boardEta !== null &&
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
            Number(
              live?.delayMinutes ||
              item?.delayMinutes ||
              0
            ),
          corridor,
          direction:
            "TOWARD GUDUR",
          platform:
            String(
              live?.platform ||
              stop?.platform ||
              item?.platform ||
              "—"
            )
        });
      }
    }

    // ========================================================
    // ADD EXISTING TRACKING RECORDS TO CANDIDATES
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
          (c) =>
            c.trainNo ===
            trainNo
        );

      if (
        already
      ) {
        continue;
      }

      // Only actively tracked trains
      // should be live-verified.
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
            record.name,
          corridor:
            record.corridor,
          boardEta:
            record.etaMinutes ??
            999999
        });
      }
    }

    // ========================================================
    // SORT LIVE CANDIDATES
    // ========================================================

    candidateList.sort(
      (a, b) =>
        a.boardEta -
        b.boardEta
    );

    // Remove duplicates.
    const uniqueCandidates =
      [];

    for (
      const candidate of
        candidateList
    ) {
      if (
        uniqueCandidates.some(
          (x) =>
            x.trainNo ===
            candidate.trainNo
        )
      ) {
        continue;
      }

      uniqueCandidates.push(
        candidate
      );
    }

    // ========================================================
    // LIMIT LIVE API CALLS
    // ========================================================

    const liveCandidates =
      uniqueCandidates.slice(
        0,
        MAX_LIVE_CALLS
      );

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    if (
      liveCandidates.length === 0
    ) {
      console.log(
        "[LIVE QUEUE] No train requires live verification."
      );
    }

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

      // ------------------------------------------------------
      // Update tracking state from actual RailRadar position.
      // ------------------------------------------------------

      updateTrackingState(
        record,
        liveData
      );

      // ------------------------------------------------------
      // If train has already passed Gudur, do NOT let
      // the station board resurrect it.
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
      // At platform = OPEN.
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
      // Actual position information.
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
        // Start physical tracking at 1 km.
        // ----------------------------------------------------

        if (
          gudurDistance !== null &&
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
      // Gate evaluation.
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
          Number(
            gateResult.distance.toFixed(
              3
            )
          );

        record.etaMinutes =
          0;

        console.log(
          `[GATE TRIGGER] ${trainNo} ${record.name} | ${record.corridor} | ${gateResult.distance.toFixed(3)} km from gate`
        );
      }
    }

    // ========================================================
    // SECONDARY SAFETY:
    // If a record already has a known GPS position beyond
    // the gate and it is an approaching train, do not close.
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
        !record
      ) {
        continue;
      }

      if (
        !record.coordinates
      ) {
        continue;
      }

      const gateResult =
        evaluateGateForTrain(
          record
        );

      if (
        gateResult.clear &&
        record.state ===
          "AT_GATE"
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
    // GATE STATUS
    // ========================================================

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear",
      direction:
        "TOWARD GUDUR",
      corridor:
        "MAS"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear",
      direction:
        "TOWARD GUDUR",
      corridor:
        "TPTY"
    };

    // ========================================================
    // APPLY TRACKING RECORDS TO GATES
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
        distance !== null
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

    // --------------------------------------------------------
    // First add station-board trains.
    // --------------------------------------------------------

    for (
      const train of
        upcomingBoardTrains
    ) {
      upcomingMap.set(
        train.trainNo,
        train
      );
    }

    // --------------------------------------------------------
    // Then overwrite with authoritative tracking state.
    // --------------------------------------------------------

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
        continue;
      }

      // ------------------------------------------------------
      // IMPORTANT:
      // Never show a train after it has passed Gudur.
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
      // At Gudur platform = show ETA 0 but OPEN.
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
      // Approaching trains.
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
              record.etaMinutes ??
              record.boardEta ??
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
      // At gate.
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
    // SORT UPCOMING
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
    // CLEAN TRACKING STATE
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

      const updatedMs =
        new Date(
          record.lastUpdated ||
          0
        ).getTime();

      const ageMinutes =
        Number.isFinite(
          updatedMs
        )
          ? (
              nowMs -
              updatedMs
            ) /
              60000
          : Infinity;

      // ------------------------------------------------------
      // Passed gate = remove.
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
      // Departed Gudur records eventually expire.
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
      // Unknown/stale records.
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
    // SAVE TRACKING
    // ========================================================

    await trackingRef.set(
      tracking
    );

    // ========================================================
    // FIREBASE OUTPUT
    // ========================================================

    await gateRef.set({
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
    // SUCCESS LOG
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
    // SHOW UPCOMING
    // ========================================================

    if (
      upcomingList.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      upcomingList.forEach(
        (train, index) => {
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

    process.exitCode = 1;
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
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem();
