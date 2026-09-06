const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

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

    console.log(
      "Firebase service account: GitHub Secret"
    );
  } else {
    const SERVICE_ACCOUNT_FILE =
      "./serviceAccountKey.json";

    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
      );
    }

    serviceAccount =
      require(SERVICE_ACCOUNT_FILE);

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
// GUDUR COORDINATES
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

// ============================================================
// GATE COORDINATES
// ============================================================

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SETTINGS
// ============================================================

// Upcoming trains can be maximum 150 km away.
const UPCOMING_MAX_DISTANCE_KM = 150;

// IMPORTANT:
// Allow trains up to 6 hours away in the upcoming list.
const UPCOMING_MAX_ETA_MINUTES = 360;

// Physical gate closure distance.
const GATE_STOP_DISTANCE_KM = 0.60;

// Local mode refresh.
const REFRESH_INTERVAL_MS = 60000;

// Default speed if RailRadar does not provide speed.
const DEFAULT_SPEED_KMPH = 55;

// Minimum usable speed.
const MIN_SPEED_KMPH = 5;

// RailRadar station board.
const STATION_BOARD_HOURS = 4;

// ============================================================
// IMPORTANT CHANGE
// ============================================================
//
// We DO NOT stop after only 7 trains anymore.
//
// The station board can return 16+ trains.
//
// We inspect all board trains for upcoming status.
//
// Live verification is limited separately.
//
// ============================================================

const MAX_LIVE_VERIFICATIONS = 12;

// ============================================================
// KNOWN TIRUPATI CORRIDOR TRAINS
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
    "07670",
    "22708",
    "20630"
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
// NUMBER
// ============================================================

function toNumber(value) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

// ============================================================
// HAVERSINE
// ============================================================

function haversineKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const aLat =
    toNumber(lat1);

  const aLng =
    toNumber(lng1);

  const bLat =
    toNumber(lat2);

  const bLng =
    toNumber(lng2);

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
    ((bLat - aLat) *
      Math.PI) /
    180;

  const dLng =
    ((bLng - aLng) *
      Math.PI) /
    180;

  const lat1Rad =
    (aLat *
      Math.PI) /
    180;

  const lat2Rad =
    (bLat *
      Math.PI) /
    180;

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      lat1Rad
    ) *
      Math.cos(
        lat2Rad
      ) *
      Math.sin(
        dLng / 2
      ) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    train.origin ||
    train.source ||
    train.from ||
    train.fromStation ||
    train.startStation ||
    train.start ||
    item.origin ||
    item.source ||
    item.from ||
    item.fromStation ||
    item.startStation ||
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
    train.destination ||
    train.to ||
    train.destinationStation ||
    train.endStation ||
    item.destination ||
    item.to ||
    item.destinationStation ||
    ""
  );
}

// ============================================================
// ROUTE
// ============================================================

function getRoute(
  train,
  live,
  item
) {
  if (
    Array.isArray(
      train.route
    )
  ) {
    return train.route;
  }

  if (
    Array.isArray(
      live.route
    )
  ) {
    return live.route;
  }

  if (
    Array.isArray(
      item.route
    )
  ) {
    return item.route;
  }

  return [];
}

// ============================================================
// STATION CODE
// ============================================================

function getStationCode(
  stop
) {
  return normalizeText(
    stop?.stationCode ||
      stop?.code ||
      stop?.station ||
      ""
  ).replace(
    / /g,
    ""
  );
}

// ============================================================
// GUDUR SEQUENCE
// ============================================================

function getGudurSequence(
  train,
  live,
  item
) {
  const route =
    getRoute(
      train,
      live,
      item
    );

  for (
    const stop of route
  ) {
    if (
      getStationCode(
        stop
      ) === "GDR"
    ) {
      const sequence =
        toNumber(
          stop.sequence
        );

      if (
        sequence !== null
      ) {
        return sequence;
      }
    }
  }

  return null;
}

// ============================================================
// CURRENT SEQUENCE
// ============================================================

function getCurrentSequence(
  train,
  live,
  item
) {
  const current =
    train.currentLocation ||
    live.currentLocation ||
    item.currentLocation ||
    {};

  return toNumber(
    current.sequence
  );
}

// ============================================================
// ROUTE DIRECTION
// ============================================================

function getRouteDirection(
  train,
  live,
  item
) {
  const current =
    train.currentLocation ||
    live.currentLocation ||
    item.currentLocation ||
    {};

  const status =
    normalizeText(
      current.status
    );

  if (
    status.includes(
      "DEPART"
    )
  ) {
    return "AWAY_FROM_GUDUR";
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
      item
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

    return "AT_GUDUR";
  }

  // ----------------------------------------------------------
  // DESTINATION FALLBACK
  // ----------------------------------------------------------

  const destination =
    getDestination(
      train,
      item
    );

  if (
    containsAny(
      destination,
      [
        "GUDUR",
        "GDR"
      ]
    )
  ) {
    return "TOWARD_GUDUR";
  }

  return "UNKNOWN";
}

// ============================================================
// CORRIDOR DETECTION
// ============================================================

function determinePhysicalCorridor(
  train,
  live,
  item
) {
  const route =
    getRoute(
      train,
      live,
      item
    );

  const gudurSequence =
    getGudurSequence(
      train,
      live,
      item
    );

  let lastSide =
    null;

  // ----------------------------------------------------------
  // ROUTE ANALYSIS
  // ----------------------------------------------------------

  for (
    const stop of route
  ) {
    const sequence =
      toNumber(
        stop.sequence
      );

    if (
      sequence === null
    ) {
      continue;
    }

    if (
      gudurSequence !== null &&
      sequence >=
        gudurSequence
    ) {
      continue;
    }

    const text =
      normalizeText(
        [
          stop.stationCode,
          stop.code,
          stop.stationName,
          stop.name
        ]
          .filter(Boolean)
          .join(" ")
      );

    if (
      containsAny(
        text,
        [
          "CHENNAI",
          "MAS",
          "CHENNAI CENTRAL",
          "MGR CHENNAI CENTRAL",
          "AVADI",
          "PERAMBUR"
        ]
      )
    ) {
      lastSide = "MAS";
    }

    if (
      containsAny(
        text,
        [
          "TIRUPATI",
          "TPTY",
          "RENIGUNTA",
          "RU"
        ]
      )
    ) {
      lastSide = "TPTY";
    }
  }

  if (lastSide) {
    return lastSide;
  }

  // ----------------------------------------------------------
  // ORIGIN FALLBACK
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
        "CHENNAI",
        "MAS",
        "CHENNAI CENTRAL",
        "MGR CHENNAI CENTRAL",
        "AVADI",
        "PERAMBUR",
        "SULLURUPETA",
        "NAYUDUPETA"
      ]
    )
  ) {
    return "MAS";
  }

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

  // ----------------------------------------------------------
  // DESTINATION FALLBACK
  // ----------------------------------------------------------

  const destination =
    getDestination(
      train,
      item
    );

  if (
    containsAny(
      destination,
      [
        "TIRUPATI",
        "TPTY"
      ]
    )
  ) {
    return "TPTY";
  }

  if (
    containsAny(
      destination,
      [
        "CHENNAI",
        "MAS"
      ]
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // KNOWN TPTY TRAINS
  // ----------------------------------------------------------

  const trainNo =
    String(
      train.number ||
        item.trainNumber ||
        ""
    ).trim();

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// ACTUAL GPS
// ============================================================

function extractActualGpsPosition(
  train,
  live,
  item
) {
  const current =
    train.currentLocation ||
    live.currentLocation ||
    item.currentLocation ||
    {};

  const lat =
    toNumber(
      current.lat ??
        current.latitude ??
        current.location?.lat ??
        current.location?.latitude
    );

  const lng =
    toNumber(
      current.lng ??
        current.lon ??
        current.longitude ??
        current.location?.lng ??
        current.location?.lon ??
        current.location?.longitude
    );

  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  if (
    current.isActualPosition ===
    false
  ) {
    return null;
  }

  const speed =
    toNumber(
      current.speedKmph ??
        current.speedKmh ??
        current.speed
    );

  return {
    lat,
    lng,
    speedKmph:
      speed !== null
        ? speed
        : null,

    source:
      current.positionSource ||
      "GPS",

    isActualPosition:
      true
  };
}

// ============================================================
// ACTUAL STATION POSITION
// ============================================================

function extractActualStationPosition(
  train,
  live,
  item
) {
  const current =
    train.currentLocation ||
    live.currentLocation ||
    item.currentLocation ||
    {};

  if (
    current.isActualPosition !==
    true
  ) {
    return null;
  }

  const currentSequence =
    toNumber(
      current.sequence
    );

  const currentCode =
    getStationCode(
      current
    );

  const route =
    getRoute(
      train,
      live,
      item
    );

  let matched =
    null;

  if (
    currentSequence !== null
  ) {
    matched =
      route.find(
        (stop) =>
          toNumber(
            stop.sequence
          ) ===
          currentSequence
      );
  }

  if (
    !matched &&
    currentCode
  ) {
    matched =
      route.find(
        (stop) =>
          getStationCode(
            stop
          ) ===
          currentCode
      );
  }

  if (!matched) {
    return null;
  }

  const lat =
    toNumber(
      matched.lat ??
        matched.latitude
    );

  const lng =
    toNumber(
      matched.lng ??
        matched.lon ??
        matched.longitude
    );

  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  const speed =
    toNumber(
      current.speedKmph ??
        current.speedKmh ??
        current.speed
    );

  return {
    lat,
    lng,

    speedKmph:
      speed !== null
        ? speed
        : null,

    source:
      "STATION_CODE",

    stationCode:
      currentCode,

    stationName:
      current.stationName ||
      matched.stationName ||
      matched.name ||
      "",

    isActualPosition:
      true
  };
}

// ============================================================
// BEST ACTUAL POSITION
// ============================================================

function getActualPosition(
  train,
  live,
  item
) {
  const gps =
    extractActualGpsPosition(
      train,
      live,
      item
    );

  if (gps) {
    return gps;
  }

  return extractActualStationPosition(
    train,
    live,
    item
  );
}

// ============================================================
// GATE DISTANCES
// ============================================================

function getGateDistances(
  position
) {
  if (!position) {
    return {
      chennai: null,
      tirupati: null,
      gudur: null
    };
  }

  return {
    chennai:
      haversineKm(
        position.lat,
        position.lng,
        CHENNAI_GATE_LAT,
        CHENNAI_GATE_LNG
      ),

    tirupati:
      haversineKm(
        position.lat,
        position.lng,
        TIRUPATI_GATE_LAT,
        TIRUPATI_GATE_LNG
      ),

    gudur:
      haversineKm(
        position.lat,
        position.lng,
        GDR_LAT,
        GDR_LNG
      )
  };
}

// ============================================================
// GATE CLOSURE
// ============================================================
//
// Direction DOES NOT matter.
//
// Chennai corridor -> Chennai gate.
// Tirupati corridor -> Tirupati gate.
//
// Both directions are allowed.
//
// ============================================================

function shouldCloseGate(
  corridor,
  position,
  distances
) {
  if (!position) {
    return {
      close: false,
      distanceKm: null
    };
  }

  if (
    position.isActualPosition !==
    true
  ) {
    return {
      close: false,
      distanceKm: null
    };
  }

  if (
    corridor === "MAS"
  ) {
    const distance =
      distances.chennai;

    return {
      close:
        distance !== null &&
        distance <=
          GATE_STOP_DISTANCE_KM,

      distanceKm:
        distance
    };
  }

  if (
    corridor === "TPTY"
  ) {
    const distance =
      distances.tirupati;

    return {
      close:
        distance !== null &&
        distance <=
          GATE_STOP_DISTANCE_KM,

      distanceKm:
        distance
    };
  }

  return {
    close: false,
    distanceKm: null
  };
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  value,
  delayMinutes = 0
) {
  if (!value) {
    return -1;
  }

  const text =
    String(value).trim();

  // ISO timestamp
  const date =
    new Date(text);

  if (
    !isNaN(
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

  // HH:MM
  const match =
    text.match(
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
// SPEED
// ============================================================

function getUsableSpeed(
  position,
  live,
  train
) {
  const candidates = [
    position?.speedKmph,
    live?.speedKmph,
    live?.speedKmh,
    live?.speed,
    train?.speedKmph,
    train?.speedKmh,
    train?.speed
  ];

  for (
    const value of
      candidates
  ) {
    const speed =
      toNumber(value);

    if (
      speed !== null &&
      speed >=
        MIN_SPEED_KMPH
    ) {
      return speed;
    }
  }

  return DEFAULT_SPEED_KMPH;
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  position
) {
  if (!position) {
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
// ETA
// ============================================================
//
// First preference:
// RailRadar's arrival time at Gudur.
//
// Second:
// Actual physical distance + speed.
//
// This prevents incorrect 388/408/453 minute values caused
// by unrelated journey distances.
//
// ============================================================

function calculateEta(
  train,
  live,
  stop,
  item,
  position,
  currentMin
) {
  // ----------------------------------------------------------
  // METHOD 1: ARRIVAL TIME AT GUDUR
  // ----------------------------------------------------------

  const arrivalTime =
    stop.actualArrival ||
    stop.expectedArrival ||
    stop.scheduledArrival ||
    stop.arrival ||
    live.expectedArrivalTime ||
    live.arrivalTime ||
    "";

  const arrivalMin =
    parseTimeToMinutes(
      arrivalTime,
      0
    );

  if (
    arrivalMin !== -1
  ) {
    const diff =
      calculateTimeDifference(
        arrivalMin,
        currentMin
      );

    if (
      diff >= 0 &&
      diff <= 720
    ) {
      return {
        etaMinutes:
          Math.round(diff),

        distanceKm:
          getDistanceToGudur(
            position
          ) !== null
            ? Number(
                getDistanceToGudur(
                  position
                ).toFixed(1)
              )
            : null,

        speedKmph:
          position
            ? Number(
                getUsableSpeed(
                  position,
                  live,
                  train
                ).toFixed(1)
              )
            : null,

        source:
          "RAILRADAR_ARRIVAL"
      };
    }
  }

  // ----------------------------------------------------------
  // METHOD 2: ACTUAL DISTANCE
  // ----------------------------------------------------------

  const actualDistance =
    getDistanceToGudur(
      position
    );

  if (
    actualDistance !== null
  ) {
    const speed =
      getUsableSpeed(
        position,
        live,
        train
      );

    const etaMinutes =
      Math.max(
        0,
        Math.round(
          (actualDistance /
            speed) *
            60
        )
      );

    return {
      etaMinutes,

      distanceKm:
        Number(
          actualDistance.toFixed(
            1
          )
        ),

      speedKmph:
        Number(
          speed.toFixed(
            1
          )
        ),

      source:
        "ACTUAL_DISTANCE"
    };
  }

  return null;
}

// ============================================================
// UPCOMING FILTER
// ============================================================

function shouldShowUpcoming(
  processed
) {
  if (!processed) {
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
    processed.direction !==
    "TOWARD_GUDUR"
  ) {
    return false;
  }

  if (
    processed.etaMinutes ===
      null ||
    processed.etaMinutes ===
      undefined
  ) {
    return false;
  }

  if (
    processed.etaMinutes < 0
  ) {
    return false;
  }

  if (
    processed.etaMinutes >
    UPCOMING_MAX_ETA_MINUTES
  ) {
    return false;
  }

  if (
    processed.distanceKm !==
      null &&
    processed.distanceKm >
      UPCOMING_MAX_DISTANCE_KM
  ) {
    return false;
  }

  return true;
}

// ============================================================
// UPCOMING OBJECT
// ============================================================

function makeUpcomingTrain(
  processed
) {
  return {
    trainNo:
      processed.trainNo,

    name:
      processed.trainName,

    origin:
      processed.origin ||
      "Southern side",

    destination:
      processed.destination ||
      "Gudur",

    etaMinutes:
      processed.etaMinutes,

    distanceKm:
      processed.distanceKm,

    speedKmph:
      processed.speedKmph,

    delayMinutes:
      processed.delayMinutes,

    corridor:
      processed.corridor,

    direction:
      "TOWARD GUDUR",

    platform:
      processed.platform ||
      "—",

    etaSource:
      processed.etaSource,

    positionSource:
      processed.positionSource ||
      "UNKNOWN"
  };
}

// ============================================================
// LIVE TRAIN API
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const endpoints = [
    `/trains/${trainNo}/live`,
    `/trains/${trainNo}`,
    `/train/${trainNo}/live`
  ];

  let lastError =
    null;

  for (
    const endpoint of
      endpoints
  ) {
    try {
      console.log(
        `   Live request: ${endpoint}`
      );

      const response =
        await axios.get(
          `${RAILRADAR_BASE_URL}${endpoint}`,
          {
            params: {
              authoritative:
                true,

              includeCoordinates:
                true
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
      `Could not fetch live train ${trainNo}`
    )
  );
}

// ============================================================
// MERGE DATA
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

  const boardLive =
    boardItem?.live ||
    {};

  const boardStop =
    boardItem?.stop ||
    {};

  const train =
    liveData.train ||
    boardTrain ||
    {};

  const live =
    liveData.live ||
    boardLive ||
    {};

  const stop =
    liveData.stop ||
    boardStop ||
    {};

  return {
    train,
    live,
    stop,

    currentLocation:
      liveData.currentLocation ||
      train.currentLocation ||
      live.currentLocation ||
      null,

    previousHalt:
      liveData.previousHalt ||
      null,

    nextHalt:
      liveData.nextHalt ||
      null,

    route:
      Array.isArray(
        liveData.route
      )
        ? liveData.route
        : Array.isArray(
            train.route
          )
          ? train.route
          : [],

    delayMinutes:
      Number(
        liveData.delayMinutes ??
          live.delayMinutes ??
          0
      ),

    isLive:
      liveData.isLive ??
      live.isLive ??
      false,

    status:
      liveData.status ||
      live.status ||
      train.status ||
      "",

    lastUpdatedAt:
      liveData.lastUpdatedAt ||
      null
  };
}

// ============================================================
// UPDATE SYSTEM
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
      `\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY environment variable is missing."
      );
    }

    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours:
              STATION_BOARD_HOURS
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

    const trainsArray =
      Array.isArray(
        boardRes.data?.data
          ?.trains
      )
        ? boardRes.data.data.trains
        : [];

    console.log(
      `✅ RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let masGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        null,

      corridor:
        "MAS"
    };

    let tptyGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        null,

      corridor:
        "TPTY"
    };

    const upcomingList =
      [];

    const verifiedTrains =
      [];

    let apiRequests = 1;

    // ========================================================
    // PROCESS ALL BOARD TRAINS
    // ========================================================
    //
    // We no longer ignore trains after #7.
    //
    // ========================================================

    for (
      let i = 0;
      i <
        trainsArray.length;
      i++
    ) {
      const item =
        trainsArray[i] ||
        {};

      const boardTrain =
        item.train ||
        {};

      const boardLive =
        item.live ||
        {};

      const boardStop =
        item.stop ||
        {};

      const trainNo =
        String(
          boardTrain.number ||
            item.trainNumber ||
            item.number ||
            ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        boardTrain.name ||
        item.trainName ||
        `Express ${trainNo}`;

      const origin =
        getOrigin(
          boardTrain,
          item
        );

      const destination =
        getDestination(
          boardTrain,
          item
        );

      const boardDelay =
        Number(
          boardLive.delayMinutes ||
            item.delayMinutes ||
            0
        );

      // ------------------------------------------------------
      // TRY TO GET USEFUL BOARD ETA
      // ------------------------------------------------------

      const boardArrival =
        boardStop.arrival ||
        boardStop.expectedArrival ||
        boardStop.scheduledArrival ||
        boardLive.expectedArrivalTime ||
        item.expectedArrivalTime ||
        "";

      const boardArrivalMin =
        parseTimeToMinutes(
          boardArrival,
          0
        );

      let boardEta =
        null;

      if (
        boardArrivalMin !== -1
      ) {
        const diff =
          calculateTimeDifference(
            boardArrivalMin,
            currentMin
          );

        if (
          diff >= 0 &&
          diff <= 720
        ) {
          boardEta =
            Math.round(diff);
        }
      }

      // ------------------------------------------------------
      // BOARD CORRIDOR
      // ------------------------------------------------------

      const boardCorridor =
        determinePhysicalCorridor(
          boardTrain,
          boardLive,
          item
        );

      // ------------------------------------------------------
      // BOARD DIRECTION
      // ------------------------------------------------------

      const boardDirection =
        getRouteDirection(
          boardTrain,
          boardLive,
          item
        );

      // ------------------------------------------------------
      // LOG EVERY BOARD TRAIN
      // ------------------------------------------------------

      console.log(
        `[BOARD ${i + 1}/${trainsArray.length}] ${trainNo} ${trainName} | ${boardCorridor || "UNKNOWN"} | ${boardDirection} | ETA ${boardEta ?? "?"}m`
      );

      // ------------------------------------------------------
      // LIVE VERIFICATION
      // ------------------------------------------------------
      //
      // Verify trains that are:
      //
      // 1. likely upcoming
      // 2. relevant corridor
      // 3. potentially near gate
      //
      // We can still verify a limited number to control
      // API usage.
      //
      // ------------------------------------------------------

      const shouldVerify =
        verifiedTrains.length <
          MAX_LIVE_VERIFICATIONS &&
        (
          boardCorridor === "MAS" ||
          boardCorridor === "TPTY"
        );

      if (
        shouldVerify
      ) {
        try {
          const liveResponse =
            await fetchLiveTrain(
              trainNo
            );

          apiRequests++;

          const verifiedData =
            mergeVerifiedData(
              item,
              liveResponse
            );

          verifiedTrains.push({
            item,
            data:
              verifiedData
          });

        } catch (error) {
          apiRequests++;

          console.error(
            `   ⚠️ Live verification failed for ${trainNo}: ${error.message}`
          );
        }
      }

      // ------------------------------------------------------
      // IMPORTANT:
      //
      // If board data itself says this is a relevant inbound
      // train and ETA is available, add it now.
      //
      // This means upcoming trains are NOT dependent on
      // successful live verification.
      //
      // ------------------------------------------------------

      if (
        (
          boardCorridor === "MAS" ||
          boardCorridor === "TPTY"
        ) &&
        boardDirection ===
          "TOWARD_GUDUR" &&
        boardEta !== null &&
        boardEta <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        upcomingList.push({
          trainNo,

          name:
            trainName,

          origin:
            origin ||
            "Southern side",

          destination:
            destination ||
            "Gudur",

          etaMinutes:
            boardEta,

          distanceKm:
            null,

          speedKmph:
            null,

          delayMinutes:
            boardDelay,

          corridor:
            boardCorridor,

          direction:
            "TOWARD_GUDUR",

          platform:
            boardLive.platform ||
            boardStop.platform ||
            item.platform ||
            "—",

          etaSource:
            "STATION_BOARD",

          positionSource:
            "BOARD"
        });

        console.log(
          `   ➜ [BOARD UPCOMING] ${trainNo} | ${boardCorridor} | ETA ${boardEta}m`
        );
      }
    }

    // ========================================================
    // PROCESS VERIFIED TRAINS
    // ========================================================

    for (
      const verified of
        verifiedTrains
    ) {
      const item =
        verified.item;

      const data =
        verified.data;

      const train =
        data.train ||
        {};

      const live =
        data.live ||
        {};

      const stop =
        data.stop ||
        {};

      const trainNo =
        String(
          train.number ||
            item.train?.number ||
            item.trainNumber ||
            ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train.name ||
        item.train?.name ||
        `Express ${trainNo}`;

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

      const delayMin =
        Number(
          data.delayMinutes ||
            live.delayMinutes ||
            0
        );

      // ------------------------------------------------------
      // ACTUAL POSITION
      // ------------------------------------------------------

      const position =
        getActualPosition(
          train,
          live,
          item
        );

      const positionSource =
        position?.source ||
        "NONE";

      // ------------------------------------------------------
      // CORRIDOR
      // ------------------------------------------------------

      const corridor =
        determinePhysicalCorridor(
          train,
          live,
          item
        );

      // ------------------------------------------------------
      // DIRECTION
      // ------------------------------------------------------

      const direction =
        getRouteDirection(
          train,
          live,
          item
        );

      // ------------------------------------------------------
      // GATE DISTANCE
      // ------------------------------------------------------

      const gateDistances =
        getGateDistances(
          position
        );

      // ------------------------------------------------------
      // GATE DECISION
      // ------------------------------------------------------

      const gateDecision =
        shouldCloseGate(
          corridor,
          position,
          gateDistances
        );

      // ------------------------------------------------------
      // ETA
      // ------------------------------------------------------

      const eta =
        calculateEta(
          train,
          live,
          stop,
          item,
          position,
          currentMin
        );

      // ------------------------------------------------------
      // GATE CLOSURE
      // ------------------------------------------------------

      if (
        gateDecision.close
      ) {
        const speed =
          getUsableSpeed(
            position,
            live,
            train
          );

        const travelMinutes =
          (
            gateDecision.distanceKm /
            speed
          ) *
          60;

        const waitTime =
          Math.max(
            1,
            Math.min(
              15,
              Math.round(
                travelMinutes
              ) + 2
            )
          );

        const statusText =
          delayMin > 0
            ? `${delayMin}m late`
            : "On Time";

        const label =
          `${trainNo} ${trainName} (${statusText})`;

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
            positionSource
        };

        if (
          corridor ===
          "MAS"
        ) {
          masGate =
            payload;

          console.log(
            `🚨 CHENNAI GATE CLOSED | ${label} | ${gateDecision.distanceKm.toFixed(3)} km | ${direction}`
          );
        }

        if (
          corridor ===
          "TPTY"
        ) {
          tptyGate =
            payload;

          console.log(
            `🚨 TIRUPATI GATE CLOSED | ${label} | ${gateDecision.distanceKm.toFixed(3)} km | ${direction}`
          );
        }
      }

      // ------------------------------------------------------
      // VERIFIED UPCOMING
      // ------------------------------------------------------

      if (
        direction ===
          "TOWARD_GUDUR" &&
        (
          corridor ===
            "MAS" ||
          corridor ===
            "TPTY"
        ) &&
        eta
      ) {
        const verifiedUpcoming = {
          trainNo,

          name:
            trainName,

          origin:
            origin ||
            "Southern side",

          destination:
            destination ||
            "Gudur",

          etaMinutes:
            eta.etaMinutes,

          distanceKm:
            eta.distanceKm,

          speedKmph:
            eta.speedKmph,

          delayMinutes:
            delayMin,

          corridor,

          direction:
            "TOWARD_GUDUR",

          platform:
            live.platform ||
            stop.platform ||
            train.platform ||
            item.platform ||
            "—",

          etaSource:
            eta.source,

          positionSource
        };

        if (
          shouldShowUpcoming(
            verifiedUpcoming
          )
        ) {
          upcomingList.push(
            verifiedUpcoming
          );

          console.log(
            `   ➜ [LIVE UPCOMING] ${trainNo} ${trainName} | ${corridor} | ${eta.etaMinutes}m | ${eta.distanceKm ?? "?"} km`
          );
        }
      }
    }

    // ========================================================
    // REMOVE DUPLICATES
    // ========================================================

    const uniqueMap =
      new Map();

    for (
      const train of
        upcomingList
    ) {
      const key =
        train.trainNo;

      // Prefer live data over board data.
      if (
        !uniqueMap.has(key) ||
        train.etaSource !==
          "STATION_BOARD"
      ) {
        uniqueMap.set(
          key,
          train
        );
      }
    }

    const uniqueUpcoming =
      Array.from(
        uniqueMap.values()
      );

    // ========================================================
    // FINAL UPCOMING FILTER
    // ========================================================

    const safeUpcoming =
      uniqueUpcoming
        .filter(
          (train) =>
            train.corridor ===
              "MAS" ||
            train.corridor ===
              "TPTY"
        )
        .filter(
          (train) =>
            train.direction ===
            "TOWARD_GUDUR"
        )
        .filter(
          (train) =>
            Number(
              train.etaMinutes
            ) <=
            UPCOMING_MAX_ETA_MINUTES
        )
        .filter(
          (train) =>
            train.distanceKm ===
              null ||
            train.distanceKm ===
              undefined ||
            Number(
              train.distanceKm
            ) <=
              UPCOMING_MAX_DISTANCE_KM
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
          5
        );

    // ========================================================
    // DURATION
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        cycleStart
      ) /
      1000;

    // ========================================================
    // FIREBASE
    // ========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        safeUpcoming,

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
    // LOG
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "       SYNC SUCCESS"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Chennai Gate : ${masGate.status}`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status}`
    );

    console.log(
      `Upcoming     : ${safeUpcoming.length}`
    );

    console.log(
      `Verified     : ${verifiedTrains.length}`
    );

    console.log(
      `API Requests : ${apiRequests}`
    );

    console.log(
      `Duration     : ${durationSeconds.toFixed(1)} sec`
    );

    console.log(
      "=========================================="
    );

    if (
      safeUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      safeUpcoming.forEach(
        (train) => {
          console.log(
            ` ${train.corridor} | ${train.trainNo} ${train.name} | ETA ${train.etaMinutes}m | ${train.etaSource}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    return true;

  } catch (error) {
    // ========================================================
    // ERROR
    // ========================================================

    console.error(
      "\n=========================================="
    );

    console.error(
      "       MONITOR ERROR"
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

    // ========================================================
    // FAIL SAFE
    // ========================================================

    try {
      await gateRef.set({
        tirupatiGate: {
          status:
            "OPEN",

          waitMinutes:
            0,

          activeTrain:
            "Monitor error",

          corridor:
            "TPTY"
        },

        chennaiGate: {
          status:
            "OPEN",

          waitMinutes:
            0,

          activeTrain:
            "Monitor error",

          corridor:
            "MAS"
        },

        upcomingTrains:
          [],

        lastUpdated:
          new Date().toLocaleTimeString(),

        lastUpdatedAt:
          new Date().toISOString(),

        lastUpdatedAtMs:
          Date.now(),

        verifiedTrains:
          0,

        apiRequests:
          0,

        monitorStatus:
          "ERROR",

        error:
          error.message
      });
    } catch (
      firebaseError
    ) {
      console.error(
        "❌ Firebase error:",
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
  "RailRadar: Configured"
);

console.log(
  "Gate closure: ACTUAL POSITION ONLY"
);

console.log(
  "Gate direction: BOTH DIRECTIONS"
);

console.log(
  `Upcoming max distance: ${UPCOMING_MAX_DISTANCE_KM} km`
);

console.log(
  `Upcoming max ETA: ${UPCOMING_MAX_ETA_MINUTES} minutes`
);

console.log(
  `Live verification limit: ${MAX_LIVE_VERIFICATIONS}`
);

console.log(
  "=========================================="
);

// ============================================================
// GITHUB ACTIONS
// ============================================================

if (
  process.env.GITHUB_ACTIONS
) {
  updateGateSystem()
    .then(
      (success) => {
        console.log(
          "\n=========================================="
        );

        console.log(
          " GitHub Actions monitor cycle completed "
        );

        console.log(
          "=========================================="
        );

        process.exit(
          success ? 0 : 1
        );
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
