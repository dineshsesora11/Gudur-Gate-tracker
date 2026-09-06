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
  console.error("❌ Could not load Firebase service account.");
  console.error(
    "Use FIREBASE_SERVICE_ACCOUNT secret or place serviceAccountKey.json beside code.js."
  );
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL:
    "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db = getDatabase();
const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY ||
  "YOUR_RAILRADAR_API_KEY";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

const STATION_CODE = "GDR";

// ============================================================
// GUDUR / GATE COORDINATES
// ============================================================

const GUDUR = {
  lat: 14.1451694,
  lng: 79.8443472
};

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

const APPROACHING_GUDUR_DISTANCE_KM = 1.0;

const GATE_DISTANCE_KM = 0.52;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// LIVE TRAIN CHECK
// ============================================================
//
// IMPORTANT:
//
// We DO NOT hard-code temporary/special train numbers.
//
// The GDR live station board is the source of truth for
// which trains RailRadar currently knows about.
//
// A train is only displayed when it passes the validation
// checks below.
//
// ============================================================

const LIVE_CHECK_INTERVAL_MS =
  20 * 60 * 1000;

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
// SAFE NUMBER
// ============================================================

function toNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) / 180;

  const dLon =
    ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// GET TRAIN COORDINATES
// ============================================================

function getTrainCoordinates(
  train,
  live,
  stop,
  item
) {
  const candidates = [
    live.coordinates,
    live.location?.coordinates,
    live.currentLocation?.coordinates,

    train.coordinates,
    train.currentLocation?.coordinates,

    stop.coordinates,

    item.coordinates,
    item.currentLocation?.coordinates
  ];

  for (const c of candidates) {
    if (!c) continue;

    const lat =
      toNumber(
        c.lat ??
          c.latitude
      );

    const lng =
      toNumber(
        c.lng ??
          c.lon ??
          c.longitude
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
// GET CURRENT STATION SEQUENCE
// ============================================================

function getCurrentSequence(
  train,
  live,
  item
) {
  const values = [
    live.sequence,
    live.currentSequence,

    live.currentLocation?.sequence,

    train.sequence,
    train.currentSequence,

    item.sequence,

    item.currentLocation?.sequence
  ];

  for (const value of values) {
    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

// ============================================================
// GET GUDUR SEQUENCE
// ============================================================

function getGudurSequence(
  train,
  live,
  stop,
  item
) {
  const values = [
    live.gudurSequence,
    train.gudurSequence,
    item.gudurSequence,

    stop.sequence
  ];

  for (const value of values) {
    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

// ============================================================
// GET STATION CODE
// ============================================================

function getStationCode(
  train,
  live,
  stop,
  item
) {
  const values = [
    live.stationCode,
    live.currentStationCode,

    live.currentLocation?.stationCode,

    stop.stationCode,

    item.stationCode,

    item.currentLocation?.stationCode
  ];

  for (const value of values) {
    if (value) {
      return String(value)
        .trim()
        .toUpperCase();
    }
  }

  return "";
}

// ============================================================
// GET TRAIN ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const candidates = [
    train.origin,
    train.source,
    train.from,
    train.fromStation,
    train.startStation,
    train.start,

    item.origin,
    item.source,
    item.from,
    item.fromStation,
    item.startStation
  ];

  for (const value of candidates) {
    if (!value) continue;

    if (typeof value === "object") {
      if (value.name) {
        return String(value.name);
      }

      if (value.code) {
        return String(value.code);
      }
    }

    return String(value);
  }

  return "";
}

// ============================================================
// GET TRAIN DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const candidates = [
    train.destination,
    train.to,
    train.destinationStation,
    train.endStation,

    item.destination,
    item.to,
    item.destinationStation,
    item.endStation
  ];

  for (const value of candidates) {
    if (!value) continue;

    if (typeof value === "object") {
      if (value.name) {
        return String(value.name);
      }

      if (value.code) {
        return String(value.code);
      }
    }

    return String(value);
  }

  return "";
}

// ============================================================
// GET TRAIN NAME
// ============================================================

function getTrainName(
  train,
  item,
  trainNo
) {
  return (
    train.name ||
    item.trainName ||
    `Train ${trainNo}`
  );
}

// ============================================================
// GET DELAY
// ============================================================

function getDelayMinutes(
  train,
  live,
  item
) {
  const values = [
    live.delayMinutes,
    live.delay,

    train.delayMinutes,
    train.delay,

    item.delayMinutes,
    item.delay
  ];

  for (const value of values) {
    const n = Number(value);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return 0;
}

// ============================================================
// GET LIVE STATUS
// ============================================================

function getLiveStatus(
  train,
  live,
  stop,
  item
) {
  const values = [
    live.status,
    live.currentStatus,

    live.currentLocation?.status,

    train.status,

    stop.status,

    item.status
  ];

  for (const value of values) {
    if (value) {
      return normalizeText(value);
    }
  }

  return "";
}

// ============================================================
// DIRECTION TEXT
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  const fields = [
    train.direction,
    train.travelDirection,
    train.routeDirection,
    train.runningDirection,

    live.direction,
    live.travelDirection,
    live.routeDirection,
    live.runningDirection,

    live.currentLocation?.direction,

    stop.direction,

    item.direction,
    item.travelDirection,
    item.routeDirection,
    item.runningDirection
  ];

  return fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================
//
// Returns:
//
// true  = definitely toward Gudur
// false = definitely away from Gudur
// null  = unknown
//
// ============================================================

function getExplicitDirection(
  train,
  live,
  stop,
  item
) {
  const direction =
    getDirectionText(
      train,
      live,
      stop,
      item
    );

  if (!direction) {
    return null;
  }

  if (
    direction.includes(
      "TOWARD GUDUR"
    ) ||
    direction.includes(
      "TOWARDS GUDUR"
    ) ||
    direction.includes(
      "TO GUDUR"
    ) ||
    direction.includes(
      "GUDUR INBOUND"
    ) ||
    direction.includes(
      "APPROACHING GUDUR"
    ) ||
    direction.includes(
      "INBOUND"
    )
  ) {
    return true;
  }

  if (
    direction.includes(
      "FROM GUDUR"
    ) ||
    direction.includes(
      "GUDUR OUTBOUND"
    ) ||
    direction.includes(
      "AWAY FROM GUDUR"
    ) ||
    direction.includes(
      "OUTBOUND"
    ) ||
    direction.includes(
      "TO CHENNAI"
    ) ||
    direction.includes(
      "TOWARD CHENNAI"
    ) ||
    direction.includes(
      "TOWARDS CHENNAI"
    ) ||
    direction.includes(
      "TO TIRUPATI"
    ) ||
    direction.includes(
      "TOWARD TIRUPATI"
    ) ||
    direction.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return false;
  }

  return null;
}

// ============================================================
// PHYSICAL DIRECTION USING SEQUENCE
// ============================================================
//
// If RailRadar gives current sequence and Gudur sequence:
//
// current sequence < Gudur sequence
//
// means the train has not reached Gudur yet.
//
// current sequence > Gudur sequence
//
// means the train has passed Gudur.
//
// This is much safer than using the train name.
//
// ============================================================

function sequenceDirection(
  currentSequence,
  gudurSequence
) {
  if (
    currentSequence === null ||
    gudurSequence === null
  ) {
    return null;
  }

  if (
    currentSequence <
    gudurSequence
  ) {
    return true;
  }

  if (
    currentSequence >
    gudurSequence
  ) {
    return false;
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR FROM ACTUAL ROUTE
// ============================================================
//
// IMPORTANT:
//
// We do NOT use train names such as:
//
// "Bengaluru"
// "Tirupati"
// "Express"
//
// to classify a train.
//
// We first use explicit RailRadar direction.
//
// If that is unavailable, sequence is used.
//
// The actual origin is then used to determine the side:
//
// Chennai side -> MAS
// Tirupati side -> TPTY
//
// Unknown side -> ignored.
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const explicit =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  if (explicit === false) {
    return null;
  }

  const currentSequence =
    getCurrentSequence(
      train,
      live,
      item
    );

  const gudurSequence =
    getGudurSequence(
      train,
      live,
      stop,
      item
    );

  const sequenceDir =
    sequenceDirection(
      currentSequence,
      gudurSequence
    );

  if (
    explicit === null &&
    sequenceDir === false
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // ORIGIN
  // ----------------------------------------------------------

  const origin =
    normalizeText(
      getOrigin(
        train,
        item
      )
    );

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  const chennaiSide = [
    "CHENNAI",
    "MAS",
    "MGR CHENNAI",
    "CHENNAI CENTRAL",
    "DR MGR CHENNAI CENTRAL",
    "PURATCHI THALAIVAR",
    "AVADI",
    "PERAMBUR",
    "SULLURUPETA",
    "NAYUDUPETA"
  ];

  if (
    chennaiSide.some(
      (x) =>
        origin.includes(
          normalizeText(x)
        )
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // TIRUPATI SIDE
  // ----------------------------------------------------------

  const tirupatiSide = [
    "TIRUPATI",
    "TPTY",
    "RENIGUNTA",
    "RU"
  ];

  if (
    tirupatiSide.some(
      (x) =>
        origin.includes(
          normalizeText(x)
        )
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // UNKNOWN ORIGIN
  // ----------------------------------------------------------

  return null;
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const date =
    new Date(timeStr);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    return (
      date.getHours() * 60 +
      date.getMinutes() +
      Number(delayMinutes || 0)
    );
  }

  const match =
    String(timeStr)
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
    ) +
    Number(delayMinutes || 0)
  );
}

// ============================================================
// TIME DIFFERENCE
// ============================================================

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
// GET ARRIVAL TIME
// ============================================================

function getArrivalTime(
  train,
  live,
  stop,
  item
) {
  return (
    live.expectedArrivalTime ||
    live.eta ||
    stop.expectedArrival ||
    stop.arrival ||
    item.expectedArrivalTime ||
    item.arrival ||
    train.expectedArrivalTime ||
    ""
  );
}

// ============================================================
// GET DEPARTURE TIME
// ============================================================

function getDepartureTime(
  train,
  live,
  stop,
  item,
  arrivalTime
) {
  return (
    live.expectedDepartureTime ||
    live.etd ||
    stop.expectedDeparture ||
    stop.departure ||
    item.expectedDepartureTime ||
    item.departure ||
    train.expectedDepartureTime ||
    arrivalTime
  );
}

// ============================================================
// TRAIN IS ACTUALLY AT GUDUR
// ============================================================

function isAtGudurStation(
  train,
  live,
  stop,
  item
) {
  const station =
    getStationCode(
      train,
      live,
      stop,
      item
    );

  const status =
    getLiveStatus(
      train,
      live,
      stop,
      item
    );

  return (
    station === "GDR" &&
    (
      status.includes(
        "AT STATION"
      ) ||
      status.includes(
        "ARRIVED"
      ) ||
      status.includes(
        "HALT"
      ) ||
      status === ""
    )
  );
}

// ============================================================
// TRAIN PASSED GUDUR
// ============================================================

function hasPassedGudur(
  train,
  live,
  stop,
  item
) {
  const currentSequence =
    getCurrentSequence(
      train,
      live,
      item
    );

  const gudurSequence =
    getGudurSequence(
      train,
      live,
      stop,
      item
    );

  if (
    currentSequence !== null &&
    gudurSequence !== null
  ) {
    return (
      currentSequence >
      gudurSequence
    );
  }

  return false;
}

// ============================================================
// PHYSICAL DISTANCE TO GATE
// ============================================================

function getGateDistances(
  train,
  live,
  stop,
  item
) {
  const coords =
    getTrainCoordinates(
      train,
      live,
      stop,
      item
    );

  if (!coords) {
    return null;
  }

  return {
    tirupatiGateKm:
      distanceKm(
        coords.lat,
        coords.lng,
        TIRUPATI_GATE.lat,
        TIRUPATI_GATE.lng
      ),

    chennaiGateKm:
      distanceKm(
        coords.lat,
        coords.lng,
        CHENNAI_GATE.lat,
        CHENNAI_GATE.lng
      ),

    gudurKm:
      distanceKm(
        coords.lat,
        coords.lng,
        GUDUR.lat,
        GUDUR.lng
      )
  };
}

// ============================================================
// DETERMINE WHETHER TRAIN IS PHYSICALLY NEAR GATE
// ============================================================

function isNearGate(
  corridor,
  distances
) {
  if (!distances) {
    return false;
  }

  if (
    corridor === "TPTY"
  ) {
    return (
      distances.tirupatiGateKm <=
      GATE_CLOSE_DISTANCE_KM
    );
  }

  if (
    corridor === "MAS"
  ) {
    return (
      distances.chennaiGateKm <=
      GATE_CLOSE_DISTANCE_KM
    );
  }

  return false;
}

// ============================================================
// DETERMINE WHETHER TRAIN PASSED GATE
// ============================================================

function hasPassedGate(
  corridor,
  distances
) {
  if (!distances) {
    return false;
  }

  if (
    corridor === "TPTY"
  ) {
    return (
      distances.tirupatiGateKm >
      GATE_CLEAR_DISTANCE_KM
    );
  }

  if (
    corridor === "MAS"
  ) {
    return (
      distances.chennaiGateKm >
      GATE_CLEAR_DISTANCE_KM
    );
  }

  return false;
}

// ============================================================
// CALCULATE ETA
// ============================================================
//
// Priority:
//
// 1. Actual GDR station
// 2. RailRadar expected arrival
// 3. Speed/distance fallback if available
//
// IMPORTANT:
//
// A train being far away does NOT automatically make its
// timetable ETA zero.
//
// ============================================================

function calculateEta(
  train,
  live,
  stop,
  item,
  currentMin
) {
  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      train,
      live,
      stop,
      item
    )
  ) {
    return 0;
  }

  // ----------------------------------------------------------
  // ALREADY PASSED GUDUR
  // ----------------------------------------------------------

  if (
    hasPassedGudur(
      train,
      live,
      stop,
      item
    )
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const arrival =
    getArrivalTime(
      train,
      live,
      stop,
      item
    );

  if (arrival) {
    const delay =
      getDelayMinutes(
        train,
        live,
        item
      );

    const arrivalMin =
      parseTimeToMinutes(
        arrival,
        delay
      );

    if (arrivalMin !== -1) {
      const diff =
        calculateTimeDifference(
          arrivalMin,
          currentMin
        );

      if (
        diff >= -15 &&
        diff <= 180
      ) {
        return Math.max(
          0,
          Math.round(diff)
        );
      }
    }
  }

  // ----------------------------------------------------------
  // SPEED / DISTANCE FALLBACK
  // ----------------------------------------------------------

  const distances =
    getGateDistances(
      train,
      live,
      stop,
      item
    );

  const gudurKm =
    distances?.gudurKm;

  const speed =
    toNumber(
      live.speed ||
        live.currentSpeed ||
        train.speed
    );

  if (
    gudurKm !== undefined &&
    gudurKm !== null &&
    speed !== null &&
    speed > 5
  ) {
    const etaHours =
      gudurKm / speed;

    const etaMinutes =
      etaHours * 60;

    if (
      etaMinutes >= 0 &&
      etaMinutes <= 180
    ) {
      return Math.max(
        0,
        Math.round(
          etaMinutes
        )
      );
    }
  }

  return null;
}

// ============================================================
// PROCESS ONE TRAIN
// ============================================================

function processTrain(
  item,
  currentMin
) {
  const train =
    item.train || {};

  const live =
    item.live || {};

  const stop =
    item.stop || {};

  const trainNo =
    String(
      train.number ||
        item.trainNumber ||
        ""
    ).trim();

  if (!trainNo) {
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

  const status =
    getLiveStatus(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // REJECT CLEARLY NON-RUNNING RECORDS
  // ----------------------------------------------------------

  if (
    status.includes(
      "CANCEL"
    ) ||
    status.includes(
      "NOT RUN"
    ) ||
    status.includes(
      "NOT RUNNING"
    )
  ) {
    console.log(
      `[IGNORED] ${trainNo} ${trainName} - ${status}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // DETERMINE CORRIDOR
  // ----------------------------------------------------------

  const corridor =
    determineCorridor(
      train,
      live,
      stop,
      item
    );

  if (!corridor) {
    console.log(
      `[IGNORED] ${trainNo} ${trainName} - corridor/direction not verified`
    );

    return null;
  }

  // ----------------------------------------------------------
  // CHECK DIRECTION
  // ----------------------------------------------------------

  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  const currentSequence =
    getCurrentSequence(
      train,
      live,
      item
    );

  const gudurSequence =
    getGudurSequence(
      train,
      live,
      stop,
      item
    );

  const sequenceDir =
    sequenceDirection(
      currentSequence,
      gudurSequence
    );

  if (
    explicitDirection === false ||
    sequenceDir === false
  ) {
    console.log(
      `[IGNORED] ${trainNo} ${trainName} - moving away from Gudur`
    );

    return null;
  }

  // ----------------------------------------------------------
  // CHECK IF ALREADY PASSED GUDUR
  // ----------------------------------------------------------

  if (
    hasPassedGudur(
      train,
      live,
      stop,
      item
    )
  ) {
    console.log(
      `[IGNORED] ${trainNo} ${trainName} - already passed Gudur`
    );

    return null;
  }

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  const etaMinutes =
    calculateEta(
      train,
      live,
      stop,
      item,
      currentMin
    );

  // ----------------------------------------------------------
  // PHYSICAL LOCATION
  // ----------------------------------------------------------

  const distances =
    getGateDistances(
      train,
      live,
      stop,
      item
    );

  const nearGate =
    isNearGate(
      corridor,
      distances
    );

  const passedGate =
    hasPassedGate(
      corridor,
      distances
    );

  const atGudur =
    isAtGudurStation(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // IF TRAIN PASSED GATE
  // ----------------------------------------------------------

  if (
    passedGate &&
    !atGudur
  ) {
    console.log(
      `[IGNORED] ${trainNo} ${trainName} - passed gate area`
    );

    return null;
  }

  // ----------------------------------------------------------
  // DELAY
  // ----------------------------------------------------------

  const delayMinutes =
    getDelayMinutes(
      train,
      live,
      item
    );

  // ----------------------------------------------------------
  // PLATFORM
  // ----------------------------------------------------------

  const platform =
    String(
      live.platform ||
        stop.platform ||
        item.platform ||
        "--"
    );

  // ----------------------------------------------------------
  // SERVICE DATE
  // ----------------------------------------------------------

  const serviceDate =
    item.startDate ||
    item.serviceDate ||
    train.startDate ||
    live.startDate ||
    "";

  // ----------------------------------------------------------
  // FINAL RECORD
  // ----------------------------------------------------------

  return {
    trainNo,

    name: trainName,

    origin:
      origin ||
      "Unknown origin",

    destination:
      destination ||
      "Gudur",

    etaMinutes,

    delayMinutes,

    corridor,

    direction:
      "TOWARD GUDUR",

    platform,

    serviceDate,

    status,

    physicalDistanceKm:
      distances
        ? Number(
            (
              corridor === "MAS"
                ? distances.chennaiGateKm
                : distances.tirupatiGateKm
            ).toFixed(2)
          )
        : null,

    distanceToGudurKm:
      distances
        ? Number(
            distances.gudurKm.toFixed(2)
          )
        : null,

    approachingGudur:
      distances
        ? distances.gudurKm <=
          APPROACHING_GUDUR_DISTANCE_KM
        : false,

    atGudur,

    approachingGate:
      nearGate,

    currentSequence,

    gudurSequence
  };
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  try {
    const now =
      new Date();

    const currentMin =
      now.getHours() * 60 +
      now.getMinutes();

    console.log(
      "\n=========================================="
    );

    console.log(
      `[${now.toLocaleTimeString()}] RailRadar GDR LIVE BOARD`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // RAILRADAR LIVE STATION BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/${STATION_CODE}/live`,
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

    const responseBody =
      boardRes.data;

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
      `RailRadar returned ${trainsArray.length} board records.`
    );

    // ========================================================
    // GATE DEFAULTS
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
    // UPCOMING
    // ========================================================

    const upcomingMap =
      new Map();

    // ========================================================
    // PROCESS BOARD
    // ========================================================

    for (
      const item of
      trainsArray
    ) {
      const result =
        processTrain(
          item,
          currentMin
        );

      if (!result) {
        continue;
      }

      const key =
        `${result.trainNo}_${result.serviceDate || "unknown"}`;

      // ------------------------------------------------------
      // DEDUPE
      // ------------------------------------------------------

      const existing =
        upcomingMap.get(
          key
        );

      if (
        existing
      ) {
        const existingEta =
          existing.etaMinutes;

        const newEta =
          result.etaMinutes;

        if (
          newEta !== null &&
          (
            existingEta === null ||
            newEta <
              existingEta
          )
        ) {
          upcomingMap.set(
            key,
            result
          );
        }

        continue;
      }

      upcomingMap.set(
        key,
        result
      );

      console.log(
        `[VALID] ${result.trainNo} ${result.name} | ${result.origin} -> ${result.destination} | ${result.corridor} | ETA ${result.etaMinutes === null ? "--" : result.etaMinutes + "m"}`
      );

      // ======================================================
      // GATE CLOSURE
      // ======================================================

      //
      // IMPORTANT:
      //
      // ETA alone NEVER closes the gate.
      //
      // Gate closes only when the physical live location
      // confirms the train is near the actual crossing.
      //

      const gateDistance =
        result.physicalDistanceKm;

      const isPhysicallyNearGate =
        gateDistance !== null &&
        gateDistance <=
          GATE_CLOSE_DISTANCE_KM;

      const isPhysicallyAtGate =
        gateDistance !== null &&
        gateDistance <=
          GATE_CLOSE_DISTANCE_KM;

      if (
        isPhysicallyNearGate ||
        isPhysicallyAtGate
      ) {
        const waitMinutes =
          Math.max(
            1,
            result.etaMinutes !== null
              ? result.etaMinutes + 2
              : 3
          );

        const label =
          `${result.trainNo} ${result.name}`;

        const payload = {
          status:
            "CLOSED",

          waitMinutes,

          activeTrain:
            label,

          direction:
            "TOWARD GUDUR",

          corridor:
            result.corridor,

          trainNo:
            result.trainNo,

          distanceKm:
            result.physicalDistanceKm
        };

        if (
          result.corridor ===
          "MAS"
        ) {
          masGate =
            payload;
        }

        if (
          result.corridor ===
          "TPTY"
        ) {
          tptyGate =
            payload;
        }
      }
    }

    // ========================================================
    // UPCOMING SORT
    // ========================================================

    const upcomingList =
      Array.from(
        upcomingMap.values()
      );

    upcomingList.sort(
      (a, b) => {
        if (
          a.etaMinutes === null
        ) {
          return 1;
        }

        if (
          b.etaMinutes === null
        ) {
          return -1;
        }

        return (
          a.etaMinutes -
          b.etaMinutes
        );
      }
    );

    // ========================================================
    // MAX 5
    // ========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedLocal:
        now.toLocaleTimeString(),

      lastUpdated:
        now.toLocaleTimeString(),

      source:
        "RailRadar GDR Live Station Board",

      sourceStation:
        "GDR"
    });

    // ========================================================
    // LOG
    // ========================================================

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      ` -> Chennai Gate : ${masGate.status}`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status}`
    );

    console.log(
      ` -> Valid trains : ${topUpcoming.length}`
    );

    // ========================================================
    // UPCOMING DISPLAY
    // ========================================================

    if (
      topUpcoming.length === 0
    ) {
      console.log(
        "\n[UPCOMING] No verified trains."
      );
    } else {
      console.log(
        "\n[VERIFIED TRAINS TO GUDUR]"
      );

      for (
        const train of
        topUpcoming
      ) {
        console.log(
          ` ${train.corridor} | ${train.trainNo} ${train.name} | ETA ${train.etaMinutes === null ? "--" : train.etaMinutes + "m"} | ${train.origin} -> ${train.destination}`
        );
      }
    }

    console.log(
      "\n=========================================="
    );
  } catch (err) {
    console.error(
      "\n❌ UPDATE FAILED"
    );

    if (
      err.response
    ) {
      console.error(
        `HTTP ${err.response.status}`
      );

      console.error(
        JSON.stringify(
          err.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        err.message
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
  " RailRadar Real-time Gudur Gate Monitor "
);

console.log(
  "=========================================="
);

console.log(
  "Station: GDR"
);

console.log(
  "Chennai Gate: 14.1396667, 79.8441278"
);

console.log(
  "Tirupati Gate: 14.1402028, 79.8435972"
);

console.log(
  "Gudur Junction: 14.1451694, 79.8443472"
);

console.log(
  "=========================================="
);

console.log(
  "Direction: TOWARD GUDUR ONLY"
);

console.log(
  "Train source: RailRadar LIVE BOARD"
);

console.log(
  "Hard-coded special trains: NONE"
);

console.log(
  "03251: REMOVED"
);

console.log(
  "22365: NOT hard-coded"
);

console.log(
  "18509: NOT hard-coded"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN NOW
// ============================================================

updateGateSystem();

// ============================================================
// RUN EVERY 3 MINUTES
// ============================================================
//
// GitHub Actions can invoke this script every 5 minutes.
// If running continuously on a server, this checks every
// 3 minutes.
//
// ============================================================

setInterval(
  updateGateSystem,
  180000
);
