const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR GATE TRACKER - LIVE GPS VERSION
// ============================================================

// ------------------------------------------------------------
// FIREBASE CONFIGURATION
// ------------------------------------------------------------

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

// serviceAccountKey.json must be in the same folder as code.js
const SERVICE_ACCOUNT_FILE = "./serviceAccountKey.json";

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    serviceAccount = require(SERVICE_ACCOUNT_FILE);
  } else {
    throw new Error(
      "Firebase service account not found."
    );
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    "Use FIREBASE_SERVICE_ACCOUNT or place serviceAccountKey.json beside code.js."
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

// API key supplied by the user
const RAILRADAR_API_KEY =
  "rg_142aad0a449a42618d75f24a1d4e0669";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// IMPORTANT LOCATIONS
// ============================================================

// Gudur Railway Station
const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

// Chennai-side railway gate
const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

// Tirupati-side railway gate
const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SYSTEM SETTINGS
// ============================================================

// Upcoming trains can be displayed within this distance.
const UPCOMING_MAX_DISTANCE_KM = 150;

// Gate closure distance.
// Approximately 600 metres around each crossing.
const GATE_STOP_DISTANCE_KM = 0.6;

// RailRadar maximum is reported as 10 requests/minute.
// We intentionally stay below that.
const MAX_API_REQUESTS_PER_CYCLE = 8;

// One station board request + seven individual live requests.
const VERIFY_PER_CYCLE = 7;

// Run every 60 seconds.
const REFRESH_INTERVAL_MS = 60 * 1000;

// ============================================================
// REQUEST COUNTER
// ============================================================

let requestsThisMinute = 0;
let requestWindowStarted = Date.now();

function resetRequestWindowIfNeeded() {
  const elapsed =
    Date.now() - requestWindowStarted;

  if (elapsed >= 60 * 1000) {
    requestsThisMinute = 0;
    requestWindowStarted = Date.now();
  }
}

function canMakeRequest() {
  resetRequestWindowIfNeeded();

  return (
    requestsThisMinute <
    MAX_API_REQUESTS_PER_CYCLE
  );
}

// ============================================================
// GENERIC RAILRADAR REQUEST
// ============================================================

async function railRadarGet(path) {
  resetRequestWindowIfNeeded();

  if (!canMakeRequest()) {
    throw new Error(
      "RailRadar request limit reached for this minute."
    );
  }

  requestsThisMinute++;

  return axios.get(
    `${RAILRADAR_BASE_URL}${path}`,
    {
      headers: {
        Authorization:
          `Bearer ${RAILRADAR_API_KEY}`,

        // Some API configurations use X-API-Key.
        // Sending both is harmless for normal API gateways.
        "X-API-Key":
          RAILRADAR_API_KEY,

        Accept:
          "application/json"
      },

      timeout: 15000
    }
  );
}

// ============================================================
// TEXT NORMALIZATION
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

function distanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const aLat = toNumber(lat1);
  const aLng = toNumber(lng1);
  const bLat = toNumber(lat2);
  const bLng = toNumber(lng2);

  if (
    aLat === null ||
    aLng === null ||
    bLat === null ||
    bLng === null
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    ((bLat - aLat) * Math.PI) /
    180;

  const dLng =
    ((bLng - aLng) * Math.PI) /
    180;

  const lat1Rad =
    (aLat * Math.PI) / 180;

  const lat2Rad =
    (bLat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(dLng / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// BEARING
// ============================================================

function calculateBearing(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const aLat = toNumber(lat1);
  const aLng = toNumber(lng1);
  const bLat = toNumber(lat2);
  const bLng = toNumber(lng2);

  if (
    aLat === null ||
    aLng === null ||
    bLat === null ||
    bLng === null
  ) {
    return null;
  }

  const lat1Rad =
    (aLat * Math.PI) / 180;

  const lat2Rad =
    (bLat * Math.PI) / 180;

  const dLng =
    ((bLng - aLng) * Math.PI) /
    180;

  const y =
    Math.sin(dLng) *
    Math.cos(lat2Rad);

  const x =
    Math.cos(lat1Rad) *
      Math.sin(lat2Rad) -
    Math.sin(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.cos(dLng);

  let bearing =
    (Math.atan2(y, x) * 180) /
    Math.PI;

  bearing =
    (bearing + 360) % 360;

  return bearing;
}

// ============================================================
// ANGULAR DIFFERENCE
// ============================================================

function bearingDifference(
  a,
  b
) {
  if (
    a === null ||
    b === null
  ) {
    return null;
  }

  let diff =
    Math.abs(a - b);

  if (diff > 180) {
    diff = 360 - diff;
  }

  return diff;
}

// ============================================================
// FIND FIRST VALUE
// ============================================================

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return firstValue(
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
    item?.startStation
  ) || "";
}

// ============================================================
// DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  return firstValue(
    train?.destination,
    train?.to,
    train?.destinationStation,
    train?.endStation,

    item?.destination,
    item?.to,
    item?.destinationStation
  ) || "";
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return String(
    firstValue(
      train?.number,
      train?.trainNumber,
      item?.number,
      item?.trainNumber
    ) || ""
  ).trim();
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
    firstValue(
      train?.name,
      train?.trainName,
      item?.name,
      item?.trainName
    ) ||
    `Train ${trainNo}`
  );
}

// ============================================================
// ROUTE EXTRACTION
// ============================================================

function getEmbeddedRoute(
  liveData
) {
  const candidates = [
    liveData?.route,
    liveData?.route?.stops,
    liveData?.route?.stations,

    liveData?.stops,
    liveData?.stations,

    liveData?.trainRoute,
    liveData?.trainRoute?.stops,
    liveData?.trainRoute?.stations,

    liveData?.data?.route,
    liveData?.data?.stops,
    liveData?.data?.stations
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (
      candidate &&
      typeof candidate === "object"
    ) {
      if (
        Array.isArray(candidate.stops)
      ) {
        return candidate.stops;
      }

      if (
        Array.isArray(candidate.stations)
      ) {
        return candidate.stations;
      }

      if (
        Array.isArray(candidate.route)
      ) {
        return candidate.route;
      }
    }
  }

  return [];
}

// ============================================================
// STOP NAME
// ============================================================

function getStopName(stop) {
  return String(
    firstValue(
      stop?.name,
      stop?.stationName,
      stop?.station,
      stop?.station?.name,
      stop?.code,
      stop?.stationCode
    ) || ""
  );
}

// ============================================================
// STOP CODE
// ============================================================

function getStopCode(stop) {
  return normalizeText(
    firstValue(
      stop?.code,
      stop?.stationCode,
      stop?.station?.code,
      stop?.station?.stationCode
    ) || ""
  );
}

// ============================================================
// STOP SEQUENCE
// ============================================================

function getStopSequence(
  stop,
  fallbackIndex
) {
  const value =
    firstValue(
      stop?.sequence,
      stop?.seq,
      stop?.stopSequence,
      stop?.index
    );

  const n = Number(value);

  if (Number.isFinite(n)) {
    return n;
  }

  return fallbackIndex;
}

// ============================================================
// STOP COORDINATES
// ============================================================

function getStopCoordinates(
  stop
) {
  const lat = firstValue(
    stop?.latitude,
    stop?.lat,
    stop?.location?.latitude,
    stop?.location?.lat,
    stop?.coordinates?.latitude,
    stop?.coordinates?.lat
  );

  const lng = firstValue(
    stop?.longitude,
    stop?.lng,
    stop?.lon,
    stop?.location?.longitude,
    stop?.location?.lng,
    stop?.location?.lon,
    stop?.coordinates?.longitude,
    stop?.coordinates?.lng,
    stop?.coordinates?.lon
  );

  if (
    toNumber(lat) === null ||
    toNumber(lng) === null
  ) {
    return null;
  }

  return {
    lat: Number(lat),
    lng: Number(lng)
  };
}

// ============================================================
// FIND GUDUR STOP IN ROUTE
// ============================================================

function isGudurStop(stop) {
  const name =
    normalizeText(
      getStopName(stop)
    );

  const code =
    getStopCode(stop);

  return (
    code === "GDR" ||
    name === "GDR" ||
    name.includes("GUDUR")
  );
}

// ============================================================
// FIND CURRENT STOP
// ============================================================

function findCurrentStop(
  liveData,
  route
) {
  const currentStop =
    liveData?.currentStop ||
    liveData?.live?.currentStop ||
    liveData?.currentStation ||
    liveData?.live?.currentStation;

  if (
    currentStop &&
    typeof currentStop === "object"
  ) {
    return {
      stop: currentStop,
      index: route.findIndex(
        (s) =>
          getStopCode(s) ===
          getStopCode(currentStop)
      )
    };
  }

  const currentCode =
    normalizeText(
      firstValue(
        liveData?.currentLocation?.stationCode,
        liveData?.currentLocation?.station,
        liveData?.live?.currentLocation?.stationCode,
        liveData?.live?.currentLocation?.station
      ) || ""
    );

  if (currentCode) {
    const index =
      route.findIndex(
        (stop) =>
          getStopCode(stop) ===
          currentCode
      );

    if (index >= 0) {
      return {
        stop: route[index],
        index
      };
    }
  }

  return {
    stop: null,
    index: -1
  };
}

// ============================================================
// GUDUR ROUTE INDEX
// ============================================================

function findGudurRouteIndex(
  route
) {
  return route.findIndex(
    isGudurStop
  );
}

// ============================================================
// SIDE CLASSIFICATION
// ============================================================

const CHENNAI_SIDE_CODES =
  new Set([
    "MAS",
    "MS",
    "PER",
    "NYP",
    "SPE",
    "AJJ",
    "TRL",
    "AVD"
  ]);

const TIRUPATI_SIDE_CODES =
  new Set([
    "TPTY",
    "RU",
    "KHT",
    "VKI",
    "TDK",
    "PUDI",
    "PUT"
  ]);

function classifyStationSide(
  stop
) {
  const code =
    getStopCode(stop);

  const name =
    normalizeText(
      getStopName(stop)
    );

  if (
    CHENNAI_SIDE_CODES.has(code) ||
    name.includes("CHENNAI") ||
    name.includes("AVADI") ||
    name.includes("PERAMBUR") ||
    name.includes("SULLURUPETA") ||
    name.includes("NAYUDUPETA")
  ) {
    return "MAS";
  }

  if (
    TIRUPATI_SIDE_CODES.has(code) ||
    name.includes("TIRUPATI") ||
    name.includes("RENIGUNTA")
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR FROM ROUTE
// ============================================================
//
// For a train approaching Gudur:
// inspect the stops BEFORE Gudur.
//
// For a train leaving Gudur:
// inspect the stops AFTER Gudur.
//
// This prevents a north-origin train merely travelling south
// from being incorrectly assigned to Tirupati/Chennai gates.
// ============================================================

function determineCorridorFromRoute(
  route,
  currentIndex,
  gudurIndex,
  direction
) {
  if (
    !Array.isArray(route) ||
    gudurIndex < 0
  ) {
    return null;
  }

  if (
    direction === "TOWARD_GUDUR"
  ) {
    const start =
      Math.min(
        currentIndex >= 0
          ? currentIndex
          : 0,
        gudurIndex - 1
      );

    for (
      let i = start;
      i >= 0;
      i--
    ) {
      const side =
        classifyStationSide(
          route[i]
        );

      if (side) {
        return side;
      }
    }
  }

  if (
    direction === "FROM_GUDUR"
  ) {
    const start =
      Math.max(
        currentIndex >= 0
          ? currentIndex
          : gudurIndex + 1,
        gudurIndex + 1
      );

    for (
      let i = start;
      i < route.length;
      i++
    ) {
      const side =
        classifyStationSide(
          route[i]
        );

      if (side) {
        return side;
      }
    }
  }

  return null;
}

// ============================================================
// DIRECTION FROM ROUTE
// ============================================================

function determineDirection(
  currentIndex,
  gudurIndex
) {
  if (
    currentIndex < 0 ||
    gudurIndex < 0
  ) {
    return "UNKNOWN";
  }

  if (
    currentIndex === gudurIndex
  ) {
    return "AT_GUDUR";
  }

  if (
    currentIndex < gudurIndex
  ) {
    return "TOWARD_GUDUR";
  }

  return "FROM_GUDUR";
}

// ============================================================
// DIRECTION TEXT FALLBACK
// ============================================================

function getDirectionText(
  liveData
) {
  const values = [
    liveData?.direction,
    liveData?.travelDirection,
    liveData?.routeDirection,
    liveData?.runningDirection,

    liveData?.live?.direction,
    liveData?.live?.travelDirection,
    liveData?.live?.routeDirection,
    liveData?.live?.runningDirection,

    liveData?.currentLocation?.direction
  ];

  return values
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function explicitDirection(
  liveData
) {
  const text =
    getDirectionText(
      liveData
    );

  if (!text) {
    return null;
  }

  if (
    text.includes("TOWARD GUDUR") ||
    text.includes("TOWARDS GUDUR") ||
    text.includes("TO GUDUR") ||
    text.includes("APPROACHING GUDUR") ||
    text.includes("GUDUR INBOUND") ||
    text.includes("INBOUND")
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    text.includes("FROM GUDUR") ||
    text.includes("GUDUR OUTBOUND") ||
    text.includes("OUTBOUND") ||
    text.includes("AWAY FROM GUDUR")
  ) {
    return "FROM_GUDUR";
  }

  return null;
}

// ============================================================
// GPS EXTRACTION
// ============================================================

function extractCurrentGps(
  liveData
) {
  const locations = [
    liveData?.currentLocation,
    liveData?.live?.currentLocation,
    liveData?.location,
    liveData?.live?.location,
    liveData?.currentPosition,
    liveData?.live?.currentPosition
  ];

  for (const location of locations) {
    if (
      !location ||
      typeof location !== "object"
    ) {
      continue;
    }

    const lat =
      firstValue(
        location.latitude,
        location.lat,
        location.coordinates?.latitude,
        location.coordinates?.lat
      );

    const lng =
      firstValue(
        location.longitude,
        location.lng,
        location.lon,
        location.coordinates?.longitude,
        location.coordinates?.lng,
        location.coordinates?.lon
      );

    if (
      toNumber(lat) === null ||
      toNumber(lng) === null
    ) {
      continue;
    }

    const isActual =
      firstValue(
        location.isActualPosition,
        location.actual,
        location.isLive,
        location.live
      );

    const speed =
      toNumber(
        firstValue(
          location.speedKmh,
          location.speed,
          liveData?.speedKmh,
          liveData?.live?.speedKmh
        )
      );

    const bearing =
      toNumber(
        firstValue(
          location.bearingDegrees,
          location.bearing,
          liveData?.bearingDegrees,
          liveData?.live?.bearingDegrees
        )
      );

    return {
      lat: Number(lat),
      lng: Number(lng),

      isActualPosition:
        isActual === undefined
          ? true
          : Boolean(isActual),

      speedKmh:
        speed !== null
          ? speed
          : 0,

      bearingDegrees:
        bearing !== null
          ? bearing
          : null
    };
  }

  return null;
}

// ============================================================
// ROUTE-BASED POSITION FALLBACK
// ============================================================
//
// This is allowed for displaying an upcoming train,
// but NOT sufficient by itself for gate closure.
// ============================================================

function extractRoutePosition(
  liveData,
  route,
  currentIndex
) {
  if (
    !Array.isArray(route) ||
    currentIndex < 0 ||
    !route[currentIndex]
  ) {
    return null;
  }

  const stop =
    route[currentIndex];

  const coordinates =
    getStopCoordinates(
      stop
    );

  if (!coordinates) {
    return null;
  }

  return {
    lat: coordinates.lat,
    lng: coordinates.lng,
    isActualPosition: false,
    speedKmh: 0,
    bearingDegrees: null,
    source: "ROUTE_STOP"
  };
}

// ============================================================
// POSITION EXTRACTION
// ============================================================

function extractBestPosition(
  liveData,
  route,
  currentIndex
) {
  const gps =
    extractCurrentGps(
      liveData
    );

  if (gps) {
    return {
      ...gps,
      source: "GPS"
    };
  }

  const routePosition =
    extractRoutePosition(
      liveData,
      route,
      currentIndex
    );

  if (routePosition) {
    return routePosition;
  }

  return null;
}

// ============================================================
// ETA CALCULATION
// ============================================================

function calculateEtaMinutes(
  distance,
  speedKmh
) {
  if (
    distance === null ||
    distance < 0
  ) {
    return null;
  }

  let speed =
    Number(speedKmh || 0);

  if (
    !Number.isFinite(speed) ||
    speed < 5
  ) {
    speed = 55;
  }

  const minutes =
    (distance / speed) *
    60;

  return Math.max(
    0,
    Math.round(minutes)
  );
}

// ============================================================
// FALLBACK TIME ETA
// ============================================================

function parseTimeToMinutes(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    !Number.isNaN(
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
    return null;
  }

  return (
    Number(match[1]) * 60 +
    Number(match[2])
  );
}

function currentMinutes() {
  const now =
    new Date();

  return (
    now.getHours() * 60 +
    now.getMinutes()
  );
}

function timeDifferenceMinutes(
  target,
  current
) {
  if (
    target === null ||
    current === null
  ) {
    return null;
  }

  let diff =
    target - current;

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// VERIFY ONE TRAIN
// ============================================================

async function verifyTrain(
  trainNumber
) {
  try {
    const response =
      await railRadarGet(
        `/trains/${encodeURIComponent(
          trainNumber
        )}/live?authoritative=true&includeCoordinates=true`
      );

    return response.data;
  } catch (error) {
    console.error(
      `[VERIFY ERROR] ${trainNumber}: ${getErrorMessage(
        error
      )}`
    );

    return null;
  }
}

// ============================================================
// EXTRACT LIVE DATA OBJECT
// ============================================================

function extractLiveData(
  responseBody
) {
  if (
    responseBody?.data
  ) {
    return responseBody.data;
  }

  return responseBody || {};
}

// ============================================================
// PROCESS VERIFIED TRAIN
// ============================================================

function processVerifiedTrain(
  boardItem,
  liveResponse
) {
  const boardTrain =
    boardItem?.train || {};

  const boardStop =
    boardItem?.stop || {};

  const boardLive =
    boardItem?.live || {};

  const liveData =
    extractLiveData(
      liveResponse
    );

  const liveTrain =
    liveData?.train ||
    boardTrain ||
    {};

  const trainNumber =
    String(
      firstValue(
        liveTrain.number,
        liveTrain.trainNumber,
        boardTrain.number
      ) || ""
    ).trim();

  if (!trainNumber) {
    return null;
  }

  const trainName =
    firstValue(
      liveTrain.name,
      liveTrain.trainName,
      boardTrain.name
    ) ||
    `Train ${trainNumber}`;

  const origin =
    getOrigin(
      liveTrain,
      boardItem
    );

  const destination =
    getDestination(
      liveTrain,
      boardItem
    );

  const route =
    getEmbeddedRoute(
      liveData
    );

  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  const currentStopInfo =
    findCurrentStop(
      liveData,
      route
    );

  let currentIndex =
    currentStopInfo.index;

  // ----------------------------------------------------------
  // CURRENT GPS
  // ----------------------------------------------------------

  const gps =
    extractCurrentGps(
      liveData
    );

  // ----------------------------------------------------------
  // IF GPS HAS A CURRENT STATION CODE
  // ----------------------------------------------------------

  if (
    currentIndex < 0 &&
    gps
  ) {
    const currentStationCode =
      normalizeText(
        firstValue(
          liveData?.currentLocation
            ?.stationCode,
          liveData?.currentLocation
            ?.station
        ) || ""
      );

    if (currentStationCode) {
      currentIndex =
        route.findIndex(
          (stop) =>
            getStopCode(stop) ===
            currentStationCode
        );
    }
  }

  // ----------------------------------------------------------
  // DIRECTION FROM ROUTE
  // ----------------------------------------------------------

  let direction =
    determineDirection(
      currentIndex,
      gudurIndex
    );

  // ----------------------------------------------------------
  // EXPLICIT DIRECTION FALLBACK
  // ----------------------------------------------------------

  if (
    direction === "UNKNOWN"
  ) {
    const explicit =
      explicitDirection(
        liveData
      );

    if (explicit) {
      direction = explicit;
    }
  }

  // ----------------------------------------------------------
  // POSITION
  // ----------------------------------------------------------

  const position =
    extractBestPosition(
      liveData,
      route,
      currentIndex
    );

  if (!position) {
    return {
      trainNumber,
      trainName,
      origin,
      destination,
      direction,
      corridor: null,
      position: null,
      distanceToGdrKm: null,
      distanceToChennaiGateKm: null,
      distanceToTirupatiGateKm: null,
      etaMinutes: null,
      speedKmh: 0,
      positionSource: "NONE",
      isAtGudurStation:
        direction === "AT_GUDUR"
    };
  }

  // ----------------------------------------------------------
  // DISTANCES
  // ----------------------------------------------------------

  const distanceToGdrKm =
    distanceKm(
      position.lat,
      position.lng,
      GDR_LAT,
      GDR_LNG
    );

  const distanceToChennaiGateKm =
    distanceKm(
      position.lat,
      position.lng,
      CHENNAI_GATE_LAT,
      CHENNAI_GATE_LNG
    );

  const distanceToTirupatiGateKm =
    distanceKm(
      position.lat,
      position.lng,
      TIRUPATI_GATE_LAT,
      TIRUPATI_GATE_LNG
    );

  // ----------------------------------------------------------
  // CORRIDOR
  // ----------------------------------------------------------

  let corridor =
    determineCorridorFromRoute(
      route,
      currentIndex,
      gudurIndex,
      direction
    );

  // ----------------------------------------------------------
  // ORIGIN FALLBACK
  // ----------------------------------------------------------
  //
  // Only use clearly identifiable origin.
  // Never use destination alone to decide corridor.
  // ----------------------------------------------------------

  if (!corridor) {
    const originText =
      normalizeText(
        origin
      );

    if (
      originText.includes(
        "CHENNAI"
      ) ||
      originText.includes("MAS") ||
      originText.includes("PERAMBUR") ||
      originText.includes("AVADI") ||
      originText.includes("SULLURUPETA") ||
      originText.includes("NAYUDUPETA")
    ) {
      corridor = "MAS";
    }

    if (
      originText.includes(
        "TIRUPATI"
      ) ||
      originText === "TPTY" ||
      originText.includes(
        "RENIGUNTA"
      ) ||
      originText === "RU"
    ) {
      corridor = "TPTY";
    }
  }

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  let etaMinutes =
    calculateEtaMinutes(
      distanceToGdrKm,
      position.speedKmh
    );

  // ----------------------------------------------------------
  // BOARD ETA FALLBACK
  // ----------------------------------------------------------

  if (
    etaMinutes === null &&
    boardStop
  ) {
    const arrival =
      firstValue(
        boardStop.arrival,
        boardLive.expectedArrivalTime
      );

    const targetMinutes =
      parseTimeToMinutes(
        arrival
      );

    etaMinutes =
      timeDifferenceMinutes(
        targetMinutes,
        currentMinutes()
      );

    if (
      etaMinutes !== null
    ) {
      etaMinutes =
        Math.max(
          0,
          etaMinutes
        );
    }
  }

  // ----------------------------------------------------------
  // IS TRAIN AT GUDUR?
  // ----------------------------------------------------------

  const isAtGudurStation =
    direction === "AT_GUDUR" ||
    (
      distanceToGdrKm !== null &&
      distanceToGdrKm < 0.25
    );

  return {
    trainNumber,
    trainName,
    origin,
    destination,

    direction,

    corridor,

    position: {
      lat: position.lat,
      lng: position.lng
    },

    distanceToGdrKm,

    distanceToChennaiGateKm,

    distanceToTirupatiGateKm,

    etaMinutes,

    speedKmh:
      position.speedKmh,

    bearingDegrees:
      position.bearingDegrees,

    positionSource:
      position.source,

    isActualPosition:
      position.isActualPosition,

    isAtGudurStation
  };
}

// ============================================================
// SHOULD CLOSE GATE?
// ============================================================
//
// SAFETY RULE:
//
// Gate can close ONLY when:
//
// 1. Actual GPS position exists.
// 2. Position is marked actual.
// 3. Train is moving toward Gudur.
// 4. Correct corridor is identified.
// 5. Train is physically within 600m of the crossing.
//
// A train merely at Gudur station does NOT close a gate.
// ============================================================

function shouldCloseGate(
  train
) {
  if (!train) {
    return false;
  }

  if (
    train.positionSource !==
    "GPS"
  ) {
    return false;
  }

  if (
    train.isActualPosition ===
    false
  ) {
    return false;
  }

  if (
    train.direction !==
    "TOWARD_GUDUR"
  ) {
    return false;
  }

  if (
    train.isAtGudurStation
  ) {
    return false;
  }

  if (!train.corridor) {
    return false;
  }

  if (
    train.corridor !== "MAS" &&
    train.corridor !== "TPTY"
  ) {
    return false;
  }

  const distance =
    train.corridor === "MAS"
      ? train.distanceToChennaiGateKm
      : train.distanceToTirupatiGateKm;

  if (
    distance === null
  ) {
    return false;
  }

  return (
    distance <=
    GATE_STOP_DISTANCE_KM
  );
}

// ============================================================
// GATE PAYLOAD
// ============================================================

function makeClosedGate(
  train
) {
  const distance =
    train.corridor === "MAS"
      ? train.distanceToChennaiGateKm
      : train.distanceToTirupatiGateKm;

  let waitMinutes =
    train.etaMinutes;

  if (
    waitMinutes === null
  ) {
    waitMinutes = 3;
  }

  waitMinutes =
    Math.max(
      1,
      Math.min(
        15,
        Math.round(waitMinutes + 2)
      )
    );

  return {
    status: "CLOSED",

    waitMinutes,

    activeTrain:
      `${train.trainNumber} ${train.trainName}`,

    direction:
      "TOWARD GUDUR",

    corridor:
      train.corridor,

    distanceKm:
      Number(
        distance.toFixed(3)
      ),

    speedKmh:
      Number(
        train.speedKmh || 0
      ),

    positionSource:
      "GPS",

    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// OPEN GATE
// ============================================================

function makeOpenGate() {
  return {
    status: "OPEN",

    waitMinutes: 0,

    activeTrain:
      "Tracks clear",

    direction: "",

    corridor: "",

    distanceKm: null,

    speedKmh: 0,

    positionSource:
      "",

    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// BUILD UPCOMING TRAIN
// ============================================================

function buildUpcomingTrain(
  train
) {
  if (!train) {
    return null;
  }

  if (
    train.distanceToGdrKm ===
    null
  ) {
    return null;
  }

  if (
    train.distanceToGdrKm >
    UPCOMING_MAX_DISTANCE_KM
  ) {
    return null;
  }

  let directionLabel =
    "Direction unavailable";

  if (
    train.direction ===
    "TOWARD_GUDUR"
  ) {
    directionLabel =
      "Toward Gudur";
  } else if (
    train.direction ===
    "FROM_GUDUR"
  ) {
    directionLabel =
      "From Gudur";
  } else if (
    train.direction ===
    "AT_GUDUR"
  ) {
    directionLabel =
      "At Gudur";
  }

  return {
    trainNo:
      train.trainNumber,

    name:
      train.trainName,

    origin:
      train.origin ||
      "Unknown",

    destination:
      train.destination ||
      "Unknown",

    direction:
      directionLabel,

    corridor:
      train.corridor ||
      "OTHER",

    etaMinutes:
      train.etaMinutes,

    distanceKm:
      Number(
        train.distanceToGdrKm.toFixed(2)
      ),

    speedKmh:
      Number(
        train.speedKmh || 0
      ),

    positionSource:
      train.positionSource,

    isActualPosition:
      Boolean(
        train.isActualPosition
      ),

    atGudur:
      Boolean(
        train.isAtGudurStation
      )
  };
}

// ============================================================
// ERROR MESSAGE
// ============================================================

function getErrorMessage(
  error
) {
  if (
    error?.response
  ) {
    return `HTTP ${error.response.status} ${
      error.response.data?.error?.message ||
      error.response.data?.message ||
      ""
    }`.trim();
  }

  return (
    error?.message ||
    String(error)
  );
}

// ============================================================
// VERIFICATION QUEUE
// ============================================================

let verificationQueue = [];

// ============================================================
// UPDATE VERIFICATION QUEUE
// ============================================================

function updateVerificationQueue(
  numbers
) {
  const unique =
    [...new Set(numbers)];

  // Keep existing queue order for
  // trains still present on the board.
  const existing =
    verificationQueue.filter(
      (number) =>
        unique.includes(number)
    );

  // Add new trains.
  for (const number of unique) {
    if (
      !existing.includes(number)
    ) {
      existing.push(number);
    }
  }

  verificationQueue =
    existing;
}

// ============================================================
// TAKE NEXT VERIFICATION BATCH
// ============================================================

function getNextVerificationBatch() {
  if (
    verificationQueue.length ===
    0
  ) {
    return [];
  }

  const count =
    Math.min(
      VERIFY_PER_CYCLE,
      verificationQueue.length
    );

  const selected =
    verificationQueue.slice(
      0,
      count
    );

  verificationQueue =
    verificationQueue
      .slice(count)
      .concat(selected);

  return selected;
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
    `[${now.toLocaleTimeString()}] Gudur Live Radar Update`
  );

  console.log(
    "=========================================="
  );

  try {
    // ----------------------------------------------------------
    // RESET REQUEST WINDOW IF NECESSARY
    // ----------------------------------------------------------

    resetRequestWindowIfNeeded();

    // ----------------------------------------------------------
    // STATION BOARD
    // ----------------------------------------------------------

    console.log(
      "[1/8] Requesting GDR live station board..."
    );

    const boardResponse =
      await railRadarGet(
        "/stations/GDR/live?hours=4&includeIntermediate=true"
      );

    const boardBody =
      boardResponse.data || {};

    const trainsArray =
      boardBody?.data?.trains ||
      boardBody?.trains ||
      [];

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      throw new Error(
        "RailRadar returned invalid station-board data."
      );
    }

    console.log(
      `RailRadar returned ${trainsArray.length} board records.`
    );

    // ----------------------------------------------------------
    // BUILD BOARD MAP
    // ----------------------------------------------------------

    const boardMap =
      new Map();

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const number =
        getTrainNumber(
          train,
          item
        );

      if (!number) {
        continue;
      }

      boardMap.set(
        number,
        item
      );
    }

    // ----------------------------------------------------------
    // UPDATE ROTATING QUEUE
    // ----------------------------------------------------------

    updateVerificationQueue(
      [...boardMap.keys()]
    );

    const verificationNumbers =
      getNextVerificationBatch();

    console.log(
      `Verification queue: ${verificationQueue.length} trains`
    );

    console.log(
      `Verifying ${verificationNumbers.length} trains this cycle.`
    );

    // ----------------------------------------------------------
    // VERIFY TRAINS
    // ----------------------------------------------------------

    const verifiedTrains = [];

    for (
      const trainNumber of verificationNumbers
    ) {
      if (
        !canMakeRequest()
      ) {
        console.log(
          "Request limit reached. Stopping verification."
        );

        break;
      }

      console.log(
        `[LIVE] Verifying ${trainNumber}...`
      );

      const liveResponse =
        await verifyTrain(
          trainNumber
        );

      if (!liveResponse) {
        continue;
      }

      const boardItem =
        boardMap.get(
          trainNumber
        ) || {};

      const processed =
        processVerifiedTrain(
          boardItem,
          liveResponse
        );

      if (!processed) {
        continue;
      }

      verifiedTrains.push(
        processed
      );

      const distanceText =
        processed.distanceToGdrKm ===
        null
          ? "unknown"
          : `${processed.distanceToGdrKm.toFixed(
              2
            )} km`;

      console.log(
        `[GPS] ${processed.trainNumber} ${processed.trainName} | ${processed.direction} | corridor=${processed.corridor || "OTHER"} | GDR=${distanceText} | source=${processed.positionSource}`
      );
    }

    // ----------------------------------------------------------
    // GATE STATUS
    // ----------------------------------------------------------

    let chennaiGate =
      makeOpenGate();

    let tirupatiGate =
      makeOpenGate();

    // ----------------------------------------------------------
    // FIND CLOSING TRAINS
    // ----------------------------------------------------------

    const closingCandidates =
      verifiedTrains.filter(
        shouldCloseGate
      );

    // ----------------------------------------------------------
    // CHENNAI GATE
    // ----------------------------------------------------------

    const chennaiCandidates =
      closingCandidates
        .filter(
          (train) =>
            train.corridor ===
            "MAS"
        )
        .sort(
          (a, b) =>
            (
              a.distanceToChennaiGateKm ??
              Infinity
            ) -
            (
              b.distanceToChennaiGateKm ??
              Infinity
            )
        );

    if (
      chennaiCandidates.length >
      0
    ) {
      chennaiGate =
        makeClosedGate(
          chennaiCandidates[0]
        );

      console.log(
        `[GATE CLOSED] Chennai Gate -> ${chennaiGate.activeTrain} | ${chennaiGate.distanceKm} km`
      );
    }

    // ----------------------------------------------------------
    // TIRUPATI GATE
    // ----------------------------------------------------------

    const tirupatiCandidates =
      closingCandidates
        .filter(
          (train) =>
            train.corridor ===
            "TPTY"
        )
        .sort(
          (a, b) =>
            (
              a.distanceToTirupatiGateKm ??
              Infinity
            ) -
            (
              b.distanceToTirupatiGateKm ??
              Infinity
            )
        );

    if (
      tirupatiCandidates.length >
      0
    ) {
      tirupatiGate =
        makeClosedGate(
          tirupatiCandidates[0]
        );

      console.log(
        `[GATE CLOSED] Tirupati Gate -> ${tirupatiGate.activeTrain} | ${tirupatiGate.distanceKm} km`
      );
    }

    // ----------------------------------------------------------
    // UPCOMING TRAINS
    // ----------------------------------------------------------

    const upcoming =
      verifiedTrains
        .map(
          buildUpcomingTrain
        )
        .filter(Boolean);

    // Remove duplicates.
    const uniqueUpcoming =
      [];

    const seenUpcoming =
      new Set();

    for (
      const train of upcoming
    ) {
      if (
        seenUpcoming.has(
          train.trainNo
        )
      ) {
        continue;
      }

      seenUpcoming.add(
        train.trainNo
      );

      uniqueUpcoming.push(
        train
      );
    }

    // Sort by distance first.
    uniqueUpcoming.sort(
      (a, b) => {
        const aDistance =
          a.distanceKm ??
          Infinity;

        const bDistance =
          b.distanceKm ??
          Infinity;

        if (
          aDistance !==
          bDistance
        ) {
          return (
            aDistance -
            bDistance
          );
        }

        const aEta =
          a.etaMinutes ??
          Infinity;

        const bEta =
          b.etaMinutes ??
          Infinity;

        return (
          aEta -
          bEta
        );
      }
    );

    const topUpcoming =
      uniqueUpcoming.slice(
        0,
        10
      );

    // ----------------------------------------------------------
    // FIREBASE UPDATE
    // ----------------------------------------------------------

    await gateRef.set({
      tirupatiGate,

      chennaiGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toISOString(),

      lastUpdatedLocal:
        now.toLocaleTimeString(),

      system: {
        status: "ONLINE",

        apiRequestsThisMinute:
          requestsThisMinute,

        verifiedCount:
          verifiedTrains.length,

        boardCount:
          trainsArray.length,

        gpsVerifiedCount:
          verifiedTrains.filter(
            (t) =>
              t.positionSource ===
              "GPS"
          ).length,

        gateLogic:
          "GPS + route direction + corridor + 600m threshold",

        stationToGateDistanceKm:
          0.53059
      }
    });

    // ----------------------------------------------------------
    // LOG RESULTS
    // ----------------------------------------------------------

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      ` -> Chennai Gate : ${chennaiGate.status} | ${chennaiGate.activeTrain}`
    );

    console.log(
      ` -> Tirupati Gate: ${tirupatiGate.status} | ${tirupatiGate.activeTrain}`
    );

    console.log(
      ` -> Verified trains: ${verifiedTrains.length}`
    );

    console.log(
      ` -> Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      ` -> API requests this minute: ${requestsThisMinute}/${MAX_API_REQUESTS_PER_CYCLE}`
    );

    // ----------------------------------------------------------
    // UPCOMING LOG
    // ----------------------------------------------------------

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING / LIVE TRAINS]"
      );

      for (
        const train of topUpcoming
      ) {
        console.log(
          `   ${train.trainNo} ${train.name} | ${train.direction} | ${train.distanceKm} km from GDR | ETA ${
            train.etaMinutes === null
              ? "?"
              : `${train.etaMinutes}m`
          }`
        );
      }
    } else {
      console.log(
        "\n[UPCOMING / LIVE TRAINS] None verified"
      );
    }
  } catch (error) {
    // ----------------------------------------------------------
    // ERROR
    // ----------------------------------------------------------

    console.error(
      "\n[UPDATE ERROR]"
    );

    if (
      error?.response
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

    // ----------------------------------------------------------
    // FAIL-SAFE FIREBASE STATUS
    // ----------------------------------------------------------
    //
    // Never leave an old CLOSED state active when the live
    // service has failed.
    // ----------------------------------------------------------

    try {
      await gateRef.update({
        "chennaiGate": {
          status: "OPEN",
          waitMinutes: 0,
          activeTrain:
            "Live data unavailable",
          direction: "",
          corridor: "",
          positionSource: "",
          updatedAt:
            new Date().toISOString()
        },

        "tirupatiGate": {
          status: "OPEN",
          waitMinutes: 0,
          activeTrain:
            "Live data unavailable",
          direction: "",
          corridor: "",
          positionSource: "",
          updatedAt:
            new Date().toISOString()
        },

        "system/status":
          "API_ERROR",

        "system/error":
          getErrorMessage(
            error
          ),

        "system/errorAt":
          new Date().toISOString()
      });

      console.log(
        "[FAIL-SAFE] Firebase gate state reset to OPEN because live data failed."
      );
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
  "=========================================="
);

console.log(
  " GUDUR GATE LIVE TRAIN MONITOR "
);

console.log(
  "=========================================="
);

console.log(
  `Chennai Gate : ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  `Tirupati Gate: ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  `Gudur Station: ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  "Station -> Gate distance: approximately 530.59 metres"
);

console.log(
  "=========================================="
);

console.log(
  "RailRadar API: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "Position priority: Actual GPS -> route stop"
);

console.log(
  "Gate closure: GPS position + route direction + corridor"
);

console.log(
  `Gate threshold: ${GATE_STOP_DISTANCE_KM} km`
);

console.log(
  `Upcoming range: ${UPCOMING_MAX_DISTANCE_KM} km`
);

console.log(
  `API request target: ${MAX_API_REQUESTS_PER_CYCLE}/minute`
);

console.log(
  "=========================================="
);

// ============================================================
// FIRST UPDATE
// ============================================================

updateGateSystem();

// ============================================================
// UPDATE EVERY MINUTE
// ============================================================

setInterval(
  updateGateSystem,
  REFRESH_INTERVAL_MS
);
