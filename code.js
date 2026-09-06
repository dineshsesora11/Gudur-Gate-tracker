const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

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
    "Use the GitHub Secret FIREBASE_SERVICE_ACCOUNT."
  );

  console.error(error.message);

  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = admin.database();
const gateRef = db.ref("gudur_gates");

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

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;
const UPCOMING_MAX_ETA_MINUTES = 360;

const GATE_STOP_DISTANCE_KM = 0.6;

const STATION_BOARD_HOURS = 4;

const MAX_BOARD_CANDIDATES = 22;

const MAX_LIVE_VERIFICATIONS = 7;

// ============================================================
// KNOWN TIRUPATI-SIDE TRAINS
// ============================================================
//
// These are explicitly treated as TPTY corridor trains.
//
// This is important because the GDR station-board response
// does not always contain enough route information.
//
// ============================================================

const TIRUPATI_CORRIDOR_TRAINS = new Set([
  "12733",
  "12734",
  "12763",
  "12764",

  "17479",
  "17480",
  "17487",
  "17488",

  "17261",
  "17262",

  "07669",
  "07670",

  // Current important trains
  "20630",
  "17247"
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
// containsAny
// ============================================================

function containsAny(text, values) {
  const normalized = normalizeText(text);

  return values.some((value) =>
    normalized.includes(
      normalizeText(value)
    )
  );
}

// ============================================================
// NUMBER NORMALIZER
// ============================================================

function normalizeTrainNumber(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .trim();
}

// ============================================================
// NESTED VALUE LOOKUP
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
// ORIGIN DETECTION
// ============================================================

function getOrigin(train, item) {
  return firstValue(
    train.origin?.name,
    train.origin?.code,

    train.source?.name,
    train.source?.code,

    train.from?.name,
    train.from?.code,

    train.fromStation?.name,
    train.fromStation?.code,

    train.startStation?.name,
    train.startStation?.code,

    train.start,

    item.origin?.name,
    item.origin?.code,

    item.source?.name,
    item.source?.code,

    item.from?.name,
    item.from?.code,

    item.fromStation?.name,
    item.fromStation?.code,

    item.startStation?.name,
    item.startStation?.code
  );
}

// ============================================================
// DESTINATION DETECTION
// ============================================================

function getDestination(train, item) {
  return firstValue(
    train.destination?.name,
    train.destination?.code,

    train.to?.name,
    train.to?.code,

    train.destinationStation?.name,
    train.destinationStation?.code,

    train.endStation?.name,
    train.endStation?.code,

    item.destination?.name,
    item.destination?.code,

    item.to?.name,
    item.to?.code,

    item.destinationStation?.name,
    item.destinationStation?.code
  );
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

function getExplicitInboundDirection(
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
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("APPROACHING GUDUR") ||
    direction.includes("INBOUND")
  ) {
    return true;
  }

  if (
    direction.includes("FROM GUDUR") ||
    direction.includes("GUDUR OUTBOUND") ||
    direction.includes("OUTBOUND") ||
    direction.includes("AWAY FROM GUDUR")
  ) {
    return false;
  }

  return null;
}

// ============================================================
// ROUTE EXTRACTION
// ============================================================

function getRouteCandidates(
  train,
  live,
  stop,
  item
) {
  const possibleRoutes = [
    train.route,
    train.stations,
    train.stops,
    train.routeStations,

    live.route,
    live.stations,
    live.stops,
    live.routeStations,

    stop.route,
    stop.stations,
    stop.stops,

    item.route,
    item.stations,
    item.stops,
    item.routeStations
  ];

  const result = [];

  for (const route of possibleRoutes) {
    if (Array.isArray(route)) {
      result.push(...route);
    }
  }

  return result;
}

// ============================================================
// ROUTE TEXT
// ============================================================

function getRouteText(
  train,
  live,
  stop,
  item
) {
  const routes =
    getRouteCandidates(
      train,
      live,
      stop,
      item
    );

  const text = [];

  for (const station of routes) {
    if (typeof station === "string") {
      text.push(station);
      continue;
    }

    if (station && typeof station === "object") {
      text.push(
        station.code || "",
        station.name || "",
        station.stationCode || "",
        station.stationName || ""
      );
    }
  }

  return text
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// ROUTE SEQUENCE
// ============================================================

function getCurrentSequence(
  train,
  live,
  stop,
  item
) {
  return firstValue(
    live.currentLocation?.sequence,
    train.currentLocation?.sequence,

    live.sequence,
    train.sequence,

    stop.sequence,
    item.sequence
  );
}

// ============================================================
// CURRENT STATION CODE
// ============================================================

function getCurrentStationCode(
  train,
  live,
  stop,
  item
) {
  return firstValue(
    live.currentLocation?.stationCode,
    train.currentLocation?.stationCode,

    live.currentStationCode,
    train.currentStationCode,

    stop.stationCode,
    item.stationCode
  );
}

// ============================================================
// ACTUAL POSITION
// ============================================================

function extractActualGpsPosition(
  train,
  live,
  stop,
  item
) {
  const locations = [
    live.currentLocation,
    train.currentLocation,
    live.position,
    train.position,

    live.location,
    train.location,

    item.currentLocation,
    item.position,
    item.location
  ];

  for (const location of locations) {
    if (!location || typeof location !== "object") {
      continue;
    }

    const lat = Number(
      firstValue(
        location.lat,
        location.latitude
      )
    );

    const lng = Number(
      firstValue(
        location.lng,
        location.lon,
        location.longitude
      )
    );

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat !== 0 &&
      lng !== 0
    ) {
      const actualFlag =
        firstValue(
          location.isActualPosition,
          location.actual
        );

      return {
        lat,
        lng,

        speedKmh: Number(
          firstValue(
            location.speedKmh,
            location.speed,
            0
          )
        ),

        bearing: Number(
          firstValue(
            location.bearing,
            location.heading,
            0
          )
        ),

        isActualPosition:
          actualFlag === false
            ? false
            : true,

        source:
          firstValue(
            location.positionSource,
            "gps"
          )
      };
    }
  }

  return null;
}

// ============================================================
// ACTUAL STATION POSITION
// ============================================================

function extractActualStationPosition(
  train,
  live,
  stop,
  item
) {
  const stationCode =
    normalizeText(
      getCurrentStationCode(
        train,
        live,
        stop,
        item
      )
    );

  const actualFlag =
    firstValue(
      live.currentLocation?.isActualPosition,
      train.currentLocation?.isActualPosition,
      live.isActualPosition,
      train.isActualPosition
    );

  if (
    actualFlag === false ||
    !stationCode
  ) {
    return null;
  }

  if (
    stationCode === "GDR" ||
    stationCode.includes("GUDUR")
  ) {
    return {
      lat: GDR_LAT,
      lng: GDR_LNG,
      speedKmh: 0,
      bearing: 0,
      isActualPosition: true,
      source: "station-code"
    };
  }

  return null;
}

// ============================================================
// GET ACTUAL POSITION
// ============================================================

function getActualPosition(
  train,
  live,
  stop,
  item
) {
  const gps =
    extractActualGpsPosition(
      train,
      live,
      stop,
      item
    );

  if (gps) {
    return gps;
  }

  return extractActualStationPosition(
    train,
    live,
    stop,
    item
  );
}

// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function haversineKm(
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
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  actualPosition
) {
  if (!actualPosition) {
    return null;
  }

  return haversineKm(
    actualPosition.lat,
    actualPosition.lng,
    GDR_LAT,
    GDR_LNG
  );
}

// ============================================================
// ETA PARSER
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  let totalMinutes = -1;

  const date =
    new Date(timeStr);

  if (!isNaN(date.getTime())) {
    totalMinutes =
      date.getHours() * 60 +
      date.getMinutes();
  } else {
    const match =
      String(timeStr)
        .trim()
        .match(
          /(\d{1,2}):(\d{2})/
        );

    if (match) {
      totalMinutes =
        parseInt(match[1], 10) *
          60 +
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

function getBoardEtaMinutes(
  train,
  live,
  stop,
  item,
  currentMinutes
) {
  const delayMinutes =
    Number(
      firstValue(
        live.delayMinutes,
        train.delayMinutes,
        0
      )
    );

  const etaDirect =
    firstValue(
      live.etaMinutes,
      live.eta,
      item.etaMinutes,
      item.eta
    );

  if (
    etaDirect !== ""
  ) {
    const numeric =
      Number(etaDirect);

    if (
      Number.isFinite(numeric)
    ) {
      return numeric;
    }
  }

  const arrival =
    firstValue(
      stop.arrival,
      stop.arrivalTime,

      live.expectedArrivalTime,
      live.expectedArrival,

      live.arrivalTime,

      item.arrival,
      item.arrivalTime
    );

  const arrivalMinutes =
    parseTimeToMinutes(
      arrival,
      delayMinutes
    );

  if (
    arrivalMinutes === -1
  ) {
    return null;
  }

  return calculateTimeDifference(
    arrivalMinutes,
    currentMinutes
  );
}

// ============================================================
// SPEED / PHYSICAL ETA
// ============================================================

function calculatePhysicalEta(
  actualPosition
) {
  if (!actualPosition) {
    return null;
  }

  const distance =
    getDistanceToGudur(
      actualPosition
    );

  if (
    distance === null
  ) {
    return null;
  }

  if (
    distance <= 0.05
  ) {
    return 0;
  }

  let speed =
    Number(
      actualPosition.speedKmh
    );

  if (
    !Number.isFinite(speed) ||
    speed < 5
  ) {
    speed = 55;
  }

  return (
    distance /
    speed *
    60
  );
}

// ============================================================
// CORRIDOR FROM ROUTE
// ============================================================

function getRouteCorridor(
  train,
  live,
  stop,
  item
) {
  const routeText =
    getRouteText(
      train,
      live,
      stop,
      item
    );

  if (!routeText) {
    return null;
  }

  const hasTirupati =
    containsAny(
      routeText,
      [
        "TIRUPATI",
        "TPTY"
      ]
    );

  const hasChennai =
    containsAny(
      routeText,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI CENTRAL",
        "CHENNAI CENTRAL"
      ]
    );

  if (
    hasTirupati &&
    !hasChennai
  ) {
    return "TPTY";
  }

  if (
    hasChennai
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// CORRIDOR DETECTION
// ============================================================
//
// Priority:
//
// 1. Explicit known TPTY train number
// 2. Explicit route TPTY
// 3. Origin TPTY
// 4. Explicit route MAS
// 5. Origin Chennai
// 6. GDR board fallback -> MAS
//
// The final MAS fallback is intentional.
//
// At GDR, the normal station board contains mainline trains.
// Known Tirupati branch trains are explicitly separated above.
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo =
    normalizeTrainNumber(
      train.number ||
      item.trainNumber ||
      item.number
    );

  // ----------------------------------------------------------
  // 1. KNOWN TIRUPATI TRAINS
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // 2. EXPLICIT ROUTE
  // ----------------------------------------------------------

  const routeCorridor =
    getRouteCorridor(
      train,
      live,
      stop,
      item
    );

  if (
    routeCorridor
  ) {
    return routeCorridor;
  }

  // ----------------------------------------------------------
  // 3. ORIGIN
  // ----------------------------------------------------------

  const origin =
    getOrigin(
      train,
      item
    );

  if (
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU"
      ]
    )
  ) {
    return "TPTY";
  }

  if (
    containsAny(
      origin,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI CENTRAL",
        "CHENNAI CENTRAL",
        "AVADI",
        "PERAMBUR",
        "SULLURUPETA",
        "NAYUDUPETA"
      ]
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // 4. DEFAULT GDR MAINLINE
  // ----------------------------------------------------------

  return "MAS";
}

// ============================================================
// DIRECTION / INBOUND CHECK
// ============================================================

function isTowardGudur(
  train,
  live,
  stop,
  item,
  etaMinutes
) {
  const explicit =
    getExplicitInboundDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicit === false
  ) {
    return false;
  }

  if (
    explicit === true
  ) {
    return true;
  }

  // Station board candidate with a future ETA
  // is treated as an inbound train to GDR.
  if (
    etaMinutes !== null &&
    etaMinutes >= 0
  ) {
    return true;
  }

  // Actual position at GDR is relevant to gate operation.
  const actual =
    getActualPosition(
      train,
      live,
      stop,
      item
    );

  if (
    actual
  ) {
    const distance =
      getDistanceToGudur(
        actual
      );

    if (
      distance !== null &&
      distance <=
        GATE_STOP_DISTANCE_KM
    ) {
      return true;
    }
  }

  return false;
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
  return String(
    firstValue(
      live.platform,
      stop.platform,
      train.platform,
      item.platform,
      "1"
    )
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
  return firstValue(
    train.name,
    item.trainName,
    item.name,
    `Express ${trainNo}`
  );
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return normalizeTrainNumber(
    train.number ||
    item.trainNumber ||
    item.number
  );
}

// ============================================================
// LIVE TRAIN FETCH
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${trainNo}/live?includeCoordinates=true`;

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

        timeout: 12000
      }
    );

  return response.data;
}

// ============================================================
// LIVE RESPONSE NORMALIZATION
// ============================================================

function normalizeLiveResponse(
  response
) {
  const data =
    response?.data || {};

  const train =
    data.train || {};

  const live =
    data.live ||
    data.currentLocation ||
    {};

  const currentLocation =
    data.currentLocation ||
    live.currentLocation ||
    {};

  return {
    train,
    live: {
      ...live,
      currentLocation
    },

    stop:
      data.stop || {},

    item:
      data
  };
}

// ============================================================
// GATE DEFAULT
// ============================================================

function createOpenGate() {
  return {
    status: "OPEN",
    waitMinutes: 0,
    activeTrain: "Tracks clear",
    direction: "CLEAR",
    corridor: "NONE"
  };
}

// ============================================================
// PROCESS LIVE TRAIN FOR GATE
// ============================================================

function evaluateGateClosure(
  train,
  live,
  stop,
  item,
  corridor,
  currentMinutes
) {
  const actual =
    getActualPosition(
      train,
      live,
      stop,
      item
    );

  if (!actual) {
    return null;
  }

  if (
    actual.isActualPosition === false
  ) {
    return null;
  }

  const distance =
    getDistanceToGudur(
      actual
    );

  if (
    distance === null
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // MUST BE CLOSE TO GUDUR
  // ----------------------------------------------------------

  if (
    distance >
    GATE_STOP_DISTANCE_KM
  ) {
    return null;
  }

  const explicitDirection =
    getExplicitInboundDirection(
      train,
      live,
      stop,
      item
    );

  // At GDR itself, actual station position is sufficient.
  // Otherwise reject explicit outbound movement.
  if (
    explicitDirection === false &&
    distance > 0.05
  ) {
    return null;
  }

  const trainNo =
    getTrainNumber(
      train,
      item
    );

  const trainName =
    getTrainName(
      train,
      item,
      trainNo
    );

  const delayMinutes =
    Number(
      firstValue(
        live.delayMinutes,
        train.delayMinutes,
        0
      )
    );

  const eta =
    calculatePhysicalEta(
      actual
    );

  let waitMinutes;

  if (
    distance <= 0.05
  ) {
    waitMinutes =
      Math.max(
        1,
        Math.min(
          8,
          3 +
            Math.max(
              0,
              delayMinutes
            )
        )
      );
  } else if (
    eta !== null
  ) {
    waitMinutes =
      Math.max(
        1,
        Math.ceil(eta + 2)
      );
  } else {
    waitMinutes = 5;
  }

  let trainStatus =
    "Approaching";

  if (
    distance <= 0.05
  ) {
    trainStatus =
      "At Gudur";
  } else if (
    delayMinutes > 0
  ) {
    trainStatus =
      `${delayMinutes}m late`;
  } else {
    trainStatus =
      "On Time";
  }

  return {
    status: "CLOSED",

    waitMinutes,

    activeTrain:
      `${trainNo} ${trainName} (${trainStatus})`,

    direction:
      "TOWARD GUDUR",

    corridor,

    distanceKm:
      Number(
        distance.toFixed(2)
      ),

    actualPositionSource:
      actual.source
  };
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  let apiRequests = 0;

  try {
    const now =
      new Date();

    const currentMinutes =
      now.getHours() * 60 +
      now.getMinutes();

    console.log(
      "\n=========================================="
    );

    console.log(
      `[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    console.log(
      "=========================================="
    );

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY is missing."
      );
    }

    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=${STATION_BOARD_HOURS}`,
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

    apiRequests++;

    const responseBody =
      boardResponse.data;

    const trainsArray =
      responseBody?.data?.trains ||
      responseBody?.trains ||
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
      `\n✅ RailRadar returned ${trainsArray.length} trains.`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // PREPARE BOARD CANDIDATES
    // ========================================================

    const boardCandidates = [];

    for (
      let index = 0;
      index <
        Math.min(
          trainsArray.length,
          MAX_BOARD_CANDIDATES
        );
      index++
    ) {
      const item =
        trainsArray[index] ||
        {};

      const train =
        item.train ||
        {};

      const live =
        item.live ||
        {};

      const stop =
        item.stop ||
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

      const delayMinutes =
        Number(
          firstValue(
            live.delayMinutes,
            train.delayMinutes,
            item.delayMinutes,
            0
          )
        );

      const eta =
        getBoardEtaMinutes(
          train,
          live,
          stop,
          item,
          currentMinutes
        );

      const corridor =
        determineCorridor(
          train,
          live,
          stop,
          item
        );

      console.log(
        `[BOARD ${index + 1}] ${trainNo} ${name} | ${corridor} | ETA ${eta === null ? "UNKNOWN" : `${Math.round(eta)}m`}`
      );

      boardCandidates.push({
        item,
        train,
        live,
        stop,

        trainNo,
        name,

        origin:
          origin || "Unknown",

        destination:
          destination || "Gudur",

        delayMinutes,

        etaMinutes:
          eta,

        corridor
      });
    }

    // ========================================================
    // SORT BOARD CANDIDATES
    // ========================================================

    boardCandidates.sort(
      (a, b) => {
        const aEta =
          a.etaMinutes === null
            ? 99999
            : a.etaMinutes;

        const bEta =
          b.etaMinutes === null
            ? 99999
            : b.etaMinutes;

        return (
          aEta - bEta
        );
      }
    );

    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let masGate =
      createOpenGate();

    let tptyGate =
      createOpenGate();

    // ========================================================
    // LIVE VERIFICATION CANDIDATES
    // ========================================================
    //
    // Verify the closest trains first.
    //
    // TPTY trains are also deliberately included so a
    // TPTY train isn't ignored merely because it is later
    // in the board list.
    //
    // ========================================================

    const verificationMap =
      new Map();

    for (
      const candidate of
        boardCandidates.slice(
          0,
          MAX_LIVE_VERIFICATIONS
        )
    ) {
      verificationMap.set(
        candidate.trainNo,
        candidate
      );
    }

    // Always add known TPTY candidates if present.
    for (
      const candidate of
        boardCandidates
    ) {
      if (
        candidate.corridor === "TPTY"
      ) {
        verificationMap.set(
          candidate.trainNo,
          candidate
        );
      }

      if (
        verificationMap.size >=
        MAX_LIVE_VERIFICATIONS + 3
      ) {
        break;
      }
    }

    const verifiedCandidates =
      Array.from(
        verificationMap.values()
      ).slice(
        0,
        MAX_LIVE_VERIFICATIONS + 3
      );

    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    const verifiedTrains = [];

    for (
      const candidate of
        verifiedCandidates
    ) {
      try {
        console.log(
          `[LIVE] Checking ${candidate.trainNo} ${candidate.name}...`
        );

        const rawLive =
          await fetchLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        const normalized =
          normalizeLiveResponse(
            rawLive
          );

        const liveTrain =
          normalized.train;

        const live =
          normalized.live;

        const stop =
          normalized.stop;

        const item =
          normalized.item;

        const corridor =
          determineCorridor(
            liveTrain,
            live,
            stop,
            item
          );

        const actual =
          getActualPosition(
            liveTrain,
            live,
            stop,
            item
          );

        const distance =
          actual
            ? getDistanceToGudur(
                actual
              )
            : null;

        const physicalEta =
          actual
            ? calculatePhysicalEta(
                actual
              )
            : null;

        const boardEta =
          candidate.etaMinutes;

        let finalEta =
          physicalEta;

        if (
          finalEta === null &&
          boardEta !== null
        ) {
          finalEta =
            boardEta;
        }

        const towardGudur =
          isTowardGudur(
            liveTrain,
            live,
            stop,
            item,
            finalEta
          );

        const liveTrainNo =
          getTrainNumber(
            liveTrain,
            item
          ) ||
          candidate.trainNo;

        const liveTrainName =
          getTrainName(
            liveTrain,
            item,
            liveTrainNo
          );

        const liveOrigin =
          getOrigin(
            liveTrain,
            item
          ) ||
          candidate.origin;

        const liveDestination =
          getDestination(
            liveTrain,
            item
          ) ||
          candidate.destination;

        const delayMinutes =
          Number(
            firstValue(
              live.delayMinutes,
              liveTrain.delayMinutes,
              candidate.delayMinutes,
              0
            )
          );

        const platform =
          getPlatform(
            liveTrain,
            live,
            stop,
            item
          );

        const verified = {
          trainNo:
            liveTrainNo,

          name:
            liveTrainName,

          origin:
            liveOrigin ||
            "Unknown",

          destination:
            liveDestination ||
            "Gudur",

          corridor,

          direction:
            towardGudur
              ? "TOWARD GUDUR"
              : "UNKNOWN",

          etaMinutes:
            finalEta === null
              ? null
              : Math.max(
                  0,
                  Math.round(
                    finalEta
                  )
                ),

          delayMinutes,

          distanceKm:
            distance === null
              ? null
              : Number(
                  distance.toFixed(2)
                ),

          platform,

          actualPosition:
            Boolean(
              actual
            ),

          actualPositionSource:
            actual?.source ||
            null,

          liveData:
            true
        };

        verifiedTrains.push(
          verified
        );

        console.log(
          `[LIVE RESULT] ${liveTrainNo} ${liveTrainName} | ${corridor} | ${towardGudur ? "TOWARD GUDUR" : "UNKNOWN"} | Distance ${distance === null ? "UNKNOWN" : `${distance.toFixed(2)} km`} | ETA ${verified.etaMinutes === null ? "UNKNOWN" : `${verified.etaMinutes}m`}`
        );

        // ====================================================
        // GATE CLOSURE
        // ====================================================

        if (
          towardGudur &&
          corridor === "MAS"
        ) {
          const gate =
            evaluateGateClosure(
              liveTrain,
              live,
              stop,
              item,
              corridor,
              currentMinutes
            );

          if (
            gate
          ) {
            masGate =
              gate;
          }
        }

        if (
          towardGudur &&
          corridor === "TPTY"
        ) {
          const gate =
            evaluateGateClosure(
              liveTrain,
              live,
              stop,
              item,
              corridor,
              currentMinutes
            );

          if (
            gate
          ) {
            tptyGate =
              gate;
          }
        }

      } catch (liveError) {
        console.error(
          `[LIVE ERROR] ${candidate.trainNo}: ${liveError.message}`
        );
      }
    }

    // ========================================================
    // UPCOMING TRAINS
    // ========================================================
    //
    // IMPORTANT:
    //
    // We use the station board ETA for upcoming trains.
    // This prevents a train 100+ km away from suddenly
    // receiving a fake 18-minute ETA.
    //
    // Known TPTY trains are already classified above.
    //
    // ========================================================

    const upcomingMap =
      new Map();

    // Add board candidates first.
    for (
      const candidate of
        boardCandidates
    ) {
      if (
        candidate.etaMinutes === null
      ) {
        continue;
      }

      const eta =
        Number(
          candidate.etaMinutes
        );

      if (
        !Number.isFinite(eta)
      ) {
        continue;
      }

      if (
        eta < 0 ||
        eta >
          UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      if (
        candidate.corridor !== "MAS" &&
        candidate.corridor !== "TPTY"
      ) {
        continue;
      }

      const towardGudur =
        isTowardGudur(
          candidate.train,
          candidate.live,
          candidate.stop,
          candidate.item,
          eta
        );

      if (
        !towardGudur
      ) {
        continue;
      }

      upcomingMap.set(
        candidate.trainNo,
        {
          trainNo:
            candidate.trainNo,

          name:
            candidate.name,

          origin:
            candidate.origin,

          destination:
            candidate.destination,

          etaMinutes:
            Math.max(
              0,
              Math.round(
                eta
              )
            ),

          delayMinutes:
            candidate.delayMinutes,

          corridor:
            candidate.corridor,

          direction:
            "TOWARD GUDUR",

          platform:
            getPlatform(
              candidate.train,
              candidate.live,
              candidate.stop,
              candidate.item
            ),

          distanceKm:
            null,

          liveData:
            false
        }
      );
    }

    // ========================================================
    // MERGE LIVE VERIFIED DATA
    // ========================================================

    for (
      const verified of
        verifiedTrains
    ) {
      if (
        verified.corridor !== "MAS" &&
        verified.corridor !== "TPTY"
      ) {
        continue;
      }

      if (
        verified.direction !==
        "TOWARD GUDUR"
      ) {
        continue;
      }

      if (
        verified.etaMinutes === null
      ) {
        continue;
      }

      if (
        verified.etaMinutes >
        UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      if (
        verified.distanceKm !== null &&
        verified.distanceKm >
          UPCOMING_MAX_DISTANCE_KM
      ) {
        continue;
      }

      upcomingMap.set(
        verified.trainNo,
        {
          trainNo:
            verified.trainNo,

          name:
            verified.name,

          origin:
            verified.origin,

          destination:
            verified.destination,

          etaMinutes:
            Math.max(
              0,
              verified.etaMinutes
            ),

          delayMinutes:
            verified.delayMinutes,

          corridor:
            verified.corridor,

          direction:
            "TOWARD GUDUR",

          platform:
            verified.platform,

          distanceKm:
            verified.distanceKm,

          liveData:
            true
        }
      );
    }

    // ========================================================
    // SORT UPCOMING
    // ========================================================

    const upcomingList =
      Array.from(
        upcomingMap.values()
      );

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ========================================================
    // MAXIMUM 5 UPCOMING
    // ========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE PAYLOAD
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        startedAt
      ) / 1000;

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedLocal:
        now.toLocaleString(),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedAtMs:
        Date.now(),

      verifiedTrains:
        verifiedTrains.length,

      apiRequests,

      monitorStatus:
        "OK",

      monitorDurationSeconds:
        Number(
          durationSeconds.toFixed(
            1
          )
        )
    });

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      "=========================================="
    );

    console.log(
      ` -> Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );

    console.log(
      ` -> Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      ` -> Verified trains: ${verifiedTrains.length}`
    );

    console.log(
      ` -> API requests: ${apiRequests}`
    );

    console.log(
      ` -> Duration: ${durationSeconds.toFixed(1)} seconds`
    );

    // ========================================================
    // SHOW UPCOMING
    // ========================================================

    console.log(
      "\n[UPCOMING TRAINS TO GUDUR]"
    );

    if (
      topUpcoming.length === 0
    ) {
      console.log(
        "None"
      );
    } else {
      topUpcoming.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform}`
          );
        }
      );
    }

    console.log(
      "\n=========================================="
    );

    return true;

  } catch (error) {
    console.error(
      "\n=========================================="
    );

    console.error(
      "[MONITOR ERROR]"
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
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    }

    console.error(
      "=========================================="
    );

    try {
      await gateRef.set({
        tirupatiGate:
          createOpenGate(),

        chennaiGate:
          createOpenGate(),

        upcomingTrains:
          [],

        lastUpdated:
          new Date()
            .toLocaleTimeString(),

        lastUpdatedLocal:
          new Date()
            .toLocaleString(),

        lastUpdatedAt:
          new Date()
            .toISOString(),

        lastUpdatedAtMs:
          Date.now(),

        verifiedTrains:
          0,

        apiRequests,

        monitorStatus:
          "ERROR",

        monitorError:
          error.message
      });
    } catch (
      firebaseError
    ) {
      console.error(
        "[FIREBASE ERROR]",
        firebaseError.message
      );
    }

    return false;
  }
}

// ============================================================
// START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor Active "
);

console.log(
  "=========================================="
);

console.log(
  `Gudur: ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  `Chennai Gate: ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  `Tirupati Gate: ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  "=========================================="
);

console.log(
  "Firebase: Configured"
);

console.log(
  `RailRadar API Key: ${
    RAILRADAR_API_KEY
      ? "Configured"
      : "MISSING"
  }`
);

console.log(
  "Corridor: ACTUAL ROUTE FIRST + TPTY TRAIN MAP"
);

console.log(
  "Upcoming: TOWARD GUDUR ONLY"
);

console.log(
  "Gate closure: ACTUAL POSITION ONLY"
);

console.log(
  `Upcoming max ETA: ${UPCOMING_MAX_ETA_MINUTES} minutes`
);

console.log(
  `Gate closure distance: ${GATE_STOP_DISTANCE_KM} km`
);

console.log(
  "GitHub Actions mode: RUN ONCE"
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
// Do NOT use setInterval() here.
//
// GitHub Actions starts this script every 5 minutes.
// The script must finish after one successful sync.
//
// ============================================================

updateGateSystem()
  .then(
    (success) => {
      process.exitCode =
        success ? 0 : 1;
    }
  )
  .catch(
    (error) => {
      console.error(
        "[FATAL]",
        error.message
      );

      process.exitCode = 1;
    }
  );
