const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

// ------------------------------------------------------------
// GitHub Actions secret
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
// Local fallback
// ------------------------------------------------------------

if (!serviceAccount) {
  try {
    serviceAccount =
      require("./serviceAccountKey.json");

    console.log(
      "✅ Firebase service account loaded from serviceAccountKey.json."
    );
  } catch (error) {
    console.error(
      "❌ Could not load Firebase service account."
    );

    console.error(
      "For GitHub Actions, create FIREBASE_SERVICE_ACCOUNT."
    );

    console.error(
      "For local testing, put serviceAccountKey.json beside code.js."
    );

    console.error(
      error.message
    );

    process.exit(1);
  }
}

// ============================================================
// FIREBASE INITIALIZATION
// ============================================================

admin.initializeApp({
  credential:
    cert(serviceAccount),

  databaseURL:
    "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db =
  getDatabase();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY ||
  "YOUR_RAILRADAR_API_KEY";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// LOCATIONS
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
// DISTANCES
// ============================================================

const APPROACHING_GUDUR_DISTANCE_KM =
  1.00;

const GATE_WARNING_DISTANCE_KM =
  1.00;

const GATE_CLOSE_DISTANCE_KM =
  0.60;

const GATE_CLEAR_DISTANCE_KM =
  0.80;

// ============================================================
// UPCOMING TRAIN WINDOW
// ============================================================
//
// RailRadar station request asks for 4 hours.
// Therefore use 240 minutes here.
//
// ============================================================

const UPCOMING_WINDOW_MINUTES =
  240;

// ============================================================
// LIVE REQUEST LIMIT
// ============================================================

const MAX_LIVE_REQUESTS =
  8;

// ============================================================
// APPROVED TIRUPATI TRAINS
// ============================================================

const TPTY_TRAINS =
  new Set([
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
// APPROVED CHENNAI TRAINS
// ============================================================

const MAS_TRAINS =
  new Set([
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

const OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "20498",
    "67226"
  ]);

// ============================================================
// NORMALIZE TEXT
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

// ============================================================
// NORMALIZE TRAIN NUMBER
// ============================================================

function normalizeTrainNumber(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .trim()
    .replace(
      /\s+/g,
      ""
    );
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================

function determineCorridor(
  trainNo
) {
  const number =
    normalizeTrainNumber(
      trainNo
    );

  if (
    TPTY_TRAINS.has(
      number
    )
  ) {
    return "TPTY";
  }

  if (
    MAS_TRAINS.has(
      number
    )
  ) {
    return "MAS";
  }

  if (
    OTHER_TRAINS.has(
      number
    )
  ) {
    return "OTHER";
  }

  return null;
}

// ============================================================
// HAVERSINE
// ============================================================

function haversineDistanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R =
    6371;

  const dLat =
    ((lat2 - lat1) *
      Math.PI) /
    180;

  const dLon =
    ((lon2 - lon1) *
      Math.PI) /
    180;

  const a =
    Math.sin(
      dLat / 2
    ) *
      Math.sin(
        dLat / 2
      ) +
    Math.cos(
      (lat1 * Math.PI) /
        180
    ) *
      Math.cos(
        (lat2 * Math.PI) /
          180
      ) *
      Math.sin(
        dLon / 2
      ) *
      Math.sin(
        dLon / 2
      );

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return (
    R * c
  );
}

// ============================================================
// GET COORDINATES
// ============================================================

function getCoordinates(
  train,
  live,
  item
) {
  const candidates = [
    live?.currentLocation
      ?.coordinates,

    live?.currentLocation,

    live?.coordinates,

    live?.position,

    train?.currentLocation
      ?.coordinates,

    train?.currentLocation,

    train?.coordinates,

    train?.position,

    item?.currentLocation
      ?.coordinates,

    item?.currentLocation,

    item?.coordinates,

    item?.position
  ];

  for (
    const value of candidates
  ) {
    if (!value) {
      continue;
    }

    // --------------------------------------------------------
    // Array
    // --------------------------------------------------------

    if (
      Array.isArray(value) &&
      value.length >= 2
    ) {
      const first =
        Number(value[0]);

      const second =
        Number(value[1]);

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
    // Object
    // --------------------------------------------------------

    if (
      typeof value ===
      "object"
    ) {
      const lat =
        Number(
          value.lat ??
            value.latitude ??
            value.Latitude
        );

      const lng =
        Number(
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

      // GeoJSON

      if (
        Array.isArray(
          value.coordinates
        ) &&
        value.coordinates.length >=
          2
      ) {
        const lng2 =
          Number(
            value.coordinates[0]
          );

        const lat2 =
          Number(
            value.coordinates[1]
          );

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
// TRAIN NAME
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
// ORIGIN
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
// DESTINATION
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
// DELAY
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

  for (
    const value of values
  ) {
    const number =
      Number(value);

    if (
      Number.isFinite(
        number
      )
    ) {
      return number;
    }
  }

  return 0;
}

// ============================================================
// SAFE DATE PARSER
// ============================================================

function parseRailDate(
  value
) {
  if (!value) {
    return null;
  }

  // ----------------------------------------------------------
  // Date object
  // ----------------------------------------------------------

  if (
    value instanceof Date
  ) {
    if (
      !isNaN(
        value.getTime()
      )
    ) {
      return value;
    }

    return null;
  }

  // ----------------------------------------------------------
  // Numeric timestamp
  // ----------------------------------------------------------

  if (
    typeof value ===
    "number"
  ) {
    const date =
      new Date(value);

    if (
      !isNaN(
        date.getTime()
      )
    ) {
      return date;
    }

    return null;
  }

  const text =
    String(value).trim();

  if (!text) {
    return null;
  }

  // ----------------------------------------------------------
  // ISO / normal date
  // ----------------------------------------------------------

  const normalDate =
    new Date(text);

  if (
    !isNaN(
      normalDate.getTime()
    )
  ) {
    return normalDate;
  }

  return null;
}

// ============================================================
// GET TIME COMPONENTS
// ============================================================

function parseClockTime(
  value
) {
  if (!value) {
    return null;
  }

  const text =
    String(value)
      .trim();

  const match =
    text.match(
      /(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return null;
  }

  const hours =
    parseInt(
      match[1],
      10
    );

  const minutes =
    parseInt(
      match[2],
      10
    );

  if (
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return {
    hours,
    minutes
  };
}

// ============================================================
// PARSE TIME TO MINUTES
// ============================================================
//
// Handles:
//
// 16:30
// 4:30 PM
// ISO timestamp
//
// ============================================================

function parseTimeToMinutes(
  value,
  currentDate,
  delayMinutes = 0
) {
  if (!value) {
    return -1;
  }

  // ----------------------------------------------------------
  // Date / timestamp
  // ----------------------------------------------------------

  const parsedDate =
    parseRailDate(
      value
    );

  if (
    parsedDate
  ) {
    const localHours =
      parsedDate.getHours();

    const localMinutes =
      parsedDate.getMinutes();

    return (
      localHours * 60 +
      localMinutes +
      Number(
        delayMinutes || 0
      )
    );
  }

  // ----------------------------------------------------------
  // Clock string
  // ----------------------------------------------------------

  const clock =
    parseClockTime(
      value
    );

  if (!clock) {
    return -1;
  }

  let result =
    clock.hours * 60 +
    clock.minutes;

  result +=
    Number(
      delayMinutes || 0
    );

  return result;
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
// GET ARRIVAL
// ============================================================

function getArrivalTime(
  train,
  live,
  stop,
  item
) {
  return (
    live?.expectedArrivalTime ||
    live?.expectedArrival ||
    stop?.arrival ||
    item?.expectedArrivalTime ||
    item?.arrival ||
    train?.arrival ||
    ""
  );
}

// ============================================================
// GET DEPARTURE
// ============================================================

function getDepartureTime(
  train,
  live,
  stop,
  item,
  arrivalTime
) {
  return (
    live?.expectedDepartureTime ||
    live?.expectedDeparture ||
    stop?.departure ||
    item?.expectedDepartureTime ||
    item?.departure ||
    train?.departure ||
    arrivalTime
  );
}

// ============================================================
// CHECK AT GUDUR
// ============================================================

function isAtGudur(
  train,
  live,
  stop,
  item,
  coordinates
) {
  const stationText =
    normalizeText(
      [
        stop?.station,
        stop?.stationCode,
        stop?.stationName,

        live?.station,
        live?.stationCode,
        live?.stationName,

        item?.station,
        item?.stationCode,
        item?.stationName,

        train?.station,
        train?.stationCode,
        train?.stationName
      ]
        .filter(Boolean)
        .join(" ")
    );

  if (
    stationText.includes(
      "GUDUR"
    ) ||
    stationText ===
      "GDR" ||
    stationText.includes(
      " GDR "
    )
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

  return (
    distance <= 0.20
  );
}

// ============================================================
// DEPARTED GUDUR
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
      item?.previousStopSequence ??
      -1
    );

  const previousWasGudur =
    previousStation.includes(
      "GUDUR"
    ) ||
    previousCode ===
      "GDR";

  return (
    previousWasGudur &&
    sequence >= 0 &&
    previousSequence >= 0 &&
    sequence >
      previousSequence
  );
}

// ============================================================
// GATE COORDINATES
// ============================================================

function getGateCoordinates(
  corridor
) {
  if (
    corridor === "MAS"
  ) {
    return CHENNAI_GATE;
  }

  if (
    corridor === "TPTY"
  ) {
    return TIRUPATI_GATE;
  }

  return null;
}

// ============================================================
// DISTANCE TO GATE
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
// VERIFIED ETA
// ============================================================

function getVerifiedEta(
  train,
  live,
  stop,
  item,
  coordinates,
  atGudur,
  departedGudur,
  currentMin,
  currentDate
) {
  // ----------------------------------------------------------
  // At Gudur
  // ----------------------------------------------------------

  if (atGudur) {
    return 0;
  }

  // ----------------------------------------------------------
  // Already departed Gudur
  // ----------------------------------------------------------

  if (departedGudur) {
    return null;
  }

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

  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // If RailRadar supplies an ISO timestamp containing
  // a timezone, calculate using the actual timestamp.
  //
  // Otherwise use clock time.
  // ----------------------------------------------------------

  const parsedDate =
    parseRailDate(
      arrivalTime
    );

  if (
    parsedDate
  ) {
    const nowMs =
      currentDate.getTime();

    const arrivalMs =
      parsedDate.getTime() +
      Number(
        delayMinutes || 0
      ) *
        60000;

    let diffMinutes =
      Math.round(
        (arrivalMs -
          nowMs) /
          60000
      );

    // Handle date-less / odd API dates

    if (
      diffMinutes < -720
    ) {
      diffMinutes +=
        1440;
    }

    if (
      diffMinutes > 720
    ) {
      diffMinutes -=
        1440;
    }

    if (
      diffMinutes >= -15 &&
      diffMinutes <=
        UPCOMING_WINDOW_MINUTES
    ) {
      return Math.max(
        0,
        diffMinutes
      );
    }
  }

  // ----------------------------------------------------------
  // Clock-only fallback
  // ----------------------------------------------------------

  const arrivalMinutes =
    parseTimeToMinutes(
      arrivalTime,
      currentDate,
      delayMinutes
    );

  if (
    arrivalMinutes !== -1
  ) {
    const diff =
      calculateTimeDifference(
        arrivalMinutes,
        currentMin
      );

    if (
      diff >= -15 &&
      diff <=
        UPCOMING_WINDOW_MINUTES
    ) {
      return Math.max(
        0,
        diff
      );
    }
  }

  // ----------------------------------------------------------
  // GPS SPEED FALLBACK
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
// DEDUPLICATE
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

  for (
    const train of trains
  ) {
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
      train.etaMinutes !==
        null &&
      existing.etaMinutes !==
        null &&
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
// OPEN GATE
// ============================================================

function createOpenGate() {
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
    " GUDUR CROSSING RADAR V10"
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
    "LIVE GPS: ENABLED"
  );

  console.log(
    "Fresh GPS: EVERY WORKFLOW RUN"
  );

  console.log(
    `Upcoming window: ${UPCOMING_WINDOW_MINUTES} minutes`
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

  // ==========================================================
  // STATION BOARD
  // ==========================================================

  console.log(
    "Fetching RailRadar GDR station board..."
  );

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

  // ==========================================================
  // APPROVED TRAINS
  // ==========================================================

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

  // ==========================================================
  // DEDUPLICATE BOARD
  // ==========================================================

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

  // ==========================================================
  // LIVE REQUEST COUNTER
  // ==========================================================

  let liveRequests = 0;

  // ==========================================================
  // PROCESSED TRAINS
  // ==========================================================

  const processedTrains =
    [];

  // ==========================================================
  // PROCESS
  // ==========================================================

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

    // --------------------------------------------------------
    // FRESH LIVE REQUEST
    // --------------------------------------------------------

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
        live = {
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
        `[LIVE LIMIT] ${trainNo}`
      );
    }

    // --------------------------------------------------------
    // COORDINATES
    // --------------------------------------------------------

    const coordinates =
      getCoordinates(
        train,
        live,
        item
      );

    // --------------------------------------------------------
    // GUDUR STATUS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // GATE DISTANCE
    // --------------------------------------------------------

    const gateDistance =
      getDistanceToGate(
        coordinates,
        corridor
      );

    // --------------------------------------------------------
    // DELAY
    // --------------------------------------------------------

    const delayMin =
      getDelayMinutes(
        live,
        item
      );

    // --------------------------------------------------------
    // ETA
    // --------------------------------------------------------

    const etaMinutes =
      getVerifiedEta(
        train,
        live,
        stop,
        item,
        coordinates,
        trainIsAtGudur,
        departedGudur,
        currentMin,
        now
      );

    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    const status =
      getTrainStatus(
        trainIsAtGudur,
        departedGudur,
        etaMinutes
      );

    // --------------------------------------------------------
    // PHYSICAL POSITION
    // --------------------------------------------------------

    const hasPhysicalPosition =
      coordinates !== null;

    // --------------------------------------------------------
    // WARNING
    // --------------------------------------------------------

    const gateWarning =
      hasPhysicalPosition &&
      !trainIsAtGudur &&
      gateDistance !== null &&
      gateDistance <=
        GATE_WARNING_DISTANCE_KM &&
      gateDistance >
        GATE_CLOSE_DISTANCE_KM;

    // --------------------------------------------------------
    // CLOSED
    // --------------------------------------------------------

    const gateClosed =
      hasPhysicalPosition &&
      !trainIsAtGudur &&
      gateDistance !== null &&
      gateDistance <=
        GATE_CLOSE_DISTANCE_KM;

    // --------------------------------------------------------
    // INFORMATION
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // LOG
    // --------------------------------------------------------

    console.log(
      `[TRAIN] ${trainNo} | ${trainName} | ${corridor} | ETA=${etaMinutes === null ? "--" : `${etaMinutes}m`} | gateDistance=${gateDistance === null ? "--" : `${gateDistance.toFixed(3)}km`} | warning=${gateWarning} | closed=${gateClosed} | atGDR=${trainIsAtGudur} | departed=${departedGudur}`
    );

    // --------------------------------------------------------
    // STORE
    // --------------------------------------------------------

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
        gateDistance ===
        null
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
        "TOWARD GUDUR",

      platform:
        String(
          live.platform ||
          item.platform ||
          "1"
        )
    });
  }

  // ==========================================================
  // DEDUPLICATED FINAL LIST
  // ==========================================================

  const deduplicatedTrains =
    deduplicateBoard(
      processedTrains
    );

  // ==========================================================
  // UPCOMING TRAINS
  // ==========================================================
  //
  // IMPORTANT:
  //
  // We ALWAYS create the upcomingTrains array.
  //
  // Then we convert it to an object for Firebase.
  //
  // Firebase will therefore retain the node even when
  // there are no trains.
  //
  // ==========================================================

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
            UPCOMING_WINDOW_MINUTES
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

  // ==========================================================
  // LOG UPCOMING FILTER
  // ==========================================================

  console.log(
    "\n[UPCOMING TRAIN FILTER]"
  );

  if (
    deduplicatedTrains.length ===
    0
  ) {
    console.log(
      "No approved trains available."
    );
  }

  for (
    const train of
    deduplicatedTrains
  ) {
    if (
      train.etaMinutes ===
      null
    ) {
      console.log(
        `[EXCLUDED] ${train.trainNo} | ETA unavailable`
      );

      continue;
    }

    if (
      train.etaMinutes <
      0
    ) {
      console.log(
        `[EXCLUDED] ${train.trainNo} | ETA negative`
      );

      continue;
    }

    if (
      train.etaMinutes >
      UPCOMING_WINDOW_MINUTES
    ) {
      console.log(
        `[EXCLUDED] ${train.trainNo} | ETA ${train.etaMinutes}m > ${UPCOMING_WINDOW_MINUTES}m`
      );

      continue;
    }

    console.log(
      `[INCLUDED] ${train.trainNo} | ETA ${train.etaMinutes}m | corridor=${train.corridor}`
    );
  }

  // ==========================================================
  // DEFAULT GATES
  // ==========================================================

  let chennaiGate =
    createOpenGate();

  let tirupatiGate =
    createOpenGate();

  // ==========================================================
  // CHENNAI CLOSED
  // ==========================================================

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

  if (
    chennaiCandidates.length >
    0
  ) {
    const train =
      chennaiCandidates[0];

    chennaiGate = {
      status:
        "CLOSED",

      waitMinutes:
        Math.max(
          1,
          train.etaMinutes !==
            null
            ? train.etaMinutes +
                2
            : 5
        ),

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
    // --------------------------------------------------------
    // CHENNAI WARNING
    // --------------------------------------------------------

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

  // ==========================================================
  // TIRUPATI CLOSED
  // ==========================================================

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

  if (
    tirupatiCandidates.length >
    0
  ) {
    const train =
      tirupatiCandidates[0];

    tirupatiGate = {
      status:
        "CLOSED",

      waitMinutes:
        Math.max(
          1,
          train.etaMinutes !==
            null
            ? train.etaMinutes +
                2
            : 5
        ),

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
    // --------------------------------------------------------
    // TIRUPATI WARNING
    // --------------------------------------------------------

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

  // ==========================================================
  // FIREBASE UPCOMING OBJECT
  // ==========================================================
  //
  // IMPORTANT:
  //
  // Do NOT write an empty [] to Firebase.
  //
  // We use an object:
  //
  // {
  //   "0": {...},
  //   "1": {...}
  // }
  //
  // If there are zero trains, use:
  //
  // {}
  //
  // This guarantees that the upcomingTrains child exists.
  //
  // ==========================================================

  const upcomingTrainsFirebase =
    {};

  topUpcoming.forEach(
    (train, index) => {
      upcomingTrainsFirebase[
        String(index)
      ] = train;
    }
  );

  // ==========================================================
  // FIREBASE PAYLOAD
  // ==========================================================

  const firebaseData = {
    chennaiGate,

    tirupatiGate,

    upcomingTrains:
      upcomingTrainsFirebase,

    lastUpdated:
      now.toISOString(),

    lastUpdatedLocal:
      now.toLocaleString(),

    meta: {
      version:
        "V10",

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

      upcomingWindowMinutes:
        UPCOMING_WINDOW_MINUTES,

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

  // ==========================================================
  // SHOW WRITE DATA
  // ==========================================================

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
    `Upcoming trains to write: ${topUpcoming.length}`
  );

  if (
    topUpcoming.length >
    0
  ) {
    topUpcoming.forEach(
      (train, index) => {
        console.log(
          `   ${index + 1}. ${train.trainNo} | ${train.name} | ETA ${train.etaMinutes}m`
        );
      }
    );
  } else {
    console.log(
      "   No upcoming trains."
    );
  }

  console.log(
    `Chennai Gate: ${chennaiGate.status}`
  );

  console.log(
    `Tirupati Gate: ${tirupatiGate.status}`
  );

  // ==========================================================
  // FIREBASE WRITE
  // ==========================================================

  await gateRef.set(
    firebaseData
  );

  console.log(
    "✅ Firebase write completed."
  );

  // ==========================================================
  // FIREBASE VERIFICATION
  // ==========================================================

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

  const verifyData =
    verifySnapshot.val();

  if (
    !verifyData
  ) {
    throw new Error(
      "Firebase verification failed: gudur_gates is empty."
    );
  }

  // ----------------------------------------------------------
  // VERIFY UPCOMING NODE
  // ----------------------------------------------------------

  if (
    !Object.prototype.hasOwnProperty.call(
      verifyData,
      "upcomingTrains"
    )
  ) {
    throw new Error(
      "Firebase verification failed: upcomingTrains node does not exist."
    );
  }

  const verifiedUpcomingRaw =
    verifyData.upcomingTrains ||
    {};

  const verifiedUpcoming =
    Array.isArray(
      verifiedUpcomingRaw
    )
      ? verifiedUpcomingRaw
      : Object.values(
          verifiedUpcomingRaw
        );

  console.log(
    "✅ upcomingTrains node EXISTS."
  );

  console.log(
    `✅ Firebase upcomingTrains count: ${verifiedUpcoming.length}`
  );

  // ----------------------------------------------------------
  // VERIFY GATES
  // ----------------------------------------------------------

  if (
    verifyData.chennaiGate
  ) {
    console.log(
      `✅ Chennai Gate verified: ${verifyData.chennaiGate.status}`
    );
  } else {
    throw new Error(
      "Firebase verification failed: chennaiGate missing."
    );
  }

  if (
    verifyData.tirupatiGate
  ) {
    console.log(
      `✅ Tirupati Gate verified: ${verifyData.tirupatiGate.status}`
    );
  } else {
    throw new Error(
      "Firebase verification failed: tirupatiGate missing."
    );
  }

  // ----------------------------------------------------------
  // SHOW VERIFIED TRAINS
  // ----------------------------------------------------------

  if (
    verifiedUpcoming.length >
    0
  ) {
    console.log(
      "\n[VERIFIED FIREBASE UPCOMING TRAINS]"
    );

    verifiedUpcoming.forEach(
      (train, index) => {
        console.log(
          `   ${index + 1}. ${train.corridor || "--"} | ${train.trainNo || "--"} | ${train.name || "--"} | ETA ${train.etaMinutes ?? "--"}m`
        );
      }
    );
  } else {
    console.log(
      "\n[VERIFIED FIREBASE UPCOMING TRAINS] None"
    );
  }

  // ==========================================================
  // FINAL SUCCESS
  // ==========================================================

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
    `Upcoming trains: ${verifiedUpcoming.length}`
  );

  console.log(
    `Live requests used: ${liveRequests}/${MAX_LIVE_REQUESTS}`
  );

  console.log(
    "\n=========================================="
  );

  console.log(
    "Firebase update and verification completed."
  );

  console.log(
    "=========================================="
  );
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
  "Upcoming window: 240 minutes"
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
// LIVE TRAIN FUNCTION
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
    if (
      error.response
    ) {
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
// CLEAN EXIT
// ============================================================

async function main() {
  try {
    await updateGateSystem();

    console.log(
      "\nMonitor run completed successfully."
    );

    console.log(
      "Closing Firebase connection..."
    );

    try {
      await admin
        .app()
        .delete();

      console.log(
        "Firebase connection closed."
      );
    } catch (
      firebaseCloseError
    ) {
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

    try {
      await admin
        .app()
        .delete();
    } catch (_) {
      // Ignore cleanup error
    }

    process.exit(1);
  }
}

// ============================================================
// RUN
// ============================================================

main();
