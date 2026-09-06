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

  console.error(error.message);

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
// GUDUR / GATE COORDINATES
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SETTINGS
// ============================================================

// Upcoming trains can be at most 150 km away.
const UPCOMING_MAX_DISTANCE_KM = 150;

// IMPORTANT:
// Never show an upcoming train more than 3 hours away.
const UPCOMING_MAX_ETA_MINUTES = 180;

// Gate physically closes only when train is within
// this distance of the corresponding crossing.
const GATE_STOP_DISTANCE_KM = 0.60;

// GitHub Actions cannot run faster than every 5 minutes.
const REFRESH_INTERVAL_MS = 60000;

// Default speed if RailRadar does not provide a usable speed.
const DEFAULT_SPEED_KMPH = 55;

// Never allow a calculated speed below this.
const MIN_SPEED_KMPH = 5;

// Station board request.
const STATION_BOARD_HOURS = 4;

// Maximum trains from station board that we will verify.
const MAX_BOARD_CANDIDATES = 22;

// Maximum live train API calls per cycle.
const MAX_LIVE_VERIFICATIONS = 7;

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

  return values.some((value) =>
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

// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function haversineKm(
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
    ((bLat - aLat) *
      Math.PI) /
    180;

  const dLng =
    ((bLng - aLng) *
      Math.PI) /
    180;

  const lat1Rad =
    (aLat * Math.PI) /
    180;

  const lat2Rad =
    (bLat * Math.PI) /
    180;

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
// GET ORIGIN
// ============================================================

function getOrigin(train, item) {
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
// GET DESTINATION
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
// ROUTE HELPERS
// ============================================================

function getRoute(train, live, item) {
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
// ROUTE STATION CODE
// ============================================================

function getStationCode(stop) {
  return normalizeText(
    stop?.stationCode ||
      stop?.code ||
      stop?.station ||
      ""
  ).replace(/ /g, "");
}

// ============================================================
// FIND GUDUR SEQUENCE
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

  for (const stop of route) {
    const code =
      getStationCode(stop);

    if (
      code === "GDR"
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

  const sequence =
    toNumber(
      current.sequence
    );

  return sequence;
}

// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// This is used to determine which physical corridor
// the train belongs to.
//
// It is NOT used to reject a train from gate closure.
//
// Both directions must close the corresponding gate.
//
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

  const currentStatus =
    normalizeText(
      current.status
    );

  if (
    currentStatus.includes(
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

  return "UNKNOWN";
}

// ============================================================
// DETERMINE CORRIDOR FROM ROUTE
// ============================================================
//
// MAS corridor:
// Chennai side <-> Gudur
//
// TPTY corridor:
// Tirupati side <-> Gudur
//
// We look at stations BEFORE Gudur in the actual route.
// This is more reliable than using only train origin.
//
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

  for (const stop of route) {
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
  // KNOWN TIRUPATI TRAIN FALLBACK
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
// EXTRACT ACTUAL GPS POSITION
// ============================================================
//
// ONLY actual position is allowed for physical gate closure.
//
// Route interpolation is deliberately NOT used here.
//
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

  const bearing =
    toNumber(
      current.bearingDegrees ??
        current.bearing
    );

  return {
    lat,
    lng,
    speedKmph:
      speed !== null
        ? speed
        : null,
    bearing:
      bearing !== null
        ? bearing
        : null,
    source:
      current.positionSource ||
      "GPS",
    isActualPosition: true
  };
}

// ============================================================
// EXTRACT ACTUAL STATION POSITION
// ============================================================
//
// RailRadar can return station-code based actual position.
// When includeCoordinates=true, route stops contain coordinates.
//
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

  // First match by sequence.
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

  // Then match by station code.
  if (
    !matched &&
    currentCode
  ) {
    matched =
      route.find(
        (stop) =>
          getStationCode(
            stop
          ) === currentCode
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
    bearing: null,
    source:
      "STATION_CODE",
    stationCode:
      currentCode,
    stationName:
      current.stationName ||
      matched.stationName ||
      matched.name ||
      "",
    isActualPosition: true
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
// GET ACTUAL DISTANCE TO GATE
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
// GATE CLOSURE DECISION
// ============================================================
//
// IMPORTANT:
//
// Chennai gate closes for:
// Chennai -> Gudur
// Gudur -> Chennai
//
// Tirupati gate closes for:
// Tirupati -> Gudur
// Gudur -> Tirupati
//
// Direction is NOT used to reject closure.
//
// Actual physical position is mandatory.
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

  // ----------------------------------------------------------
  // ISO DATE / DATETIME
  // ----------------------------------------------------------

  const date =
    new Date(text);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    return (
      date.getHours() * 60 +
      date.getMinutes() +
      Number(
        delayMinutes || 0
      )
    );
  }

  // ----------------------------------------------------------
  // HH:MM
  // ----------------------------------------------------------

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
// GET SPEED
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

  for (const value of candidates) {
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
// ACTUAL DISTANCE TO GUDUR
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
// ETA CALCULATION
// ============================================================
//
// Priority:
//
// 1. Actual physical distance to Gudur + actual speed
// 2. Route arrival time
// 3. No ETA
//
// This prevents huge incorrect ETA values caused by
// total journey distance or origin distance.
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
  // METHOD 1: ACTUAL GPS DISTANCE
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

    const etaHours =
      actualDistance /
      speed;

    const etaMinutes =
      Math.max(
        0,
        Math.round(
          etaHours * 60
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

  // ----------------------------------------------------------
  // METHOD 2: ROUTE ARRIVAL TIME
  // ----------------------------------------------------------

  const arrivalTime =
    stop?.actualArrival ||
    stop?.expectedArrival ||
    stop?.arrival ||
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
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
      diff >= 0
    ) {
      return {
        etaMinutes:
          Math.round(diff),
        distanceKm:
          null,
        speedKmph:
          null,
        source:
          "ARRIVAL_TIME"
      };
    }
  }

  return null;
}

// ============================================================
// UPCOMING TRAIN FILTER
// ============================================================
//
// Upcoming trains MUST:
//
// - Be MAS/TPTY
// - Be TOWARD Gudur
// - Have actual/valid ETA
// - Be <= 150 km
// - Be <= 180 minutes
//
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
// FIREBASE TRAIN OBJECT
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

  for (const endpoint of endpoints) {
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
// MERGE LIVE RESPONSE
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
      `\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // ----------------------------------------------------------
    // CHECK API KEY
    // ----------------------------------------------------------

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY environment variable is missing."
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

    let trainsArray =
      boardRes.data?.data
        ?.trains || [];

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      trainsArray = [];
    }

    console.log(
      `✅ RailRadar returned ${trainsArray.length} trains.`
    );

    // ----------------------------------------------------------
    // LIMIT BOARD CANDIDATES
    // ----------------------------------------------------------

    trainsArray =
      trainsArray.slice(
        0,
        MAX_BOARD_CANDIDATES
      );

    // ----------------------------------------------------------
    // DEFAULT GATES
    // ----------------------------------------------------------

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

    // ----------------------------------------------------------
    // UPCOMING LIST
    // ----------------------------------------------------------

    const upcomingList =
      [];

    // ----------------------------------------------------------
    // VERIFIED TRAINS
    // ----------------------------------------------------------

    const verifiedTrains =
      [];

    let apiRequests = 1;

    // ----------------------------------------------------------
    // PROCESS BOARD
    // ----------------------------------------------------------

    for (
      let i = 0;
      i <
        trainsArray.length;
      i++
    ) {
      if (
        verifiedTrains.length >=
        MAX_LIVE_VERIFICATIONS
      ) {
        break;
      }

      const item =
        trainsArray[i] ||
        {};

      const boardTrain =
        item.train ||
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

      try {
        const liveResponse =
          await fetchLiveTrain(
            trainNo
          );

        apiRequests++;

        const processedData =
          mergeVerifiedData(
            item,
            liveResponse
          );

        verifiedTrains.push(
          {
            item,
            data:
              processedData
          }
        );

      } catch (error) {
        console.error(
          `   ⚠️ Live verification failed for ${trainNo}: ${error.message}`
        );

        // Do not count failed alternative
        // endpoints separately here.
        apiRequests++;
      }
    }

    console.log(
      `✅ Verified ${verifiedTrains.length} trains.`
    );

    // ==========================================================
    // PROCESS VERIFIED TRAINS
    // ==========================================================

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

      // --------------------------------------------------------
      // CURRENT POSITION
      // --------------------------------------------------------

      const position =
        getActualPosition(
          train,
          live,
          item
        );

      const positionSource =
        position?.source ||
        "NONE";

      // --------------------------------------------------------
      // CORRIDOR
      // --------------------------------------------------------

      const corridor =
        determinePhysicalCorridor(
          train,
          live,
          item
        );

      // --------------------------------------------------------
      // DIRECTION
      // --------------------------------------------------------

      const direction =
        getRouteDirection(
          train,
          live,
          item
        );

      // --------------------------------------------------------
      // GATE DISTANCES
      // --------------------------------------------------------

      const gateDistances =
        getGateDistances(
          position
        );

      // --------------------------------------------------------
      // GATE CLOSURE
      // --------------------------------------------------------

      const gateDecision =
        shouldCloseGate(
          corridor,
          position,
          gateDistances
        );

      // --------------------------------------------------------
      // ARRIVAL / DEPARTURE
      // --------------------------------------------------------

      const arrTimeStr =
        stop.actualArrival ||
        stop.expectedArrival ||
        stop.arrival ||
        live.expectedArrivalTime ||
        "";

      const depTimeStr =
        stop.actualDeparture ||
        stop.expectedDeparture ||
        stop.departure ||
        live.expectedDepartureTime ||
        "";

      const arrMin =
        parseTimeToMinutes(
          arrTimeStr,
          0
        );

      const depMin =
        parseTimeToMinutes(
          depTimeStr,
          0
        );

      // --------------------------------------------------------
      // ETA
      // --------------------------------------------------------

      const eta =
        calculateEta(
          train,
          live,
          stop,
          item,
          position,
          currentMin
        );

      let etaMinutes =
        eta?.etaMinutes ??
        null;

      // --------------------------------------------------------
      // NEVER ALLOW INVALID NEGATIVE ETA
      // --------------------------------------------------------

      if (
        etaMinutes !== null &&
        etaMinutes < 0
      ) {
        etaMinutes = 0;
      }

      // --------------------------------------------------------
      // AT GUDUR / PAST GUDUR
      // --------------------------------------------------------

      const routeDirection =
        direction;

      const isAtGudur =
        routeDirection ===
        "AT_GUDUR";

      const isPastGudur =
        routeDirection ===
        "AWAY_FROM_GUDUR";

      // --------------------------------------------------------
      // UPCOMING
      // --------------------------------------------------------

      const processed = {
        trainNo,

        trainName,

        origin,

        destination,

        corridor,

        direction:
          routeDirection,

        etaMinutes,

        distanceKm:
          eta?.distanceKm ??
          null,

        speedKmph:
          eta?.speedKmph ??
          null,

        etaSource:
          eta?.source ||
          "NONE",

        positionSource,

        delayMinutes:
          delayMin,

        platform:
          live.platform ||
          stop.platform ||
          train.platform ||
          item.platform ||
          "—"
      };

      if (
        !isAtGudur &&
        !isPastGudur &&
        shouldShowUpcoming(
          processed
        )
      ) {
        upcomingList.push(
          makeUpcomingTrain(
            processed
          )
        );

        console.log(
          `[UPCOMING ${corridor}] ${trainNo} ${trainName} | ${origin || "Unknown"} -> ${destination || "Gudur"} | ${etaMinutes}m | ${eta?.distanceKm ?? "?"} km`
        );
      }

      // --------------------------------------------------------
      // GATE CLOSURE
      // --------------------------------------------------------
      //
      // IMPORTANT:
      //
      // Direction does NOT matter here.
      //
      // Physical distance decides closure.
      //
      // --------------------------------------------------------

      if (
        gateDecision.close
      ) {
        const gateWait =
          Math.max(
            1,
            Math.min(
              15,
              Math.round(
                (gateDecision.distanceKm /
                  Math.max(
                    getUsableSpeed(
                      position,
                      live,
                      train
                    ),
                    MIN_SPEED_KMPH
                  )) *
                  60
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
            gateWait,

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
            `🚨 CHENNAI GATE CLOSED | ${label} | ${gateDecision.distanceKm.toFixed(3)} km`
          );
        }

        if (
          corridor ===
          "TPTY"
        ) {
          tptyGate =
            payload;

          console.log(
            `🚨 TIRUPATI GATE CLOSED | ${label} | ${gateDecision.distanceKm.toFixed(3)} km`
          );
        }
      }
    }

    // ==========================================================
    // SORT UPCOMING
    // ==========================================================

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ==========================================================
    // MAX 5 UPCOMING TRAINS
    // ==========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ==========================================================
    // EXTRA SAFETY:
    // REMOVE ANYTHING ABOVE 180 MINUTES
    // ==========================================================

    const safeUpcoming =
      topUpcoming.filter(
        (train) =>
          Number(
            train.etaMinutes
          ) <=
          UPCOMING_MAX_ETA_MINUTES
      );

    // ==========================================================
    // DURATION
    // ==========================================================

    const durationSeconds =
      (
        Date.now() -
        cycleStart
      ) /
      1000;

    // ==========================================================
    // FIREBASE WRITE
    // ==========================================================

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

    // ==========================================================
    // SUCCESS LOG
    // ==========================================================

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
            ` ${train.corridor} | ${train.trainNo} ${train.name} | ${train.distanceKm ?? "?"} km | ETA ${train.etaMinutes}m`
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
    // ERROR HANDLING
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

    // ----------------------------------------------------------
    // ALWAYS FAIL SAFE:
    // OPEN GATES
    // ----------------------------------------------------------

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
// START APPLICATION
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

  // ----------------------------------------------------------
  // LOCAL MODE
  // ----------------------------------------------------------

  updateGateSystem();

  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}
