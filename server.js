"use strict";

const axios = require("axios");

const {
  initializeApp,
  cert
} = require("firebase-admin/app");

const {
  getDatabase
} = require("firebase-admin/database");

const serviceAccount =
  require("./serviceAccountKey.json");

// ============================================================
// FIREBASE
// ============================================================

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL:
    "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db = getDatabase(firebaseApp);
const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  "rg_2f55dc07e2ff444a90d8c2c9dc2fdd95";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

const api = axios.create({
  baseURL: RAILRADAR_BASE_URL,
  timeout: 15000,
  headers: {
    Authorization:
      `Bearer ${RAILRADAR_API_KEY}`,
    "x-api-key":
      RAILRADAR_API_KEY,
    Accept: "application/json",
    "User-Agent":
      "Gudur-Gate-Tracker/2.0"
  }
});

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;
const GATE_STOP_DISTANCE_KM = 5;

const MAX_GPS_AGE_MINUTES = 10;
const MAX_ETA_MINUTES = 600;
const MAX_UPCOMING_TRAINS = 30;

// RailRadar limit is 10/min.
// Keep a safety margin.
const MAX_REQUESTS_PER_CYCLE = 8;

// Check every 60 seconds.
// The first update happens immediately.
const REFRESH_INTERVAL_MS = 60 * 1000;

// ============================================================
// LOCATIONS
// ============================================================

const CHENNAI_GATE = {
  name: "Chennai Gate",
  code: "MAS",
  lat: 14.13968,
  lng: 79.84419
};

const TIRUPATI_GATE = {
  name: "Tirupati Gate",
  code: "TPTY",
  lat: 14.14024,
  lng: 79.84361
};

const GUDUR = {
  name: "Gudur Junction",
  code: "GDR",
  lat: 14.1484,
  lng: 79.8452
};

// ============================================================
// REQUEST COUNTER
// ============================================================

let requestsThisCycle = 0;

function resetRequestCounter() {
  requestsThisCycle = 0;
}

function canRequest() {
  return (
    requestsThisCycle <
    MAX_REQUESTS_PER_CYCLE
  );
}

// ============================================================
// BASIC HELPERS
// ============================================================

function toNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function clean(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

function normalizeNumber(value) {
  const digits =
    clean(value).replace(/\D/g, "");

  return digits
    ? digits.padStart(5, "0")
    : "";
}

function normalizeText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ============================================================
// HAVERSINE
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  if (
    lat1 === null ||
    lon1 === null ||
    lat2 === null ||
    lon2 === null
  ) {
    return null;
  }

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
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

// ============================================================
// API
// ============================================================

async function apiGet(
  endpoint,
  params = {}
) {
  if (!canRequest()) {
    return null;
  }

  requestsThisCycle++;

  try {
    console.log(
      `📡 API ${requestsThisCycle}/${MAX_REQUESTS_PER_CYCLE} ${endpoint}`
    );

    const response =
      await api.get(
        endpoint,
        { params }
      );

    return response.data;

  } catch (error) {
    const status =
      error.response?.status;

    if (status === 429) {
      console.log(
        "⚠️ RailRadar 429 rate limit."
      );
    } else {
      console.log(
        `⚠️ API error ${endpoint}`
      );

      console.log(
        error.response?.data ||
        error.message
      );
    }

    return null;
  }
}

// ============================================================
// LIVE GUDUR BOARD
// ============================================================

async function getGudurBoard() {
  return await apiGet(
    "/stations/GDR/live",
    {
      hours: 8,
      includeIntermediate: true
    }
  );
}

// ============================================================
// EXTRACT TRAIN ARRAY
// ============================================================

function extractTrains(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  const candidates = [
    data.trains,
    data.data,
    data.results,
    data.liveTrains,
    data.station?.trains,
    data.station?.liveTrains
  ];

  for (
    const value of candidates
  ) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

// ============================================================
// TRAIN INFO
// ============================================================

function getTrainInfo(item) {
  if (!item) {
    return null;
  }

  const train =
    item.train || item;

  const number =
    normalizeNumber(
      train.number ??
      item.number ??
      item.trainNumber
    );

  if (!number) {
    return null;
  }

  return {
    number,

    name:
      clean(
        train.name ??
        item.name ??
        item.trainName
      ),

    source:
      clean(
        train.source ??
        item.source
      ),

    destination:
      clean(
        train.destination ??
        item.destination
      ),

    raw: item
  };
}

// ============================================================
// COORDINATE EXTRACTION
// ============================================================

function extractCoordinates(data) {
  if (!data) {
    return null;
  }

  const objects = [
    data.currentLocation,
    data.live?.currentLocation,
    data.train?.currentLocation,
    data.location,
    data.live?.location,
    data.position,
    data.live?.position,
    data.currentPosition,
    data.train?.currentPosition
  ];

  for (
    const obj of objects
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
      lng !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return {
        lat,
        lng
      };
    }
  }

  return null;
}

// ============================================================
// GPS TIMESTAMP
// ============================================================

function extractTimestamp(data) {
  if (!data) {
    return null;
  }

  const values = [
    data.currentLocation?.timestamp,
    data.currentLocation?.updatedAt,
    data.currentLocation?.lastUpdated,

    data.live?.currentLocation?.timestamp,
    data.live?.currentLocation?.updatedAt,
    data.live?.currentLocation?.lastUpdated,

    data.live?.timestamp,
    data.live?.updatedAt,
    data.live?.lastUpdated,

    data.timestamp,
    data.updatedAt,
    data.lastUpdated
  ];

  for (
    const value of values
  ) {
    if (!value) {
      continue;
    }

    const parsed =
      new Date(value).getTime();

    if (Number.isFinite(parsed)) {
      return parsed;
    }

    const n =
      Number(value);

    if (Number.isFinite(n)) {
      return n < 100000000000
        ? n * 1000
        : n;
    }
  }

  return null;
}

// ============================================================
// SPEED
// ============================================================

function extractSpeed(data) {
  if (!data) {
    return null;
  }

  const values = [
    data.currentLocation?.speedKmh,
    data.currentLocation?.speed,
    data.live?.currentLocation?.speedKmh,
    data.live?.currentLocation?.speed,
    data.live?.speedKmh,
    data.live?.speed,
    data.speedKmh,
    data.speed
  ];

  for (
    const value of values
  ) {
    const speed =
      toNumber(value);

    if (
      speed !== null &&
      speed >= 0 &&
      speed <= 300
    ) {
      return speed;
    }
  }

  return null;
}

// ============================================================
// ETA
// ============================================================

function extractEta(data) {
  if (!data) {
    return null;
  }

  const values = [
    data.live?.expectedArrivalTime,
    data.live?.etaMinutes,
    data.live?.eta,
    data.expectedArrivalTime,
    data.etaMinutes,
    data.eta
  ];

  for (
    const value of values
  ) {
    if (
      value === null ||
      value === undefined
    ) {
      continue;
    }

    const n =
      toNumber(value);

    if (
      n !== null &&
      n >= 0 &&
      n <= MAX_ETA_MINUTES
    ) {
      return n;
    }

    const text =
      clean(value);

    const match =
      text.match(
        /(\d+(?:\.\d+)?)\s*(?:m|min|minute|minutes)/i
      );

    if (match) {
      const minutes =
        Number(match[1]);

      if (
        Number.isFinite(minutes)
      ) {
        return minutes;
      }
    }

    const time =
      new Date(value).getTime();

    if (Number.isFinite(time)) {
      const minutes =
        (time - Date.now()) /
        60000;

      if (
        minutes >= 0 &&
        minutes <= MAX_ETA_MINUTES
      ) {
        return minutes;
      }
    }
  }

  return null;
}

// ============================================================
// GUDUR ROUTE DETECTION
// ============================================================
//
// This is the important part.
//
// We are NOT requiring Gudur to be the destination.
//
// A train is useful if its actual route contains GDR.
//
// We examine route/stop information returned by the live
// response when available.
//
// ============================================================

function getStopCode(stop) {
  if (!stop) {
    return "";
  }

  return normalizeText(
    stop.code ??
    stop.stationCode ??
    stop.station?.code ??
    stop.station?.stationCode
  );
}

function getStopName(stop) {
  if (!stop) {
    return "";
  }

  return normalizeText(
    stop.name ??
    stop.stationName ??
    stop.station?.name
  );
}

function routeContainsGudur(data) {
  if (!data) {
    return false;
  }

  const arrays = [
    data.stops,
    data.route,
    data.route?.stops,
    data.train?.stops,
    data.train?.route,
    data.live?.stops,
    data.live?.route,
    data.live?.route?.stops,
    data.data?.stops,
    data.data?.route
  ];

  for (
    const arr of arrays
  ) {
    if (!Array.isArray(arr)) {
      continue;
    }

    for (
      const stop of arr
    ) {
      const code =
        getStopCode(stop);

      const name =
        getStopName(stop);

      if (
        code === "gdr" ||
        name.includes("gudur") ||
        name === "gdr"
      ) {
        return true;
      }
    }
  }

  // Sometimes the response is a GeoJSON-style route.

  if (
    data.features &&
    Array.isArray(data.features)
  ) {
    const text =
      JSON.stringify(
        data.features
      ).toLowerCase();

    if (
      text.includes("gudur") ||
      text.includes('"gdr"')
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// SIDE IDENTIFICATION
// ============================================================

const CHENNAI_TERMS = [
  "MAS",
  "CHENNAI",
  "MGRCHENNAICENTRAL",
  "CHENNAICENTRAL",
  "CHENNAIEGMORE",
  "MS",
  "TBM",
  "PER",
  "PERAMBUR",
  "MMC",
  "MOOREMARKET",
  "AVD",
  "AVADI"
];

const TIRUPATI_TERMS = [
  "TPTY",
  "TIRUPATI",
  "RU",
  "RENIGUNTA",
  "RENIGUNTajunction"
];

function matchesSide(
  value,
  terms
) {
  const text =
    normalizeText(value);

  return terms.some(
    term =>
      text.includes(
        normalizeText(term)
      )
  );
}

function identifyEndpointSide(
  train
) {
  const source =
    train.source;

  const destination =
    train.destination;

  const sourceChennai =
    matchesSide(
      source,
      CHENNAI_TERMS
    );

  const sourceTirupati =
    matchesSide(
      source,
      TIRUPATI_TERMS
    );

  const destinationChennai =
    matchesSide(
      destination,
      CHENNAI_TERMS
    );

  const destinationTirupati =
    matchesSide(
      destination,
      TIRUPATI_TERMS
    );

  if (sourceChennai) {
    return {
      sourceSide: "CHENNAI",
      destinationSide:
        destinationTirupati
          ? "TIRUPATI"
          : null
    };
  }

  if (sourceTirupati) {
    return {
      sourceSide: "TIRUPATI",
      destinationSide:
        destinationChennai
          ? "CHENNAI"
          : null
    };
  }

  if (destinationChennai) {
    return {
      sourceSide: null,
      destinationSide: "CHENNAI"
    };
  }

  if (destinationTirupati) {
    return {
      sourceSide: null,
      destinationSide: "TIRUPATI"
    };
  }

  return {
    sourceSide: null,
    destinationSide: null
  };
}

// ============================================================
// DETERMINE SIDE FROM GPS
// ============================================================
//
// This is a geometric fallback.
//
// The two gates are south of Gudur Junction.
//
// We calculate distance to both gate points and Gudur.
//
// ============================================================

function determineNearestGate(
  coords
) {
  const chennaiDistance =
    distanceKm(
      coords.lat,
      coords.lng,
      CHENNAI_GATE.lat,
      CHENNAI_GATE.lng
    );

  const tirupatiDistance =
    distanceKm(
      coords.lat,
      coords.lng,
      TIRUPATI_GATE.lat,
      TIRUPATI_GATE.lng
    );

  return {
    chennaiDistance,
    tirupatiDistance
  };
}

// ============================================================
// DIRECTION
// ============================================================

function determineDirection(
  train,
  coords
) {
  const sides =
    identifyEndpointSide(
      train
    );

  const distGudur =
    distanceKm(
      coords.lat,
      coords.lng,
      GUDUR.lat,
      GUDUR.lng
    );

  const nearest =
    determineNearestGate(
      coords
    );

  // ----------------------------------------------------------
  // If source explicitly identifies a side:
  // ----------------------------------------------------------

  if (
    sides.sourceSide ===
    "CHENNAI"
  ) {
    // Train started from Chennai side.
    //
    // If it is still south of/near Gudur, it is approaching.
    //
    if (
      distGudur !== null &&
      distGudur >
      nearest.chennaiDistance
    ) {
      return {
        direction:
          "chennai_inbound",
        gate: "chennai"
      };
    }

    return {
      direction:
        "chennai_outbound",
      gate: "chennai"
    };
  }

  if (
    sides.sourceSide ===
    "TIRUPATI"
  ) {
    if (
      distGudur !== null &&
      distGudur >
      nearest.tirupatiDistance
    ) {
      return {
        direction:
          "tirupati_inbound",
        gate: "tirupati"
      };
    }

    return {
      direction:
        "tirupati_outbound",
      gate: "tirupati"
    };
  }

  // ----------------------------------------------------------
  // If destination explicitly identifies side:
  // ----------------------------------------------------------

  if (
    sides.destinationSide ===
    "CHENNAI"
  ) {
    return {
      direction:
        "chennai_outbound",
      gate: "chennai"
    };
  }

  if (
    sides.destinationSide ===
    "TIRUPATI"
  ) {
    return {
      direction:
        "tirupati_outbound",
      gate: "tirupati"
    };
  }

  // ----------------------------------------------------------
  // Unknown endpoint.
  //
  // Do not guess a gate.
  // ----------------------------------------------------------

  return null;
}

// ============================================================
// GPS FRESHNESS
// ============================================================

function gpsIsFresh(timestamp) {
  if (!timestamp) {
    return true;
  }

  const age =
    (Date.now() - timestamp) /
    60000;

  return (
    age >= -2 &&
    age <=
      MAX_GPS_AGE_MINUTES
  );
}

// ============================================================
// PHYSICAL ETA
// ============================================================

function calculatePhysicalEta(
  distance,
  speed
) {
  if (
    distance === null ||
    distance <= 0
  ) {
    return 0;
  }

  let actualSpeed =
    speed;

  if (
    actualSpeed === null ||
    actualSpeed < 8
  ) {
    actualSpeed = 45;
  }

  actualSpeed =
    Math.min(
      actualSpeed,
      180
    );

  return Math.max(
    1,
    Math.round(
      distance /
      actualSpeed *
      60
    )
  );
}

// ============================================================
// SAFE ETA
// ============================================================

function safeEta(
  distance,
  apiEta,
  speed
) {
  const physical =
    calculatePhysicalEta(
      distance,
      speed
    );

  if (
    apiEta === null
  ) {
    return physical;
  }

  // If API ETA is wildly faster than physically possible,
  // ignore it.

  if (
    apiEta <
    Math.max(
      1,
      physical * 0.35
    )
  ) {
    return physical;
  }

  if (
    apiEta >
    Math.max(
      physical * 2.5,
      physical + 20
    )
  ) {
    return physical;
  }

  return Math.round(
    apiEta
  );
}

// ============================================================
// BUILD LIVE TRAIN
// ============================================================

function buildLiveTrain(
  train,
  live
) {
  const coords =
    extractCoordinates(
      live
    );

  if (!coords) {
    console.log(
      `⚠️ ${train.number}: no live GPS`
    );

    return null;
  }

  const timestamp =
    extractTimestamp(
      live
    );

  if (
    !gpsIsFresh(timestamp)
  ) {
    console.log(
      `⚠️ ${train.number}: stale GPS`
    );

    return null;
  }

  const direction =
    determineDirection(
      train,
      coords
    );

  if (!direction) {
    console.log(
      `⚠️ ${train.number}: cannot determine Chennai/Tirupati direction`
    );

    return null;
  }

  const gate =
    direction.gate ===
    "chennai"
      ? CHENNAI_GATE
      : TIRUPATI_GATE;

  const distance =
    distanceKm(
      coords.lat,
      coords.lng,
      gate.lat,
      gate.lng
    );

  if (
    distance === null
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // 150 KM FILTER
  // ----------------------------------------------------------

  if (
    distance >
    UPCOMING_MAX_DISTANCE_KM
  ) {
    return null;
  }

  const speed =
    extractSpeed(
      live
    );

  const apiEta =
    extractEta(
      live
    );

  const eta =
    safeEta(
      distance,
      apiEta,
      speed
    );

  const stop =
    distance <=
    GATE_STOP_DISTANCE_KM;

  const approaching =
    distance <= 30;

  let status =
    "UPCOMING";

  if (stop) {
    status = "STOP";
  } else if (approaching) {
    status = "APPROACHING";
  }

  return {
    number:
      train.number,

    name:
      train.name ||
      "Unknown Train",

    source:
      train.source,

    destination:
      train.destination,

    direction:
      direction.direction,

    gate:
      direction.gate,

    distanceKm:
      Number(
        distance.toFixed(1)
      ),

    etaMinutes:
      Math.max(
        1,
        eta
      ),

    speedKmh:
      speed === null
        ? null
        : Math.round(speed),

    status,

    latitude:
      Number(
        coords.lat.toFixed(6)
      ),

    longitude:
      Number(
        coords.lng.toFixed(6)
      ),

    gpsUpdatedAt:
      timestamp
        ? new Date(
            timestamp
          ).toISOString()
        : new Date().toISOString(),

    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// DEDUPLICATE
// ============================================================

function deduplicate(
  trains
) {
  const map =
    new Map();

  for (
    const train of trains
  ) {
    const key =
      `${train.number}-${train.direction}`;

    const old =
      map.get(key);

    if (
      !old ||
      train.distanceKm <
        old.distanceKm
    ) {
      map.set(
        key,
        train
      );
    }
  }

  return Array.from(
    map.values()
  );
}

// ============================================================
// EMPTY GATE
// ============================================================

function emptyGate(
  name
) {
  return {
    name,

    open: true,

    status: "GO",

    trainNumber: null,

    trainName: null,

    direction: null,

    distanceKm: null,

    etaMinutes: null,

    speedKmh: null,

    latitude: null,

    longitude: null,

    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// GATE RECORD
// ============================================================

function gateFromTrain(
  train,
  name
) {
  if (!train) {
    return emptyGate(
      name
    );
  }

  const closed =
    train.distanceKm <=
    GATE_STOP_DISTANCE_KM;

  return {
    name,

    open:
      !closed,

    status:
      closed
        ? "STOP"
        : "GO",

    trainNumber:
      train.number,

    trainName:
      train.name,

    direction:
      train.direction,

    distanceKm:
      train.distanceKm,

    etaMinutes:
      train.etaMinutes,

    speedKmh:
      train.speedKmh,

    latitude:
      train.latitude,

    longitude:
      train.longitude,

    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// MAIN
// ============================================================

async function updateTracker() {
  console.log("");
  console.log(
    "===================================================="
  );

  console.log(
    "🚆 GUDUR GATE TRACKER"
  );

  console.log(
    "===================================================="
  );

  console.log(
    `📏 Upcoming: ${UPCOMING_MAX_DISTANCE_KM} KM`
  );

  console.log(
    `🚧 STOP: ${GATE_STOP_DISTANCE_KM} KM`
  );

  console.log(
    `🔄 Refresh: ${REFRESH_INTERVAL_MS / 1000} seconds`
  );

  console.log(
    `🕒 ${new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata"
    })}`
  );

  resetRequestCounter();

  try {
    // --------------------------------------------------------
    // GET LIVE GUDUR BOARD
    // --------------------------------------------------------

    const board =
      await getGudurBoard();

    if (!board) {
      console.log(
        "❌ Gudur live board unavailable."
      );

      return;
    }

    const boardTrains =
      extractTrains(
        board
      );

    console.log(
      `📋 Gudur board trains: ${boardTrains.length}`
    );

    // --------------------------------------------------------
    // GET TRAIN INFO
    // --------------------------------------------------------

    const candidates =
      [];

    const seen =
      new Set();

    for (
      const item of boardTrains
    ) {
      const train =
        getTrainInfo(
          item
        );

      if (!train) {
        continue;
      }

      if (
        seen.has(
          train.number
        )
      ) {
        continue;
      }

      seen.add(
        train.number
      );

      candidates.push(
        train
      );
    }

    console.log(
      `🔎 Unique candidates: ${candidates.length}`
    );

    // --------------------------------------------------------
    // PRIORITIZE
    // --------------------------------------------------------
    //
    // The board's own live distance/ETA is used only for
    // prioritization.
    //
    // Final decision is based on individual live GPS.
    //

    candidates.sort(
      (a, b) => {
        const da =
          toNumber(
            a.raw?.live?.distanceKm ??
            a.raw?.distanceKm
          );

        const db =
          toNumber(
            b.raw?.live?.distanceKm ??
            b.raw?.distanceKm
          );

        if (
          da !== null &&
          db !== null
        ) {
          return da - db;
        }

        return 0;
      }
    );

    // --------------------------------------------------------
    // LIVE VALIDATION
    // --------------------------------------------------------

    const liveTrains =
      [];

    for (
      const train of candidates
    ) {
      if (
        !canRequest()
      ) {
        console.log(
          "⚠️ API request budget reached."
        );

        break;
      }

      console.log(
        `🔍 Checking ${train.number} ${train.name}`
      );

      const live =
        await apiGet(
          `/trains/${train.number}/live`,
          {
            authoritative: true
          }
        );

      if (!live) {
        continue;
      }

      // ------------------------------------------------------
      // Route check
      // ------------------------------------------------------
      //
      // If route information is available, require Gudur.
      //
      // Some live responses don't include the complete route.
      // In that case we use the station-board candidate plus
      // direction/GPS checks.
      //

      const routeKnown =
        routeContainsGudur(
          live
        );

      if (routeKnown) {
        console.log(
          `🛤️ ${train.number}: GDR route confirmed`
        );
      }

      const result =
        buildLiveTrain(
          train,
          live
        );

      if (!result) {
        continue;
      }

      // If the API explicitly supplies a route and it does not
      // contain GDR, don't show it.

      const routeDataAvailable =
        Boolean(
          live.route ||
          live.stops ||
          live.train?.route ||
          live.train?.stops ||
          live.live?.route ||
          live.live?.stops
        );

      if (
        routeDataAvailable &&
        !routeKnown
      ) {
        console.log(
          `❌ ${train.number}: route does not contain GDR`
        );

        continue;
      }

      liveTrains.push(
        result
      );

      console.log(
        `✅ ${result.number} | ${result.distanceKm} km | ${result.etaMinutes}m | ${result.direction}`
      );
    }

    // --------------------------------------------------------
    // DEDUPLICATE
    // --------------------------------------------------------

    let trains =
      deduplicate(
        liveTrains
      );

    // --------------------------------------------------------
    // SORT
    // --------------------------------------------------------

    trains.sort(
      (a, b) =>
        a.distanceKm -
        b.distanceKm
    );

    trains =
      trains.slice(
        0,
        MAX_UPCOMING_TRAINS
      );

    // --------------------------------------------------------
    // GATE TRAINS
    // --------------------------------------------------------

    const chennaiInbound =
      trains
        .filter(
          t =>
            t.direction ===
            "chennai_inbound"
        )
        .sort(
          (a, b) =>
            a.distanceKm -
            b.distanceKm
        );

    const tirupatiInbound =
      trains
        .filter(
          t =>
            t.direction ===
            "tirupati_inbound"
        )
        .sort(
          (a, b) =>
            a.distanceKm -
            b.distanceKm
        );

    const chennaiGateTrain =
      chennaiInbound[0] ||
      null;

    const tirupatiGateTrain =
      tirupatiInbound[0] ||
      null;

    const chennaiGate =
      gateFromTrain(
        chennaiGateTrain,
        "Chennai Gate"
      );

    const tirupatiGate =
      gateFromTrain(
        tirupatiGateTrain,
        "Tirupati Gate"
      );

    // --------------------------------------------------------
    // FIREBASE
    // --------------------------------------------------------
    //
    // IMPORTANT:
    //
    // .set() completely replaces old data.
    //
    // Therefore a train that disappeared from the latest live
    // data is automatically removed.
    //
    // --------------------------------------------------------

    const firebaseData = {
      chennaiGate,

      tirupatiGate,

      upcomingTrains:
        trains,

      lastUpdated:
        new Date().toISOString(),

      settings: {
        upcomingMaxDistanceKm:
          UPCOMING_MAX_DISTANCE_KM,

        gateStopDistanceKm:
          GATE_STOP_DISTANCE_KM,

        refreshSeconds:
          REFRESH_INTERVAL_MS /
          1000
      }
    };

    await gateRef.set(
      firebaseData
    );

    // --------------------------------------------------------
    // LOG
    // --------------------------------------------------------

    console.log("");

    console.log(
      "--------------- GATES ---------------"
    );

    console.log(
      `🚧 Chennai Gate: ${chennaiGate.status}` +
      (
        chennaiGate.trainNumber
          ? ` | ${chennaiGate.trainNumber} | ${chennaiGate.distanceKm} km`
          : ""
      )
    );

    console.log(
      `🚧 Tirupati Gate: ${tirupatiGate.status}` +
      (
        tirupatiGate.trainNumber
          ? ` | ${tirupatiGate.trainNumber} | ${tirupatiGate.distanceKm} km`
          : ""
      )
    );

    console.log("");

    console.log(
      "--------------- TRAINS ---------------"
    );

    if (
      trains.length === 0
    ) {
      console.log(
        "⚠️ No verified live trains within 150 KM."
      );
    }

    for (
      const train of trains
    ) {
      console.log(
        `${train.number} | ` +
        `${train.name} | ` +
        `${train.distanceKm} km | ` +
        `${train.etaMinutes} min | ` +
        `${train.direction}`
      );
    }

    console.log("");

    console.log(
      `📡 Requests: ${requestsThisCycle}/${MAX_REQUESTS_PER_CYCLE}`
    );

    console.log(
      `💾 Firebase: ${trains.length} live trains`
    );

    console.log(
      "======================================="
    );

  } catch (error) {
    console.error(
      "❌ Tracker error:"
    );

    console.error(
      error
    );
  }
}

// ============================================================
// START
// ============================================================

console.log("");
console.log(
  "🚆 GUDUR GATE TRACKER STARTED"
);

console.log(
  "📍 Monitoring trains around Gudur"
);

console.log(
  "🛤️ Through trains + stopping trains"
);

console.log(
  "↔️ Chennai ↔ Gudur ↔ Tirupati"
);

console.log(
  "📏 Upcoming radius: 150 KM"
);

console.log(
  "🚧 Gate STOP: 5 KM"
);

console.log(
  "🔄 Update interval: 60 seconds"
);

console.log("");

// Immediate update.
updateTracker();

// Continuous updates.
setInterval(
  updateTracker,
  REFRESH_INTERVAL_MS
);