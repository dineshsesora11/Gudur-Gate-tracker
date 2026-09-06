const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {
  // ----------------------------------------------------------
  // GITHUB ACTIONS
  // ----------------------------------------------------------
  // GitHub Actions provides the Firebase service account
  // through the FIREBASE_SERVICE_ACCOUNT secret.
  // ----------------------------------------------------------

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    console.log(
      "Firebase service account: GitHub Secret"
    );

  } else {
    // --------------------------------------------------------
    // LOCAL COMPUTER
    // --------------------------------------------------------
    // For local testing, put serviceAccountKey.json in the
    // same folder as code.js.
    // --------------------------------------------------------

    const fs = require("fs");

    const SERVICE_ACCOUNT_FILE =
      "./serviceAccountKey.json";

    if (
      !fs.existsSync(
        SERVICE_ACCOUNT_FILE
      )
    ) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
      );
    }

    serviceAccount =
      require(
        SERVICE_ACCOUNT_FILE
      );

    console.log(
      "Firebase service account: Local JSON"
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

// ============================================================
// INITIALIZE FIREBASE
// ============================================================

admin.initializeApp({
  credential:
    admin.credential.cert(
      serviceAccount
    ),

  databaseURL:
    FIREBASE_DATABASE_URL
});

const db =
  admin.database();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY ||
  "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR LOCATIONS
// ============================================================

const GDR_LAT =
  14.14842;

const GDR_LNG =
  79.84524;

// Chennai-side crossing gate
const CHENNAI_GATE_LAT =
  14.1396639;

const CHENNAI_GATE_LNG =
  79.8441306;

// Tirupati-side crossing gate
const TIRUPATI_GATE_LAT =
  14.1402056;

const TIRUPATI_GATE_LNG =
  79.8436000;

// ============================================================
// SETTINGS
// ============================================================

// Upcoming train display range
const UPCOMING_MAX_DISTANCE_KM =
  150;

// Physical gate closure distance
const GATE_STOP_DISTANCE_KM =
  0.6;

// Maximum live verification requests
//
// 1 request = station board
// 7 requests = individual live trains
//
// TOTAL = 8
//
const MAX_LIVE_REQUESTS =
  7;

// Maximum board candidates we keep
const MAX_BOARD_CANDIDATES =
  22;

// Local refresh interval
const REFRESH_INTERVAL_MS =
  180000;

// Default estimated speed
const DEFAULT_SPEED_KMPH =
  55;

// Minimum valid speed
const MIN_SPEED_KMPH =
  5;

// ============================================================
// KNOWN TIRUPATI CORRIDOR TRAINS
// ============================================================
//
// These are used as a fallback when RailRadar gives an
// explicit "toward Gudur" direction but does not provide
// enough route-origin information.
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
// NUMBER HELPER
// ============================================================

function toNumber(value) {
  const n =
    Number(value);

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
  const a =
    toNumber(lat1);

  const b =
    toNumber(lng1);

  const c =
    toNumber(lat2);

  const d =
    toNumber(lng2);

  if (
    a === null ||
    b === null ||
    c === null ||
    d === null
  ) {
    return null;
  }

  const R =
    6371;

  const dLat =
    (
      (c - a) *
      Math.PI
    ) / 180;

  const dLng =
    (
      (d - b) *
      Math.PI
    ) / 180;

  const lat1Rad =
    a *
    Math.PI /
    180;

  const lat2Rad =
    c *
    Math.PI /
    180;

  const x =
    Math.sin(dLat / 2) *
    Math.sin(dLat / 2) +
    Math.cos(lat1Rad) *
    Math.cos(lat2Rad) *
    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);

  const y =
    2 *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(1 - x)
    );

  return R * y;
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
// EXTRACT ROUTE
// ============================================================

function getRoute(
  train,
  live,
  item
) {
  if (
    Array.isArray(
      live?.route
    )
  ) {
    return live.route;
  }

  if (
    Array.isArray(
      train?.route
    )
  ) {
    return train.route;
  }

  if (
    Array.isArray(
      item?.route
    )
  ) {
    return item.route;
  }

  return [];
}

// ============================================================
// GET CURRENT LOCATION
// ============================================================

function getCurrentLocation(
  train,
  live,
  item
) {
  return (
    live?.currentLocation ||
    train?.currentLocation ||
    item?.currentLocation ||
    {}
  );
}

// ============================================================
// GET ROUTE SEQUENCE FOR GUDUR
// ============================================================

function getGudurSequence(
  route
) {
  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  const gudur =
    route.find(
      (stop) =>
        normalizeText(
          stop?.stationCode
        ) === "GDR"
    );

  if (
    gudur &&
    Number.isFinite(
      Number(gudur.sequence)
    )
  ) {
    return Number(
      gudur.sequence
    );
  }

  return null;
}

// ============================================================
// GET CURRENT SEQUENCE
// ============================================================

function getCurrentSequence(
  currentLocation
) {
  const sequence =
    Number(
      currentLocation?.sequence
    );

  if (
    Number.isFinite(sequence)
  ) {
    return sequence;
  }

  return null;
}

// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// Returns:
//
// TOWARD_GUDUR
// AWAY_FROM_GUDUR
// UNKNOWN
//
// Sequence is more reliable than guessing from text.
//

function getRouteDirection(
  train,
  live,
  item,
  route
) {
  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  const currentSequence =
    getCurrentSequence(
      currentLocation
    );

  const gudurSequence =
    getGudurSequence(
      route
    );

  if (
    currentSequence !== null &&
    gudurSequence !== null
  ) {
    if (
      currentSequence <
      gudurSequence
    ) {
      return "TOWARD_GUDUR";
    }

    if (
      currentSequence >
      gudurSequence
    ) {
      return "AWAY_FROM_GUDUR";
    }
  }

  // ----------------------------------------------------------
  // FALLBACK TO EXPLICIT DIRECTION
  // ----------------------------------------------------------

  const directionFields = [
    train?.direction,
    train?.travelDirection,
    train?.routeDirection,
    train?.runningDirection,

    live?.direction,
    live?.travelDirection,
    live?.routeDirection,
    live?.runningDirection,

    item?.direction,
    item?.travelDirection,
    item?.routeDirection,
    item?.runningDirection
  ];

  const directionText =
    directionFields
      .filter(Boolean)
      .map(normalizeText)
      .join(" ");

  if (
    directionText.includes(
      "TOWARD GUDUR"
    ) ||
    directionText.includes(
      "TOWARDS GUDUR"
    ) ||
    directionText.includes(
      "TO GUDUR"
    ) ||
    directionText.includes(
      "GUDUR INBOUND"
    ) ||
    directionText.includes(
      "INBOUND"
    ) ||
    directionText.includes(
      "APPROACHING GUDUR"
    )
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    directionText.includes(
      "FROM GUDUR"
    ) ||
    directionText.includes(
      "GUDUR OUTBOUND"
    ) ||
    directionText.includes(
      "OUTBOUND"
    ) ||
    directionText.includes(
      "AWAY FROM GUDUR"
    ) ||
    directionText.includes(
      "TO CHENNAI"
    ) ||
    directionText.includes(
      "TOWARD CHENNAI"
    ) ||
    directionText.includes(
      "TOWARDS CHENNAI"
    ) ||
    directionText.includes(
      "TO TIRUPATI"
    ) ||
    directionText.includes(
      "TOWARD TIRUPATI"
    ) ||
    directionText.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return "UNKNOWN";
}

// ============================================================
// ROUTE STATION TEXT
// ============================================================

function getRouteStationText(
  routeStop
) {
  return [
    routeStop?.stationCode,
    routeStop?.stationName,
    routeStop?.code,
    routeStop?.name
  ]
    .filter(Boolean)
    .join(" ");
}

// ============================================================
// FIND ROUTE ANCHOR
// ============================================================

function routeContainsAny(
  route,
  values
) {
  if (
    !Array.isArray(route)
  ) {
    return false;
  }

  return route.some(
    (stop) =>
      containsAny(
        getRouteStationText(stop),
        values
      )
  );
}

// ============================================================
// DETERMINE PHYSICAL CORRIDOR
// ============================================================
//
// MAS:
//
// Chennai <-> Gudur
//
// TPTY:
//
// Tirupati <-> Gudur
//
// IMPORTANT:
// This is NOT a direction filter.
//
// Both directions are valid for gate closure.
//

function determinePhysicalCorridor(
  train,
  live,
  item,
  route
) {
  const trainNo =
    String(
      train?.number ||
      live?.trainNumber ||
      item?.trainNumber ||
      ""
    ).trim();

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

  const originDestinationText =
    [
      origin,
      destination
    ]
      .filter(Boolean)
      .join(" ");

  // ----------------------------------------------------------
  // FIRST: EXPLICIT CHENNAI SIDE
  // ----------------------------------------------------------

  if (
    containsAny(
      originDestinationText,
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
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // SECOND: EXPLICIT TIRUPATI SIDE
  // ----------------------------------------------------------

  if (
    containsAny(
      originDestinationText,
      [
        "TIRUPATI",
        "TPTY",
        "TIRUPATI MAIN",
        "RENIGUNTA",
        "RU"
      ]
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // THIRD: ROUTE ANCHORS
  // ----------------------------------------------------------

  const hasChennaiAnchor =
    routeContainsAny(
      route,
      [
        "MAS",
        "CHENNAI",
        "CHENNAI CENTRAL",
        "MGR CHENNAI CENTRAL"
      ]
    );

  const hasTirupatiAnchor =
    routeContainsAny(
      route,
      [
        "TPTY",
        "TIRUPATI",
        "RENIGUNTA"
      ]
    );

  // If route clearly contains Tirupati side and not Chennai
  if (
    hasTirupatiAnchor &&
    !hasChennaiAnchor
  ) {
    return "TPTY";
  }

  // If route clearly contains Chennai
  if (
    hasChennaiAnchor &&
    !hasTirupatiAnchor
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // KNOWN TIRUPATI TRAIN FALLBACK
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  return "UNKNOWN";
}

// ============================================================
// ACTUAL GPS POSITION
// ============================================================
//
// Only actual GPS is allowed to close a gate.
//

function extractActualGpsPosition(
  train,
  live,
  item
) {
  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  const possibleObjects = [
    currentLocation,
    live,
    train,
    item
  ];

  for (
    const obj of possibleObjects
  ) {
    if (!obj) {
      continue;
    }

    const lat =
      toNumber(
        obj.lat ??
        obj.latitude
      );

    const lng =
      toNumber(
        obj.lng ??
        obj.lon ??
        obj.longitude
      );

    if (
      lat !== null &&
      lng !== null
    ) {
      const actualFlag =
        obj.isActualPosition;

      // If RailRadar explicitly says this is NOT actual,
      // don't use it for physical gate closure.
      if (
        actualFlag === false
      ) {
        continue;
      }

      return {
        lat,
        lng,

        source:
          "GPS",

        isActualPosition:
          true,

        speedKmph:
          toNumber(
            obj.speedKmph ??
            obj.speed ??
            obj.speedKmh
          ),

        bearingDegrees:
          toNumber(
            obj.bearingDegrees ??
            obj.bearing
          )
      };
    }
  }

  return null;
}

// ============================================================
// ACTUAL STATION-CODE POSITION
// ============================================================
//
// RailRadar can return:
//
// currentLocation.stationCode = GDR
// currentLocation.sequence = 28
//
// When includeCoordinates=true is used, route stops can contain
// lat/lng.
//
// This function matches the actual current station to the
// corresponding route stop.
//

function extractStationCodePosition(
  train,
  live,
  item,
  route
) {
  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  const isActual =
    currentLocation?.isActualPosition;

  if (
    isActual === false
  ) {
    return null;
  }

  const currentSequence =
    getCurrentSequence(
      currentLocation
    );

  const currentStationCode =
    normalizeText(
      currentLocation?.stationCode
    );

  let matchedStop =
    null;

  // ----------------------------------------------------------
  // FIRST: MATCH BY SEQUENCE
  // ----------------------------------------------------------

  if (
    currentSequence !== null &&
    Array.isArray(route)
  ) {
    matchedStop =
      route.find(
        (stop) =>
          Number(
            stop?.sequence
          ) === currentSequence
      );
  }

  // ----------------------------------------------------------
  // SECOND: MATCH BY STATION CODE
  // ----------------------------------------------------------

  if (
    !matchedStop &&
    currentStationCode &&
    Array.isArray(route)
  ) {
    matchedStop =
      route.find(
        (stop) =>
          normalizeText(
            stop?.stationCode
          ) === currentStationCode
      );
  }

  if (
    !matchedStop
  ) {
    return null;
  }

  const lat =
    toNumber(
      matchedStop.lat ??
      matchedStop.latitude
    );

  const lng =
    toNumber(
      matchedStop.lng ??
      matchedStop.lon ??
      matchedStop.longitude
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

    source:
      "STATION_CODE",

    isActualPosition:
      true,

    stationCode:
      matchedStop.stationCode ||
      currentLocation.stationCode,

    stationName:
      matchedStop.stationName ||
      currentLocation.stationName,

    sequence:
      Number(
        matchedStop.sequence
      )
  };
}

// ============================================================
// ROUTE INTERPOLATED POSITION
// ============================================================
//
// IMPORTANT:
//
// This position is ONLY for display / ETA.
//
// NEVER use this position to close a physical gate.
//

function extractInterpolatedRoutePosition(
  train,
  live,
  item,
  route
) {
  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  const currentSequence =
    getCurrentSequence(
      currentLocation
    );

  if (
    currentSequence === null ||
    !Array.isArray(route)
  ) {
    return null;
  }

  const currentIndex =
    route.findIndex(
      (stop) =>
        Number(
          stop?.sequence
        ) === currentSequence
    );

  if (
    currentIndex < 0
  ) {
    return null;
  }

  const currentStop =
    route[currentIndex];

  const nextStop =
    route[currentIndex + 1];

  if (
    !currentStop ||
    !nextStop
  ) {
    return null;
  }

  const currentLat =
    toNumber(
      currentStop.lat ??
      currentStop.latitude
    );

  const currentLng =
    toNumber(
      currentStop.lng ??
      currentStop.lon ??
      currentStop.longitude
    );

  const nextLat =
    toNumber(
      nextStop.lat ??
      nextStop.latitude
    );

  const nextLng =
    toNumber(
      nextStop.lng ??
      nextStop.lon ??
      nextStop.longitude
    );

  if (
    currentLat === null ||
    currentLng === null ||
    nextLat === null ||
    nextLng === null
  ) {
    return null;
  }

  let progress =
    toNumber(
      currentLocation.segmentProgress
    );

  if (
    progress === null
  ) {
    progress =
      toNumber(
        currentLocation.progress
      );
  }

  if (
    progress === null
  ) {
    progress = 0;
  }

  progress =
    Math.max(
      0,
      Math.min(
        1,
        progress
      )
    );

  return {
    lat:
      currentLat +
      (
        nextLat -
        currentLat
      ) *
      progress,

    lng:
      currentLng +
      (
        nextLng -
        currentLng
      ) *
      progress,

    source:
      "ROUTE_INTERPOLATED",

    isActualPosition:
      false
  };
}

// ============================================================
// BEST DISPLAY POSITION
// ============================================================

function getBestPosition(
  train,
  live,
  item,
  route
) {
  // ----------------------------------------------------------
  // 1. ACTUAL GPS
  // ----------------------------------------------------------

  const gps =
    extractActualGpsPosition(
      train,
      live,
      item
    );

  if (gps) {
    return gps;
  }

  // ----------------------------------------------------------
  // 2. ACTUAL STATION-CODE COORDINATES
  // ----------------------------------------------------------

  const stationPosition =
    extractStationCodePosition(
      train,
      live,
      item,
      route
    );

  if (
    stationPosition
  ) {
    return stationPosition;
  }

  // ----------------------------------------------------------
  // 3. ROUTE INTERPOLATION
  //
  // DISPLAY ONLY
  // ----------------------------------------------------------

  const interpolated =
    extractInterpolatedRoutePosition(
      train,
      live,
      item,
      route
    );

  if (
    interpolated
  ) {
    return interpolated;
  }

  return null;
}

// ============================================================
// GET DISTANCES
// ============================================================

function getDistances(
  position
) {
  if (!position) {
    return {
      gdr: null,
      chennaiGate: null,
      tirupatiGate: null
    };
  }

  return {
    gdr:
      distanceKm(
        position.lat,
        position.lng,
        GDR_LAT,
        GDR_LNG
      ),

    chennaiGate:
      distanceKm(
        position.lat,
        position.lng,
        CHENNAI_GATE_LAT,
        CHENNAI_GATE_LNG
      ),

    tirupatiGate:
      distanceKm(
        position.lat,
        position.lng,
        TIRUPATI_GATE_LAT,
        TIRUPATI_GATE_LNG
      )
  };
}

// ============================================================
// DETERMINE GATE
// ============================================================
//
// Physical logic:
//
// MAS corridor:
//
// Chennai <-> Gudur
//       |
// Chennai Gate
//
// TPTY corridor:
//
// Tirupati <-> Gudur
//       |
// Tirupati Gate
//
// Direction DOES NOT matter here.
//

function shouldCloseGate(
  corridor,
  position,
  distances
) {
  // ----------------------------------------------------------
  // CRITICAL SAFETY RULE
  // ----------------------------------------------------------
  //
  // Never close a physical gate using route interpolation.
  //

  if (
    !position ||
    position.isActualPosition !== true
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // CHENNAI GATE
  // ----------------------------------------------------------

  if (
    corridor === "MAS" &&
    distances.chennaiGate !== null &&
    distances.chennaiGate <=
      GATE_STOP_DISTANCE_KM
  ) {
    return {
      gate: "MAS",
      distanceKm:
        distances.chennaiGate
    };
  }

  // ----------------------------------------------------------
  // TIRUPATI GATE
  // ----------------------------------------------------------

  if (
    corridor === "TPTY" &&
    distances.tirupatiGate !== null &&
    distances.tirupatiGate <=
      GATE_STOP_DISTANCE_KM
  ) {
    return {
      gate: "TPTY",
      distanceKm:
        distances.tirupatiGate
    };
  }

  return null;
}

// ============================================================
// UPCOMING TRAIN FILTER
// ============================================================
//
// Upcoming list ONLY:
//
// TOWARD GUDUR
// MAS or TPTY
// Not already at Gudur
// Not past Gudur
// Within 150 km
//
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
    processed.corridor !== "MAS" &&
    processed.corridor !== "TPTY"
  ) {
    return false;
  }

  if (
    processed.atGudur
  ) {
    return false;
  }

  if (
    processed.passedGudur
  ) {
    return false;
  }

  if (
    processed.distanceToGdrKm ===
    null
  ) {
    return false;
  }

  if (
    processed.distanceToGdrKm >
    UPCOMING_MAX_DISTANCE_KM
  ) {
    return false;
  }

  return true;
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (
    !timeStr
  ) {
    return -1;
  }

  let totalMinutes =
    -1;

  const date =
    new Date(
      timeStr
    );

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    totalMinutes =
      date.getHours() *
        60 +
      date.getMinutes();

  } else {
    const match =
      String(
        timeStr
      )
        .trim()
        .match(
          /(\d{1,2}):(\d{2})/
        );

    if (
      match
    ) {
      totalMinutes =
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

  if (
    totalMinutes === -1
  ) {
    return -1;
  }

  return (
    totalMinutes +
    Number(
      delayMinutes || 0
    )
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
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const urls = [
    `${RAILRADAR_BASE_URL}/trains/${trainNo}/live`,
    `${RAILRADAR_BASE_URL}/trains/${trainNo}`,
    `${RAILRADAR_BASE_URL}/train/${trainNo}/live`
  ];

  for (
    const url of urls
  ) {
    try {
      console.log(
        `[LIVE FETCH] ${trainNo}`
      );

      const response =
        await axios.get(
          url,
          {
            params: {
              includeCoordinates:
                true
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

      return (
        response.data
      );

    } catch (error) {
      const status =
        error?.response?.status;

      // Only continue to another endpoint
      // when the endpoint does not exist.
      if (
        status === 404
      ) {
        continue;
      }

      throw error;
    }
  }

  return null;
}

// ============================================================
// MERGE VERIFIED DATA
// ============================================================

function mergeVerifiedData(
  boardItem,
  responseBody
) {
  const liveData =
    responseBody?.data ||
    responseBody ||
    {};

  return {
    boardItem,

    data:
      liveData
  };
}

// ============================================================
// CREATE DEFAULT GATE
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
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const cycleStart =
    Date.now();

  try {
    const now =
      new Date();

    const currentMin =
      now.getHours() *
        60 +
      now.getMinutes();

    console.log(
      "\n=========================================="
    );

    console.log(
      " RailRadar Real-time Gudur Gate Monitor "
    );

    console.log(
      "=========================================="
    );

    console.log(
      `\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // ----------------------------------------------------------
    // CHECK API KEY
    // ----------------------------------------------------------

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY is missing."
      );
    }

    // ----------------------------------------------------------
    // STATION BOARD
    // ----------------------------------------------------------

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
      `RailRadar returned ${trainsArray.length} board records.`
    );

    // ----------------------------------------------------------
    // SORT / LIMIT BOARD
    // ----------------------------------------------------------

    const boardCandidates =
      trainsArray
        .slice(
          0,
          MAX_BOARD_CANDIDATES
        );

    console.log(
      `Verification queue: ${boardCandidates.length}`
    );

    console.log(
      `Live verification: ${Math.min(
        MAX_LIVE_REQUESTS,
        boardCandidates.length
      )}`
    );

    // ----------------------------------------------------------
    // API REQUEST COUNTER
    // ----------------------------------------------------------

    let apiRequests =
      1;

    // Station board = request #1

    // ----------------------------------------------------------
    // VERIFY LIVE TRAINS
    // ----------------------------------------------------------

    const verifiedTrains =
      [];

    for (
      let i = 0;
      i <
        boardCandidates.length &&
      verifiedTrains.length <
        MAX_LIVE_REQUESTS;
      i++
    ) {
      const item =
        boardCandidates[i] ||
        {};

      const train =
        item.train ||
        {};

      const trainNo =
        String(
          train.number ||
          item.trainNumber ||
          item.number ||
          ""
        ).trim();

      if (
        !trainNo
      ) {
        continue;
      }

      console.log(
        `\n[LIVE REQUEST ${verifiedTrains.length + 1}/${MAX_LIVE_REQUESTS}] ${trainNo}`
      );

      try {
        const liveResponse =
          await fetchLiveTrain(
            trainNo
          );

        apiRequests++;

        if (
          !liveResponse
        ) {
          console.log(
            `[LIVE] ${trainNo} returned no data.`
          );

          continue;
        }

        const merged =
          mergeVerifiedData(
            item,
            liveResponse
          );

        verifiedTrains.push(
          merged
        );

      } catch (error) {
        apiRequests++;

        console.error(
          `[LIVE ERROR] ${trainNo}: ${error.message}`
        );
      }
    }

    // ----------------------------------------------------------
    // DEFAULT GATES
    // ----------------------------------------------------------

    let masGate =
      createOpenGate();

    let tptyGate =
      createOpenGate();

    // ----------------------------------------------------------
    // UPCOMING LIST
    // ----------------------------------------------------------

    const upcomingList =
      [];

    // ----------------------------------------------------------
    // PROCESS VERIFIED TRAINS
    // ----------------------------------------------------------

    for (
      const verified of
        verifiedTrains
    ) {
      const item =
        verified.boardItem ||
        {};

      const liveData =
        verified.data ||
        {};

      const train =
        liveData.train ||
        item.train ||
        {};

      const live =
        liveData.live ||
        {};

      const stop =
        liveData.stop ||
        item.stop ||
        {};

      const trainNo =
        String(
          train.number ||
          liveData.trainNumber ||
          item.trainNumber ||
          ""
        ).trim();

      if (
        !trainNo
      ) {
        continue;
      }

      const trainName =
        train.name ||
        liveData.trainName ||
        item.train?.name ||
        `Express ${trainNo}`;

      // --------------------------------------------------------
      // ROUTE
      // --------------------------------------------------------

      const route =
        getRoute(
          train,
          liveData,
          item
        );

      // --------------------------------------------------------
      // DIRECTION
      // --------------------------------------------------------

      const direction =
        getRouteDirection(
          train,
          liveData,
          item,
          route
        );

      // --------------------------------------------------------
      // PHYSICAL CORRIDOR
      // --------------------------------------------------------

      const corridor =
        determinePhysicalCorridor(
          train,
          liveData,
          item,
          route
        );

      // --------------------------------------------------------
      // POSITION
      // --------------------------------------------------------

      const position =
        getBestPosition(
          train,
          liveData,
          item,
          route
        );

      const distances =
        getDistances(
          position
        );

      // --------------------------------------------------------
      // CURRENT LOCATION
      // --------------------------------------------------------

      const currentLocation =
        getCurrentLocation(
          train,
          liveData,
          item
        );

      const currentStationCode =
        normalizeText(
          currentLocation?.stationCode
        );

      const atGudur =
        currentStationCode ===
        "GDR";

      // --------------------------------------------------------
      // ROUTE SEQUENCE
      // --------------------------------------------------------

      const currentSequence =
        getCurrentSequence(
          currentLocation
        );

      const gudurSequence =
        getGudurSequence(
          route
        );

      const passedGudur =
        currentSequence !== null &&
        gudurSequence !== null &&
        currentSequence >
          gudurSequence;

      // --------------------------------------------------------
      // DELAY
      // --------------------------------------------------------

      const delayMin =
        Number(
          liveData.delayMinutes ??
          live.delayMinutes ??
          train.delayMinutes ??
          0
        );

      // --------------------------------------------------------
      // LOG
      // --------------------------------------------------------

      const gdrText =
        distances.gdr !== null
          ? `${distances.gdr.toFixed(2)}km`
          : "?km";

      const masText =
        distances.chennaiGate !== null
          ? `${distances.chennaiGate.toFixed(2)}km`
          : "?km";

      const tptyText =
        distances.tirupatiGate !== null
          ? `${distances.tirupatiGate.toFixed(2)}km`
          : "?km";

      console.log(
        `[LIVE] ${trainNo} ${trainName}`
      );

      console.log(
        `       Direction: ${direction}`
      );

      console.log(
        `       Corridor: ${corridor}`
      );

      console.log(
        `       GDR: ${gdrText} (${position?.source || "NONE"})`
      );

      console.log(
        `       Chennai Gate: ${masText} (${position?.source || "NONE"})`
      );

      console.log(
        `       Tirupati Gate: ${tptyText} (${position?.source || "NONE"})`
      );

      console.log(
        `       Position: ${currentStationCode || "UNKNOWN"}`
      );

      // --------------------------------------------------------
      // PHYSICAL GATE CLOSURE
      // --------------------------------------------------------
      //
      // IMPORTANT:
      //
      // Direction is deliberately NOT checked here.
      //
      // A train:
      //
      // Chennai -> Gudur
      // Gudur -> Chennai
      //
      // both close Chennai Gate.
      //
      // Likewise for Tirupati Gate.
      //

      const gateDecision =
        shouldCloseGate(
          corridor,
          position,
          distances
        );

      if (
        gateDecision
      ) {
        const waitTime =
          Math.max(
            1,
            Math.ceil(
              (
                gateDecision.distanceKm /
                DEFAULT_SPEED_KMPH
              ) *
              60
            ) + 2
          );

        const trainStatus =
          delayMin > 0
            ? `${delayMin}m late`
            : "On Time";

        const label =
          `${trainNo} ${trainName} (${trainStatus})`;

        const payload = {
          status:
            "CLOSED",

          waitMinutes:
            waitTime,

          activeTrain:
            label,

          direction:
            direction,

          corridor:
            corridor,

          distanceKm:
            Number(
              gateDecision.distanceKm.toFixed(
                3
              )
            ),

          positionSource:
            position.source
        };

        if (
          gateDecision.gate ===
          "MAS"
        ) {
          // Keep the closest train
          // if multiple trains are near
          // the same gate.

          if (
            masGate.status !==
              "CLOSED" ||
            waitTime <
              masGate.waitMinutes
          ) {
            masGate =
              payload;
          }
        }

        if (
          gateDecision.gate ===
          "TPTY"
        ) {
          if (
            tptyGate.status !==
              "CLOSED" ||
            waitTime <
              tptyGate.waitMinutes
          ) {
            tptyGate =
              payload;
          }
        }
      }

      // --------------------------------------------------------
      // UPCOMING ETA
      // --------------------------------------------------------

      let etaMinutes =
        null;

      // --------------------------------------------------------
      // USE CURRENT LOCATION DISTANCE
      // --------------------------------------------------------

      if (
        distances.gdr !== null
      ) {
        const speed =
          Math.max(
            MIN_SPEED_KMPH,
            toNumber(
              liveData?.currentLocation?.speedKmph ??
              liveData?.currentLocation?.speed ??
              live?.speedKmph ??
              live?.speed ??
              DEFAULT_SPEED_KMPH
            ) ||
            DEFAULT_SPEED_KMPH
          );

        etaMinutes =
          Math.max(
            0,
            Math.round(
              (
                distances.gdr /
                speed
              ) *
              60
            )
          );
      }

      // --------------------------------------------------------
      // FALLBACK: NEXT HALT / STATION BOARD ETA
      // --------------------------------------------------------

      if (
        etaMinutes === null
      ) {
        const arrTimeStr =
          stop.arrival ||
          live.expectedArrivalTime ||
          item.stop?.arrival ||
          "";

        const arrMin =
          parseTimeToMinutes(
            arrTimeStr,
            delayMin
          );

        if (
          arrMin !== -1
        ) {
          etaMinutes =
            Math.max(
              0,
              calculateTimeDifference(
                arrMin,
                currentMin
              )
            );
        }
      }

      // --------------------------------------------------------
      // CREATE PROCESSED TRAIN
      // --------------------------------------------------------

      const processed = {
        trainNo,

        name:
          trainName,

        origin:
          getOrigin(
            train,
            item
          ) ||
          "Southern side",

        destination:
          getDestination(
            train,
            item
          ) ||
          "Gudur",

        direction,

        corridor,

        etaMinutes:
          etaMinutes !== null
            ? etaMinutes
            : 0,

        delayMinutes:
          delayMin,

        distanceToGdrKm:
          distances.gdr !== null
            ? Number(
                distances.gdr.toFixed(
                  2
                )
              )
            : null,

        distanceToChennaiGateKm:
          distances.chennaiGate !== null
            ? Number(
                distances.chennaiGate.toFixed(
                  2
                )
              )
            : null,

        distanceToTirupatiGateKm:
          distances.tirupatiGate !== null
            ? Number(
                distances.tirupatiGate.toFixed(
                  2
                )
              )
            : null,

        atGudur,

        passedGudur,

        positionSource:
          position?.source ||
          "NONE",

        directionLabel:
          direction ===
          "TOWARD_GUDUR"
            ? "TOWARD GUDUR"
            : direction ===
              "AWAY_FROM_GUDUR"
              ? "AWAY FROM GUDUR"
              : "UNKNOWN"
      };

      // --------------------------------------------------------
      // UPCOMING LIST
      // --------------------------------------------------------

      if (
        shouldShowUpcoming(
          processed
        )
      ) {
        upcomingList.push(
          processed
        );
      }
    }

    // ==========================================================
    // SORT UPCOMING
    // ==========================================================

    upcomingList.sort(
      (
        a,
        b
      ) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ==========================================================
    // MAXIMUM 5 UPCOMING TRAINS
    // ==========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ==========================================================
    // CYCLE DURATION
    // ==========================================================

    const durationSeconds =
      (
        Date.now() -
        cycleStart
      ) /
      1000;

    // ==========================================================
    // FIREBASE UPDATE
    // ==========================================================

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

    // ==========================================================
    // SUCCESS LOG
    // ==========================================================

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
      ` -> API requests: ${apiRequests}/8`
    );

    console.log(
      ` -> Cycle duration: ${durationSeconds.toFixed(1)}s`
    );

    // ==========================================================
    // UPCOMING DISPLAY
    // ==========================================================

    console.log(
      "\n[UPCOMING TRAINS TO GUDUR]"
    );

    if (
      topUpcoming.length === 0
    ) {
      console.log(
        "   None"
      );
    } else {
      topUpcoming.forEach(
        (t) => {
          console.log(
            `   ${t.corridor} | ${t.trainNo} ${t.name} | ETA ${t.etaMinutes}m | GDR ${t.distanceToGdrKm}km`
          );
        }
      );
    }

    // ==========================================================
    // GATE LOGIC
    // ==========================================================

    console.log(
      "\n[GATE LOGIC]"
    );

    console.log(
      "   Chennai Gate = closes for MAS corridor trains"
    );

    console.log(
      "                  regardless of direction."
    );

    console.log(
      "   Tirupati Gate = closes for TPTY corridor trains"
    );

    console.log(
      "                   regardless of direction."
    );

    console.log(
      "   Gate closure requires ACTUAL physical position."
    );

    console.log(
      "   Route interpolation is NEVER used to close gates."
    );

    console.log(
      "==========================================\n"
    );

  } catch (err) {
    // ==========================================================
    // ERROR HANDLING
    // ==========================================================

    console.error(
      "\n=========================================="
    );

    console.error(
      "[MONITOR ERROR]"
    );

    console.error(
      "=========================================="
    );

    if (
      err.response
    ) {
      console.error(
        `HTTP ${err.response.status}`
      );

      console.error(
        "Response:",
        err.response.data
      );
    } else {
      console.error(
        err.message
      );
    }

    // ----------------------------------------------------------
    // WRITE ERROR STATE TO FIREBASE
    // ----------------------------------------------------------

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

        apiRequests:
          0,

        monitorStatus:
          "ERROR",

        error:
          err.message
      });

      console.error(
        "Firebase error state written."
      );

    } catch (
      firebaseError
    ) {
      console.error(
        "Firebase error:",
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
  " RailRadar Real-time Gudur Gate Monitor "
);

console.log(
  "=========================================="
);

console.log(
  `Gudur Station: ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  `Chennai Gate:  ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  `Tirupati Gate: ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  "=========================================="
);

console.log(
  "RailRadar API: " +
    (
      RAILRADAR_API_KEY
        ? "Configured"
        : "MISSING"
    )
);

console.log(
  "Firebase: Configured"
);

console.log(
  "=========================================="
);

console.log(
  "GATE LOGIC:"
);

console.log(
  "Chennai Gate = BOTH DIRECTIONS"
);

console.log(
  "Tirupati Gate = BOTH DIRECTIONS"
);

console.log(
  "=========================================="
);

// ============================================================
// GITHUB ACTIONS MODE
// ============================================================
//
// GitHub Actions runs:
//
// node code.js
//
// It must complete one cycle and exit.
//
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
  // ==========================================================
  // LOCAL MODE
  // ==========================================================

  updateGateSystem();

  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}
