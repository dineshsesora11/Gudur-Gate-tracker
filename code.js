const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR GATE - REAL-TIME RAILRADAR MONITOR
// ============================================================
//
// Chennai/Tirupati side -> Gudur only
//
// Chennai -> Gudur  = Chennai Gate
// Tirupati -> Gudur  = Tirupati Gate
//
// Gudur -> Chennai/Tirupati is rejected.
//
// Gate closure requires ACTUAL LIVE GPS.
// Route interpolation is used only for display/ETA.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

const SERVICE_ACCOUNT_FILE =
  "./serviceAccountKey.json";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";


// ============================================================
// GUDUR LOCATION
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;


// ============================================================
// GATE LOCATIONS
// ============================================================

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;


// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;

const GATE_STOP_DISTANCE_KM = 0.6;

// One station-board request + up to 7 live requests.
const MAX_LIVE_VERIFICATIONS = 7;

const MAX_BOARD_CANDIDATES = 22;

// Local computer refresh.
const REFRESH_INTERVAL_MS = 60000;

const DEFAULT_SPEED_KMH = 55;

const MIN_SPEED_KMH = 5;


// ============================================================
// API KEY CHECK
// ============================================================

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  console.error(
    "Set RAILRADAR_API_KEY before starting the monitor."
  );

  process.exit(1);
}


// ============================================================
// FIREBASE INITIALIZATION
// ============================================================

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log(
      "Loading Firebase service account from FIREBASE_SERVICE_ACCOUNT..."
    );

    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else if (
    fs.existsSync(SERVICE_ACCOUNT_FILE)
  ) {
    console.log(
      "Loading Firebase service account from local file..."
    );

    serviceAccount = require(
      SERVICE_ACCOUNT_FILE
    );
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
    error.message
  );

  process.exit(1);
}


if (!admin.apps.length) {
  admin.initializeApp({
    credential:
      admin.credential.cert(
        serviceAccount
      ),

    databaseURL:
      FIREBASE_DATABASE_URL
  });
}


const db =
  admin.database();

const gateRef =
  db.ref("gudur_gates");


// ============================================================
// TIRUPATI CORRIDOR TRAIN NUMBERS
// ============================================================
//
// Fallback only.
//
// Train number alone is NOT enough to close a gate.
// Direction must still be TOWARD_GUDUR.
//

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
// NUMBER HELPERS
// ============================================================

function safeNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function firstNumber(...values) {
  for (const value of values) {
    const number =
      safeNumber(value);

    if (number !== null) {
      return number;
    }
  }

  return null;
}


// ============================================================
// NESTED OBJECT LOOKUP
// ============================================================

function getNested(
  object,
  paths
) {
  if (
    !object ||
    typeof object !== "object"
  ) {
    return null;
  }

  for (const path of paths) {
    const parts =
      Array.isArray(path)
        ? path
        : String(path).split(".");

    let current =
      object;

    for (const part of parts) {
      if (current == null) {
        current = null;
        break;
      }

      current =
        current[part];
    }

    if (
      current !== undefined &&
      current !== null &&
      current !== ""
    ) {
      return current;
    }
  }

  return null;
}


// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function haversineKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) /
    180;

  const dLng =
    ((lng2 - lng1) * Math.PI) /
    180;

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

  return R * c;
}


// ============================================================
// TEXT MATCHING
// ============================================================

function containsAny(
  text,
  values
) {
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
// GET TRAIN ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const source =
    train?.source;

  if (
    source &&
    typeof source === "object"
  ) {
    return (
      source.name ||
      source.code ||
      ""
    );
  }

  return (
    train?.origin ||
    train?.from ||
    train?.fromStation ||
    train?.startStation ||
    train?.start ||
    source ||
    item?.origin ||
    item?.source?.name ||
    item?.source?.code ||
    item?.from ||
    item?.fromStation ||
    item?.startStation ||
    ""
  );
}


// ============================================================
// GET TRAIN DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const destination =
    train?.destination;

  if (
    destination &&
    typeof destination === "object"
  ) {
    return (
      destination.name ||
      destination.code ||
      ""
    );
  }

  return (
    train?.to ||
    train?.destinationStation ||
    train?.endStation ||
    destination ||
    item?.destination ||
    item?.to ||
    item?.destinationStation ||
    ""
  );
}


// ============================================================
// CHENNAI SIDE DETECTION
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const origin =
    getOrigin(
      train,
      item
    );

  return containsAny(
    origin,
    [
      "CHENNAI",
      "MAS",
      "CHENNAI CENTRAL",
      "MGR CHENNAI CENTRAL",
      "DR MGR CHENNAI CENTRAL",
      "PURATCHI THALAIVAR DR MGR CENTRAL",
      "AVADI",
      "PERAMBUR",
      "SULLURUPETA",
      "NAYUDUPETA"
    ]
  );
}


// ============================================================
// TIRUPATI SIDE DETECTION
// ============================================================

function isFromTirupatiSide(
  train,
  item
) {
  const origin =
    getOrigin(
      train,
      item
    );

  return containsAny(
    origin,
    [
      "TIRUPATI",
      "TPTY",
      "TIRUPATI MAIN",
      "RENIGUNTA",
      "RU"
    ]
  );
}


// ============================================================
// GET EXPLICIT DIRECTION TEXT
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  const fields = [
    train?.direction,
    train?.travelDirection,
    train?.routeDirection,
    train?.runningDirection,

    live?.direction,
    live?.travelDirection,
    live?.routeDirection,
    live?.runningDirection,

    stop?.direction,

    item?.direction,
    item?.travelDirection,
    item?.routeDirection,
    item?.runningDirection,

    item?.currentLocation?.direction,
    item?.currentLocation?.travelDirection
  ];

  return fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}


// ============================================================
// EXPLICIT DIRECTION CHECK
// ============================================================

function hasInboundDirection(
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


  // ----------------------------------------------------------
  // TOWARD GUDUR
  // ----------------------------------------------------------

  if (
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("APPROACHING GUDUR")
  ) {
    return true;
  }


  // ----------------------------------------------------------
  // AWAY FROM GUDUR
  // ----------------------------------------------------------

  if (
    direction.includes("FROM GUDUR") ||
    direction.includes("GUDUR OUTBOUND") ||
    direction.includes("OUTBOUND") ||
    direction.includes("AWAY FROM GUDUR") ||
    direction.includes("TO CHENNAI") ||
    direction.includes("TOWARD CHENNAI") ||
    direction.includes("TOWARDS CHENNAI") ||
    direction.includes("TO TIRUPATI") ||
    direction.includes("TOWARD TIRUPATI") ||
    direction.includes("TOWARDS TIRUPATI")
  ) {
    return false;
  }


  return null;
}


// ============================================================
// GET ROUTE
// ============================================================

function getRoute(
  liveResponse
) {
  const route =
    liveResponse?.route ||
    liveResponse?.data?.route ||
    liveResponse?.live?.route;

  return Array.isArray(route)
    ? route
    : [];
}


// ============================================================
// FIND GUDUR IN ROUTE
// ============================================================

function findGudurRouteIndex(
  route
) {
  if (
    !Array.isArray(route) ||
    route.length === 0
  ) {
    return -1;
  }

  for (
    let i = 0;
    i < route.length;
    i++
  ) {
    const station =
      route[i];

    const code =
      normalizeText(
        station?.stationCode ||
        station?.code ||
        station?.station?.code ||
        ""
      );

    const name =
      normalizeText(
        station?.stationName ||
        station?.name ||
        station?.station?.name ||
        ""
      );

    if (
      code === "GDR" ||
      code.includes("GDR") ||
      name.includes("GUDUR")
    ) {
      return i;
    }
  }

  return -1;
}


// ============================================================
// GET CURRENT LOCATION
// ============================================================
//
// RailRadar live response uses:
//
// data.currentLocation
//
// and:
//
// currentLocation.sequence
//
// ============================================================

function getCurrentLocation(
  liveResponse
) {
  return (
    liveResponse?.currentLocation ||
    liveResponse?.data?.currentLocation ||
    liveResponse?.live?.currentLocation ||
    null
  );
}


// ============================================================
// GET ROUTE DIRECTION
// ============================================================

function getRouteDirection(
  liveResponse
) {
  const route =
    getRoute(
      liveResponse
    );

  const currentLocation =
    getCurrentLocation(
      liveResponse
    );

  if (
    route.length === 0 ||
    !currentLocation
  ) {
    return "UNKNOWN";
  }


  const currentSequence =
    firstNumber(
      currentLocation.sequence
    );

  if (
    currentSequence === null
  ) {
    return "UNKNOWN";
  }


  let gudurSequence =
    null;


  // ----------------------------------------------------------
  // Find Gudur route sequence.
  // ----------------------------------------------------------

  for (
    const station of route
  ) {
    const code =
      normalizeText(
        station?.stationCode ||
        station?.code ||
        ""
      );

    const name =
      normalizeText(
        station?.stationName ||
        station?.name ||
        ""
      );

    if (
      code === "GDR" ||
      name.includes("GUDUR")
    ) {
      const sequence =
        firstNumber(
          station?.sequence
        );

      if (
        sequence !== null
      ) {
        gudurSequence =
          sequence;

        break;
      }
    }
  }


  if (
    gudurSequence === null
  ) {
    const gudurIndex =
      findGudurRouteIndex(
        route
      );

    if (
      gudurIndex >= 0
    ) {
      gudurSequence =
        firstNumber(
          route[gudurIndex]?.sequence
        );
    }
  }


  if (
    gudurSequence === null
  ) {
    return "UNKNOWN";
  }


  // ----------------------------------------------------------
  // Before Gudur.
  // ----------------------------------------------------------

  if (
    currentSequence <
    gudurSequence
  ) {
    return "TOWARD_GUDUR";
  }


  // ----------------------------------------------------------
  // After Gudur.
  // ----------------------------------------------------------

  if (
    currentSequence >
    gudurSequence
  ) {
    return "AWAY_FROM_GUDUR";
  }


  // Exactly Gudur.
  return "AT_GUDUR";
}


// ============================================================
// DETERMINE FINAL DIRECTION
// ============================================================

function determineDirection(
  train,
  liveResponse,
  stop,
  item
) {
  const live =
    liveResponse?.live ||
    liveResponse ||
    {};


  const explicit =
    hasInboundDirection(
      train,
      live,
      stop,
      {
        ...item,

        currentLocation:
          liveResponse?.currentLocation ||
          liveResponse?.data?.currentLocation
      }
    );


  if (
    explicit === true
  ) {
    return "TOWARD_GUDUR";
  }


  if (
    explicit === false
  ) {
    return "AWAY_FROM_GUDUR";
  }


  const routeDirection =
    getRouteDirection(
      liveResponse
    );


  if (
    routeDirection ===
    "TOWARD_GUDUR"
  ) {
    return "TOWARD_GUDUR";
  }


  if (
    routeDirection ===
    "AWAY_FROM_GUDUR"
  ) {
    return "AWAY_FROM_GUDUR";
  }


  if (
    routeDirection ===
    "AT_GUDUR"
  ) {
    return "AT_GUDUR";
  }


  return "UNKNOWN";
}


// ============================================================
// DETERMINE CORRIDOR
// ============================================================

function determineCorridor(
  train,
  item,
  direction
) {
  if (
    direction !==
    "TOWARD_GUDUR"
  ) {
    return "OTHER";
  }


  const trainNumber =
    String(
      train?.number ||
      ""
    ).trim();


  // Chennai side.
  if (
    isFromChennaiSide(
      train,
      item
    )
  ) {
    return "MAS";
  }


  // Tirupati side.
  if (
    isFromTirupatiSide(
      train,
      item
    )
  ) {
    return "TPTY";
  }


  // Known Tirupati train fallback.
  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNumber
    )
  ) {
    return "TPTY";
  }


  return "OTHER";
}


// ============================================================
// EXTRACT ACTUAL GPS
// ============================================================
//
// ONLY actual GPS is allowed to close a gate.
//

function extractGpsPosition(
  liveResponse
) {
  const currentLocation =
    getCurrentLocation(
      liveResponse
    );


  if (
    !currentLocation
  ) {
    return null;
  }


  const lat =
    firstNumber(
      currentLocation.lat,
      currentLocation.latitude,
      currentLocation.location?.lat,
      currentLocation.location?.latitude
    );


  const lng =
    firstNumber(
      currentLocation.lng,
      currentLocation.longitude,
      currentLocation.location?.lng,
      currentLocation.location?.longitude
    );


  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }


  const isActual =
    currentLocation.isActualPosition !==
    false;


  return {
    lat,
    lng,

    speedKmh:
      firstNumber(
        currentLocation.speedKmh,
        currentLocation.speed,
        currentLocation.speedKmH
      ),

    bearingDegrees:
      firstNumber(
        currentLocation.bearingDegrees,
        currentLocation.bearing,
        currentLocation.heading
      ),

    isActualPosition:
      isActual,

    source:
      "LIVE_GPS"
  };
}


// ============================================================
// ROUTE STOP POSITION
// ============================================================
//
// Display/ETA only.
// NEVER closes gate.
//

function extractRouteStopPosition(
  liveResponse
) {
  const route =
    getRoute(
      liveResponse
    );

  const currentLocation =
    getCurrentLocation(
      liveResponse
    );


  if (
    route.length === 0 ||
    !currentLocation
  ) {
    return null;
  }


  const currentSequence =
    firstNumber(
      currentLocation.sequence
    );


  if (
    currentSequence === null
  ) {
    return null;
  }


  const station =
    route.find(
      (item) =>
        firstNumber(
          item?.sequence
        ) ===
        currentSequence
    );


  if (
    !station
  ) {
    return null;
  }


  const lat =
    firstNumber(
      station?.lat,
      station?.latitude
    );

  const lng =
    firstNumber(
      station?.lng,
      station?.longitude
    );


  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }


  return {
    lat,
    lng,

    speedKmh:
      firstNumber(
        currentLocation.speedKmh
      ),

    bearingDegrees:
      firstNumber(
        currentLocation.bearingDegrees
      ),

    isActualPosition:
      false,

    source:
      "ROUTE_STOP"
  };
}


// ============================================================
// INTERPOLATED ROUTE POSITION
// ============================================================

function extractInterpolatedRoutePosition(
  liveResponse
) {
  const route =
    getRoute(
      liveResponse
    );

  const currentLocation =
    getCurrentLocation(
      liveResponse
    );


  if (
    route.length < 2 ||
    !currentLocation
  ) {
    return null;
  }


  const sequence =
    firstNumber(
      currentLocation.sequence
    );

  const progress =
    firstNumber(
      currentLocation.segmentProgress
    );


  if (
    sequence === null ||
    progress === null
  ) {
    return null;
  }


  const p =
    Math.max(
      0,
      Math.min(
        1,
        progress
      )
    );


  const currentIndex =
    route.findIndex(
      (station) =>
        firstNumber(
          station?.sequence
        ) ===
        sequence
    );


  if (
    currentIndex < 0
  ) {
    return null;
  }


  const nextIndex =
    currentIndex + 1;


  if (
    nextIndex >= route.length
  ) {
    return null;
  }


  const currentStation =
    route[currentIndex];

  const nextStation =
    route[nextIndex];


  const lat1 =
    firstNumber(
      currentStation?.lat,
      currentStation?.latitude
    );

  const lng1 =
    firstNumber(
      currentStation?.lng,
      currentStation?.longitude
    );

  const lat2 =
    firstNumber(
      nextStation?.lat,
      nextStation?.latitude
    );

  const lng2 =
    firstNumber(
      nextStation?.lng,
      nextStation?.longitude
    );


  if (
    lat1 === null ||
    lng1 === null ||
    lat2 === null ||
    lng2 === null
  ) {
    return null;
  }


  const lat =
    lat1 +
    (lat2 - lat1) * p;


  const lng =
    lng1 +
    (lng2 - lng1) * p;


  return {
    lat,
    lng,

    speedKmh:
      firstNumber(
        currentLocation.speedKmh
      ),

    bearingDegrees:
      firstNumber(
        currentLocation.bearingDegrees
      ),

    isActualPosition:
      false,

    source:
      "ROUTE_INTERPOLATED"
  };
}


// ============================================================
// BEST POSITION
// ============================================================
//
// Priority:
//
// 1. Actual GPS
// 2. Route interpolation
// 3. Route stop
//
// ============================================================

function getBestPosition(
  liveResponse
) {
  const actual =
    extractGpsPosition(
      liveResponse
    );


  if (
    actual
  ) {
    return actual;
  }


  const interpolated =
    extractInterpolatedRoutePosition(
      liveResponse
    );


  if (
    interpolated
  ) {
    return interpolated;
  }


  const routeStop =
    extractRouteStopPosition(
      liveResponse
    );


  if (
    routeStop
  ) {
    return routeStop;
  }


  return null;
}


// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  position
) {
  if (
    !position
  ) {
    return null;
  }


  return haversineKm(
    position.lat,
    position.lng,
    GDR_LAT,
    GDR_LNG
  );
}


// ============================================================
// DISTANCE TO GATE
// ============================================================

function getGateDistance(
  position,
  corridor
) {
  if (
    !position
  ) {
    return null;
  }


  if (
    corridor === "MAS"
  ) {
    return haversineKm(
      position.lat,
      position.lng,
      CHENNAI_GATE_LAT,
      CHENNAI_GATE_LNG
    );
  }


  if (
    corridor === "TPTY"
  ) {
    return haversineKm(
      position.lat,
      position.lng,
      TIRUPATI_GATE_LAT,
      TIRUPATI_GATE_LNG
    );
  }


  return null;
}


// ============================================================
// ETA CALCULATION
// ============================================================

function calculateEtaMinutes(
  distanceKm,
  speedKmh
) {
  if (
    !Number.isFinite(
      distanceKm
    )
  ) {
    return null;
  }


  let speed =
    Number(speedKmh);


  if (
    !Number.isFinite(speed) ||
    speed < MIN_SPEED_KMH
  ) {
    speed =
      DEFAULT_SPEED_KMH;
  }


  return Math.max(
    0,
    Math.round(
      (distanceKm / speed) *
      60
    )
  );
}


// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeValue,
  delayMinutes = 0
) {
  if (
    !timeValue
  ) {
    return -1;
  }


  const date =
    new Date(
      timeValue
    );


  if (
    !Number.isNaN(
      date.getTime()
    )
  ) {
    return (
      date.getHours() *
        60 +
      date.getMinutes() +
      Number(
        delayMinutes || 0
      )
    );
  }


  const match =
    String(
      timeValue
    )
      .trim()
      .match(
        /(\d{1,2}):(\d{2})/
      );


  if (
    match
  ) {
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
      Number(
        delayMinutes || 0
      )
    );
  }


  return -1;
}


// ============================================================
// TIME DIFFERENCE
// ============================================================

function calculateTimeDifference(
  arrivalMinutes,
  currentMinutes
) {
  let difference =
    arrivalMinutes -
    currentMinutes;


  if (
    difference < -720
  ) {
    difference += 1440;
  }


  if (
    difference > 720
  ) {
    difference -= 1440;
  }


  return difference;
}


// ============================================================
// BOARD ARRIVAL TIME
// ============================================================

function getBoardArrivalTime(
  boardItem
) {
  const stop =
    boardItem?.stop ||
    {};

  const live =
    boardItem?.live ||
    {};

  const train =
    boardItem?.train ||
    {};


  return (
    stop.arrival ||
    live.expectedArrivalTime ||
    live.arrivalTime ||
    train.arrival ||
    ""
  );
}


// ============================================================
// BOARD DEPARTURE TIME
// ============================================================

function getBoardDepartureTime(
  boardItem
) {
  const stop =
    boardItem?.stop ||
    {};

  const live =
    boardItem?.live ||
    {};


  return (
    stop.departure ||
    live.expectedDepartureTime ||
    live.departureTime ||
    ""
  );
}


// ============================================================
// MERGE LIVE RESPONSE
// ============================================================

function mergeVerifiedData(
  boardItem,
  liveResponse
) {
  const data =
    liveResponse?.data ||
    liveResponse ||
    {};


  const boardTrain =
    boardItem?.train ||
    {};

  const liveTrain =
    data?.train ||
    {};


  const mergedTrain = {
    ...boardTrain,
    ...liveTrain
  };


  const mergedLive = {
    ...(boardItem?.live || {}),
    ...(data?.live || {})
  };


  const mergedStop = {
    ...(boardItem?.stop || {}),
    ...(data?.stop || {})
  };


  return {
    ...boardItem,

    train:
      mergedTrain,

    live:
      mergedLive,

    stop:
      mergedStop,

    currentLocation:
      data?.currentLocation ||
      boardItem?.currentLocation ||
      null,

    previousHalt:
      data?.previousHalt ||
      boardItem?.previousHalt ||
      null,

    nextHalt:
      data?.nextHalt ||
      boardItem?.nextHalt ||
      null,

    route:
      Array.isArray(
        data?.route
      )
        ? data.route
        : (
            Array.isArray(
              boardItem?.route
            )
              ? boardItem.route
              : []
          ),

    delayMinutes:
      firstNumber(
        data?.delayMinutes,
        boardItem?.delayMinutes,
        mergedLive?.delayMinutes
      ) || 0,

    isLive:
      data?.isLive ??
      boardItem?.isLive ??
      false,

    status:
      data?.status ||
      boardItem?.status ||
      "",

    lastUpdatedAt:
      data?.lastUpdatedAt ||
      boardItem?.lastUpdatedAt ||
      ""
  };
}


// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNumber
) {
  const endpoints = [
    `/trains/${trainNumber}/live`,
    `/trains/${trainNumber}`,
    `/train/${trainNumber}/live`
  ];


  let lastError =
    null;


  for (
    const endpoint of endpoints
  ) {
    try {
      const response =
        await axios.get(
          `${RAILRADAR_BASE_URL}${endpoint}`,
          {
            headers: {
              Authorization:
                `Bearer ${RAILRADAR_API_KEY}`,

              Accept:
                "application/json"
            },

            timeout:
              12000
          }
        );


      if (
        response?.data
      ) {
        return response.data;
      }

    } catch (error) {
      lastError =
        error;


      // Only try next endpoint on 404.
      if (
        error.response &&
        error.response.status !== 404
      ) {
        break;
      }
    }
  }


  throw (
    lastError ||
    new Error(
      `Unable to fetch live train ${trainNumber}`
    )
  );
}


// ============================================================
// GET TRAIN NUMBER
// ============================================================

function getTrainNumber(
  boardItem
) {
  return String(
    boardItem?.train?.number ||
    boardItem?.number ||
    ""
  ).trim();
}


// ============================================================
// SHOULD SHOW UPCOMING
// ============================================================

function shouldShowUpcoming(
  processed
) {
  if (
    !processed
  ) {
    return false;
  }


  if (
    processed.direction !==
    "TOWARD_GUDUR"
  ) {
    return false;
  }


  if (
    processed.corridor !==
      "MAS" &&
    processed.corridor !==
      "TPTY"
  ) {
    return false;
  }


  if (
    processed.atGudur
  ) {
    return false;
  }


  if (
    processed.passedGate
  ) {
    return false;
  }


  if (
    processed.distanceToGudurKm ===
      null ||
    processed.distanceToGudurKm >
      UPCOMING_MAX_DISTANCE_KM
  ) {
    return false;
  }


  return true;
}


// ============================================================
// SHOULD CLOSE GATE
// ============================================================

function shouldCloseGate(
  processed
) {
  if (
    !processed
  ) {
    return false;
  }


  if (
    processed.direction !==
    "TOWARD_GUDUR"
  ) {
    return false;
  }


  if (
    processed.corridor !==
      "MAS" &&
    processed.corridor !==
      "TPTY"
  ) {
    return false;
  }


  if (
    !processed.position
  ) {
    return false;
  }


  if (
    processed.position.source !==
    "LIVE_GPS"
  ) {
    return false;
  }


  if (
    processed.position.isActualPosition !==
    true
  ) {
    return false;
  }


  if (
    processed.gateDistanceKm ===
    null
  ) {
    return false;
  }


  if (
    processed.gateDistanceKm >
    GATE_STOP_DISTANCE_KM
  ) {
    return false;
  }


  return true;
}


// ============================================================
// PROCESS TRAIN
// ============================================================

function processTrain(
  boardItem,
  liveResponse
) {
  const verified =
    mergeVerifiedData(
      boardItem,
      liveResponse
    );


  const train =
    verified.train ||
    {};

  const live =
    verified.live ||
    {};

  const stop =
    verified.stop ||
    {};


  const trainNumber =
    getTrainNumber(
      verified
    );


  const trainName =
    train.name ||
    `Express ${trainNumber}`;


  const origin =
    getOrigin(
      train,
      verified
    );


  const destination =
    getDestination(
      train,
      verified
    );


  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  const direction =
    determineDirection(
      train,
      verified,
      stop,
      verified
    );


  // ----------------------------------------------------------
  // CORRIDOR
  // ----------------------------------------------------------

  const corridor =
    determineCorridor(
      train,
      verified,
      direction
    );


  // ----------------------------------------------------------
  // POSITION
  // ----------------------------------------------------------

  const position =
    getBestPosition(
      verified
    );


  // ----------------------------------------------------------
  // DISTANCE TO GUDUR
  // ----------------------------------------------------------

  const distanceToGudurKm =
    position
      ? haversineKm(
          position.lat,
          position.lng,
          GDR_LAT,
          GDR_LNG
        )
      : null;


  // ----------------------------------------------------------
  // DISTANCE TO GATE
  // ----------------------------------------------------------

  const gateDistanceKm =
    getGateDistance(
      position,
      corridor
    );


  // ----------------------------------------------------------
  // ACTUAL GPS
  // ----------------------------------------------------------

  const hasActualGps =
    position?.source ===
      "LIVE_GPS" &&
    position?.isActualPosition ===
      true;


  // ----------------------------------------------------------
  // DELAY
  // ----------------------------------------------------------

  const delayMinutes =
    firstNumber(
      verified.delayMinutes,
      live.delayMinutes
    ) || 0;


  // ----------------------------------------------------------
  // BOARD ETA
  // ----------------------------------------------------------

  const now =
    new Date();


  const currentMinutes =
    now.getHours() *
      60 +
    now.getMinutes();


  const arrivalTime =
    getBoardArrivalTime(
      boardItem
    );


  const boardArrivalMinutes =
    parseTimeToMinutes(
      arrivalTime,
      delayMinutes
    );


  const boardEtaMinutes =
    boardArrivalMinutes !== -1
      ? Math.max(
          0,
          calculateTimeDifference(
            boardArrivalMinutes,
            currentMinutes
          )
        )
      : null;


  // ----------------------------------------------------------
  // GPS ETA
  // ----------------------------------------------------------

  const gpsEtaMinutes =
    distanceToGudurKm !==
      null
      ? calculateEtaMinutes(
          distanceToGudurKm,
          position?.speedKmh
        )
      : null;


  // Prefer GPS ETA when GPS is available.
  const etaMinutes =
    gpsEtaMinutes !== null
      ? gpsEtaMinutes
      : boardEtaMinutes;


  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  const atGudur =
    direction ===
      "AT_GUDUR" ||
    (
      distanceToGudurKm !== null &&
      distanceToGudurKm <
        0.15
    );


  // ----------------------------------------------------------
  // PASSED GATE
  // ----------------------------------------------------------

  const passedGate =
    direction ===
    "AWAY_FROM_GUDUR";


  // ----------------------------------------------------------
  // GATE DECISION
  // ----------------------------------------------------------

  const closeGate =
    shouldCloseGate({
      direction,
      corridor,
      position,
      gateDistanceKm
    });


  return {
    trainNo:
      trainNumber,

    name:
      trainName,

    origin:
      origin ||
      "Unknown origin",

    destination:
      destination ||
      "Gudur",

    corridor,

    direction,

    position,

    hasActualGps,

    distanceToGudurKm,

    gateDistanceKm,

    etaMinutes,

    boardEtaMinutes,

    gpsEtaMinutes,

    delayMinutes,

    atGudur,

    passedGate,

    closeGate,

    platform:
      String(
        live.platform ||
        boardItem?.live?.platform ||
        "1"
      ),

    status:
      verified.status ||
      live.type ||
      "",

    isLive:
      verified.isLive === true
  };
}


// ============================================================
// FORMAT DISTANCE
// ============================================================

function formatDistance(
  distance
) {
  if (
    distance === null ||
    !Number.isFinite(
      distance
    )
  ) {
    return "?";
  }


  return distance.toFixed(
    2
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
      "Tracks clear"
  };
}


// ============================================================
// CLOSED GATE
// ============================================================

function createClosedGate(
  train,
  waitMinutes
) {
  const statusText =
    train.delayMinutes > 0
      ? `${train.delayMinutes}m late`
      : "Approaching";


  return {
    status:
      "CLOSED",

    waitMinutes:
      Math.max(
        1,
        Math.round(
          waitMinutes || 2
        )
      ),

    activeTrain:
      `${train.trainNo} ${train.name} (${statusText})`,

    direction:
      "TOWARD GUDUR",

    corridor:
      train.corridor
  };
}


// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();


  try {
    const now =
      new Date();


    console.log(
      "\n=========================================="
    );

    console.log(
      " GUDUR GATE MONITOR"
    );

    console.log(
      ` ${now.toLocaleString()}`
    );

    console.log(
      "=========================================="
    );


    // ========================================================
    // 1. STATION BOARD
    // ========================================================

    console.log(
      "\n[1] Querying RailRadar station board..."
    );


    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours: 4
          },

          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          timeout:
            12000
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
      `✅ RailRadar returned ${trainsArray.length} board records.`
    );


    // ========================================================
    // 2. CREATE VERIFICATION QUEUE
    // ========================================================

    const currentMinutes =
      now.getHours() *
        60 +
      now.getMinutes();


    const boardCandidates =
      trainsArray
        .map(
          (item) => {
            const arrival =
              getBoardArrivalTime(
                item
              );


            const delay =
              Number(
                item?.live?.delayMinutes ||
                0
              );


            const arrivalMinutes =
              parseTimeToMinutes(
                arrival,
                delay
              );


            const eta =
              arrivalMinutes !== -1
                ? Math.max(
                    0,
                    calculateTimeDifference(
                      arrivalMinutes,
                      currentMinutes
                    )
                  )
                : 9999;


            return {
              item,
              eta
            };
          }
        )
        .sort(
          (a, b) =>
            a.eta -
            b.eta
        )
        .slice(
          0,
          MAX_BOARD_CANDIDATES
        );


    console.log(
      `Verification queue: ${boardCandidates.length} trains`
    );


    // ========================================================
    // 3. LIVE VERIFICATION
    // ========================================================

    const verifiedTrains =
      [];


    let apiRequests =
      1;


    const verificationLimit =
      Math.min(
        MAX_LIVE_VERIFICATIONS,
        boardCandidates.length
      );


    console.log(
      `Prioritizing ${verificationLimit} closest/most urgent trains.`
    );


    for (
      let i = 0;
      i < verificationLimit;
      i++
    ) {
      const boardItem =
        boardCandidates[i].item;


      const trainNumber =
        getTrainNumber(
          boardItem
        );


      if (
        !trainNumber
      ) {
        continue;
      }


      console.log(
        `\n[LIVE REQUEST ${i + 1}/${verificationLimit}] ${trainNumber}`
      );


      try {
        const liveResponse =
          await fetchLiveTrain(
            trainNumber
          );


        apiRequests++;


        const processed =
          processTrain(
            boardItem,
            liveResponse
          );


        verifiedTrains.push(
          processed
        );


        console.log(
          `[LIVE] ${processed.trainNo} ${processed.name} | ${processed.direction} | corridor=${processed.corridor} | GDR=${formatDistance(processed.distanceToGudurKm)} km | gate=${formatDistance(processed.gateDistanceKm)} km | GPS=${processed.position?.source || "NONE"}`
        );


        // ======================================================
        // TEMPORARY RAW RAILRADAR DIAGNOSTIC
        // ======================================================
        //
        // Print the complete RailRadar response for train 20625.
        //
        // This is temporary and will help determine why GPS
        // coordinates are not currently being extracted.
        //
        // ======================================================

        if (
          trainNumber === "20625"
        ) {
          console.log(
            "\n========== RAW RAILRADAR 20625 =========="
          );

          console.log(
            JSON.stringify(
              liveResponse,
              null,
              2
            )
          );

          console.log(
            "========== END RAW 20625 ==========\n"
          );
        }


        if (
          processed.direction !==
          "TOWARD_GUDUR"
        ) {
          console.log(
            `[REMOVED UPCOMING] ${processed.trainNo} - not TOWARD_GUDUR`
          );
        }

      } catch (error) {
        apiRequests++;


        console.error(
          `[LIVE ERROR] ${trainNumber}: ${error.message}`
        );
      }
    }


    // ========================================================
    // 4. DEFAULT GATE STATES
    // ========================================================

    let masGate =
      createOpenGate();


    let tptyGate =
      createOpenGate();


    // ========================================================
    // 5. UPCOMING TRAINS
    // ========================================================

    const upcomingList =
      [];


    // ========================================================
    // 6. PROCESS VERIFIED TRAINS
    // ========================================================

    for (
      const train of verifiedTrains
    ) {

      // ------------------------------------------------------
      // UPCOMING
      // ------------------------------------------------------

      if (
        shouldShowUpcoming(
          train
        )
      ) {
        upcomingList.push({
          trainNo:
            train.trainNo,

          name:
            train.name,

          origin:
            train.origin,

          destination:
            train.destination,

          etaMinutes:
            train.etaMinutes !== null
              ? train.etaMinutes
              : 0,

          delayMinutes:
            train.delayMinutes,

          corridor:
            train.corridor,

          direction:
            "TOWARD_GUDUR",

          platform:
            train.platform
        });
      }


      // ------------------------------------------------------
      // GATE CLOSURE
      // ------------------------------------------------------

      if (
        !train.closeGate
      ) {
        continue;
      }


      let waitMinutes =
        2;


      if (
        train.gateDistanceKm !== null
      ) {
        const gateEta =
          calculateEtaMinutes(
            train.gateDistanceKm,
            train.position?.speedKmh
          );


        if (
          gateEta !== null
        ) {
          waitMinutes =
            Math.max(
              1,
              gateEta + 2
            );
        }
      }


      const gate =
        createClosedGate(
          train,
          waitMinutes
        );


      if (
        train.corridor ===
        "MAS"
      ) {
        masGate =
          gate;
      }


      if (
        train.corridor ===
        "TPTY"
      ) {
        tptyGate =
          gate;
      }
    }


    // ========================================================
    // 7. SORT UPCOMING
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        (
          a.etaMinutes || 0
        ) - (
          b.etaMinutes || 0
        )
    );


    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );


    // ========================================================
    // 8. FIREBASE UPDATE
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

      verifiedTrains:
        verifiedTrains.length,

      apiRequests:
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
    // 9. SUCCESS LOGS
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
      ` -> Chennai Gate : ${masGate.status} | ${masGate.activeTrain}`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} | ${tptyGate.activeTrain}`
    );

    console.log(
      ` -> Verified trains: ${verifiedTrains.length}`
    );

    console.log(
      ` -> Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      ` -> API requests this cycle: ${apiRequests}/8`
    );


    // ========================================================
    // 10. UPCOMING TRAIN LOG
    // ========================================================

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING / LIVE TRAINS]"
      );


      topUpcoming.forEach(
        (train) => {
          console.log(
            `   ${train.corridor} | ${train.trainNo} ${train.name} | ${train.origin} -> ${train.destination} | ETA ${train.etaMinutes}m`
          );
        }
      );

    } else {
      console.log(
        "\n[UPCOMING / LIVE TRAINS] None"
      );
    }


    console.log(
      "\n=========================================="
    );

  } catch (error) {

    // ========================================================
    // ERROR
    // ========================================================

    console.error(
      "\n=========================================="
    );

    console.error(
      "[MONITOR ERROR]"
    );

    console.error(
      error.message
    );

    console.error(
      "=========================================="
    );


    if (
      error.response
    ) {
      console.error(
        `HTTP Status: ${error.response.status}`
      );


      if (
        error.response.data
      ) {
        console.error(
          "Response:",
          JSON.stringify(
            error.response.data,
            null,
            2
          )
        );
      }
    }


    // --------------------------------------------------------
    // Put gates into safe OPEN state if API/Firebase cycle
    // encounters an error.
    // --------------------------------------------------------

    try {
      await gateRef.set({
        tirupatiGate:
          createOpenGate(),

        chennaiGate:
          createOpenGate(),

        upcomingTrains:
          [],

        lastUpdated:
          new Date().toLocaleTimeString(),

        lastUpdatedLocal:
          new Date().toLocaleString(),

        verifiedTrains:
          0,

        monitorStatus:
          "ERROR",

        error:
          error.message
      });


      console.log(
        "Firebase error state written safely."
      );

    } catch (
      firebaseError
    ) {
      console.error(
        "❌ Firebase error-state update failed:",
        firebaseError.message
      );
    }
  }
}


// ============================================================
// APPLICATION START
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
  `Gudur:          ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  `Chennai Gate:   ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  `Tirupati Gate:  ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  "=========================================="
);

console.log(
  "RailRadar API Key: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "Direction: Chennai/Tirupati side -> Gudur only"
);

console.log(
  "Gate closure: ACTUAL GPS only"
);

console.log(
  "Route interpolation: Display/ETA only"
);

console.log(
  "=========================================="
);


// ============================================================
// GITHUB ACTIONS / LOCAL MODE
// ============================================================

if (
  process.env.GITHUB_ACTIONS
) {

  updateGateSystem()
    .then(
      () => {
        console.log(
          "\n=========================================="
        );

        console.log(
          " GitHub Actions monitor cycle completed "
        );

        console.log(
          "=========================================="
        );

        process.exit(0);
      }
    )
    .catch(
      (error) => {
        console.error(
          "\n❌ Monitor cycle failed:"
        );

        console.error(
          error
        );

        process.exit(1);
      }
    );

} else {

  updateGateSystem();

  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}
