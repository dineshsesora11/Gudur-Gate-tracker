const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR GATE LIVE TRAIN MONITOR
// ============================================================
//
// PURPOSE:
//   Monitor trains approaching Gudur (GDR) and update Firebase.
//
// GATE RULE:
//   Chennai-side train -> Chennai Gate
//   Tirupati-side train -> Tirupati Gate
//
// IMPORTANT:
//   Gate closure is based ONLY on actual GPS position,
//   route direction, corridor and distance to the gate.
//
// UPCOMING TRAINS:
//   Only trains TOWARD_GUDUR are shown.
//   Trains AT_GUDUR or FROM_GUDUR are removed.
//   Trains that have crossed the relevant gate are removed.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

const SERVICE_ACCOUNT_FILE =
  "./serviceAccountKey.json";


// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================
//
// GitHub Actions should provide:
//
// RAILRADAR_API_KEY
//
// through:
// GitHub -> Settings -> Secrets and variables -> Actions
//
// Do NOT put the real API key directly in this file.
//

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";


// ============================================================
// LOCATION CONFIGURATION
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;


// ============================================================
// MONITORING SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;

const GATE_STOP_DISTANCE_KM = 0.6;

// One station-board request + seven verification requests.
const MAX_API_REQUESTS_PER_CYCLE = 8;

const VERIFY_PER_CYCLE =
  Math.min(
    7,
    MAX_API_REQUESTS_PER_CYCLE - 1
  );

// Local loop interval.
// GitHub Actions normally runs only one cycle.
const REFRESH_INTERVAL_MS =
  60 * 1000;


// ============================================================
// ETA SETTINGS
// ============================================================

const DEFAULT_SPEED_KMH = 55;

const MIN_SPEED_FOR_ETA_KMH = 5;


// ============================================================
// GATE -> GUDUR DISTANCE
// ============================================================

function toRadians(value) {
  return value * Math.PI / 180;
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
  if (
    lat1 === null ||
    lat1 === undefined ||
    lng1 === null ||
    lng1 === undefined ||
    lat2 === null ||
    lat2 === undefined ||
    lng2 === null ||
    lng2 === undefined
  ) {
    return null;
  }

  const aLat = Number(lat1);
  const aLng = Number(lng1);
  const bLat = Number(lat2);
  const bLng = Number(lng2);

  if (
    !Number.isFinite(aLat) ||
    !Number.isFinite(aLng) ||
    !Number.isFinite(bLat) ||
    !Number.isFinite(bLng)
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    toRadians(bLat - aLat);

  const dLng =
    toRadians(bLng - aLng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) *
    Math.cos(toRadians(bLat)) *
    Math.sin(dLng / 2) ** 2;

  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(h)
    )
  );
}


// ============================================================
// STATIC GATE DISTANCES TO GUDUR
// ============================================================

const CHENNAI_GATE_TO_GDR_KM =
  distanceKm(
    CHENNAI_GATE_LAT,
    CHENNAI_GATE_LNG,
    GDR_LAT,
    GDR_LNG
  );

const TIRUPATI_GATE_TO_GDR_KM =
  distanceKm(
    TIRUPATI_GATE_LAT,
    TIRUPATI_GATE_LNG,
    GDR_LAT,
    GDR_LNG
  );


// ============================================================
// BEARING
// ============================================================

function bearingDegrees(
  lat1,
  lng1,
  lat2,
  lng2
) {
  if (
    lat1 === null ||
    lng1 === null ||
    lat2 === null ||
    lng2 === null
  ) {
    return null;
  }

  const phi1 =
    toRadians(Number(lat1));

  const phi2 =
    toRadians(Number(lat2));

  const deltaLng =
    toRadians(
      Number(lng2) -
      Number(lng1)
    );

  const y =
    Math.sin(deltaLng) *
    Math.cos(phi2);

  const x =
    Math.cos(phi1) *
      Math.sin(phi2) -
    Math.sin(phi1) *
      Math.cos(phi2) *
      Math.cos(deltaLng);

  let bearing =
    Math.atan2(y, x) *
    180 /
    Math.PI;

  bearing =
    (bearing + 360) % 360;

  return bearing;
}


// ============================================================
// NORMALIZE TEXT
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
// SAFE NUMBER
// ============================================================

function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// GET NESTED VALUE
// ============================================================

function getNested(
  obj,
  paths
) {
  for (const path of paths) {
    let current = obj;

    for (
      const part of path.split(".")
    ) {
      if (
        current === null ||
        current === undefined
      ) {
        current = undefined;
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
// STATION CODE NORMALIZER
// ============================================================

function normalizeStationCode(
  value
) {
  return normalizeText(value)
    .replace(/\s+/g, "");
}


// ============================================================
// CHENNAI-SIDE STATIONS
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


// ============================================================
// TIRUPATI-SIDE STATIONS
// ============================================================

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


// ============================================================
// TRAIN NUMBERS KNOWN ON TIRUPATI CORRIDOR
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
// TRAIN NUMBERS KNOWN ON CHENNAI CORRIDOR
// ============================================================
//
// This list is intentionally not used as the only proof
// of direction.
//
// GPS / route information remains more important.
//

const CHENNAI_CORRIDOR_TRAINS =
  new Set([
    "12711",
    "12712",
    "12603",
    "12604",
    "12607",
    "12608",
    "12269",
    "12270",
    "12295",
    "12296",
    "22305",
    "22306"
  ]);


// ============================================================
// ORIGIN DETECTION
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
// DESTINATION DETECTION
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
// CHENNAI SIDE DETECTION
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const possibleOrigins = [
    train.origin,
    train.source,
    train.from,
    train.fromStation,
    train.startStation,
    train.start,

    item.origin,
    item.source,
    item.from,
    item.fromStation,
    item.startStation
  ];

  const originText =
    possibleOrigins
      .filter(Boolean)
      .join(" ");

  if (
    containsAny(
      originText,
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
    return true;
  }

  const originCode =
    normalizeStationCode(
      possibleOrigins.find(
        Boolean
      )
    );

  return CHENNAI_SIDE_CODES.has(
    originCode
  );
}


// ============================================================
// TIRUPATI SIDE DETECTION
// ============================================================

function isFromTirupatiSide(
  train,
  item
) {
  const possibleOrigins = [
    train.origin,
    train.source,
    train.from,
    train.fromStation,
    train.startStation,
    train.start,

    item.origin,
    item.source,
    item.from,
    item.fromStation,
    item.startStation
  ];

  const originText =
    possibleOrigins
      .filter(Boolean)
      .join(" ");

  if (
    containsAny(
      originText,
      [
        "TIRUPATI",
        "TPTY",
        "TIRUPATI MAIN",
        "RENIGUNTA",
        "RU"
      ]
    )
  ) {
    return true;
  }

  const originCode =
    normalizeStationCode(
      possibleOrigins.find(
        Boolean
      )
    );

  return TIRUPATI_SIDE_CODES.has(
    originCode
  );
}


// ============================================================
// ROUTE EXTRACTION
// ============================================================

function extractRoute(
  train,
  live,
  stop,
  item
) {
  const candidates = [
    train.route,
    train.stops,
    train.routeStations,
    train.stationList,
    train.routeDetails,

    item.route,
    item.stops,
    item.routeStations,
    item.stationList,

    live.route,
    live.stops
  ];

  for (
    const candidate of candidates
  ) {
    if (
      Array.isArray(candidate) &&
      candidate.length > 0
    ) {
      return candidate;
    }
  }

  return [];
}


// ============================================================
// ROUTE STATION NAME
// ============================================================

function getRouteStationName(
  station
) {
  if (
    station === null ||
    station === undefined
  ) {
    return "";
  }

  if (
    typeof station === "string"
  ) {
    return station;
  }

  return (
    station.name ||
    station.stationName ||
    station.station ||
    station.code ||
    station.stationCode ||
    ""
  );
}


// ============================================================
// FIND GUDUR IN ROUTE
// ============================================================

function getGudurRouteIndex(
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
      normalizeText(
        getRouteStationName(
          route[i]
        )
      );

    if (
      station.includes("GUDUR") ||
      station.includes("GDR")
    ) {
      return i;
    }
  }

  return -1;
}


// ============================================================
// GET ROUTE DIRECTION
// ============================================================

function getRouteDirection(
  train,
  live,
  stop,
  item
) {
  const route =
    extractRoute(
      train,
      live,
      stop,
      item
    );

  const gudurIndex =
    getGudurRouteIndex(
      route
    );

  if (
    gudurIndex === -1
  ) {
    return null;
  }

  const currentIndex =
    safeNumber(
      getNested(
        live,
        [
          "currentStopIndex",
          "currentStationIndex",
          "routeIndex",
          "stationIndex"
        ]
      )
    );

  if (
    currentIndex === null
  ) {
    return null;
  }

  if (
    currentIndex <
    gudurIndex
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    currentIndex ===
    gudurIndex
  ) {
    return "AT_GUDUR";
  }

  if (
    currentIndex >
    gudurIndex
  ) {
    return "FROM_GUDUR";
  }

  return null;
}


// ============================================================
// EXPLICIT DIRECTION TEXT
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
    .map(
      normalizeText
    )
    .join(" ");
}


// ============================================================
// EXPLICIT INBOUND / OUTBOUND
// ============================================================

function getExplicitDirection(
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
    direction.includes(
      "TOWARD GUDUR"
    ) ||
    direction.includes(
      "TOWARDS GUDUR"
    ) ||
    direction.includes(
      "TO GUDUR"
    ) ||
    direction.includes(
      "GUDUR INBOUND"
    ) ||
    direction.includes(
      "INBOUND"
    ) ||
    direction.includes(
      "APPROACHING GUDUR"
    )
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    direction.includes(
      "FROM GUDUR"
    ) ||
    direction.includes(
      "GUDUR OUTBOUND"
    ) ||
    direction.includes(
      "OUTBOUND"
    ) ||
    direction.includes(
      "AWAY FROM GUDUR"
    ) ||
    direction.includes(
      "TO CHENNAI"
    ) ||
    direction.includes(
      "TOWARD CHENNAI"
    ) ||
    direction.includes(
      "TOWARDS CHENNAI"
    ) ||
    direction.includes(
      "TO TIRUPATI"
    ) ||
    direction.includes(
      "TOWARD TIRUPATI"
    ) ||
    direction.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return "FROM_GUDUR";
  }

  return null;
}


// ============================================================
// GPS EXTRACTION
// ============================================================

function extractGpsPosition(
  train,
  live,
  stop,
  item
) {
  const candidates = [
    live.currentLocation,
    live.currentPosition,
    live.gps,
    live.location,
    live.position,

    train.currentLocation,
    train.currentPosition,
    train.gps,
    train.location,
    train.position,

    item.currentLocation,
    item.currentPosition,
    item.gps,
    item.location,
    item.position
  ];

  for (
    const candidate of candidates
  ) {
    if (!candidate) {
      continue;
    }

    const lat =
      safeNumber(
        candidate.lat ??
        candidate.latitude ??
        candidate.y
      );

    const lng =
      safeNumber(
        candidate.lng ??
        candidate.lon ??
        candidate.longitude ??
        candidate.x
      );

    if (
      lat !== null &&
      lng !== null
    ) {
      const speed =
        safeNumber(
          candidate.speed ??
          candidate.speedKmh ??
          candidate.speedKmH ??
          live.speed ??
          live.speedKmh
        );

      const bearing =
        safeNumber(
          candidate.bearing ??
          candidate.heading ??
          candidate.directionDegrees ??
          live.bearing ??
          live.heading
        );

      const actualFlag =
        candidate.isActualPosition ??
        candidate.actual ??
        live.isActualPosition ??
        live.actual;

      return {
        lat,
        lng,

        speedKmh:
          speed,

        bearing:
          bearing,

        isActualPosition:
          actualFlag !== false,

        source:
          "GPS"
      };
    }
  }

  return null;
}


// ============================================================
// ROUTE STOP POSITION FALLBACK
// ============================================================
//
// IMPORTANT:
// This fallback may be used for display/ETA,
// but NEVER for gate closure.
//

function extractRouteStopPosition(
  train,
  live,
  stop,
  item
) {
  const candidates = [
    stop,
    live.nextStop,
    live.currentStop,
    train.nextStop,
    train.currentStop,
    item.nextStop,
    item.currentStop
  ];

  for (
    const candidate of candidates
  ) {
    if (!candidate) {
      continue;
    }

    const lat =
      safeNumber(
        candidate.lat ??
        candidate.latitude
      );

    const lng =
      safeNumber(
        candidate.lng ??
        candidate.lon ??
        candidate.longitude
      );

    if (
      lat !== null &&
      lng !== null
    ) {
      return {
        lat,
        lng,
        speedKmh: null,
        bearing: null,

        isActualPosition:
          false,

        source:
          "ROUTE_STOP"
      };
    }
  }

  return null;
}


// ============================================================
// GET BEST POSITION
// ============================================================

function getBestPosition(
  train,
  live,
  stop,
  item
) {
  const gps =
    extractGpsPosition(
      train,
      live,
      stop,
      item
    );

  if (gps) {
    return gps;
  }

  const routePosition =
    extractRouteStopPosition(
      train,
      live,
      stop,
      item
    );

  if (routePosition) {
    return routePosition;
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

  let totalMinutes = -1;

  const date =
    new Date(timeStr);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
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
        parseInt(
          match[1],
          10
        ) * 60 +
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
// CURRENT MINUTES
// ============================================================

function getCurrentMinutes() {
  const now =
    new Date();

  return (
    now.getHours() * 60 +
    now.getMinutes()
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
    arrivalMinutes === -1 ||
    currentMinutes === -1
  ) {
    return null;
  }

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
// GET BOARD ETA
// ============================================================
//
// Used ONLY to prioritize which trains get live verification.
// It is NOT used to close a gate.
//

function getBoardEtaMinutes(
  item,
  currentMinutes
) {
  const train =
    item?.train || {};

  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  const delay =
    Number(
      live.delayMinutes || 0
    );

  const arrival =
    stop.arrival ||
    live.expectedArrivalTime ||
    live.expectedArrival ||
    item.expectedArrivalTime ||
    item.arrival ||
    "";

  if (!arrival) {
    return null;
  }

  const arrivalMinutes =
    parseTimeToMinutes(
      arrival,
      delay
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
// CALCULATE ETA FROM DISTANCE
// ============================================================

function calculateEtaMinutes(
  distance,
  speedKmh
) {
  if (
    distance === null ||
    distance === undefined
  ) {
    return null;
  }

  if (
    distance <= 0.01
  ) {
    return 0;
  }

  let speed =
    safeNumber(
      speedKmh
    );

  if (
    speed === null ||
    speed < MIN_SPEED_FOR_ETA_KMH
  ) {
    speed =
      DEFAULT_SPEED_KMH;
  }

  const minutes =
    (
      distance /
      speed
    ) * 60;

  // Do not display 0m for a train
  // that is still physically away.
  return Math.max(
    1,
    Math.ceil(minutes)
  );
}


// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// MAS  = Chennai-side -> Gudur
// TPTY = Tirupati-side -> Gudur
// OTHER = inbound train but not one of the two gate corridors
// null = not relevant
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item,
  direction
) {
  if (
    direction !==
    "TOWARD_GUDUR"
  ) {
    return null;
  }

  const trainNo =
    String(
      train.number || ""
    ).trim();

  const fromChennai =
    isFromChennaiSide(
      train,
      item
    );

  const fromTirupati =
    isFromTirupatiSide(
      train,
      item
    );

  if (
    fromChennai
  ) {
    return "MAS";
  }

  if (
    fromTirupati
  ) {
    return "TPTY";
  }

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  if (
    CHENNAI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "MAS";
  }

  // Unknown inbound trains can still be
  // displayed as OTHER.
  return "OTHER";
}


// ============================================================
// GET DIRECTION
// ============================================================

function determineDirection(
  train,
  live,
  stop,
  item
) {
  const explicit =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  const routeDirection =
    getRouteDirection(
      train,
      live,
      stop,
      item
    );

  // Route direction has priority because
  // it is based on the actual route position.
  if (
    routeDirection
  ) {
    return routeDirection;
  }

  if (
    explicit
  ) {
    return explicit;
  }

  return null;
}


// ============================================================
// CHECK IF TRAIN IS AT GUDUR
// ============================================================

function isAtGudurStation(
  direction,
  distanceToGdrKm
) {
  if (
    direction ===
    "AT_GUDUR"
  ) {
    return true;
  }

  if (
    distanceToGdrKm !== null &&
    distanceToGdrKm <= 0.25
  ) {
    return true;
  }

  return false;
}


// ============================================================
// CHECK IF TRAIN HAS PASSED RELEVANT GATE
// ============================================================
//
// This is used ONLY for removing trains from Upcoming.
//
// We compare the train's distance to Gudur with the fixed
// gate -> Gudur distance.
//
// Example:
//
// Gate -> Gudur = ~0.53 km
//
// Before gate:
//   distance to Gudur > ~0.53 km
//
// After crossing gate:
//   distance to Gudur < ~0.53 km
//
// This gives us a local "passed gate" boundary.
//
// ============================================================

function hasPassedRelevantGate(
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
    return true;
  }

  if (
    processed.isAtGudurStation
  ) {
    return true;
  }

  const distanceToGdrKm =
    processed.distanceToGdrKm;

  const corridor =
    processed.corridor;

  if (
    distanceToGdrKm === null
  ) {
    return false;
  }

  let gateToGdrKm = null;

  if (
    corridor === "MAS"
  ) {
    gateToGdrKm =
      CHENNAI_GATE_TO_GDR_KM;
  } else if (
    corridor === "TPTY"
  ) {
    gateToGdrKm =
      TIRUPATI_GATE_TO_GDR_KM;
  } else {
    return false;
  }

  if (
    gateToGdrKm === null
  ) {
    return false;
  }

  // Small tolerance so GPS jitter around the boundary
  // does not make the train repeatedly appear/disappear.
  const passedBoundaryKm =
    Math.max(
      0,
      gateToGdrKm - 0.05
    );

  if (
    distanceToGdrKm <
    passedBoundaryKm
  ) {
    return true;
  }

  return false;
}


// ============================================================
// CHECK IF TRAIN SHOULD APPEAR IN UPCOMING
// ============================================================

function shouldShowUpcoming(
  processed
) {
  if (
    !processed
  ) {
    return false;
  }

  // Only inbound trains.
  if (
    processed.direction !==
    "TOWARD_GUDUR"
  ) {
    return false;
  }

  // Once train reaches Gudur, remove it.
  if (
    processed.isAtGudurStation
  ) {
    return false;
  }

  // Once train crosses the relevant gate,
  // remove it from Upcoming.
  if (
    hasPassedRelevantGate(
      processed
    )
  ) {
    return false;
  }

  // Must have a usable distance.
  if (
    processed.distanceToGdrKm === null
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
// GATE DISTANCE
// ============================================================

function getGateInfo(
  corridor,
  lat,
  lng
) {
  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  if (
    corridor === "MAS"
  ) {
    return {
      gateName:
        "Chennai Gate",

      distanceKm:
        distanceKm(
          lat,
          lng,
          CHENNAI_GATE_LAT,
          CHENNAI_GATE_LNG
        )
    };
  }

  if (
    corridor === "TPTY"
  ) {
    return {
      gateName:
        "Tirupati Gate",

      distanceKm:
        distanceKm(
          lat,
          lng,
          TIRUPATI_GATE_LAT,
          TIRUPATI_GATE_LNG
        )
    };
  }

  return null;
}


// ============================================================
// PROCESS TRAIN
// ============================================================

function processTrain(
  item
) {
  const train =
    item?.train || {};

  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  const trainNo =
    String(
      train.number || ""
    ).trim();

  if (
    !trainNo
  ) {
    return null;
  }

  const trainName =
    train.name ||
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

  const delayMinutes =
    Number(
      live.delayMinutes || 0
    );

  const direction =
    determineDirection(
      train,
      live,
      stop,
      item
    );

  const corridor =
    determineCorridor(
      train,
      live,
      stop,
      item,
      direction
    );

  const position =
    getBestPosition(
      train,
      live,
      stop,
      item
    );

  let distanceToGdrKm =
    null;

  let distanceToGateKm =
    null;

  let gateName =
    null;

  let etaMinutes =
    null;

  if (
    position
  ) {
    distanceToGdrKm =
      distanceKm(
        position.lat,
        position.lng,
        GDR_LAT,
        GDR_LNG
      );

    const gateInfo =
      getGateInfo(
        corridor,
        position.lat,
        position.lng
      );

    if (
      gateInfo
    ) {
      distanceToGateKm =
        gateInfo.distanceKm;

      gateName =
        gateInfo.gateName;
    }

    etaMinutes =
      calculateEtaMinutes(
        distanceToGdrKm,
        position.speedKmh
      );
  }

  // ----------------------------------------------------------
  // BOARD ETA FALLBACK
  // ----------------------------------------------------------

  if (
    etaMinutes === null
  ) {
    const boardEta =
      getBoardEtaMinutes(
        item,
        getCurrentMinutes()
      );

    if (
      boardEta !== null &&
      boardEta >= 0
    ) {
      etaMinutes =
        Math.max(
          1,
          Math.ceil(
            boardEta
          )
        );
    }
  }

  const atStation =
    isAtGudurStation(
      direction,
      distanceToGdrKm
    );

  const processed = {
    trainNo,
    name:
      trainName,

    origin:
      origin || "Unknown",

    destination:
      destination || "Gudur",

    direction:
      direction || "UNKNOWN",

    corridor:
      corridor || "OTHER",

    delayMinutes,

    positionSource:
      position
        ? position.source
        : "NONE",

    isActualPosition:
      position
        ? position.isActualPosition
        : false,

    lat:
      position
        ? position.lat
        : null,

    lng:
      position
        ? position.lng
        : null,

    speedKmh:
      position
        ? position.speedKmh
        : null,

    bearing:
      position
        ? position.bearing
        : null,

    distanceToGdrKm,

    distanceToGateKm,

    gateName,

    etaMinutes,

    isAtGudurStation:
      atStation,

    rawItem:
      item
  };

  return processed;
}


// ============================================================
// PRIORITY SCORE FOR VERIFICATION
// ============================================================
//
// IMPORTANT:
//
// This does NOT use board ETA to close a gate.
//
// It only determines which trains should receive one of
// the seven available LIVE verification requests.
//
// Priority:
//
// 1. Board trains expected soon
// 2. Trains with a known route toward Gudur
// 3. Tirupati/Chennai corridor candidates
// 4. Others
//
// ============================================================

function getVerificationPriority(
  item,
  currentMinutes
) {
  const train =
    item?.train || {};

  const trainNo =
    String(
      train.number || ""
    ).trim();

  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  const direction =
    determineDirection(
      train,
      live,
      stop,
      item
    );

  const corridor =
    determineCorridor(
      train,
      live,
      stop,
      item,
      direction
    );

  const boardEta =
    getBoardEtaMinutes(
      item,
      currentMinutes
    );

  let score = 1000;

  // ----------------------------------------------------------
  // BOARD ETA
  // ----------------------------------------------------------

  if (
    boardEta !== null
  ) {
    if (
      boardEta >= 0 &&
      boardEta <= 15
    ) {
      score -= 500;
    } else if (
      boardEta > 15 &&
      boardEta <= 30
    ) {
      score -= 400;
    } else if (
      boardEta > 30 &&
      boardEta <= 60
    ) {
      score -= 300;
    } else if (
      boardEta > 60 &&
      boardEta <= 120
    ) {
      score -= 150;
    } else if (
      boardEta < 0
    ) {
      score += 400;
    }
  }

  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  if (
    direction ===
    "TOWARD_GUDUR"
  ) {
    score -= 250;
  } else if (
    direction ===
    "AT_GUDUR"
  ) {
    score += 100;
  } else if (
    direction ===
    "FROM_GUDUR"
  ) {
    score += 500;
  } else {
    score += 100;
  }

  // ----------------------------------------------------------
  // CORRIDOR
  // ----------------------------------------------------------

  if (
    corridor === "MAS"
  ) {
    score -= 100;
  }

  if (
    corridor === "TPTY"
  ) {
    score -= 100;
  }

  // ----------------------------------------------------------
  // KNOWN TRAIN NUMBERS
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    score -= 50;
  }

  if (
    CHENNAI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    score -= 50;
  }

  return {
    item,
    score,
    boardEta
  };
}


// ============================================================
// SELECT VERIFICATION BATCH
// ============================================================
//
// Instead of simply:
//
//   first 7 trains
//
// we select the seven most urgent candidates.
//
// This is the key fix for the missed gate problem.
//

function selectVerificationBatch(
  trainsArray
) {
  const currentMinutes =
    getCurrentMinutes();

  const scored =
    trainsArray.map(
      (item, index) => ({
        ...getVerificationPriority(
          item,
          currentMinutes
        ),

        originalIndex:
          index
      })
    );

  scored.sort(
    (a, b) => {
      if (
        a.score !==
        b.score
      ) {
        return (
          a.score -
          b.score
        );
      }

      // If same score, use earliest board ETA.
      if (
        a.boardEta !== null &&
        b.boardEta !== null &&
        a.boardEta !==
        b.boardEta
      ) {
        return (
          a.boardEta -
          b.boardEta
        );
      }

      return (
        a.originalIndex -
        b.originalIndex
      );
    }
  );

  return scored
    .slice(
      0,
      VERIFY_PER_CYCLE
    )
    .map(
      (entry) =>
        entry.item
    );
}


// ============================================================
// MAKE OPEN GATE
// ============================================================

function makeOpenGate() {
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
// MAKE CLOSED GATE
// ============================================================

function makeClosedGate(
  processed
) {
  const wait =
    processed.etaMinutes !== null
      ? Math.max(
          1,
          Math.min(
            15,
            processed.etaMinutes + 2
          )
        )
      : 5;

  const status =
    processed.delayMinutes > 0
      ? `${processed.delayMinutes}m late`
      : "Approaching";

  return {
    status:
      "CLOSED",

    waitMinutes:
      wait,

    activeTrain:
      `${processed.trainNo} ${processed.name} (${status})`,

    direction:
      "TOWARD GUDUR",

    corridor:
      processed.corridor,

    distanceKm:
      processed.distanceToGateKm,

    speedKmh:
      processed.speedKmh,

    positionSource:
      processed.positionSource,

    isActualPosition:
      processed.isActualPosition
  };
}


// ============================================================
// SHOULD CLOSE GATE
// ============================================================
//
// SAFETY RULE:
//
// Gate closure requires:
//
// 1. GPS position
// 2. Actual position
// 3. TOWARD_GUDUR
// 4. MAS or TPTY corridor
// 5. Not already at Gudur
// 6. Within 600 metres of the relevant gate
//
// Board ETA alone can NEVER close the gate.
//

function shouldCloseGate(
  processed
) {
  if (
    !processed
  ) {
    return false;
  }

  if (
    processed.positionSource !==
    "GPS"
  ) {
    return false;
  }

  if (
    processed.isActualPosition ===
    false
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
    processed.isAtGudurStation
  ) {
    return false;
  }

  if (
    processed.distanceToGateKm ===
    null
  ) {
    return false;
  }

  if (
    processed.distanceToGateKm >
    GATE_STOP_DISTANCE_KM
  ) {
    return false;
  }

  return true;
}


// ============================================================
// REQUEST COUNTER
// ============================================================

let apiRequestsThisCycle = 0;


// ============================================================
// RAILRADAR GET
// ============================================================

async function railRadarGet(
  path,
  params = {}
) {
  if (
    !RAILRADAR_API_KEY
  ) {
    throw new Error(
      "RAILRADAR_API_KEY is not configured."
    );
  }

  if (
    apiRequestsThisCycle >=
    MAX_API_REQUESTS_PER_CYCLE
  ) {
    throw new Error(
      "RailRadar request limit reached for this cycle."
    );
  }

  apiRequestsThisCycle++;

  const url =
    `${RAILRADAR_BASE_URL}${path}`;

  console.log(
    `[API ${apiRequestsThisCycle}/${MAX_API_REQUESTS_PER_CYCLE}] GET ${path}`
  );

  const response =
    await axios.get(
      url,
      {
        params,

        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,

          "X-API-Key":
            RAILRADAR_API_KEY,

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
// FETCH STATION BOARD
// ============================================================

async function fetchStationBoard() {
  return railRadarGet(
    "/stations/GDR/live",
    {
      hours: 4
    }
  );
}


// ============================================================
// EXTRACT BOARD TRAINS
// ============================================================

function extractBoardTrains(
  responseBody
) {
  const candidates = [
    responseBody?.data?.trains,
    responseBody?.trains,
    responseBody?.data,
    responseBody?.results
  ];

  for (
    const candidate of candidates
  ) {
    if (
      Array.isArray(
        candidate
      )
    ) {
      return candidate;
    }
  }

  return [];
}


// ============================================================
// VERIFY LIVE TRAIN
// ============================================================
//
// The exact RailRadar live endpoint may depend on the API
// response structure.
//
// This function tries the common train-number endpoint.
//

async function verifyLiveTrain(
  trainNo
) {
  const endpoints = [
    `/trains/${encodeURIComponent(trainNo)}/live`,
    `/trains/${encodeURIComponent(trainNo)}`,
    `/train/${encodeURIComponent(trainNo)}/live`
  ];

  let lastError = null;

  for (
    const endpoint of endpoints
  ) {
    try {
      return await railRadarGet(
        endpoint
      );
    } catch (error) {
      lastError =
        error;

      // Continue only if this endpoint
      // returned an HTTP 404.
      if (
        error.response &&
        error.response.status !== 404
      ) {
        throw error;
      }
    }
  }

  if (
    lastError
  ) {
    throw lastError;
  }

  return null;
}


// ============================================================
// MERGE VERIFIED DATA
// ============================================================

function mergeVerifiedData(
  boardItem,
  liveResponse
) {
  if (
    !liveResponse
  ) {
    return boardItem;
  }

  const liveData =
    liveResponse?.data ||
    liveResponse;

  return {
    ...boardItem,

    live:
      {
        ...(boardItem.live || {}),
        ...(liveData.live || liveData)
      },

    train:
      {
        ...(boardItem.train || {}),
        ...(liveData.train || {})
      },

    stop:
      {
        ...(boardItem.stop || {}),
        ...(liveData.stop || {})
      }
  };
}


// ============================================================
// BUILD UPCOMING TRAIN
// ============================================================

function buildUpcomingTrain(
  processed
) {
  if (
    !shouldShowUpcoming(
      processed
    )
  ) {
    return null;
  }

  return {
    trainNo:
      processed.trainNo,

    name:
      processed.name,

    origin:
      processed.origin,

    destination:
      processed.destination,

    etaMinutes:
      processed.etaMinutes !== null
        ? processed.etaMinutes
        : null,

    delayMinutes:
      processed.delayMinutes,

    corridor:
      processed.corridor,

    direction:
      "TOWARD GUDUR",

    platform:
      String(
        processed.rawItem?.live?.platform ||
        processed.rawItem?.stop?.platform ||
        "1"
      ),

    distanceToGdrKm:
      processed.distanceToGdrKm !== null
        ? Number(
            processed.distanceToGdrKm.toFixed(
              2
            )
          )
        : null,

    distanceToGateKm:
      processed.distanceToGateKm !== null
        ? Number(
            processed.distanceToGateKm.toFixed(
              2
            )
          )
        : null,

    positionSource:
      processed.positionSource,

    gps:
      processed.positionSource ===
      "GPS",

    status:
      "APPROACHING"
  };
}


// ============================================================
// PROCESS VERIFIED TRAINS
// ============================================================

function processVerifiedTrains(
  verifiedItems
) {
  const processedTrains = [];

  let masGate =
    makeOpenGate();

  let tptyGate =
    makeOpenGate();

  for (
    const item of verifiedItems
  ) {
    const processed =
      processTrain(
        item
      );

    if (
      !processed
    ) {
      continue;
    }

    processedTrains.push(
      processed
    );

    console.log(
      `[LIVE] ${processed.trainNo} ${processed.name} | ` +
      `${processed.direction} | ` +
      `corridor=${processed.corridor} | ` +
      `GDR=${
        processed.distanceToGdrKm !== null
          ? processed.distanceToGdrKm.toFixed(2)
          : "?"
      } km | ` +
      `gate=${
        processed.distanceToGateKm !== null
          ? processed.distanceToGateKm.toFixed(2)
          : "?"
      } km | ` +
      `source=${processed.positionSource}`
    );

    // --------------------------------------------------------
    // UPCOMING
    // --------------------------------------------------------

    if (
      !shouldShowUpcoming(
        processed
      )
    ) {
      if (
        processed.direction ===
        "AT_GUDUR"
      ) {
        console.log(
          `[REMOVED] ${processed.trainNo} - already at Gudur`
        );
      } else if (
        processed.direction ===
        "FROM_GUDUR"
      ) {
        console.log(
          `[REMOVED] ${processed.trainNo} - already passed Gudur`
        );
      } else if (
        hasPassedRelevantGate(
          processed
        )
      ) {
        console.log(
          `[REMOVED] ${processed.trainNo} - already crossed relevant gate`
        );
      }
    }

    // --------------------------------------------------------
    // GATE CLOSURE
    // --------------------------------------------------------

    if (
      shouldCloseGate(
        processed
      )
    ) {
      const payload =
        makeClosedGate(
          processed
        );

      if (
        processed.corridor ===
        "MAS"
      ) {
        masGate =
          payload;

        console.log(
          `[GATE CLOSED] Chennai Gate | ${processed.trainNo} | ${processed.distanceToGateKm.toFixed(2)} km`
        );
      }

      if (
        processed.corridor ===
        "TPTY"
      ) {
        tptyGate =
          payload;

        console.log(
          `[GATE CLOSED] Tirupati Gate | ${processed.trainNo} | ${processed.distanceToGateKm.toFixed(2)} km`
        );
      }
    }
  }

  return {
    processedTrains,

    masGate,

    tptyGate
  };
}


// ============================================================
// BUILD UPCOMING LIST
// ============================================================

function buildUpcomingList(
  processedTrains
) {
  const upcoming = [];

  for (
    const processed of
    processedTrains
  ) {
    const item =
      buildUpcomingTrain(
        processed
      );

    if (
      item
    ) {
      upcoming.push(
        item
      );
    }
  }

  // ----------------------------------------------------------
  // SORT BY DISTANCE FIRST
  // ----------------------------------------------------------
  //
  // This keeps physically closer trains first.
  //

  upcoming.sort(
    (a, b) => {
      const aDistance =
        a.distanceToGdrKm ??
        Number.MAX_SAFE_INTEGER;

      const bDistance =
        b.distanceToGdrKm ??
        Number.MAX_SAFE_INTEGER;

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
        Number.MAX_SAFE_INTEGER;

      const bEta =
        b.etaMinutes ??
        Number.MAX_SAFE_INTEGER;

      return (
        aEta -
        bEta
      );
    }
  );

  return upcoming.slice(
    0,
    10
  );
}


// ============================================================
// FIREBASE INITIALIZATION
// ============================================================

let serviceAccount;

try {
  if (
    process.env.FIREBASE_SERVICE_ACCOUNT
  ) {
    serviceAccount =
      JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      );
  } else if (
    fs.existsSync(
      SERVICE_ACCOUNT_FILE
    )
  ) {
    serviceAccount =
      require(
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
  db.ref(
    "gudur_gates"
  );


// ============================================================
// UPDATE FIREBASE
// ============================================================

async function writeFirebaseData(
  masGate,
  tptyGate,
  upcomingTrains,
  verifiedCount
) {
  const now =
    new Date();

  await gateRef.set({
    tirupatiGate:
      tptyGate,

    chennaiGate:
      masGate,

    upcomingTrains:
      upcomingTrains,

    lastUpdated:
      now.toISOString(),

    lastUpdatedLocal:
      now.toLocaleTimeString(
        "en-IN",
        {
          hour12:
            true
        }
      ),

    verifiedTrains:
      verifiedCount,

    monitorStatus:
      "ONLINE"
  });
}


// ============================================================
// FAIL-SAFE FIREBASE UPDATE
// ============================================================

async function writeFirebaseError(
  message
) {
  const now =
    new Date();

  try {
    await gateRef.set({
      tirupatiGate:
        makeOpenGate(),

      chennaiGate:
        makeOpenGate(),

      upcomingTrains:
        [],

      lastUpdated:
        now.toISOString(),

      lastUpdatedLocal:
        now.toLocaleTimeString(
          "en-IN",
          {
            hour12:
              true
          }
        ),

      verifiedTrains:
        0,

      monitorStatus:
        "ERROR",

      error:
        message
    });
  } catch (firebaseError) {
    console.error(
      "❌ Firebase error while writing error state:",
      firebaseError.message
    );
  }
}


// ============================================================
// MAIN MONITOR CYCLE
// ============================================================

async function updateGateSystem() {
  apiRequestsThisCycle =
    0;

  const now =
    new Date();

  console.log(
    "\n=========================================="
  );

  console.log(
    `[${now.toLocaleTimeString(
      "en-IN"
    )}] Gudur Live Radar Update`
  );

  console.log(
    "=========================================="
  );

  try {
    // --------------------------------------------------------
    // CHECK API KEY
    // --------------------------------------------------------

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY environment variable is missing."
      );
    }

    // --------------------------------------------------------
    // STATION BOARD
    // --------------------------------------------------------

    console.log(
      "[1/8] Requesting GDR live station board..."
    );

    const boardResponse =
      await fetchStationBoard();

    const trainsArray =
      extractBoardTrains(
        boardResponse
      );

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      throw new Error(
        "RailRadar returned invalid train board data."
      );
    }

    console.log(
      `RailRadar returned ${trainsArray.length} board records.`
    );

    // --------------------------------------------------------
    // PRIORITIZE VERIFICATION
    // --------------------------------------------------------

    const verificationBatch =
      selectVerificationBatch(
        trainsArray
      );

    console.log(
      `Verification queue: ${trainsArray.length} trains`
    );

    console.log(
      `Prioritizing ${verificationBatch.length} trains closest/most urgent for Gudur.`
    );

    // --------------------------------------------------------
    // SHOW SELECTED TRAIN NUMBERS
    // --------------------------------------------------------

    console.log(
      "Verification priority:"
    );

    verificationBatch.forEach(
      (
        item,
        index
      ) => {
        const train =
          item?.train || {};

        const trainNo =
          String(
            train.number || "UNKNOWN"
          ).trim();

        const eta =
          getBoardEtaMinutes(
            item,
            getCurrentMinutes()
          );

        console.log(
          `  ${index + 1}. ${trainNo} | board ETA ${
            eta === null
              ? "unknown"
              : `${eta}m`
          }`
        );
      }
    );

    // --------------------------------------------------------
    // VERIFY LIVE DATA
    // --------------------------------------------------------

    const verifiedItems =
      [];

    for (
      let i = 0;
      i <
      verificationBatch.length;
      i++
    ) {
      const boardItem =
        verificationBatch[i];

      const train =
        boardItem?.train || {};

      const trainNo =
        String(
          train.number || ""
        ).trim();

      if (
        !trainNo
      ) {
        continue;
      }

      console.log(
        `[LIVE ${i + 1}/${verificationBatch.length}] Verifying ${trainNo}...`
      );

      try {
        const liveResponse =
          await verifyLiveTrain(
            trainNo
          );

        const merged =
          mergeVerifiedData(
            boardItem,
            liveResponse
          );

        verifiedItems.push(
          merged
        );
      } catch (error) {
        console.error(
          `[VERIFY ERROR] ${trainNo}: ${error.message}`
        );

        // Keep the board record as a fallback
        // for display/diagnostic purposes.
        verifiedItems.push(
          boardItem
        );
      }
    }

    // --------------------------------------------------------
    // PROCESS
    // --------------------------------------------------------

    const result =
      processVerifiedTrains(
        verifiedItems
      );

    const masGate =
      result.masGate;

    const tptyGate =
      result.tptyGate;

    const upcomingTrains =
      buildUpcomingList(
        result.processedTrains
      );

    // --------------------------------------------------------
    // FIREBASE
    // --------------------------------------------------------

    await writeFirebaseData(
      masGate,
      tptyGate,
      upcomingTrains,
      verifiedItems.length
    );

    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      ` -> Chennai Gate : ${masGate.status} | ${masGate.activeTrain}`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} | ${tptyGate.activeTrain}`
    );

    console.log(
      ` -> Verified trains: ${verifiedItems.length}`
    );

    console.log(
      ` -> Upcoming trains: ${upcomingTrains.length}`
    );

    console.log(
      ` -> API requests this minute: ${apiRequestsThisCycle}/${MAX_API_REQUESTS_PER_CYCLE}`
    );

    // --------------------------------------------------------
    // UPCOMING LOG
    // --------------------------------------------------------

    if (
      upcomingTrains.length > 0
    ) {
      console.log(
        "\n[UPCOMING / LIVE TRAINS]"
      );

      upcomingTrains.forEach(
        (train) => {
          console.log(
            `   ${train.trainNo} ${train.name} | ` +
            `${train.direction} | ` +
            `${train.distanceToGdrKm} km from GDR | ` +
            `ETA ${train.etaMinutes}m`
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

    console.log(
      "Cycle completed successfully."
    );

    console.log(
      "=========================================="
    );
  } catch (error) {
    // --------------------------------------------------------
    // ERROR LOG
    // --------------------------------------------------------

    if (
      error.response
    ) {
      console.error(
        `[ERROR] RailRadar HTTP ${error.response.status}`
      );

      console.error(
        "Response:",
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        `[ERROR] ${error.message}`
      );
    }

    // --------------------------------------------------------
    // FIREBASE ERROR STATE
    // --------------------------------------------------------

    await writeFirebaseError(
      error.message
    );
  }
}


// ============================================================
// START
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
  `Station -> Chennai Gate: approximately ${(CHENNAI_GATE_TO_GDR_KM * 1000).toFixed(2)} metres`
);

console.log(
  `Station -> Tirupati Gate: approximately ${(TIRUPATI_GATE_TO_GDR_KM * 1000).toFixed(2)} metres`
);

console.log(
  "=========================================="
);

console.log(
  `RailRadar API: ${
    RAILRADAR_API_KEY
      ? "Configured"
      : "MISSING"
  }`
);

console.log(
  `Firebase: ${
    serviceAccount
      ? "Configured"
      : "MISSING"
  }`
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
  `API request target: ${MAX_API_REQUESTS_PER_CYCLE}/cycle`
);

console.log(
  `Live verification: ${VERIFY_PER_CYCLE} trains/cycle`
);

console.log(
  "Verification: nearest/most urgent trains prioritized"
);

console.log(
  "Upcoming: passed-gate trains automatically removed"
);

console.log(
  "=========================================="
);


// ============================================================
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();


// ============================================================
// LOCAL MODE
// ============================================================
//
// GitHub Actions:
//   Set GITHUB_ACTIONS=true
//   One cycle runs and exits.
//
// Local:
//   Runs every 60 seconds.
//

if (
  !process.env.GITHUB_ACTIONS
) {
  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}