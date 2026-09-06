const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

const SERVICE_ACCOUNT_FILE =
  "./serviceAccountKey.json";

// ============================================================
// LOAD FIREBASE SERVICE ACCOUNT
// ============================================================

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else if (
    fs.existsSync(SERVICE_ACCOUNT_FILE)
  ) {
    serviceAccount =
      require(SERVICE_ACCOUNT_FILE);
  } else {
    throw new Error(
      "Firebase service account not found."
    );
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(error.message);

  process.exit(1);
}

// ============================================================
// INITIALIZE FIREBASE
// ============================================================

admin.initializeApp({
  credential:
    admin.credential.cert(serviceAccount),

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
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR LOCATION
// ============================================================

const GDR_LAT =
  14.14842;

const GDR_LNG =
  79.84524;

// ============================================================
// CHENNAI-SIDE GATE
// ============================================================

const CHENNAI_GATE_LAT =
  14.1396639;

const CHENNAI_GATE_LNG =
  79.8441306;

// ============================================================
// TIRUPATI-SIDE GATE
// ============================================================

const TIRUPATI_GATE_LAT =
  14.1402056;

const TIRUPATI_GATE_LNG =
  79.8436000;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM =
  150;

const GATE_STOP_DISTANCE_KM =
  0.6;

const MAX_LIVE_REQUESTS =
  7;

const MAX_BOARD_CANDIDATES =
  22;

const REFRESH_INTERVAL_MS =
  60000;

const DEFAULT_SPEED_KMH =
  55;

const MIN_SPEED_KMH =
  5;

// ============================================================
// TIRUPATI CORRIDOR TRAIN NUMBERS
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

// ============================================================
// TEXT NORMALIZER
// ============================================================

function normalizeText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (
    typeof value === "object"
  ) {
    if (value.code) {
      return normalizeText(
        value.code
      );
    }

    if (value.name) {
      return normalizeText(
        value.name
      );
    }

    return "";
  }

  return String(value)
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
// CONTAINS ANY
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
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  item
) {
  const train =
    item?.train || {};

  return String(
    train.number ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  item
) {
  const train =
    item?.train || {};

  return (
    train.name ||
    item?.trainName ||
    `Express ${getTrainNumber(item)}`
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const source =
    train?.source;

  if (source) {
    if (
      typeof source ===
      "object"
    ) {
      return (
        source.name ||
        source.code ||
        ""
      );
    }

    return String(source);
  }

  return (
    train?.origin ||
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
  const destination =
    train?.destination;

  if (destination) {
    if (
      typeof destination ===
      "object"
    ) {
      return (
        destination.name ||
        destination.code ||
        ""
      );
    }

    return String(destination);
  }

  return (
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
// ORIGIN CODE
// ============================================================

function getOriginCode(
  train,
  item
) {
  const source =
    train?.source;

  if (
    source &&
    typeof source ===
      "object"
  ) {
    return normalizeText(
      source.code
    );
  }

  return normalizeText(
    train?.originCode ||
    train?.sourceCode ||
    item?.originCode ||
    item?.sourceCode ||
    ""
  );
}

// ============================================================
// DESTINATION CODE
// ============================================================

function getDestinationCode(
  train,
  item
) {
  const destination =
    train?.destination;

  if (
    destination &&
    typeof destination ===
      "object"
  ) {
    return normalizeText(
      destination.code
    );
  }

  return normalizeText(
    train?.destinationCode ||
    train?.toCode ||
    item?.destinationCode ||
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

  const originCode =
    getOriginCode(
      train,
      item
    );

  const text =
    `${origin} ${originCode}`;

  return containsAny(
    text,
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

  const originCode =
    getOriginCode(
      train,
      item
    );

  const text =
    `${origin} ${originCode}`;

  return containsAny(
    text,
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
// ROUTE
// ============================================================

function getRoute(
  liveResponse
) {
  return (
    liveResponse?.data?.route ||
    liveResponse?.route ||
    []
  );
}

// ============================================================
// FIND GUDUR ROUTE STOP
// ============================================================

function findGudurRouteStop(
  liveResponse
) {
  const route =
    getRoute(
      liveResponse
    );

  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  return (
    route.find(
      (stop) =>
        normalizeText(
          stop?.stationCode
        ) === "GDR"
    ) ||
    route.find(
      (stop) =>
        containsAny(
          stop?.stationName,
          [
            "GUDUR",
            "GUDUR JN",
            "GUDUR JUNCTION"
          ]
        )
    ) ||
    null
  );
}

// ============================================================
// FIND CURRENT ROUTE STOP
// ============================================================

function findCurrentRouteStop(
  liveResponse
) {
  const data =
    liveResponse?.data ||
    {};

  const current =
    data.currentLocation ||
    {};

  const route =
    getRoute(
      liveResponse
    );

  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  const stationCode =
    normalizeText(
      current.stationCode
    );

  const sequence =
    Number(
      current.sequence
    );

  if (stationCode) {
    const byCode =
      route.find(
        (stop) =>
          normalizeText(
            stop?.stationCode
          ) ===
          stationCode
      );

    if (byCode) {
      return byCode;
    }
  }

  if (
    Number.isFinite(sequence)
  ) {
    const bySequence =
      route.find(
        (stop) =>
          Number(
            stop?.sequence
          ) ===
          sequence
      );

    if (bySequence) {
      return bySequence;
    }
  }

  return null;
}

// ============================================================
// ROUTE DISTANCE
// ============================================================

function getRouteDistanceKm(
  stop
) {
  if (!stop) {
    return null;
  }

  const distance =
    Number(
      stop.distance
    );

  if (
    Number.isFinite(distance)
  ) {
    return distance;
  }

  return null;
}

// ============================================================
// CURRENT ROUTE DISTANCE
// ============================================================

function getCurrentRouteDistanceKm(
  liveResponse
) {
  const data =
    liveResponse?.data ||
    {};

  const current =
    data.currentLocation ||
    {};

  const direct =
    Number(
      current.distanceFromOriginKm
    );

  if (
    Number.isFinite(direct)
  ) {
    return direct;
  }

  const currentStop =
    findCurrentRouteStop(
      liveResponse
    );

  return getRouteDistanceKm(
    currentStop
  );
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function calculateRouteDistanceToGudur(
  liveResponse
) {
  const data =
    liveResponse?.data ||
    {};

  const current =
    data.currentLocation ||
    {};

  const gudurStop =
    findGudurRouteStop(
      liveResponse
    );

  if (!gudurStop) {
    return null;
  }

  const gudurDistance =
    getRouteDistanceKm(
      gudurStop
    );

  if (
    gudurDistance === null
  ) {
    return null;
  }

  const currentStation =
    normalizeText(
      current.stationCode
    );

  if (
    currentStation ===
    "GDR"
  ) {
    return 0;
  }

  const currentDistance =
    getCurrentRouteDistanceKm(
      liveResponse
    );

  if (
    currentDistance === null
  ) {
    return null;
  }

  return Number(
    Math.max(
      0,
      Math.abs(
        gudurDistance -
        currentDistance
      )
    ).toFixed(2)
  );
}

// ============================================================
// HAVERSINE
// ============================================================

function haversineKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R =
    6371;

  const dLat =
    (
      (lat2 - lat1) *
      Math.PI
    ) / 180;

  const dLon =
    (
      (lon2 - lon1) *
      Math.PI
    ) / 180;

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      lat1 *
        Math.PI /
        180
    ) *
    Math.cos(
      lat2 *
        Math.PI /
        180
    ) *
    Math.sin(
      dLon / 2
    ) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        1 - a
      )
    );

  return R * c;
}

// ============================================================
// EXTRACT ACTUAL GPS
// ============================================================

function extractActualGpsPosition(
  liveResponse
) {
  const data =
    liveResponse?.data ||
    {};

  const current =
    data.currentLocation ||
    {};

  const possibleObjects =
    [
      current,
      data.position,
      data.location,
      data.currentPosition
    ];

  for (
    const position of
      possibleObjects
  ) {
    if (!position) {
      continue;
    }

    const lat =
      Number(
        position.lat ??
        position.latitude
      );

    const lng =
      Number(
        position.lng ??
        position.lon ??
        position.longitude
      );

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      continue;
    }

    const actualFlag =
      position.isActualPosition;

    const positionSource =
      normalizeText(
        position.positionSource
      );

    if (
      actualFlag === true
    ) {
      return {
        lat,
        lng,

        speedKmh:
          Number(
            position.speedKmh ??
            position.speed ??
            0
          ),

        bearingDegrees:
          Number(
            position.bearingDegrees ??
            position.bearing ??
            0
          ),

        isActualPosition:
          true,

        positionSource:
          positionSource ||
          "GPS"
      };
    }
  }

  return null;
}

// ============================================================
// STATION CODE POSITION
// ============================================================

function extractStationCodePosition(
  liveResponse
) {
  const data =
    liveResponse?.data ||
    {};

  const current =
    data.currentLocation ||
    {};

  const stationCode =
    normalizeText(
      current.stationCode
    );

  if (!stationCode) {
    return null;
  }

  const sequence =
    Number(
      current.sequence
    );

  return {
    stationCode,

    stationName:
      current.stationName ||
      "",

    sequence:
      Number.isFinite(sequence)
        ? sequence
        : null,

    routeDistanceKm:
      getCurrentRouteDistanceKm(
        liveResponse
      ),

    isActualPosition:
      current.isActualPosition ===
      true,

    positionSource:
      normalizeText(
        current.positionSource
      ) ||
      "STATION_CODE"
  };
}

// ============================================================
// BEST POSITION
// ============================================================

function getBestPosition(
  liveResponse
) {
  const gps =
    extractActualGpsPosition(
      liveResponse
    );

  if (gps) {
    return {
      type: "GPS",
      ...gps
    };
  }

  const station =
    extractStationCodePosition(
      liveResponse
    );

  if (station) {
    return {
      type:
        "STATION_CODE",
      ...station
    };
  }

  return {
    type: "NONE"
  };
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  liveResponse
) {
  const gps =
    extractActualGpsPosition(
      liveResponse
    );

  if (gps) {
    return {
      distanceKm:
        Number(
          haversineKm(
            gps.lat,
            gps.lng,
            GDR_LAT,
            GDR_LNG
          ).toFixed(2)
        ),

      source:
        "GPS"
    };
  }

  const routeDistance =
    calculateRouteDistanceToGudur(
      liveResponse
    );

  if (
    routeDistance !== null
  ) {
    return {
      distanceKm:
        routeDistance,

      source:
        "ROUTE"
    };
  }

  return {
    distanceKm:
      null,

    source:
      "NONE"
  };
}

// ============================================================
// DISTANCE TO SPECIFIC GATE
// ============================================================

function getDistanceToSpecificGate(
  liveResponse,
  gateType
) {
  const gps =
    extractActualGpsPosition(
      liveResponse
    );

  if (gps) {
    const gateLat =
      gateType ===
      "TPTY"
        ? TIRUPATI_GATE_LAT
        : CHENNAI_GATE_LAT;

    const gateLng =
      gateType ===
      "TPTY"
        ? TIRUPATI_GATE_LNG
        : CHENNAI_GATE_LNG;

    return {
      distanceKm:
        Number(
          haversineKm(
            gps.lat,
            gps.lng,
            gateLat,
            gateLng
          ).toFixed(3)
        ),

      source:
        "GPS"
    };
  }

  // ----------------------------------------------------------
  // If the train is actually reported at GDR,
  // conservatively consider it inside the station area.
  // ----------------------------------------------------------

  const current =
    liveResponse?.data
      ?.currentLocation ||
    {};

  const stationCode =
    normalizeText(
      current.stationCode
    );

  if (
    stationCode ===
      "GDR" &&
    current.isActualPosition ===
      true
  ) {
    return {
      distanceKm:
        0,

      source:
        "STATION_CODE"
    };
  }

  return {
    distanceKm:
      null,

    source:
      "NONE"
  };
}

// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// Direction is now ONLY informational.
//
// IMPORTANT:
//
// TOWARD_GUDUR
//     Train is approaching Gudur.
//
// AT_GUDUR
//     Train is at Gudur.
//
// AWAY_FROM_GUDUR
//     Train has passed Gudur.
//
// A train moving AWAY from Gudur can STILL close a gate,
// because it may be travelling toward Chennai or Tirupati.
//
// ============================================================

function getRouteDirection(
  liveResponse
) {
  const data =
    liveResponse?.data ||
    {};

  const current =
    data.currentLocation ||
    {};

  const currentSequence =
    Number(
      current.sequence
    );

  const gudurStop =
    findGudurRouteStop(
      liveResponse
    );

  if (!gudurStop) {
    return "UNKNOWN";
  }

  const gudurSequence =
    Number(
      gudurStop.sequence
    );

  if (
    !Number.isFinite(
      currentSequence
    ) ||
    !Number.isFinite(
      gudurSequence
    )
  ) {
    return "UNKNOWN";
  }

  if (
    currentSequence <
    gudurSequence
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    currentSequence ===
    gudurSequence
  ) {
    return "AT_GUDUR";
  }

  return "AWAY_FROM_GUDUR";
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  const fields =
    [
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
      item?.runningDirection
    ];

  return fields
    .filter(Boolean)
    .map(
      normalizeText
    )
    .join(" ");
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// This determines which physical gate the train belongs to.
//
// IMPORTANT:
//
// Corridor is NOT used to decide whether the train is allowed
// to close a gate.
//
// It is only used to identify:
//
// MAS  = Chennai-side gate
// TPTY = Tirupati-side gate
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo =
    String(
      train?.number ||
      item?.trainNumber ||
      ""
    ).trim();

  // ----------------------------------------------------------
  // Source / origin
  // ----------------------------------------------------------

  if (
    isFromTirupatiSide(
      train,
      item
    )
  ) {
    return "TPTY";
  }

  if (
    isFromChennaiSide(
      train,
      item
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Known Tirupati trains
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Route topology
  // ----------------------------------------------------------

  const route =
    getRoute(
      live
    );

  if (
    Array.isArray(route) &&
    route.length > 0
  ) {
    const routeText =
      route
        .map(
          (stop) =>
            `${stop?.stationCode || ""} ${stop?.stationName || ""}`
        )
        .join(" ");

    const hasTpty =
      containsAny(
        routeText,
        [
          "TPTY",
          "TIRUPATI"
        ]
      );

    const hasMas =
      containsAny(
        routeText,
        [
          "MAS",
          "CHENNAI",
          "MGR CHENNAI CENTRAL"
        ]
      );

    if (
      hasTpty &&
      !hasMas
    ) {
      return "TPTY";
    }

    if (
      hasMas &&
      !hasTpty
    ) {
      return "MAS";
    }
  }

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

    if (match) {
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
    totalMinutes ===
    -1
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
// LIVE TRAIN REQUEST
// ============================================================

async function fetchLiveTrain(
  trainNumber
) {
  const endpoints =
    [
      `/trains/${trainNumber}/live`,
      `/trains/${trainNumber}`,
      `/train/${trainNumber}/live`
    ];

  let lastError =
    null;

  for (
    const endpoint of
      endpoints
  ) {
    try {
      const response =
        await axios.get(
          `${RAILRADAR_BASE_URL}${endpoint}`,
          {
            params: {
              includeCoordinates:
                "true"
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

      return response.data;
    } catch (error) {
      lastError =
        error;

      if (
        error.response &&
        error.response.status ===
          404
      ) {
        continue;
      }

      throw error;
    }
  }

  throw (
    lastError ||
    new Error(
      "Live train endpoint failed."
    )
  );
}

// ============================================================
// STATION BOARD
// ============================================================

async function fetchStationBoard() {
  const response =
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

  return response.data;
}

// ============================================================
// BOARD TRAINS
// ============================================================

function getBoardTrains(
  response
) {
  return (
    response?.data?.trains ||
    []
  );
}

// ============================================================
// BOARD ARRIVAL
// ============================================================

function getBoardArrival(
  item
) {
  const stop =
    item?.stop ||
    {};

  const live =
    item?.live ||
    {};

  return (
    stop.arrival ||
    live.expectedArrivalTime ||
    ""
  );
}

// ============================================================
// MERGE VERIFIED DATA
// ============================================================

function mergeVerifiedData(
  boardItem,
  liveResponse
) {
  const liveData =
    liveResponse?.data ||
    {};

  const boardTrain =
    boardItem?.train ||
    {};

  const liveTrain =
    liveData?.train ||
    {};

  return {
    ...boardItem,

    train: {
      ...boardTrain,
      ...liveTrain
    },

    live: {
      ...(boardItem?.live || {}),
      ...liveData
    },

    stop: {
      ...(boardItem?.stop || {})
    },

    currentLocation:
      liveData.currentLocation ||
      null,

    previousHalt:
      liveData.previousHalt ||
      null,

    nextHalt:
      liveData.nextHalt ||
      null,

    route:
      liveData.route ||
      [],

    delayMinutes:
      Number(
        liveData.delayMinutes ??
        boardItem?.live
          ?.delayMinutes ??
        0
      ),

    isLive:
      liveData.isLive ===
      true,

    status:
      liveData.status ||
      boardItem?.live?.type ||
      "",

    lastUpdatedAt:
      liveData.lastUpdatedAt ||
      null
  };
}

// ============================================================
// PROCESS TRAIN
// ============================================================

function processTrain(
  boardItem,
  liveResponse
) {
  const train =
    liveResponse?.data?.train ||
    boardItem?.train ||
    {};

  const live =
    liveResponse?.data ||
    {};

  const stop =
    boardItem?.stop ||
    {};

  const item =
    boardItem ||
    {};

  const trainNumber =
    String(
      train.number ||
      live.trainNumber ||
      getTrainNumber(
        boardItem
      ) ||
      ""
    ).trim();

  const trainName =
    train.name ||
    live.trainName ||
    getTrainName(
      boardItem
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
      live.delayMinutes ??
      boardItem?.live
        ?.delayMinutes ??
      0
    );

  // ==========================================================
  // DIRECTION
  // ==========================================================

  const direction =
    getRouteDirection(
      liveResponse
    );

  // ==========================================================
  // CORRIDOR
  // ==========================================================

  const corridor =
    determineCorridor(
      train,
      live,
      stop,
      item
    );

  // ==========================================================
  // CURRENT POSITION
  // ==========================================================

  const position =
    getBestPosition(
      liveResponse
    );

  // ==========================================================
  // CURRENT STATION
  // ==========================================================

  const currentStationCode =
    normalizeText(
      live?.currentLocation
        ?.stationCode
    );

  const currentStationName =
    live?.currentLocation
      ?.stationName ||
    null;

  const currentSequence =
    Number(
      live?.currentLocation
        ?.sequence
    );

  const atGudur =
    currentStationCode ===
    "GDR";

  const passedGudur =
    direction ===
    "AWAY_FROM_GUDUR";

  // ==========================================================
  // DISTANCE TO GUDUR
  // ==========================================================

  const gudurDistance =
    getDistanceToGudur(
      liveResponse
    );

  // ==========================================================
  // DISTANCE TO BOTH GATES
  // ==========================================================

  const chennaiGateDistance =
    getDistanceToSpecificGate(
      liveResponse,
      "MAS"
    );

  const tirupatiGateDistance =
    getDistanceToSpecificGate(
      liveResponse,
      "TPTY"
    );

  // ==========================================================
  // ETA TO GUDUR
  // ==========================================================

  let etaMinutes =
    null;

  if (
    gudurDistance.distanceKm !==
      null &&
    gudurDistance.distanceKm !==
      undefined
  ) {
    let speed =
      Number(
        live?.currentLocation
          ?.speedKmh
      );

    if (
      !Number.isFinite(speed) ||
      speed <= 0
    ) {
      speed =
        Number(
          live?.train
            ?.avgSpeed
        );
    }

    if (
      !Number.isFinite(speed) ||
      speed <= 0
    ) {
      speed =
        DEFAULT_SPEED_KMH;
    }

    speed =
      Math.max(
        MIN_SPEED_KMH,
        speed
      );

    etaMinutes =
      Math.max(
        0,
        Math.round(
          (
            gudurDistance.distanceKm /
            speed
          ) *
            60
        )
      );
  }

  // ==========================================================
  // ACTUAL PHYSICAL POSITION
  // ==========================================================

  const actualGps =
    extractActualGpsPosition(
      liveResponse
    );

  const isActualPosition =
    live?.currentLocation
      ?.isActualPosition ===
    true;

  return {
    trainNumber,

    trainName,

    origin:
      origin ||
      "Unknown origin",

    destination:
      destination ||
      "Unknown destination",

    delayMinutes,

    direction,

    corridor,

    distanceToGudurKm:
      gudurDistance.distanceKm,

    distanceToGudurSource:
      gudurDistance.source,

    chennaiGateDistanceKm:
      chennaiGateDistance.distanceKm,

    chennaiGateDistanceSource:
      chennaiGateDistance.source,

    tirupatiGateDistanceKm:
      tirupatiGateDistance.distanceKm,

    tirupatiGateDistanceSource:
      tirupatiGateDistance.source,

    gps:
      actualGps,

    positionType:
      position.type,

    currentStationCode:
      currentStationCode ||
      null,

    currentStationName,

    currentSequence:
      Number.isFinite(
        currentSequence
      )
        ? currentSequence
        : null,

    positionSource:
      normalizeText(
        live?.currentLocation
          ?.positionSource
      ) ||
      position.positionSource ||
      null,

    isActualPosition,

    atGudur,

    passedGudur,

    etaMinutes
  };
}

// ============================================================
// IMPORTANT: GATE CLOSURE LOGIC
// ============================================================
//
// THIS IS THE NEW CORRECT LOGIC.
//
// Chennai Gate:
//     If train is physically within 0.6 km
//     of Chennai Gate -> CLOSE.
//
// Tirupati Gate:
//     If train is physically within 0.6 km
//     of Tirupati Gate -> CLOSE.
//
// DIRECTION DOES NOT MATTER.
//
// Therefore:
//
// Chennai -> Gudur      => Chennai gate CLOSES
// Gudur -> Chennai      => Chennai gate CLOSES
//
// Tirupati -> Gudur     => Tirupati gate CLOSES
// Gudur -> Tirupati     => Tirupati gate CLOSES
//
// A train travelling AWAY_FROM_GUDUR is NOT automatically
// rejected anymore.
//
// ============================================================

function shouldCloseSpecificGate(
  processed,
  gateType
) {
  if (!processed) {
    return false;
  }

  const distance =
    gateType === "MAS"
      ? processed.chennaiGateDistanceKm
      : processed.tirupatiGateDistanceKm;

  const source =
    gateType === "MAS"
      ? processed.chennaiGateDistanceSource
      : processed.tirupatiGateDistanceSource;

  // ----------------------------------------------------------
  // ACTUAL GPS
  // ----------------------------------------------------------

  if (
    processed.gps &&
    processed.isActualPosition &&
    distance !== null &&
    distance !== undefined
  ) {
    return (
      distance <=
      GATE_STOP_DISTANCE_KM
    );
  }

  // ----------------------------------------------------------
  // ACTUAL GUDUR STATION POSITION
  // ----------------------------------------------------------

  if (
    processed.atGudur &&
    processed.isActualPosition &&
    source ===
      "STATION_CODE"
  ) {
    return true;
  }

  return false;
}

// ============================================================
// UPCOMING TRAIN LOGIC
// ============================================================
//
// Upcoming list remains directional because it is specifically
// showing trains that are approaching Gudur.
//
// Gate closure is DIFFERENT.
//
// Gate closure works in BOTH directions.
//
// ============================================================

function shouldShowUpcoming(
  processed
) {
  if (!processed) {
    return false;
  }

  if (
    processed.direction !==
    "TOWARD_GUDUR"
  ) {
    return false;
  }

  if (
    processed.atGudur
  ) {
    return false;
  }

  if (
    processed.distanceToGudurKm ===
      null ||
    processed.distanceToGudurKm ===
      undefined
  ) {
    return false;
  }

  if (
    processed.distanceToGudurKm >
    UPCOMING_MAX_DISTANCE_KM
  ) {
    return false;
  }

  return true;
}

// ============================================================
// CREATE GATE PAYLOAD
// ============================================================

function createGatePayload(
  processed,
  gateType
) {
  const trainStatus =
    processed.delayMinutes > 0
      ? `${processed.delayMinutes}m late`
      : "On Time";

  const label =
    `${processed.trainNumber} ${processed.trainName} (${trainStatus})`;

  const gateDistance =
    gateType === "MAS"
      ? processed.chennaiGateDistanceKm
      : processed.tirupatiGateDistanceKm;

  const gateDistanceSource =
    gateType === "MAS"
      ? processed.chennaiGateDistanceSource
      : processed.tirupatiGateDistanceSource;

  let waitMinutes =
    3;

  if (
    processed.atGudur
  ) {
    waitMinutes =
      5;
  } else if (
    processed.etaMinutes !==
    null
  ) {
    waitMinutes =
      Math.max(
        1,
        processed.etaMinutes + 2
      );
  }

  return {
    status:
      "CLOSED",

    waitMinutes,

    activeTrain:
      label,

    direction:
      processed.direction,

    corridor:
      gateType,

    positionSource:
      processed.positionSource ||
      processed.positionType,

    distanceToGudurKm:
      processed.distanceToGudurKm,

    distanceToGateKm:
      gateDistance,

    distanceToGateSource:
      gateDistanceSource,

    isActualPosition:
      processed.isActualPosition
  };
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const cycleStart =
    Date.now();

  let apiRequests =
    0;

  try {
    const now =
      new Date();

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY is missing."
      );
    }

    console.log(
      `\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // ========================================================
    // STATION BOARD
    // ========================================================

    apiRequests++;

    const boardResponse =
      await fetchStationBoard();

    const trainsArray =
      getBoardTrains(
        boardResponse
      );

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

    // ========================================================
    // BOARD CANDIDATES
    // ========================================================

    const boardCandidates =
      trainsArray
        .map(
          (item) => ({
            item,

            trainNumber:
              getTrainNumber(
                item
              ),

            arrival:
              getBoardArrival(
                item
              )
          })
        )
        .filter(
          (candidate) =>
            candidate.trainNumber
        )
        .slice(
          0,
          MAX_BOARD_CANDIDATES
        );

    const verificationLimit =
      Math.min(
        MAX_LIVE_REQUESTS,
        boardCandidates.length
      );

    console.log(
      `Verification queue: ${boardCandidates.length}`
    );

    console.log(
      `Live verification: ${verificationLimit}`
    );

    // ========================================================
    // DEFAULT GATE STATES
    // ========================================================

    let masGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear"
    };

    let tptyGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear"
    };

    // ========================================================
    // LISTS
    // ========================================================

    const upcomingList =
      [];

    const verifiedTrains =
      [];

    // ========================================================
    // VERIFY TRAINS
    // ========================================================

    for (
      let i = 0;
      i <
      verificationLimit;
      i++
    ) {
      const candidate =
        boardCandidates[i];

      const item =
        candidate.item;

      const trainNumber =
        candidate.trainNumber;

      console.log(
        `\n[LIVE REQUEST ${i + 1}/${verificationLimit}] ${trainNumber}`
      );

      let liveResponse;

      try {
        apiRequests++;

        liveResponse =
          await fetchLiveTrain(
            trainNumber
          );
      } catch (error) {
        console.error(
          `[LIVE ERROR] ${trainNumber} - ${error.message}`
        );

        continue;
      }

      // ======================================================
      // PROCESS
      // ======================================================

      const merged =
        mergeVerifiedData(
          item,
          liveResponse
        );

      const processed =
        processTrain(
          item,
          liveResponse
        );

      verifiedTrains.push(
        processed
      );

      // ======================================================
      // LOG
      // ======================================================

      console.log(
        `[LIVE] ${processed.trainNumber} ${processed.trainName}`
      );

      console.log(
        `       Direction: ${processed.direction}`
      );

      console.log(
        `       Corridor: ${processed.corridor || "UNKNOWN"}`
      );

      console.log(
        `       GDR: ${processed.distanceToGudurKm ?? "?"}km (${processed.distanceToGudurSource})`
      );

      console.log(
        `       Chennai Gate: ${processed.chennaiGateDistanceKm ?? "?"}km (${processed.chennaiGateDistanceSource})`
      );

      console.log(
        `       Tirupati Gate: ${processed.tirupatiGateDistanceKm ?? "?"}km (${processed.tirupatiGateDistanceSource})`
      );

      console.log(
        `       Position: ${processed.positionType}`
      );

      // ======================================================
      // UPCOMING TRAINS
      // ======================================================

      if (
        shouldShowUpcoming(
          processed
        )
      ) {
        upcomingList.push({
          trainNo:
            processed.trainNumber,

          name:
            processed.trainName,

          origin:
            processed.origin,

          destination:
            processed.destination,

          etaMinutes:
            processed.etaMinutes,

          delayMinutes:
            processed.delayMinutes,

          corridor:
            processed.corridor,

          direction:
            processed.direction,

          distanceToGudurKm:
            processed.distanceToGudurKm,

          distanceSource:
            processed.distanceToGudurSource,

          platform:
            String(
              merged?.live
                ?.platform ||
              item?.live
                ?.platform ||
              "1"
            )
        });
      }

      // ======================================================
      // CHENNAI GATE
      // ======================================================
      //
      // Direction DOES NOT MATTER.
      //
      // If physically near Chennai Gate:
      //
      // Chennai -> Gudur = CLOSE
      // Gudur -> Chennai = CLOSE
      //
      // ======================================================

      const closeChennaiGate =
        shouldCloseSpecificGate(
          processed,
          "MAS"
        );

      if (
        closeChennaiGate
      ) {
        const payload =
          createGatePayload(
            processed,
            "MAS"
          );

        // Keep the train with the
        // closest physical distance.
        if (
          masGate.status !==
            "CLOSED" ||
          (
            processed.chennaiGateDistanceKm !==
              null &&
            processed.chennaiGateDistanceKm <
              (
                masGate.distanceToGateKm ??
                Infinity
              )
          )
        ) {
          masGate =
            payload;
        }

        console.log(
          `[CHENNAI GATE CLOSED] ${processed.trainNumber} | direction=${processed.direction} | distance=${processed.chennaiGateDistanceKm}km`
        );
      }

      // ======================================================
      // TIRUPATI GATE
      // ======================================================
      //
      // Direction DOES NOT MATTER.
      //
      // If physically near Tirupati Gate:
      //
      // Tirupati -> Gudur = CLOSE
      // Gudur -> Tirupati = CLOSE
      //
      // ======================================================

      const closeTirupatiGate =
        shouldCloseSpecificGate(
          processed,
          "TPTY"
        );

      if (
        closeTirupatiGate
      ) {
        const payload =
          createGatePayload(
            processed,
            "TPTY"
          );

        if (
          tptyGate.status !==
            "CLOSED" ||
          (
            processed.tirupatiGateDistanceKm !==
              null &&
            processed.tirupatiGateDistanceKm <
              (
                tptyGate.distanceToGateKm ??
                Infinity
              )
          )
        ) {
          tptyGate =
            payload;
        }

        console.log(
          `[TIRUPATI GATE CLOSED] ${processed.trainNumber} | direction=${processed.direction} | distance=${processed.tirupatiGateDistanceKm}km`
        );
      }
    }

    // ========================================================
    // SORT UPCOMING
    // ========================================================

    upcomingList.sort(
      (
        a,
        b
      ) =>
        (
          a.etaMinutes ??
          9999
        ) -
        (
          b.etaMinutes ??
          9999
        )
    );

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        cycleStart
      ) /
      1000;

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
      "=========================================="
    );

    // ========================================================
    // SHOW UPCOMING
    // ========================================================

    if (
      topUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (train) => {
          console.log(
            `   ${train.corridor || "UNKNOWN"} | ${train.trainNo} ${train.name} | ETA ${train.etaMinutes ?? "?"}m | GDR ${train.distanceToGudurKm ?? "?"}km`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    // ========================================================
    // GATE DIRECTION SUMMARY
    // ========================================================

    console.log(
      "\n[GATE LOGIC]"
    );

    console.log(
      "   Chennai Gate = closes for trains physically near Chennai Gate"
    );

    console.log(
      "                  regardless of direction."
    );

    console.log(
      "   Tirupati Gate = closes for trains physically near Tirupati Gate"
    );

    console.log(
      "                   regardless of direction."
    );

    console.log(
      "=========================================="
    );
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

    console.error(
      "=========================================="
    );

    try {
      const durationSeconds =
        (
          Date.now() -
          cycleStart
        ) /
        1000;

      await gateRef.set({
        tirupatiGate: {
          status:
            "OPEN",

          waitMinutes:
            0,

          activeTrain:
            "Tracks clear"
        },

        chennaiGate: {
          status:
            "OPEN",

          waitMinutes:
            0,

          activeTrain:
            "Tracks clear"
        },

        upcomingTrains:
          [],

        lastUpdated:
          new Date()
            .toLocaleTimeString(),

        lastUpdatedLocal:
          new Date()
            .toLocaleString(),

        verifiedTrains:
          0,

        apiRequests:
          apiRequests,

        monitorStatus:
          "ERROR",

        error:
          error.message,

        monitorDurationSeconds:
          Number(
            durationSeconds.toFixed(
              1
            )
          )
      });
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
  "RailRadar API: Configured"
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

