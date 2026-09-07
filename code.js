const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

// ------------------------------------------------------------
// FIRST: GitHub Actions secret
// ------------------------------------------------------------

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    console.log(
      "✅ Firebase service account loaded from FIREBASE_SERVICE_ACCOUNT."
    );
  } catch (error) {
    console.error(
      "❌ FIREBASE_SERVICE_ACCOUNT contains invalid JSON."
    );

    console.error(error.message);

    process.exit(1);
  }
}

// ------------------------------------------------------------
// SECOND: local serviceAccountKey.json
// ------------------------------------------------------------

if (!serviceAccount) {
  try {
    serviceAccount = require("./serviceAccountKey.json");

    console.log(
      "✅ Firebase service account loaded from serviceAccountKey.json."
    );
  } catch (error) {
    console.error(
      "❌ Could not load Firebase service account."
    );

    console.error(
      "For GitHub Actions, create the FIREBASE_SERVICE_ACCOUNT secret."
    );

    console.error(
      "For local testing, place serviceAccountKey.json beside code.js."
    );

    console.error(error.message);

    process.exit(1);
  }
}

// ============================================================
// INITIALIZE FIREBASE
// ============================================================

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

const APPROACHING_GUDUR_DISTANCE_KM = 1.00;

const GATE_WARNING_DISTANCE_KM = 1.00;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// LIVE REQUEST LIMIT
// ============================================================

const MAX_LIVE_REQUESTS = 8;

// ============================================================
// APPROVED TIRUPATI CORRIDOR TRAINS
// ============================================================

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

// ============================================================
// APPROVED CHENNAI CORRIDOR TRAINS
// ============================================================

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

// ============================================================
// OTHER APPROVED TRAINS
// ============================================================

const OTHER_TRAINS = new Set([
  "12743",
  "12744",
  "20498",
  "67226"
]);

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
// NUMBER NORMALIZER
// ============================================================

function normalizeTrainNumber(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/\s+/g, "");
}

// ============================================================
// DETERMINE TRAIN CORRIDOR
// ============================================================

function determineCorridor(trainNo) {
  const number = normalizeTrainNumber(trainNo);

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
// HAVERSINE DISTANCE
// ============================================================

function haversineDistanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
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

function getCoordinates(
  train,
  live,
  item
) {
  const candidates = [
    live?.currentLocation?.coordinates,
    live?.currentLocation,
    live?.coordinates,
    live?.position,

    train?.currentLocation?.coordinates,
    train?.currentLocation,
    train?.coordinates,
    train?.position,

    item?.currentLocation?.coordinates,
    item?.currentLocation,
    item?.coordinates,
    item?.position
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    // --------------------------------------------------------
    // Array format: [longitude, latitude]
    // --------------------------------------------------------

    if (
      Array.isArray(value) &&
      value.length >= 2
    ) {
      const first = Number(value[0]);
      const second = Number(value[1]);

      if (
        Number.isFinite(first) &&
        Number.isFinite(second)
      ) {
        if (
          Math.abs(first) <= 90 &&
          Math.abs(second) <= 180
        ) {
          return {
            lat: first,
            lng: second
          };
        }

        return {
          lat: second,
          lng: first
        };
      }
    }

    // --------------------------------------------------------
    // Object formats
    // --------------------------------------------------------

    if (
      typeof value === "object"
    ) {
      const lat = Number(
        value.lat ??
          value.latitude ??
          value.Latitude
      );

      const lng = Number(
        value.lng ??
          value.lon ??
          value.longitude ??
          value.Longitude
      );

      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180
      ) {
        return {
          lat,
          lng
        };
      }

      // GeoJSON style:
      // { coordinates: [lng, lat] }

      if (
        Array.isArray(value.coordinates) &&
        value.coordinates.length >= 2
      ) {
        const lng2 =
          Number(value.coordinates[0]);

        const lat2 =
          Number(value.coordinates[1]);

        if (
          Number.isFinite(lat2) &&
          Number.isFinite(lng2)
        ) {
          return {
            lat: lat2,
            lng: lng2
          };
        }
      }
    }
  }

  return null;
}

// ============================================================
// GET DESTINATION
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
// GET ORIGIN
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
// GET TRAIN NAME
// ============================================================

function getTrainName(
  train,
  trainNo
) {
  return (
    train?.name ||
    train?.trainName ||
    train?.displayName ||
    `Express ${trainNo}`
  );
}

// ============================================================
// PARSE TIME
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  let totalMinutes = -1;

  const date = new Date(timeStr);

  if (!isNaN(date.getTime())) {
    totalMinutes =
      date.getHours() * 60 +
      date.getMinutes();
  } else {
    const match = String(timeStr)
      .trim()
      .match(/(\d{1,2}):(\d{2})/);

    if (match) {
      totalMinutes =
        parseInt(match[1], 10) * 60 +
        parseInt(match[2], 10);
    }
  }

  if (totalMinutes === -1) {
    return -1;
  }

  return (
    totalMinutes +
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

  // Midnight crossing

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// GET LIVE TRAIN API
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    console.log(
      `[LIVE REQUEST] ${trainNo}`
    );

    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${trainNo}/live`,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          timeout: 12000
        }
      );

    const body =
      response.data;

    const live =
      body?.data ||
      body?.train ||
      body ||
      {};

    return live;

  } catch (error) {
    if (error.response) {
      console.error(
        `[LIVE ERROR] ${trainNo} | HTTP ${error.response.status}`
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
// GET LIVE DELAY
// ============================================================

function getDelayMinutes(
  live,
  item
) {
  const values = [
    live?.delayMinutes,
    live?.delay,
    live?.delayMins,

    item?.delayMinutes,
    item?.delay
  ];

  for (const value of values) {
    const number =
      Number(value);

    if (Number.isFinite(number)) {
      return number;
    }
  }

  return 0;
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
    stop?.arrival ||
    live?.expectedArrivalTime ||
    live?.expectedArrival ||
    live?.arrival ||
    item?.expectedArrivalTime ||
    item?.arrival ||
    train?.arrival ||
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
    stop?.departure ||
    live?.expectedDepartureTime ||
    live?.expectedDeparture ||
    live?.departure ||
    item?.expectedDepartureTime ||
    item?.departure ||
    train?.departure ||
    arrivalTime
  );
}

// ============================================================
// CHECK IF TRAIN IS AT GUDUR
// ============================================================

function isAtGudur(
  train,
  live,
  stop,
  item,
  coordinates
) {
  const stationText = normalizeText(
    [
      stop?.station,
      stop?.stationCode,
      stop?.stationName,

      live?.station,
      live?.stationCode,
      live?.stationName,

      item?.station,
      item?.stationCode,
      item?.stationName
    ]
      .filter(Boolean)
      .join(" ")
  );

  if (
    stationText.includes(" GDR ") ||
    stationText === "GDR" ||
    stationText.includes("GUDUR")
  ) {
    return true;
  }

  if (!coordinates) {
    return false;
  }

  const distance =
    haversineDistanceKm(
      coordinates.lat,
      coordinates.lng,
      GUDUR.lat,
      GUDUR.lng
    );

  return distance <= 0.20;
}

// ============================================================
// CHECK IF TRAIN DEPARTED GUDUR
// ============================================================

function hasDepartedGudur(
  train,
  live,
  stop,
  item
) {
  const previousStation =
    normalizeText(
      live?.previousStation ||
      live?.previousStop ||
      train?.previousStation ||
      item?.previousStation ||
      ""
    );

  const previousCode =
    normalizeText(
      live?.previousStationCode ||
      train?.previousStationCode ||
      item?.previousStationCode ||
      ""
    );

  const sequence =
    Number(
      live?.stopSequence ??
      live?.sequence ??
      item?.stopSequence ??
      item?.sequence ??
      -1
    );

  const previousSequence =
    Number(
      live?.previousStopSequence ??
      live?.previousStopSequence ??
      -1
    );

  const previousWasGudur =
    previousStation.includes("GUDUR") ||
    previousCode === "GDR";

  if (
    previousWasGudur &&
    sequence >= 0 &&
    previousSequence >= 0 &&
    sequence > previousSequence
  ) {
    return true;
  }

  return false;
}

// ============================================================
// GET GATE COORDINATES
// ============================================================

function getGateCoordinates(
  corridor
) {
  if (corridor === "MAS") {
    return CHENNAI_GATE;
  }

  if (corridor === "TPTY") {
    return TIRUPATI_GATE;
  }

  // OTHER trains are not assigned to a gate

  return null;
}

// ============================================================
// GET DISTANCE TO GATE
// ============================================================

function getDistanceToGate(
  coordinates,
  corridor
) {
  if (!coordinates) {
    return null;
  }

  const gate =
    getGateCoordinates(
      corridor
    );

  if (!gate) {
    return null;
  }

  return haversineDistanceKm(
    coordinates.lat,
    coordinates.lng,
    gate.lat,
    gate.lng
  );
}

// ============================================================
// GET VERIFIED ETA
// ============================================================

function getVerifiedEta(
  train,
  live,
  stop,
  item,
  coordinates,
  atGudur,
  departedGudur,
  currentMin
) {
  // ----------------------------------------------------------
  // Already at Gudur
  // ----------------------------------------------------------

  if (atGudur) {
    return 0;
  }

  // ----------------------------------------------------------
  // Train already departed Gudur
  // ----------------------------------------------------------

  if (departedGudur) {
    return null;
  }

  // ----------------------------------------------------------
  // Station board ETA
  // ----------------------------------------------------------

  const delayMinutes =
    getDelayMinutes(
      live,
      item
    );

  const arrivalTime =
    getArrivalTime(
      train,
      live,
      stop,
      item
    );

  const arrivalMinutes =
    parseTimeToMinutes(
      arrivalTime,
      delayMinutes
    );

  if (arrivalMinutes !== -1) {
    const diff =
      calculateTimeDifference(
        arrivalMinutes,
        currentMin
      );

    if (
      diff >= -15 &&
      diff <= 720
    ) {
      return Math.max(
        0,
        diff
      );
    }
  }

  // ----------------------------------------------------------
  // GPS speed fallback
  // ----------------------------------------------------------

  if (
    coordinates &&
    live
  ) {
    const speed =
      Number(
        live.speed ||
        live.speedKmph ||
        live.speedKmH ||
        0
      );

    const distanceToGudur =
      haversineDistanceKm(
        coordinates.lat,
        coordinates.lng,
        GUDUR.lat,
        GUDUR.lng
      );

    if (
      Number.isFinite(speed) &&
      speed > 5 &&
      distanceToGudur >
        APPROACHING_GUDUR_DISTANCE_KM
    ) {
      const etaHours =
        distanceToGudur /
        speed;

      return Math.max(
        1,
        Math.round(
          etaHours * 60
        )
      );
    }
  }

  return null;
}

// ============================================================
// TRAIN STATUS
// ============================================================

function getTrainStatus(
  atGudur,
  departedGudur,
  etaMinutes
) {
  if (atGudur) {
    return "AT STATION";
  }

  if (departedGudur) {
    return "DEPARTED";
  }

  if (
    etaMinutes !== null &&
    etaMinutes <= 45
  ) {
    return "UPCOMING";
  }

  return "SCHEDULED";
}

// ============================================================
// DEDUPLICATE BOARD
// ============================================================

function deduplicateBoard(
  trains
) {
  const map =
    new Map();

  const priority = {
    "AT STATION": 4,
    "UPCOMING": 3,
    "SCHEDULED": 2,
    "DEPARTED": 1
  };

  for (const train of trains) {
    const number =
      normalizeTrainNumber(
        train.trainNo
      );

    if (!number) {
      continue;
    }

    const existing =
      map.get(number);

    if (!existing) {
      map.set(
        number,
        train
      );

      continue;
    }

    const currentPriority =
      priority[
        train.status
      ] || 0;

    const existingPriority =
      priority[
        existing.status
      ] || 0;

    if (
      currentPriority >
      existingPriority
    ) {
      map.set(
        number,
        train
      );

      continue;
    }

    if (
      currentPriority ===
        existingPriority &&
      train.etaMinutes !== null &&
      existing.etaMinutes !== null &&
      train.etaMinutes <
        existing.etaMinutes
    ) {
      map.set(
        number,
        train
      );
    }
  }

  return Array.from(
    map.values()
  );
}

// ============================================================
// CREATE OPEN GATE
// ============================================================

function createOpenGate() {
  return {
    status: "OPEN",

    waitMinutes: 0,

    activeTrain:
      "Tracks clear",

    direction:
      "CLEAR",

    corridor:
      "",

    trainNo:
      "",

    gateDistanceKm:
      null,

    warningDistanceKm:
      GATE_WARNING_DISTANCE_KM,

    closeDistanceKm:
      GATE_CLOSE_DISTANCE_KM
  };
}

// ============================================================
// MAIN UPDATE
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
      `[${now.toLocaleString()}]`
    );

    console.log(
      " GUDUR CROSSING RADAR V9"
    );

    console.log(
      "=========================================="
    );

    console.log(
      "STRICT TRAIN NUMBERS: ENABLED"
    );

    console.log(
      "Unknown trains: IGNORED"
    );

    console.log(
      "Duplicate train numbers: REMOVED"
    );

    console.log(
      "LIVE GPS VERIFICATION: ENABLED"
    );

    console.log(
      "LIVE GPS: FRESH REQUEST EVERY WORKFLOW RUN"
    );

    console.log(
      "1.00 km WARNING: ENABLED"
    );

    console.log(
      "0.60 km GATE CLOSE: ENABLED"
    );

    console.log(
      "0.80 km GATE CLEAR: ENABLED"
    );

    console.log(
      "Gate closure: LIVE PHYSICAL POSITION"
    );

    console.log(
      "departedGudur is NOT required for gate closure"
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Fetching RailRadar GDR station board..."
    );

    // ========================================================
    // FETCH STATION BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4`,
        {
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
      throw new Error(
        "RailRadar returned invalid train data."
      );
    }

    console.log(
      `Raw board trains: ${trainsArray.length}`
    );

    // ========================================================
    // FIRST PASS
    // ========================================================

    const approvedBoard =
      [];

    for (
      const item of
      trainsArray
    ) {
      const train =
        item?.train ||
        {};

      const trainNo =
        normalizeTrainNumber(
          train.number ||
          item.number ||
          item.trainNumber
        );

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

      const live =
        item?.live ||
        {};

      const stop =
        item?.stop ||
        {};

      approvedBoard.push({
        item,
        train,
        live,
        stop,
        trainNo,
        corridor
      });
    }

    // ========================================================
    // REMOVE DUPLICATE TRAIN NUMBERS
    // ========================================================

    const uniqueMap =
      new Map();

    for (
      const record of
      approvedBoard
    ) {
      if (
        !uniqueMap.has(
          record.trainNo
        )
      ) {
        uniqueMap.set(
          record.trainNo,
          record
        );
      }
    }

    const uniqueApproved =
      Array.from(
        uniqueMap.values()
      );

    console.log(
      `Approved unique trains: ${uniqueApproved.length}`
    );

    // ========================================================
    // LIVE REQUEST COUNTER
    // ========================================================

    let liveRequests = 0;

    // ========================================================
    // PROCESS TRAINS
    // ========================================================

    const processedTrains =
      [];

    for (
      const record of
      uniqueApproved
    ) {
      const {
        item,
        train,
        trainNo,
        corridor
      } = record;

      let live =
        record.live ||
        {};

      const stop =
        record.stop ||
        {};

      // ------------------------------------------------------
      // ALWAYS REQUEST FRESH LIVE DATA
      // ------------------------------------------------------

      if (
        liveRequests <
        MAX_LIVE_REQUESTS
      ) {
        liveRequests++;

        const freshLive =
          await fetchLiveTrain(
            trainNo
          );

        if (
          freshLive
        ) {
          live =
            {
              ...live,
              ...freshLive
            };

          console.log(
            `[LIVE RESULT] ${trainNo} | GPS DATA RECEIVED`
          );
        } else {
          console.log(
            `[LIVE RESULT] ${trainNo} | GPS NOT AVAILABLE`
          );
        }
      } else {
        console.log(
          `[LIVE LIMIT] ${trainNo} | Maximum live requests reached`
        );
      }

      // ------------------------------------------------------
      // COORDINATES
      // ------------------------------------------------------

      const coordinates =
        getCoordinates(
          train,
          live,
          item
        );

      // ------------------------------------------------------
      // GUDUR STATUS
      // ------------------------------------------------------

      const trainIsAtGudur =
        isAtGudur(
          train,
          live,
          stop,
          item,
          coordinates
        );

      const departedGudur =
        hasDepartedGudur(
          train,
          live,
          stop,
          item
        );

      // ------------------------------------------------------
      // GATE DISTANCE
      // ------------------------------------------------------

      const gateDistance =
        getDistanceToGate(
          coordinates,
          corridor
        );

      // ------------------------------------------------------
      // DELAY
      // ------------------------------------------------------

      const delayMin =
        getDelayMinutes(
          live,
          item
        );

      // ------------------------------------------------------
      // ETA
      // ------------------------------------------------------

      const etaMinutes =
        getVerifiedEta(
          train,
          live,
          stop,
          item,
          coordinates,
          trainIsAtGudur,
          departedGudur,
          currentMin
        );

      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------

      const status =
        getTrainStatus(
          trainIsAtGudur,
          departedGudur,
          etaMinutes
        );

      // ------------------------------------------------------
      // PHYSICAL POSITION CHECK
      // ------------------------------------------------------

      const hasPhysicalPosition =
        coordinates !== null;

      // ------------------------------------------------------
      // WARNING
      //
      // Train is between:
      //
      // 1.00 km and 0.60 km
      //
      // from its corresponding gate.
      // ------------------------------------------------------

      const gateWarning =
        hasPhysicalPosition &&
        !trainIsAtGudur &&
        gateDistance !== null &&
        gateDistance <=
          GATE_WARNING_DISTANCE_KM &&
        gateDistance >
          GATE_CLOSE_DISTANCE_KM;

      // ------------------------------------------------------
      // CLOSED
      //
      // Train is at or inside:
      //
      // 0.60 km
      //
      // from the corresponding gate.
      //
      // IMPORTANT:
      // departedGudur is NOT required.
      // ------------------------------------------------------

      const gateClosed =
        hasPhysicalPosition &&
        !trainIsAtGudur &&
        gateDistance !== null &&
        gateDistance <=
          GATE_CLOSE_DISTANCE_KM;

      const trainName =
        getTrainName(
          train,
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

      // ------------------------------------------------------
      // LOG
      // ------------------------------------------------------

      console.log(
        `[TRAIN] ${trainNo} | ${trainName} | ${corridor} | ETA=${etaMinutes === null ? "--" : `${etaMinutes}m`} | gateDistance=${gateDistance === null ? "--" : `${gateDistance.toFixed(3)}km`} | warning=${gateWarning} | closed=${gateClosed} | atGDR=${trainIsAtGudur} | departed=${departedGudur}`
      );

      // ------------------------------------------------------
      // STORE TRAIN
      // ------------------------------------------------------

      processedTrains.push({
        trainNo,

        name:
          trainName,

        origin:
          origin ||
          "Southern side",

        destination:
          destination ||
          "Gudur",

        corridor,

        status,

        etaMinutes,

        delayMinutes:
          delayMin,

        hasPhysicalPosition,

        gateDistanceKm:
          gateDistance === null
            ? null
            : Number(
                gateDistance.toFixed(
                  3
                )
              ),

        gateWarning,

        gateClosed,

        atGudur:
          trainIsAtGudur,

        departedGudur,

        direction:
          gateDistance !== null &&
          !trainIsAtGudur
            ? "TOWARD GUDUR"
            : "TOWARD GUDUR",

        platform:
          String(
            live.platform ||
            item.platform ||
            "1"
          )
      });
    }

    // ========================================================
    // DEDUPLICATE PROCESSED TRAINS
    // ========================================================

    const deduplicatedTrains =
      deduplicateBoard(
        processedTrains
      );

    // ========================================================
    // UPCOMING TRAINS
    // ========================================================

    const upcomingList =
      deduplicatedTrains
        .filter(
          (train) =>
            train.corridor ===
              "MAS" ||
            train.corridor ===
              "TPTY" ||
            train.corridor ===
              "OTHER"
        )
        .filter(
          (train) =>
            train.etaMinutes !==
              null &&
            train.etaMinutes >=
              0 &&
            train.etaMinutes <=
              180
        )
        .sort(
          (a, b) =>
            a.etaMinutes -
            b.etaMinutes
        );

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let chennaiGate =
      createOpenGate();

    let tirupatiGate =
      createOpenGate();

    // ========================================================
    // FIND ACTIVE CLOSURES
    // ========================================================

    const chennaiCandidates =
      deduplicatedTrains
        .filter(
          (train) =>
            train.corridor ===
              "MAS" &&
            train.gateClosed
        )
        .sort(
          (a, b) =>
            a.gateDistanceKm -
            b.gateDistanceKm
        );

    const tirupatiCandidates =
      deduplicatedTrains
        .filter(
          (train) =>
            train.corridor ===
              "TPTY" &&
            train.gateClosed
        )
        .sort(
          (a, b) =>
            a.gateDistanceKm -
            b.gateDistanceKm
        );

    // ========================================================
    // CHENNAI GATE
    // ========================================================

    if (
      chennaiCandidates.length >
      0
    ) {
      const train =
        chennaiCandidates[0];

      const waitMinutes =
        Math.max(
          1,
          train.etaMinutes !== null
            ? train.etaMinutes + 2
            : 5
        );

      chennaiGate = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          `${train.trainNo} ${train.name}`,

        direction:
          "TOWARD GUDUR",

        corridor:
          "MAS",

        trainNo:
          train.trainNo,

        gateDistanceKm:
          train.gateDistanceKm,

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM
      };
    } else {
      // ------------------------------------------------------
      // WARNING ONLY
      // ------------------------------------------------------

      const warningTrain =
        deduplicatedTrains
          .filter(
            (train) =>
              train.corridor ===
                "MAS" &&
              train.gateWarning
          )
          .sort(
            (a, b) =>
              a.gateDistanceKm -
              b.gateDistanceKm
          )[0];

      if (
        warningTrain
      ) {
        chennaiGate = {
          status:
            "WARNING",

          waitMinutes:
            Math.max(
              1,
              warningTrain.etaMinutes ??
                2
            ),

          activeTrain:
            `${warningTrain.trainNo} ${warningTrain.name}`,

          direction:
            "TOWARD GUDUR",

          corridor:
            "MAS",

          trainNo:
            warningTrain.trainNo,

          gateDistanceKm:
            warningTrain.gateDistanceKm,

          warningDistanceKm:
            GATE_WARNING_DISTANCE_KM,

          closeDistanceKm:
            GATE_CLOSE_DISTANCE_KM
        };
      }
    }

    // ========================================================
    // TIRUPATI GATE
    // ========================================================

    if (
      tirupatiCandidates.length >
      0
    ) {
      const train =
        tirupatiCandidates[0];

      const waitMinutes =
        Math.max(
          1,
          train.etaMinutes !== null
            ? train.etaMinutes + 2
            : 5
        );

      tirupatiGate = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          `${train.trainNo} ${train.name}`,

        direction:
          "TOWARD GUDUR",

        corridor:
          "TPTY",

        trainNo:
          train.trainNo,

        gateDistanceKm:
          train.gateDistanceKm,

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM
      };
    } else {
      // ------------------------------------------------------
      // WARNING ONLY
      // ------------------------------------------------------

      const warningTrain =
        deduplicatedTrains
          .filter(
            (train) =>
              train.corridor ===
                "TPTY" &&
              train.gateWarning
          )
          .sort(
            (a, b) =>
              a.gateDistanceKm -
              b.gateDistanceKm
          )[0];

      if (
        warningTrain
      ) {
        tirupatiGate = {
          status:
            "WARNING",

          waitMinutes:
            Math.max(
              1,
              warningTrain.etaMinutes ??
                2
            ),

          activeTrain:
            `${warningTrain.trainNo} ${warningTrain.name}`,

          direction:
            "TOWARD GUDUR",

          corridor:
            "TPTY",

          trainNo:
            warningTrain.trainNo,

          gateDistanceKm:
            warningTrain.gateDistanceKm,

          warningDistanceKm:
            GATE_WARNING_DISTANCE_KM,

          closeDistanceKm:
            GATE_CLOSE_DISTANCE_KM
        };
      }
    }

    // ========================================================
    // FIREBASE DATA
    // ========================================================

    const firebaseData = {
      tirupatiGate,

      chennaiGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toISOString(),

      lastUpdatedLocal:
        now.toLocaleString(),

      meta: {
        version:
          "V9",

        strictTrainNumbers:
          true,

        unknownTrainsIgnored:
          true,

        duplicateTrainsRemoved:
          true,

        liveGps:
          true,

        freshGpsEveryWorkflowRun:
          true,

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        clearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        gateClosure:
          "LIVE_PHYSICAL_POSITION",

        departedGudurRequired:
          false
      }
    };

    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    await gateRef.set(
      firebaseData
    );

    // ========================================================
    // SUCCESS LOGS
    // ========================================================

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
      `Chennai Gate : ${chennaiGate.status} | ${chennaiGate.activeTrain}`
    );

    console.log(
      `Tirupati Gate: ${tirupatiGate.status} | ${tirupatiGate.activeTrain}`
    );

    console.log(
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live requests used: ${liveRequests}/${MAX_LIVE_REQUESTS}`
    );

    // ========================================================
    // SHOW UPCOMING TRAINS
    // ========================================================

    if (
      topUpcoming.length >
      0
    ) {
      console.log(
        "\n[INBOUND TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (train) => {
          console.log(
            `   ${train.corridor} | ${train.trainNo} ${train.name} | ETA ${train.etaMinutes}m | Gate ${train.gateDistanceKm === null ? "--" : `${train.gateDistanceKm}km`} | warning=${train.gateWarning} | closed=${train.gateClosed}`
          );
        }
      );
    } else {
      console.log(
        "\n[INBOUND TRAINS TO GUDUR] None"
      );
    }

    console.log(
      "\n=========================================="
    );

    console.log(
      "Firebase update completed."
    );

    console.log(
      "=========================================="
    );

  } catch (error) {
    // ========================================================
    // ERROR HANDLING
    // ========================================================

    console.error(
      "\n=========================================="
    );

    console.error(
      "MONITOR ERROR"
    );

    console.error(
      "=========================================="
    );

    if (
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );

      console.error(
        "Response:",
        error.response.data
      );
    } else {
      console.error(
        error.message
      );
    }

    throw error;
  }
}

// ============================================================
// START APPLICATION
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor V9 "
);

console.log(
  "=========================================="
);

console.log(
  "Gudur Station:"
);

console.log(
  "14.1451694 N, 79.8443472 E"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Chennai Gate:"
);

console.log(
  "14.1396667 N, 79.8441278 E"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Tirupati Gate:"
);

console.log(
  "14.1402028 N, 79.8435972 E"
);

console.log(
  "=========================================="
);

console.log(
  "Strict train numbers: ENABLED"
);

console.log(
  "Unknown trains: IGNORED"
);

console.log(
  "Duplicate trains: REMOVED"
);

console.log(
  "Live GPS: ENABLED"
);

console.log(
  "Fresh GPS: EVERY WORKFLOW RUN"
);

console.log(
  "Warning distance: 1.00 km"
);

console.log(
  "Close distance: 0.60 km"
);

console.log(
  "Clear distance: 0.80 km"
);

console.log(
  "Gate closure: LIVE PHYSICAL POSITION"
);

console.log(
  "departedGudur required: NO"
);

console.log(
  "Firebase: CONFIGURED"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================
//
// IMPORTANT:
//
// GitHub Actions runs this program once.
// After Firebase is updated, we explicitly close
// the Firebase Admin connection and exit cleanly.
//
// This prevents:
// "Error: The operation was canceled."
//
// ============================================================

async function main() {
  try {
    await updateGateSystem();

    console.log(
      "Monitor run completed successfully."
    );

    console.log(
      "Closing Firebase connection..."
    );

    try {
      await admin.app().delete();

      console.log(
        "Firebase connection closed."
      );
    } catch (firebaseCloseError) {
      console.error(
        "Firebase close warning:",
        firebaseCloseError.message
      );
    }

    console.log(
      "Exiting successfully."
    );

    process.exit(0);

  } catch (error) {
    console.error(
      "\n❌ Monitor run failed."
    );

    try {
      await admin.app().delete();
    } catch (_) {
      // Ignore cleanup error
    }

    process.exit(1);
  }
}

// ============================================================
// START
// ============================================================

main();
