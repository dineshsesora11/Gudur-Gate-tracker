const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing."
    );
  }

  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );
} catch (error) {
  console.error(
    "❌ Could not load FIREBASE_SERVICE_ACCOUNT."
  );
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = admin.database();

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
// GUDUR LOCATIONS
// ============================================================
//
// Coordinates supplied by user.
//
// Gudur Junction:
// 14°08'42.61"N 79°50'39.65"E
//
// Tirupati Gate:
// 14°08'24.73"N 79°50'36.95"E
//
// Chennai Gate:
// 14°08'22.80"N 79°50'38.86"E
//
// Distance from Junction to each gate:
// approximately 0.52 km
// ============================================================

const GDR_LAT = 14.1451694;
const GDR_LNG = 79.8443472;

const TIRUPATI_GATE_LAT = 14.1402028;
const TIRUPATI_GATE_LNG = 79.8435972;

const CHENNAI_GATE_LAT = 14.1396667;
const CHENNAI_GATE_LNG = 79.8441278;

// ============================================================
// GATE DISTANCE RULES
// ============================================================
//
// 1.00 km:
// Start active tracking.
//
// 0.52 km:
// Approximate physical gate position.
//
// 0.60 km:
// Close-zone safety radius.
//
// 0.80 km:
// Train has moved beyond gate zone.
//
// ============================================================

const TRACKING_DISTANCE_KM = 1.00;

const GATE_DISTANCE_KM = 0.52;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// UPCOMING CONFIGURATION
// ============================================================

const UPCOMING_MAX_ETA_MINUTES = 360;

const UPCOMING_DISPLAY_LIMIT = 15;

// ============================================================
// LIVE VERIFICATION
// ============================================================
//
// GitHub Actions runs every 5 minutes.
//
// Only a small number of trains are checked live.
// ============================================================

const LIVE_VERIFY_ETA_MINUTES = 60;

const MAX_LIVE_CALLS = 4;

// ============================================================
// TRACKING RETENTION
// ============================================================

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

  return values.some(
    (value) =>
      normalized.includes(
        normalizeText(value)
      )
  );
}

// ============================================================
// NUMBER HELPERS
// ============================================================

function toNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function safeEta(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  if (n < 0) {
    return 0;
  }

  return Math.round(n);
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
  const aLat = toNumber(lat1);
  const aLon = toNumber(lon1);
  const bLat = toNumber(lat2);
  const bLon = toNumber(lon2);

  if (
    aLat === null ||
    aLon === null ||
    bLat === null ||
    bLon === null
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    ((bLat - aLat) * Math.PI) /
    180;

  const dLon =
    ((bLon - aLon) * Math.PI) /
    180;

  const lat1Rad =
    (aLat * Math.PI) / 180;

  const lat2Rad =
    (bLat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(dLon / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  value,
  delayMinutes = 0
) {
  if (!value) {
    return null;
  }

  let minutes = null;

  const date =
    new Date(value);

  if (!isNaN(date.getTime())) {
    minutes =
      date.getHours() * 60 +
      date.getMinutes();
  }

  if (minutes === null) {
    const match =
      String(value)
        .trim()
        .match(
          /(\d{1,2}):(\d{2})/
        );

    if (match) {
      minutes =
        parseInt(
          match[1],
          10
        ) *
          60 +
        parseInt(
          match[2],
          10
        );
    }
  }

  if (minutes === null) {
    return null;
  }

  return (
    minutes +
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
  if (
    arrivalMinutes === null ||
    arrivalMinutes === undefined
  ) {
    return null;
  }

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
// GENERIC VALUE EXTRACTION
// ============================================================

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
    }
  }

  return "";
}

// ============================================================
// STATION CODE EXTRACTION
// ============================================================

function getStationCode(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value === "object"
  ) {
    return firstValue(
      value.code,
      value.stationCode,
      value.station_code
    );
  }

  return String(value).trim();
}

// ============================================================
// STATION NAME EXTRACTION
// ============================================================

function getStationName(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value === "object"
  ) {
    return firstValue(
      value.name,
      value.stationName,
      value.station_name
    );
  }

  return String(value).trim();
}

// ============================================================
// ORIGIN EXTRACTION
// ============================================================

function getOriginObject(
  train,
  item
) {
  return firstValue(
    train.source,
    train.origin,
    train.from,
    train.fromStation,
    train.startStation,

    item.source,
    item.origin,
    item.from,
    item.fromStation,
    item.startStation
  );
}

function getOriginCode(
  train,
  item
) {
  const origin =
    getOriginObject(
      train,
      item
    );

  return getStationCode(
    origin
  );
}

function getOriginName(
  train,
  item
) {
  const origin =
    getOriginObject(
      train,
      item
    );

  return getStationName(
    origin
  );
}

// ============================================================
// DESTINATION EXTRACTION
// ============================================================

function getDestinationObject(
  train,
  item
) {
  return firstValue(
    train.destination,
    train.to,
    train.destinationStation,
    train.endStation,

    item.destination,
    item.to,
    item.destinationStation,
    item.endStation
  );
}

function getDestinationCode(
  train,
  item
) {
  const destination =
    getDestinationObject(
      train,
      item
    );

  return getStationCode(
    destination
  );
}

function getDestinationName(
  train,
  item
) {
  const destination =
    getDestinationObject(
      train,
      item
    );

  return getStationName(
    destination
  );
}

// ============================================================
// KNOWN DESTINATION GROUPS
// ============================================================
//
// If destination is toward Chennai / Arakkonam:
// MAS corridor.
//
// If destination is toward Tirupati / Katpadi:
// TPTY corridor.
//
// ============================================================

const CHENNAI_DESTINATIONS =
  new Set([
    "MAS",
    "MS",
    "TBM",
    "CGL",
    "AJJ",
    "MLPM",
    "PER",
    "AVD",
    "MSB",
    "MMC",
    "SPE",
    "TRL"
  ]);

const TIRUPATI_DESTINATIONS =
  new Set([
    "TPTY",
    "RU",
    "KPD",
    "CTO",
    "VGA",
    "SKL"
  ]);

// ============================================================
// TRAIN NAME FALLBACK
// ============================================================

function corridorFromTrainName(
  trainName
) {
  const name =
    normalizeText(
      trainName
    );

  if (
    name.includes(
      "TIRUPATI"
    ) ||
    name.includes(
      "NARAYANADRI"
    ) ||
    name.includes(
      "PADMAVATHI"
    ) ||
    name.includes(
      "VENKATADRI"
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// CORRIDOR DETECTION
// ============================================================
//
// IMPORTANT:
//
// We use the train's destination / route.
//
// This does NOT mean that a train merely going TO Chennai
// should close Chennai Gate immediately.
//
// Gate closing happens only after the train leaves Gudur
// and moves into the appropriate branch.
// ============================================================

function determineCorridor(
  train,
  item
) {
  const destinationCode =
    normalizeText(
      getDestinationCode(
        train,
        item
      )
    );

  const destinationName =
    normalizeText(
      getDestinationName(
        train,
        item
      )
    );

  const trainName =
    firstValue(
      train.name,
      item.name
    );

  // ----------------------------------------------------------
  // TIRUPATI / KATPADI
  // ----------------------------------------------------------

  if (
    TIRUPATI_DESTINATIONS.has(
      destinationCode
    ) ||
    containsAny(
      destinationName,
      [
        "TIRUPATI",
        "KATPAD",
        "RENIGUNTA"
      ]
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI / ARAKKONAM
  // ----------------------------------------------------------

  if (
    CHENNAI_DESTINATIONS.has(
      destinationCode
    ) ||
    containsAny(
      destinationName,
      [
        "CHENNAI",
        "ARAKKONAM",
        "TAMBARAM",
        "MELPAKKAM"
      ]
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // NAME FALLBACK
  // ----------------------------------------------------------

  return corridorFromTrainName(
    trainName
  );
}

// ============================================================
// BOARD ARRIVAL TIME
// ============================================================

function getArrivalTime(
  train,
  live,
  stop,
  item
) {
  return firstValue(
    stop.arrival,
    stop.expectedArrival,

    live.expectedArrivalTime,
    live.arrivalTime,

    item.expectedArrivalTime,
    item.arrivalTime,

    train.expectedArrivalTime
  );
}

// ============================================================
// PLATFORM
// ============================================================

function getPlatform(
  train,
  live,
  stop,
  item
) {
  return firstValue(
    live.platform,
    stop.platform,
    item.platform,
    train.platform,
    "—"
  );
}

// ============================================================
// CURRENT LIVE LOCATION
// ============================================================

function getLiveCoordinates(
  currentLocation
) {
  if (
    !currentLocation ||
    typeof currentLocation !==
      "object"
  ) {
    return null;
  }

  const lat =
    firstValue(
      currentLocation.latitude,
      currentLocation.lat
    );

  const lng =
    firstValue(
      currentLocation.longitude,
      currentLocation.lng,
      currentLocation.lon
    );

  const latitude =
    toNumber(lat);

  const longitude =
    toNumber(lng);

  if (
    latitude === null ||
    longitude === null
  ) {
    return null;
  }

  return {
    lat: latitude,
    lng: longitude
  };
}

// ============================================================
// LIVE STATUS
// ============================================================

function getLiveStatus(
  currentLocation
) {
  return normalizeText(
    firstValue(
      currentLocation?.status,
      ""
    )
  );
}

// ============================================================
// STATION DETECTION
// ============================================================

function isAtGudurStation(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  const code =
    normalizeText(
      firstValue(
        currentLocation.stationCode,
        currentLocation.code
      )
    );

  const name =
    normalizeText(
      firstValue(
        currentLocation.stationName,
        currentLocation.name
      )
    );

  return (
    code === "GDR" ||
    name.includes("GUDUR")
  );
}

// ============================================================
// MOVEMENT DETECTION
// ============================================================

function isTrainMoving(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  const status =
    getLiveStatus(
      currentLocation
    );

  const speed =
    toNumber(
      firstValue(
        currentLocation.speedKmh,
        currentLocation.speed,
        currentLocation.velocity
      )
    );

  if (
    speed !== null &&
    speed > 2
  ) {
    return true;
  }

  return (
    status.includes("RUNNING") ||
    status.includes("MOVING") ||
    status.includes("DEPARTED")
  );
}

// ============================================================
// EXPLICIT DEPARTURE DETECTION
// ============================================================

function isExplicitlyDeparted(
  currentLocation
) {
  const status =
    getLiveStatus(
      currentLocation
    );

  return (
    status === "DEPARTED" ||
    status.includes(
      "DEPARTED"
    )
  );
}

// ============================================================
// GATE COORDINATES
// ============================================================

function getGateCoordinates(
  corridor
) {
  if (
    corridor === "TPTY"
  ) {
    return {
      lat:
        TIRUPATI_GATE_LAT,
      lng:
        TIRUPATI_GATE_LNG
    };
  }

  if (
    corridor === "MAS"
  ) {
    return {
      lat:
        CHENNAI_GATE_LAT,
      lng:
        CHENNAI_GATE_LNG
    };
  }

  return null;
}

// ============================================================
// DISTANCE TO GATE
// ============================================================

function getDistanceToGate(
  corridor,
  currentLocation
) {
  const coords =
    getLiveCoordinates(
      currentLocation
    );

  const gate =
    getGateCoordinates(
      corridor
    );

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
// TRACKING RECORD
// ============================================================

function makeTrackingRecord(
  data
) {
  return {
    trainNo:
      String(
        data.trainNo || ""
      ),

    name:
      data.name ||
      `Train ${data.trainNo}`,

    corridor:
      data.corridor ||
      null,

    origin:
      data.origin ||
      "",

    destination:
      data.destination ||
      "",

    platform:
      data.platform ||
      "—",

    etaMinutes:
      safeEta(
        data.etaMinutes
      ),

    delayMinutes:
      Number(
        data.delayMinutes || 0
      ),

    state:
      data.state ||
      "APPROACHING_GUDUR",

    lastDistanceKm:
      Number.isFinite(
        Number(
          data.lastDistanceKm
        )
      )
        ? Number(
            data.lastDistanceKm
          )
        : null,

    lastLiveStatus:
      data.lastLiveStatus ||
      "",

    lastStation:
      data.lastStation ||
      "",

    lastSeen:
      data.lastSeen ||
      new Date().toISOString()
  };
}

// ============================================================
// STATE PRIORITY
// ============================================================

function statePriority(
  state
) {
  switch (state) {
    case "AT_GATE":
      return 5;

    case "DEPARTED_GUDUR":
      return 4;

    case "AT_GUDUR_STATION":
      return 3;

    case "APPROACHING_GUDUR":
      return 2;

    default:
      return 1;
  }
}

// ============================================================
// UPDATE TRACKING STATE
// ============================================================

function updateTrackingFromLive(
  record,
  liveData
) {
  const currentLocation =
    liveData?.data
      ?.currentLocation ||
    null;

  if (
    !currentLocation
  ) {
    return record;
  }

  const newRecord = {
    ...record
  };

  const liveStatus =
    getLiveStatus(
      currentLocation
    );

  const stationCode =
    normalizeText(
      firstValue(
        currentLocation.stationCode,
        currentLocation.code
      )
    );

  const stationName =
    firstValue(
      currentLocation.stationName,
      currentLocation.name
    );

  const actual =
    currentLocation.isActualPosition ===
    true;

  const distance =
    getDistanceToGate(
      record.corridor,
      currentLocation
    );

  const atGudur =
    isAtGudurStation(
      currentLocation
    );

  const moving =
    isTrainMoving(
      currentLocation
    );

  const departed =
    isExplicitlyDeparted(
      currentLocation
    );

  newRecord.lastLiveStatus =
    liveStatus;

  newRecord.lastStation =
    stationCode ||
    stationName ||
    "";

  if (
    distance !== null
  ) {
    newRecord.lastDistanceKm =
      Number(
        distance.toFixed(3)
      );
  }

  newRecord.lastSeen =
    new Date().toISOString();

  // ==========================================================
  // RULE 1
  // TRAIN AT GUDUR PLATFORM
  // ==========================================================

  if (atGudur) {
    newRecord.state =
      "AT_GUDUR_STATION";

    console.log(
      `🟢 [AT GUDUR PLATFORM] ${record.trainNo} ${record.name} | ${record.corridor} | GATE OPEN`
    );

    return newRecord;
  }

  // ==========================================================
  // RULE 2
  // TRAIN EXPLICITLY DEPARTED
  // ==========================================================
  //
  // Even when GPS is unavailable, RailRadar's explicit
  // "departed" state means the train is no longer at GDR.
  //
  // Do NOT close the gate merely because it says departed.
  // We still need position / branch information.
  // ==========================================================

  if (
    departed &&
    newRecord.state ===
      "AT_GUDUR_STATION"
  ) {
    newRecord.state =
      "DEPARTED_GUDUR";
  }

  // ==========================================================
  // RULE 3
  // TRAIN MOVING AFTER GUDUR
  // ==========================================================

  if (
    moving &&
    newRecord.state ===
      "AT_GUDUR_STATION"
  ) {
    newRecord.state =
      "DEPARTED_GUDUR";

    console.log(
      `🚆 [DEPARTED GUDUR] ${record.trainNo} ${record.name} | ${record.corridor}`
    );
  }

  // ==========================================================
  // RULE 4
  // APPROACHING GATE
  // ==========================================================
  //
  // Gate closes only after train has left Gudur and has a
  // usable actual position near the corresponding gate.
  //
  // This prevents a train sitting on the platform from
  // closing the road gate.
  // ==========================================================

  if (
    distance !== null &&
    actual &&
    distance <=
      GATE_CLOSE_DISTANCE_KM &&
    (
      newRecord.state ===
        "DEPARTED_GUDUR" ||
      newRecord.state ===
        "APPROACHING_GUDUR" ||
      newRecord.state ===
        "AT_GATE"
    )
  ) {
    newRecord.state =
      "AT_GATE";

    console.log(
      `🔴 [AT GATE] ${record.trainNo} ${record.name} | ${record.corridor} | distance=${distance.toFixed(3)} km | GATE CLOSED`
    );

    return newRecord;
  }

  // ==========================================================
  // RULE 5
  // PASSED GATE
  // ==========================================================
  //
  // Once a train has been AT_GATE and then moves beyond
  // 0.80 km from the gate, the gate is clear.
  // ==========================================================

  if (
    newRecord.state ===
      "AT_GATE" &&
    distance !== null &&
    distance >=
      GATE_CLEAR_DISTANCE_KM
  ) {
    newRecord.state =
      "PASSED_GATE";

    console.log(
      `🟢 [PASSED GATE] ${record.trainNo} ${record.name} | ${record.corridor} | distance=${distance.toFixed(3)} km | GATE OPEN`
    );

    return newRecord;
  }

  // ==========================================================
  // RULE 6
  // NO GPS
  // ==========================================================
  //
  // Never falsely close a gate.
  // ==========================================================

  if (
    distance === null
  ) {
    console.log(
      `[LIVE POSITION] ${record.trainNo} has no usable live coordinates. Keeping state: ${newRecord.state}`
    );
  }

  return newRecord;
}

// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
      trainNo
    )}/live?authoritative=true&includeCoordinates=true&geometry=true`;

  try {
    const response =
      await axios.get(
        url,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,
            Accept:
              "application/json"
          },

          timeout: 10000
        }
      );

    return response.data;
  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo}: ${
        error.response
          ? `HTTP ${error.response.status}`
          : error.message
      }`
    );

    return null;
  }
}

// ============================================================
// LOAD TRACKING
// ============================================================

async function loadTracking() {
  try {
    const snapshot =
      await trackingRef.once(
        "value"
      );

    return (
      snapshot.val() || {}
    );
  } catch (error) {
    console.error(
      "[TRACKING LOAD ERROR]",
      error.message
    );

    return {};
  }
}

// ============================================================
// SAVE TRACKING
// ============================================================

async function saveTracking(
  tracking
) {
  await trackingRef.set(
    tracking
  );
}

// ============================================================
// MAIN SYSTEM
// ============================================================

async function updateGateSystem() {
  const now =
    new Date();

  const currentMin =
    now.getHours() * 60 +
    now.getMinutes();

  console.log(
    `\n[${now.toLocaleString(
      "en-IN"
    )}] Querying RailRadar Live Station Board for GDR...`
  );

  if (
    !RAILRADAR_API_KEY
  ) {
    throw new Error(
      "RAILRADAR_API_KEY is missing."
    );
  }

  // ==========================================================
  // LOAD EXISTING TRACKING
  // ==========================================================

  let tracking =
    await loadTracking();

  // ==========================================================
  // FETCH STATION BOARD
  // ==========================================================

  const boardUrl =
    `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`;

  let boardResponse;

  try {
    boardResponse =
      await axios.get(
        boardUrl,
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
  } catch (error) {
    console.error(
      "[BOARD ERROR]",
      error.response
        ? error.response.data
        : error.message
    );

    throw error;
  }

  const responseBody =
    boardResponse.data;

  const trainsArray =
    responseBody?.data
      ?.trains || [];

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
    `RailRadar returned ${trainsArray.length} trains.`
  );

  // ==========================================================
  // BUILD BOARD CANDIDATES
  // ==========================================================

  const boardCandidates =
    new Map();

  for (
    const item of trainsArray
  ) {
    const train =
      item.train || {};

    const live =
      item.live || {};

    const stop =
      item.stop || {};

    const trainNo =
      String(
        firstValue(
          train.number,
          item.trainNumber,
          item.number
        )
      ).trim();

    if (!trainNo) {
      continue;
    }

    const trainName =
      firstValue(
        train.name,
        item.name,
        `Train ${trainNo}`
      );

    const corridor =
      determineCorridor(
        train,
        item
      );

    if (!corridor) {
      console.log(
        `[IGNORED] ${trainNo} ${trainName} | corridor not confirmed`
      );

      continue;
    }

    const originCode =
      getOriginCode(
        train,
        item
      );

    const originName =
      getOriginName(
        train,
        item
      );

    const destinationCode =
      getDestinationCode(
        train,
        item
      );

    const destinationName =
      getDestinationName(
        train,
        item
      );

    const delayMinutes =
      Number(
        firstValue(
          live.delayMinutes,
          item.delayMinutes,
          train.delayMinutes,
          0
        )
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

    const eta =
      safeEta(
        calculateTimeDifference(
          arrivalMinutes,
          currentMin
        )
      );

    // --------------------------------------------------------
    // If no ETA can be calculated, keep only if it already
    // exists in persistent tracking.
    // --------------------------------------------------------

    if (
      eta === null
    ) {
      const existing =
        tracking[
          trainNo
        ];

      if (
        !existing ||
        !Number.isFinite(
          Number(
            existing.etaMinutes
          )
        )
      ) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} - no usable ETA`
        );

        continue;
      }
    }

    const finalEta =
      eta !== null
        ? eta
        : safeEta(
            tracking[
              trainNo
            ]?.etaMinutes
          );

    // --------------------------------------------------------
    // Ignore trains too far in the future.
    // --------------------------------------------------------

    if (
      finalEta !== null &&
      finalEta >
        UPCOMING_MAX_ETA_MINUTES
    ) {
      continue;
    }

    // --------------------------------------------------------
    // Remove clearly old trains.
    // --------------------------------------------------------

    const status =
      normalizeText(
        firstValue(
          live.status,
          item.status,
          train.status
        )
      );

    if (
      status.includes(
        "CANCEL"
      )
    ) {
      continue;
    }

    // --------------------------------------------------------
    // BUILD BOARD RECORD
    // --------------------------------------------------------

    const record =
      makeTrackingRecord({
        trainNo,

        name:
          trainName,

        corridor,

        origin:
          originCode ||
          originName ||
          "",

        destination:
          destinationCode ||
          destinationName ||
          "",

        platform:
          getPlatform(
            train,
            live,
            stop,
            item
          ),

        etaMinutes:
          finalEta,

        delayMinutes,

        state:
          tracking[
            trainNo
          ]?.state ||
          "APPROACHING_GUDUR",

        lastDistanceKm:
          tracking[
            trainNo
          ]?.lastDistanceKm,

        lastLiveStatus:
          tracking[
            trainNo
          ]?.lastLiveStatus,

        lastStation:
          tracking[
            trainNo
          ]?.lastStation,

        lastSeen:
          new Date().toISOString()
      });

    boardCandidates.set(
      trainNo,
      record
    );

    // --------------------------------------------------------
    // ALWAYS update current board ETA.
    //
    // This prevents old values such as undefined / stale
    // values from remaining in Firebase.
    // --------------------------------------------------------

    tracking[
      trainNo
    ] = record;

    console.log(
      `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${originCode || "?"} -> ${destinationCode || "?"} | ETA ${finalEta === null ? "?" : finalEta + "m"}`
    );
  }

  // ==========================================================
  // LIVE VERIFICATION QUEUE
  // ==========================================================

  const liveCandidates =
    Array.from(
      boardCandidates.values()
    )
      .filter(
        (record) =>
          record.etaMinutes !==
            null &&
          record.etaMinutes <=
            LIVE_VERIFY_ETA_MINUTES &&
          record.state !==
            "PASSED_GATE"
      )
      .sort(
        (a, b) =>
          a.etaMinutes -
          b.etaMinutes
      )
      .slice(
        0,
        MAX_LIVE_CALLS
      );

  console.log(
    `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
  );

  if (
    liveCandidates.length
  ) {
    console.log(
      "[LIVE QUEUE ORDER]"
    );

    liveCandidates.forEach(
      (record, index) => {
        console.log(
          `${index + 1}. ${record.trainNo} ${record.name} | ${record.corridor} | ETA ${record.etaMinutes}m | state=${record.state}`
        );
      }
    );
  }

  // ==========================================================
  // LIVE CHECKS
  // ==========================================================

  for (
    const record of
      liveCandidates
  ) {
    console.log(
      `\n[LIVE] Checking train ${record.trainNo}...`
    );

    const liveResponse =
      await fetchLiveTrain(
        record.trainNo
      );

    if (
      !liveResponse
    ) {
      continue;
    }

    const currentLocation =
      liveResponse?.data
        ?.currentLocation ||
      {};

    const updated =
      updateTrackingFromLive(
        record,
        liveResponse
      );

    tracking[
      record.trainNo
    ] = updated;

    const distance =
      getDistanceToGate(
        record.corridor,
        currentLocation
      );

    const station =
      firstValue(
        currentLocation.stationCode,
        currentLocation.stationName,
        "unknown"
      );

    const status =
      firstValue(
        currentLocation.status,
        "unknown"
      );

    const actual =
      currentLocation.isActualPosition ===
      true;

    console.log(
      `[LIVE VERIFIED] ${record.trainNo} | ${record.corridor} | status=${status} | station=${station} | distance=${
        distance === null
          ? "unknown"
          : distance.toFixed(3) +
            " km"
      } | actual=${actual} | state=${updated.state}`
    );

    // ========================================================
    // GATE RESULT
    // ========================================================

    if (
      updated.state ===
      "AT_GATE"
    ) {
      console.log(
        `🔴 [GATE CLOSED] ${record.trainNo} | ${record.corridor}`
      );
    }

    if (
      updated.state ===
      "AT_GUDUR_STATION"
    ) {
      console.log(
        `🟢 [GATE OPEN] ${record.trainNo} is at Gudur platform`
      );
    }

    if (
      updated.state ===
      "PASSED_GATE"
    ) {
      console.log(
        `🟢 [GATE OPEN] ${record.trainNo} has passed the gate`
      );
    }
  }

  // ==========================================================
  // CLEAN INVALID / OLD TRACKING
  // ==========================================================

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
      !record ||
      typeof record !==
        "object"
    ) {
      delete tracking[
        trainNo
      ];

      continue;
    }

    // --------------------------------------------------------
    // Remove PASSED_GATE trains immediately.
    // --------------------------------------------------------

    if (
      record.state ===
      "PASSED_GATE"
    ) {
      console.log(
        `[TRACKING CLEANUP] Removing ${trainNo} after gate passage`
      );

      delete tracking[
        trainNo
      ];

      continue;
    }

    // --------------------------------------------------------
    // Current board trains are never removed merely because
    // their station-board ETA is old.
    // --------------------------------------------------------

    if (
      boardCandidates.has(
        trainNo
      )
    ) {
      continue;
    }

    // --------------------------------------------------------
    // Validate lastSeen before calculating age.
    // --------------------------------------------------------

    const lastSeenMs =
      Date.parse(
        record.lastSeen ||
          ""
      );

    if (
      !Number.isFinite(
        lastSeenMs
      )
    ) {
      delete tracking[
        trainNo
      ];

      continue;
    }

    const ageMinutes =
      (
        nowMs -
        lastSeenMs
      ) /
      60000;

    if (
      ageMinutes >
      TRACKING_RETENTION_MINUTES
    ) {
      console.log(
        `[TRACKING CLEANUP] Removing ${trainNo} after ${Math.round(
          ageMinutes
        )} minutes`
      );

      delete tracking[
        trainNo
      ];
    }
  }

  // ==========================================================
  // BUILD UPCOMING LIST
  // ==========================================================

  const upcomingMap =
    new Map();

  // ----------------------------------------------------------
  // First: current station-board trains.
  // ----------------------------------------------------------

  for (
    const [
      trainNo,
      record
    ] of boardCandidates
  ) {
    if (
      record.etaMinutes ===
      null
    ) {
      continue;
    }

    upcomingMap.set(
      trainNo,
      record
    );
  }

  // ----------------------------------------------------------
  // Second: persistent live-tracked trains.
  //
  // This keeps trains visible when they temporarily disappear
  // from the station board.
  // ----------------------------------------------------------

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
      record.state ===
      "PASSED_GATE"
    ) {
      continue;
    }

    const eta =
      safeEta(
        boardCandidates.get(
          trainNo
        )?.etaMinutes ??
          record.etaMinutes
      );

    if (
      eta === null
    ) {
      continue;
    }

    const merged =
      makeTrackingRecord({
        ...record,

        etaMinutes:
          eta
      });

    upcomingMap.set(
      trainNo,
      merged
    );
  }

  // ==========================================================
  // SORT UPCOMING
  // ==========================================================

  const upcomingList =
    Array.from(
      upcomingMap.values()
    )
      .filter(
        (record) =>
          record.etaMinutes !==
            null &&
          record.etaMinutes <=
            UPCOMING_MAX_ETA_MINUTES
      )
      .sort(
        (a, b) => {
          const etaDiff =
            a.etaMinutes -
            b.etaMinutes;

          if (
            etaDiff !== 0
          ) {
            return etaDiff;
          }

          return (
            statePriority(
              b.state
            ) -
            statePriority(
              a.state
            )
          );
        }
      )
      .slice(
        0,
        UPCOMING_DISPLAY_LIMIT
      );

  // ==========================================================
  // CALCULATE GATE STATUS
  // ==========================================================

  let masGate = {
    status: "OPEN",
    waitMinutes: 0,
    activeTrain:
      "Tracks clear",
    direction:
      "TOWARD CHENNAI",
    corridor:
      "MAS"
  };

  let tptyGate = {
    status: "OPEN",
    waitMinutes: 0,
    activeTrain:
      "Tracks clear",
    direction:
      "TOWARD TIRUPATI",
    corridor:
      "TPTY"
  };

  // ----------------------------------------------------------
  // Find trains currently AT_GATE.
  // ----------------------------------------------------------

  for (
    const record of
      Object.values(
        tracking
      )
  ) {
    if (
      !record ||
      record.state !==
        "AT_GATE"
    ) {
      continue;
    }

    const label =
      `${record.trainNo} ${record.name}`;

    const waitMinutes =
      Math.max(
        1,
        Number(
          record.etaMinutes || 1
        ) + 2
      );

    if (
      record.corridor ===
      "MAS"
    ) {
      masGate = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          `${label} (Approaching Gate)`,

        direction:
          "TOWARD CHENNAI",

        corridor:
          "MAS"
      };
    }

    if (
      record.corridor ===
      "TPTY"
    ) {
      tptyGate = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          `${label} (Approaching Gate)`,

        direction:
          "TOWARD TIRUPATI",

        corridor:
          "TPTY"
      };
    }
  }

  // ==========================================================
  // FIREBASE UPDATE
  // ==========================================================

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
      )
  });

  await saveTracking(
    tracking
  );

  // ==========================================================
  // LOG RESULT
  // ==========================================================

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

  console.log(
    "\n[UPCOMING TRAINS TO GUDUR]"
  );

  if (
    upcomingList.length ===
    0
  ) {
    console.log(
      "None"
    );
  } else {
    upcomingList.forEach(
      (
        train,
        index
      ) => {
        console.log(
          `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform} | ${train.origin || "?"} -> ${train.destination || "?"} | state=${train.state}`
        );
      }
    );
  }
}

// ============================================================
// RUN ONCE
// ============================================================
//
// IMPORTANT:
// GitHub Actions already runs this workflow every 5 minutes.
// Therefore we DO NOT use setInterval() here.
//
// This allows the Node process to finish normally instead of
// being killed by the GitHub Actions timeout.
// ============================================================

(async () => {
  try {
    await updateGateSystem();

    console.log(
      "\n[MONITOR] Run completed successfully."
    );

    process.exit(0);
  } catch (error) {
    console.error(
      "\n[MONITOR ERROR]"
    );

    console.error(
      error.message
    );

    process.exit(1);
  }
})();
