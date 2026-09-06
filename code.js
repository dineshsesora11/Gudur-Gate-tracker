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

let serviceAccount;

try {
  if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    throw new Error(
      `${SERVICE_ACCOUNT_FILE} not found`
    );
  }

  serviceAccount =
    require(SERVICE_ACCOUNT_FILE);

} catch (error) {
  console.error(
    "❌ Could not load serviceAccountKey.json"
  );

  console.error(
    "Make sure serviceAccountKey.json is in the same folder as code.js"
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

const CHENNAI_GATE_LAT =
  14.1396639;

const CHENNAI_GATE_LNG =
  79.8441306;

const TIRUPATI_GATE_LAT =
  14.1402056;

const TIRUPATI_GATE_LNG =
  79.8436;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;

const GATE_STOP_DISTANCE_KM = 0.6;

const MAX_LIVE_REQUESTS = 7;

const REFRESH_INTERVAL_MS =
  180000;

const DEFAULT_SPEED_KMH = 55;

const MIN_SPEED_KMH = 5;

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
// GENERIC TEXT MATCH
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
// HAVERSINE DISTANCE
// ============================================================

function haversineKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  if (
    lat1 == null ||
    lng1 == null ||
    lat2 == null ||
    lng2 == null
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    ((lat2 - lat1) *
      Math.PI) /
    180;

  const dLng =
    ((lng2 - lng1) *
      Math.PI) /
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
// SAFE NUMBER
// ============================================================

function numberOrNull(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

// ============================================================
// GET ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    train.origin?.name ||
    train.origin?.code ||
    train.source?.name ||
    train.source?.code ||
    train.fromStation?.name ||
    train.fromStation?.code ||
    train.from ||
    train.startStation?.name ||
    train.startStation?.code ||
    train.start ||
    item.origin?.name ||
    item.origin?.code ||
    item.source?.name ||
    item.source?.code ||
    item.from ||
    item.fromStation?.name ||
    item.fromStation?.code ||
    item.startStation?.name ||
    item.startStation?.code ||
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
    train.destination?.name ||
    train.destination?.code ||
    train.toStation?.name ||
    train.toStation?.code ||
    train.to ||
    train.endStation?.name ||
    train.endStation?.code ||
    item.destination?.name ||
    item.destination?.code ||
    item.to ||
    item.toStation?.name ||
    item.toStation?.code ||
    ""
  );
}

// ============================================================
// ORIGIN SIDE DETECTION
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const originText =
    getOrigin(train, item);

  return containsAny(
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
  );
}

// ============================================================
// TIRUPATI SIDE DETECTION
// ============================================================

function isFromTirupatiSide(
  train,
  item
) {
  const originText =
    getOrigin(train, item);

  return containsAny(
    originText,
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
// ROUTE HELPERS
// ============================================================

function getRoute(
  train,
  live,
  item
) {
  return (
    live.route ||
    train.route ||
    item.route ||
    []
  );
}

function getRouteStationCode(
  stop
) {
  return normalizeText(
    stop?.stationCode ||
      stop?.code ||
      stop?.station?.code ||
      ""
  );
}

function getRouteStationName(
  stop
) {
  return normalizeText(
    stop?.stationName ||
      stop?.name ||
      stop?.station?.name ||
      ""
  );
}

// ============================================================
// FIND ROUTE STATION BY SEQUENCE
// ============================================================

function findRouteBySequence(
  route,
  sequence
) {
  if (
    !Array.isArray(route) ||
    sequence == null
  ) {
    return null;
  }

  return (
    route.find(
      (stop) =>
        Number(stop?.sequence) ===
        Number(sequence)
    ) || null
  );
}

// ============================================================
// FIND GDR ROUTE STOP
// ============================================================

function findGudurRouteStop(
  route
) {
  if (!Array.isArray(route)) {
    return null;
  }

  return (
    route.find((stop) => {
      const code =
        getRouteStationCode(stop);

      const name =
        getRouteStationName(stop);

      return (
        code === "GDR" ||
        name.includes("GUDUR")
      );
    }) || null
  );
}

// ============================================================
// FIND ROUTE ANCHOR
// ============================================================

function findRouteAnchor(
  route,
  codes,
  names
) {
  if (!Array.isArray(route)) {
    return null;
  }

  return (
    route.find((stop) => {
      const code =
        getRouteStationCode(stop);

      const name =
        getRouteStationName(stop);

      return (
        codes.includes(code) ||
        names.some((x) =>
          name.includes(
            normalizeText(x)
          )
        )
      );
    }) || null
  );
}

// ============================================================
// ROUTE SIDE DETECTION
// ============================================================

function determineRouteCorridor(
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

  const currentSequence =
    Number(
      live.currentLocation?.sequence ??
        train.currentLocation?.sequence ??
        item.currentLocation?.sequence
    );

  const gdrStop =
    findGudurRouteStop(route);

  const gdrSequence =
    gdrStop
      ? Number(gdrStop.sequence)
      : null;

  const masAnchor =
    findRouteAnchor(
      route,
      ["MAS"],
      [
        "CHENNAI",
        "CHENNAI CENTRAL",
        "MGR CHENNAI CENTRAL"
      ]
    );

  const tptyAnchor =
    findRouteAnchor(
      route,
      ["TPTY"],
      [
        "TIRUPATI",
        "TIRUPATI MAIN"
      ]
    );

  const masSeq =
    masAnchor
      ? Number(masAnchor.sequence)
      : null;

  const tptySeq =
    tptyAnchor
      ? Number(tptyAnchor.sequence)
      : null;

  // ----------------------------------------------------------
  // If current train sequence is BEFORE GDR
  // ----------------------------------------------------------

  if (
    gdrSequence != null &&
    Number.isFinite(currentSequence) &&
    currentSequence < gdrSequence
  ) {
    if (
      masSeq != null &&
      masSeq < gdrSequence
    ) {
      return "MAS";
    }

    if (
      tptySeq != null &&
      tptySeq < gdrSequence
    ) {
      return "TPTY";
    }
  }

  // ----------------------------------------------------------
  // If current train sequence is AFTER GDR
  // ----------------------------------------------------------

  if (
    gdrSequence != null &&
    Number.isFinite(currentSequence) &&
    currentSequence > gdrSequence
  ) {
    if (
      masSeq != null &&
      masSeq > gdrSequence
    ) {
      return "MAS";
    }

    if (
      tptySeq != null &&
      tptySeq > gdrSequence
    ) {
      return "TPTY";
    }

    // If only one side anchor exists,
    // the opposite side is the other corridor.

    if (
      masSeq != null &&
      masSeq < gdrSequence
    ) {
      return "TPTY";
    }

    if (
      tptySeq != null &&
      tptySeq < gdrSequence
    ) {
      return "MAS";
    }
  }

  // ----------------------------------------------------------
  // At GDR
  // ----------------------------------------------------------

  if (
    gdrSequence != null &&
    Number.isFinite(currentSequence) &&
    currentSequence === gdrSequence
  ) {
    const destination =
      normalizeText(
        getDestination(
          train,
          item
        )
      );

    if (
      destination.includes(
        "TIRUPATI"
      ) ||
      destination.includes(
        "TPTY"
      )
    ) {
      return "TPTY";
    }

    if (
      destination.includes(
        "CHENNAI"
      ) ||
      destination.includes(
        "MAS"
      )
    ) {
      return "MAS";
    }

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
  }

  // ----------------------------------------------------------
  // Origin fallback
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
  // Known train fallback
  // ----------------------------------------------------------

  const trainNo =
    String(
      train.number || ""
    ).trim();

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
// EXTRACT ACTUAL GPS POSITION
// ============================================================

function extractGpsPosition(
  train,
  live,
  item
) {
  const candidates = [
    live.currentLocation,
    train.currentLocation,
    item.currentLocation,
    live,
    train,
    item
  ];

  for (
    const source of candidates
  ) {
    if (!source) {
      continue;
    }

    const lat =
      numberOrNull(
        source.lat ??
          source.latitude
      );

    const lng =
      numberOrNull(
        source.lng ??
          source.longitude
      );

    if (
      lat != null &&
      lng != null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return {
        lat,
        lng,

        speedKmh:
          numberOrNull(
            source.speedKmh ??
              source.speed ??
              source.speedKmph
          ),

        bearingDegrees:
          numberOrNull(
            source.bearingDegrees ??
              source.bearing
          ),

        isActualPosition:
          source.isActualPosition === true,

        source:
          "GPS"
      };
    }
  }

  return null;
}

// ============================================================
// NEW:
// EXTRACT ACTUAL STATION-CODE POSITION
// ============================================================
//
// RailRadar can report:
// currentLocation.stationCode = GDR
// currentLocation.sequence = 28
//
// The route stop at sequence 28 can contain:
// lat / lng
//
// We use that coordinate as the ACTUAL position
// when RailRadar says isActualPosition=true.
//
// ============================================================

function extractStationCodePosition(
  train,
  live,
  item
) {
  const currentLocation =
    live.currentLocation ||
    train.currentLocation ||
    item.currentLocation;

  if (!currentLocation) {
    return null;
  }

  const stationCode =
    normalizeText(
      currentLocation.stationCode ||
        currentLocation.code ||
        ""
    );

  const sequence =
    numberOrNull(
      currentLocation.sequence
    );

  if (
    !stationCode &&
    sequence == null
  ) {
    return null;
  }

  const route =
    getRoute(
      train,
      live,
      item
    );

  if (!Array.isArray(route)) {
    return null;
  }

  let routeStop = null;

  // First try exact sequence.
  if (sequence != null) {
    routeStop =
      findRouteBySequence(
        route,
        sequence
      );
  }

  // If sequence didn't match,
  // try station code.
  if (
    !routeStop &&
    stationCode
  ) {
    routeStop =
      route.find(
        (stop) =>
          getRouteStationCode(
            stop
          ) === stationCode
      ) || null;
  }

  if (!routeStop) {
    return null;
  }

  const lat =
    numberOrNull(
      routeStop.lat ??
        routeStop.latitude ??
        routeStop.station?.lat ??
        routeStop.station?.latitude
    );

  const lng =
    numberOrNull(
      routeStop.lng ??
        routeStop.longitude ??
        routeStop.station?.lng ??
        routeStop.station?.longitude
    );

  if (
    lat == null ||
    lng == null
  ) {
    return null;
  }

  return {
    lat,
    lng,

    speedKmh:
      numberOrNull(
        currentLocation.speedKmh
      ),

    bearingDegrees:
      numberOrNull(
        currentLocation.bearingDegrees
      ),

    isActualPosition:
      currentLocation.isActualPosition === true,

    source:
      "STATION_CODE_COORDINATES",

    stationCode:
      stationCode ||
      getRouteStationCode(
        routeStop
      ),

    stationName:
      getRouteStationName(
        routeStop
      ),

    sequence:
      sequence ??
      Number(routeStop.sequence)
  };
}

// ============================================================
// EXTRACT ROUTE INTERPOLATED POSITION
// ============================================================
//
// This is DISPLAY / ETA ONLY.
// It MUST NOT be used for gate closure.
//
// ============================================================

function extractInterpolatedRoutePosition(
  train,
  live,
  item
) {
  const currentLocation =
    live.currentLocation ||
    train.currentLocation ||
    item.currentLocation;

  if (!currentLocation) {
    return null;
  }

  const sequence =
    numberOrNull(
      currentLocation.sequence
    );

  const progress =
    numberOrNull(
      currentLocation.segmentProgress
    );

  if (
    sequence == null ||
    progress == null
  ) {
    return null;
  }

  const route =
    getRoute(
      train,
      live,
      item
    );

  if (!Array.isArray(route)) {
    return null;
  }

  const currentStop =
    findRouteBySequence(
      route,
      sequence
    );

  const nextStop =
    findRouteBySequence(
      route,
      sequence + 1
    );

  if (
    !currentStop ||
    !nextStop
  ) {
    return null;
  }

  const lat1 =
    numberOrNull(
      currentStop.lat
    );

  const lng1 =
    numberOrNull(
      currentStop.lng
    );

  const lat2 =
    numberOrNull(
      nextStop.lat
    );

  const lng2 =
    numberOrNull(
      nextStop.lng
    );

  if (
    lat1 == null ||
    lng1 == null ||
    lat2 == null ||
    lng2 == null
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

  return {
    lat:
      lat1 +
      (lat2 - lat1) * p,

    lng:
      lng1 +
      (lng2 - lng1) * p,

    speedKmh:
      numberOrNull(
        currentLocation.speedKmh
      ),

    bearingDegrees:
      numberOrNull(
        currentLocation.bearingDegrees
      ),

    isActualPosition:
      false,

    source:
      "ROUTE_INTERPOLATED",

    stationCode:
      currentLocation.stationCode ||
      "",

    sequence
  };
}

// ============================================================
// BEST POSITION
// ============================================================
//
// Priority:
//
// 1. Actual GPS
// 2. Actual station-code coordinates
// 3. Route interpolation
//
// Gate closure may ONLY use 1 or 2.
//
// ============================================================

function getBestPosition(
  train,
  live,
  item
) {
  const gps =
    extractGpsPosition(
      train,
      live,
      item
    );

  if (
    gps &&
    gps.isActualPosition
  ) {
    return gps;
  }

  const stationCodePosition =
    extractStationCodePosition(
      train,
      live,
      item
    );

  if (
    stationCodePosition &&
    stationCodePosition.isActualPosition
  ) {
    return stationCodePosition;
  }

  const interpolated =
    extractInterpolatedRoutePosition(
      train,
      live,
      item
    );

  if (interpolated) {
    return interpolated;
  }

  // Non-authoritative GPS can still
  // be useful for display.

  if (gps) {
    return gps;
  }

  return null;
}

// ============================================================
// CALCULATE GATE DISTANCES
// ============================================================

function calculateGateDistances(
  position
) {
  if (!position) {
    return {
      chennaiGateDistanceKm:
        null,

      tirupatiGateDistanceKm:
        null
    };
  }

  return {
    chennaiGateDistanceKm:
      haversineKm(
        position.lat,
        position.lng,
        CHENNAI_GATE_LAT,
        CHENNAI_GATE_LNG
      ),

    tirupatiGateDistanceKm:
      haversineKm(
        position.lat,
        position.lng,
        TIRUPATI_GATE_LAT,
        TIRUPATI_GATE_LNG
      )
  };
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function calculateGudurDistance(
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
// ROUTE DISTANCE TO GUDUR
// ============================================================
//
// Used only as a fallback/display value.
// NOT used for gate closure.
//
// ============================================================

function calculateRouteDistanceToGudur(
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

  const currentLocation =
    live.currentLocation ||
    train.currentLocation ||
    item.currentLocation;

  if (
    !Array.isArray(route) ||
    !currentLocation
  ) {
    return null;
  }

  const currentSequence =
    numberOrNull(
      currentLocation.sequence
    );

  if (currentSequence == null) {
    return null;
  }

  const gdrStop =
    findGudurRouteStop(route);

  if (!gdrStop) {
    return null;
  }

  const gdrDistance =
    numberOrNull(
      gdrStop.distance
    );

  const currentStop =
    findRouteBySequence(
      route,
      currentSequence
    );

  const currentDistance =
    numberOrNull(
      currentStop?.distance ??
        currentLocation.distanceFromOriginKm
    );

  if (
    gdrDistance == null ||
    currentDistance == null
  ) {
    return null;
  }

  return Math.abs(
    gdrDistance -
      currentDistance
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
  const route =
    getRoute(
      train,
      live,
      item
    );

  const currentLocation =
    live.currentLocation ||
    train.currentLocation ||
    item.currentLocation;

  if (
    !Array.isArray(route) ||
    !currentLocation
  ) {
    return "UNKNOWN";
  }

  const currentSequence =
    numberOrNull(
      currentLocation.sequence
    );

  const gdrStop =
    findGudurRouteStop(route);

  if (
    currentSequence == null ||
    !gdrStop
  ) {
    return "UNKNOWN";
  }

  const gdrSequence =
    numberOrNull(
      gdrStop.sequence
    );

  if (gdrSequence == null) {
    return "UNKNOWN";
  }

  if (
    currentSequence <
    gdrSequence
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    currentSequence >
    gdrSequence
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return "AT_GUDUR";
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function getDirectionText(
  train,
  live,
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

    item.direction,
    item.travelDirection,
    item.routeDirection,
    item.runningDirection,

    live.currentLocation?.direction,
    live.currentLocation?.travelDirection
  ];

  return fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// GET TRAVEL DIRECTION
// ============================================================

function getTravelDirection(
  train,
  live,
  item
) {
  const explicit =
    getDirectionText(
      train,
      live,
      item
    );

  if (
    explicit.includes(
      "TOWARD GUDUR"
    ) ||
    explicit.includes(
      "TOWARDS GUDUR"
    ) ||
    explicit.includes(
      "TO GUDUR"
    ) ||
    explicit.includes(
      "INBOUND"
    ) ||
    explicit.includes(
      "APPROACHING GUDUR"
    )
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    explicit.includes(
      "AWAY FROM GUDUR"
    ) ||
    explicit.includes(
      "FROM GUDUR"
    ) ||
    explicit.includes(
      "OUTBOUND"
    ) ||
    explicit.includes(
      "TO CHENNAI"
    ) ||
    explicit.includes(
      "TOWARD CHENNAI"
    ) ||
    explicit.includes(
      "TOWARDS CHENNAI"
    ) ||
    explicit.includes(
      "TO TIRUPATI"
    ) ||
    explicit.includes(
      "TOWARD TIRUPATI"
    ) ||
    explicit.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return getRouteDirection(
    train,
    live,
    item
  );
}

// ============================================================
// DETERMINE INBOUND CORRIDOR
// ============================================================
//
// This is ONLY for the UPCOMING TRAIN LIST.
//
// Gate closure does NOT use this filter.
//
// ============================================================

function determineInboundCorridor(
  train,
  live,
  item
) {
  const direction =
    getTravelDirection(
      train,
      live,
      item
    );

  if (
    direction !==
    "TOWARD_GUDUR"
  ) {
    return null;
  }

  const corridor =
    determineRouteCorridor(
      train,
      live,
      item
    );

  if (
    corridor === "MAS" ||
    corridor === "TPTY"
  ) {
    return corridor;
  }

  return null;
}

// ============================================================
// DETERMINE PHYSICAL GATE CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// This works for BOTH directions.
//
// Chennai Gate:
//   Chennai -> Gudur
//   Gudur -> Chennai
//
// Tirupati Gate:
//   Tirupati -> Gudur
//   Gudur -> Tirupati
//
// ============================================================

function determinePhysicalGateCorridor(
  train,
  live,
  item,
  position
) {
  const corridor =
    determineRouteCorridor(
      train,
      live,
      item
    );

  if (
    corridor === "MAS" ||
    corridor === "TPTY"
  ) {
    return corridor;
  }

  // ----------------------------------------------------------
  // If position is available, use nearest gate only as
  // a fallback when route-side detection is unavailable.
  // ----------------------------------------------------------

  const distances =
    calculateGateDistances(
      position
    );

  if (
    distances.chennaiGateDistanceKm !=
      null &&
    distances.tirupatiGateDistanceKm !=
      null
  ) {
    if (
      distances.chennaiGateDistanceKm <=
      distances.tirupatiGateDistanceKm
    ) {
      return "MAS";
    }

    return "TPTY";
  }

  return "UNKNOWN";
}

// ============================================================
// PARSE TIME
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

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// FETCH LIVE TRAIN
// ============================================================
//
// IMPORTANT:
// includeCoordinates=true
//
// This gives route stops their station coordinates,
// allowing STATION_CODE actual positions to be converted
// into latitude/longitude.
//
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const endpoints = [
    `/trains/${trainNo}/live`,
    `/trains/${trainNo}`,
    `/train/${trainNo}/live`
  ];

  let lastError = null;

  for (
    const endpoint of endpoints
  ) {
    try {
      const response =
        await axios.get(
          `${RAILRADAR_BASE_URL}${endpoint}`,
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

            timeout: 12000
          }
        );

      return response.data;

    } catch (error) {
      lastError = error;

      if (
        error.response?.status ===
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
      `Live train ${trainNo} not found`
    )
  );
}

// ============================================================
// FETCH STATION BOARD
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

        timeout: 12000
      }
    );

  return response.data;
}

// ============================================================
// MERGE LIVE DATA
// ============================================================

function mergeVerifiedData(
  item,
  liveResponse
) {
  const data =
    liveResponse?.data ||
    liveResponse ||
    {};

  const merged = {
    ...item,

    ...(data.train
      ? {
          train: {
            ...(item.train || {}),
            ...data.train
          }
        }
      : {}),

    live: {
      ...(item.live || {}),
      ...(data.live || {})
    },

    stop: {
      ...(item.stop || {}),
      ...(data.stop || {})
    }
  };

  // ----------------------------------------------------------
  // Preserve important top-level live fields
  // ----------------------------------------------------------

  const importantFields = [
    "currentLocation",
    "previousHalt",
    "nextHalt",
    "route",
    "delayMinutes",
    "isLive",
    "status",
    "lastUpdatedAt"
  ];

  for (
    const field of importantFields
  ) {
    if (
      data[field] !== undefined
    ) {
      merged.live[field] =
        data[field];
    }
  }

  // ----------------------------------------------------------
  // Some responses put currentLocation
  // directly inside data.
  // ----------------------------------------------------------

  if (
    data.currentLocation
  ) {
    merged.live.currentLocation =
      data.currentLocation;
  }

  if (
    data.route
  ) {
    merged.live.route =
      data.route;
  }

  return merged;
}

// ============================================================
// PROCESS TRAIN
// ============================================================

function processTrain(
  item
) {
  const train =
    item.train || {};

  const live =
    item.live || {};

  const stop =
    item.stop || {};

  const trainNo =
    String(
      train.number ||
        item.trainNumber ||
        ""
    ).trim();

  const trainName =
    train.name ||
    item.trainName ||
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
      live.delayMinutes ??
        item.delayMinutes ??
        0
    );

  // ----------------------------------------------------------
  // POSITION
  // ----------------------------------------------------------

  const position =
    getBestPosition(
      train,
      live,
      item
    );

  // ----------------------------------------------------------
  // DISTANCES
  // ----------------------------------------------------------

  const physicalDistances =
    calculateGateDistances(
      position
    );

  const actualPosition =
    position &&
    position.isActualPosition ===
      true;

  const physicalGdrDistance =
    actualPosition
      ? calculateGudurDistance(
          position
        )
      : null;

  const routeGdrDistance =
    calculateRouteDistanceToGudur(
      train,
      live,
      item
    );

  const displayGdrDistance =
    physicalGdrDistance ??
    routeGdrDistance;

  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  const direction =
    getTravelDirection(
      train,
      live,
      item
    );

  // ----------------------------------------------------------
  // CORRIDOR
  // ----------------------------------------------------------

  const corridor =
    determineRouteCorridor(
      train,
      live,
      item
    );

  const physicalGateCorridor =
    determinePhysicalGateCorridor(
      train,
      live,
      item,
      position
    );

  // ----------------------------------------------------------
  // UPCOMING CORRIDOR
  // ----------------------------------------------------------

  const inboundCorridor =
    determineInboundCorridor(
      train,
      live,
      item
    );

  // ----------------------------------------------------------
  // ACTUAL GATE DISTANCE
  // ----------------------------------------------------------

  let physicalGateDistanceKm =
    null;

  if (
    physicalGateCorridor ===
    "MAS"
  ) {
    physicalGateDistanceKm =
      physicalDistances.chennaiGateDistanceKm;
  }

  if (
    physicalGateCorridor ===
    "TPTY"
  ) {
    physicalGateDistanceKm =
      physicalDistances.tirupatiGateDistanceKm;
  }

  // ----------------------------------------------------------
  // TIME
  // ----------------------------------------------------------

  const arrTimeStr =
    stop.arrival ||
    stop.scheduledArrival ||
    live.expectedArrivalTime ||
    "";

  const depTimeStr =
    stop.departure ||
    stop.scheduledDeparture ||
    live.expectedDepartureTime ||
    arrTimeStr;

  const now =
    new Date();

  const currentMin =
    now.getHours() * 60 +
    now.getMinutes();

  const arrMin =
    parseTimeToMinutes(
      arrTimeStr,
      delayMinutes
    );

  const depMin =
    parseTimeToMinutes(
      depTimeStr,
      delayMinutes
    );

  let etaMinutes = null;

  if (arrMin !== -1) {
    etaMinutes =
      Math.max(
        0,
        calculateTimeDifference(
          arrMin,
          currentMin
        )
      );
  }

  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  const currentLocation =
    live.currentLocation ||
    train.currentLocation ||
    item.currentLocation ||
    {};

  const currentStationCode =
    normalizeText(
      currentLocation.stationCode ||
        currentLocation.code ||
        ""
    );

  const atGudur =
    currentStationCode ===
      "GDR" ||
    (
      physicalGdrDistance !=
        null &&
      physicalGdrDistance <=
        1
    );

  // ----------------------------------------------------------
  // PASSED GUDUR
  // ----------------------------------------------------------

  const routeDirection =
    getRouteDirection(
      train,
      live,
      item
    );

  const passedGudur =
    routeDirection ===
    "AWAY_FROM_GUDUR";

  return {
    trainNo,

    trainName,

    origin:
      origin ||
      "Unknown",

    destination:
      destination ||
      "Unknown",

    direction,

    corridor,

    inboundCorridor,

    physicalGateCorridor,

    positionSource:
      position?.source ||
      "NONE",

    actualPosition,

    stationCode:
      position?.stationCode ||
      currentStationCode ||
      "",

    stationName:
      position?.stationName ||
      "",

    latitude:
      position?.lat ??
      null,

    longitude:
      position?.lng ??
      null,

    distanceToGudurKm:
      displayGdrDistance,

    actualDistanceToGudurKm:
      physicalGdrDistance,

    routeDistanceToGudurKm:
      routeGdrDistance,

    distanceToChennaiGateKm:
      physicalDistances.chennaiGateDistanceKm,

    distanceToTirupatiGateKm:
      physicalDistances.tirupatiGateDistanceKm,

    physicalGateDistanceKm,

    delayMinutes,

    etaMinutes,

    atGudur,

    passedGudur,

    speedKmh:
      position?.speedKmh ??
      null,

    platform:
      String(
        live.platform ||
          stop.platform ||
          "1"
      )
  };
}

// ============================================================
// SHOULD SHOW UPCOMING
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
    processed.inboundCorridor !==
      "MAS" &&
    processed.inboundCorridor !==
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
    processed.passedGudur
  ) {
    return false;
  }

  if (
    processed.distanceToGudurKm ==
    null
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
// SHOULD CLOSE GATE
// ============================================================
//
// IMPORTANT:
//
// BOTH DIRECTIONS.
//
// We NEVER reject AWAY_FROM_GUDUR.
//
// Example:
//
// Chennai -> Gudur
//       => Chennai Gate CLOSE
//
// Gudur -> Chennai
//       => Chennai Gate CLOSE
//
// Tirupati -> Gudur
//       => Tirupati Gate CLOSE
//
// Gudur -> Tirupati
//       => Tirupati Gate CLOSE
//
// Gate closure requires an ACTUAL position.
// Route interpolation cannot close a gate.
//
// ============================================================

function shouldCloseGate(
  processed,
  gateType
) {
  if (!processed) {
    return false;
  }

  // ----------------------------------------------------------
  // NEVER close using estimated/interpolated position
  // ----------------------------------------------------------

  if (
    !processed.actualPosition
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // Physical gate assignment
  // ----------------------------------------------------------

  if (
    processed.physicalGateCorridor !==
    gateType
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // Distance to the physical gate
  // ----------------------------------------------------------

  if (
    processed.physicalGateDistanceKm ==
    null
  ) {
    return false;
  }

  return (
    processed.physicalGateDistanceKm <=
    GATE_STOP_DISTANCE_KM
  );
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

    console.log(
      `\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // --------------------------------------------------------
    // API KEY CHECK
    // --------------------------------------------------------

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY is missing"
      );
    }

    // --------------------------------------------------------
    // STATION BOARD
    // --------------------------------------------------------

    const boardResponse =
      await fetchStationBoard();

    const responseBody =
      boardResponse;

    const trainsArray =
      responseBody?.data?.trains ||
      [];

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      throw new Error(
        "RailRadar returned invalid train data"
      );
    }

    console.log(
      `RailRadar returned ${trainsArray.length} board records.`
    );

    // --------------------------------------------------------
    // BUILD VERIFICATION QUEUE
    // --------------------------------------------------------
    //
    // We currently verify the first MAX_LIVE_REQUESTS.
    // Step 3 can improve prioritization after Step 1 works.
    //
    // --------------------------------------------------------

    const verificationQueue =
      trainsArray.slice(
        0,
        22
      );

    console.log(
      `Verification queue: ${verificationQueue.length}`
    );

    console.log(
      `Live verification: ${Math.min(
        MAX_LIVE_REQUESTS,
        verificationQueue.length
      )}`
    );

    // --------------------------------------------------------
    // DEFAULT GATES
    // --------------------------------------------------------

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear"
    };

    const upcomingList =
      [];

    const verifiedTrains =
      [];

    let apiRequests = 1;

    // --------------------------------------------------------
    // VERIFY LIVE TRAINS
    // --------------------------------------------------------

    for (
      let i = 0;
      i <
        Math.min(
          MAX_LIVE_REQUESTS,
          verificationQueue.length
        );
      i++
    ) {
      const item =
        verificationQueue[i];

      const train =
        item.train || {};

      const trainNo =
        String(
          train.number ||
            item.trainNumber ||
            ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      console.log(
        `\n[LIVE REQUEST ${i + 1}/${MAX_LIVE_REQUESTS}] ${trainNo}`
      );

      try {
        const liveResponse =
          await fetchLiveTrain(
            trainNo
          );

        apiRequests++;

        const merged =
          mergeVerifiedData(
            item,
            liveResponse
          );

        const processed =
          processTrain(
            merged
          );

        verifiedTrains.push(
          processed
        );

        console.log(
          `[LIVE] ${processed.trainNo} ${processed.trainName}`
        );

        console.log(
          `       Direction: ${processed.direction}`
        );

        console.log(
          `       Corridor: ${processed.corridor}`
        );

        console.log(
          `       GDR: ${
            processed.distanceToGudurKm !=
            null
              ? `${Number(
                  processed.distanceToGudurKm.toFixed(
                    2
                  )
                )}km (${processed.actualDistanceToGudurKm != null ? "ACTUAL" : "ROUTE"})`
              : "?km (NONE)"
          }`
        );

        console.log(
          `       Chennai Gate: ${
            processed.distanceToChennaiGateKm !=
            null
              ? `${Number(
                  processed.distanceToChennaiGateKm.toFixed(
                    3
                  )
                )}km`
              : "?km (NONE)"
          }`
        );

        console.log(
          `       Tirupati Gate: ${
            processed.distanceToTirupatiGateKm !=
            null
              ? `${Number(
                  processed.distanceToTirupatiGateKm.toFixed(
                    3
                  )
                )}km`
              : "?km (NONE)"
          }`
        );

        console.log(
          `       Position: ${processed.positionSource}`
        );

        // ------------------------------------------------------
        // UPCOMING TRAINS
        // ------------------------------------------------------

        if (
          shouldShowUpcoming(
            processed
          )
        ) {
          upcomingList.push({
            trainNo:
              processed.trainNo,

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
              processed.inboundCorridor,

            direction:
              "TOWARD_GUDUR",

            distanceToGudurKm:
              processed.distanceToGudurKm,

            platform:
              processed.platform
          });
        }

        // ------------------------------------------------------
        // CHENNAI GATE
        // ------------------------------------------------------

        if (
          shouldCloseGate(
            processed,
            "MAS"
          )
        ) {
          const waitMinutes =
            Math.max(
              1,
              processed.etaMinutes !=
                null
                ? processed.etaMinutes +
                    2
                : 5
            );

          masGate = {
            status:
              "CLOSED",

            waitMinutes,

            activeTrain:
              `${processed.trainNo} ${processed.trainName}`,

            direction:
              processed.direction,

            corridor:
              "MAS",

            distanceKm:
              Number(
                processed.distanceToChennaiGateKm.toFixed(
                  3
                )
              ),

            positionSource:
              processed.positionSource
          };
        }

        // ------------------------------------------------------
        // TIRUPATI GATE
        // ------------------------------------------------------

        if (
          shouldCloseGate(
            processed,
            "TPTY"
          )
        ) {
          const waitMinutes =
            Math.max(
              1,
              processed.etaMinutes !=
                null
                ? processed.etaMinutes +
                    2
                : 5
            );

          tptyGate = {
            status:
              "CLOSED",

            waitMinutes,

            activeTrain:
              `${processed.trainNo} ${processed.trainName}`,

            direction:
              processed.direction,

            corridor:
              "TPTY",

            distanceKm:
              Number(
                processed.distanceToTirupatiGateKm.toFixed(
                  3
                )
              ),

            positionSource:
              processed.positionSource
          };
        }

      } catch (error) {
        apiRequests++;

        console.error(
          `[LIVE ERROR] ${trainNo}: ${error.message}`
        );
      }
    }

    // --------------------------------------------------------
    // SORT UPCOMING
    // --------------------------------------------------------

    upcomingList.sort(
      (a, b) =>
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

    // --------------------------------------------------------
    // WRITE FIREBASE
    // --------------------------------------------------------

    const durationSeconds =
      (
        (Date.now() -
          cycleStart) /
        1000
      );

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

    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // UPCOMING LOG
    // --------------------------------------------------------

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (t) => {
          console.log(
            `   ${t.corridor} | ${t.trainNo} ${t.name} | ETA ${t.etaMinutes}m | GDR ${t.distanceToGudurKm != null ? `${Number(t.distanceToGudurKm.toFixed(2))}km` : "?km"}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    console.log(
      "\n[GATE LOGIC]"
    );

    console.log(
      "   Chennai Gate = BOTH DIRECTIONS"
    );

    console.log(
      "   Tirupati Gate = BOTH DIRECTIONS"
    );

    console.log(
      "   Gate closure requires ACTUAL position"
    );

    console.log(
      "   Station-code positions use route coordinates"
    );

    console.log(
      "=========================================="
    );

  } catch (error) {
    console.error(
      "\n❌ MONITOR ERROR:",
      error.message
    );

    try {
      await gateRef.set({
        tirupatiGate: {
          status: "OPEN",
          waitMinutes: 0,
          activeTrain:
            "Tracks clear"
        },

        chennaiGate: {
          status: "OPEN",
          waitMinutes: 0,
          activeTrain:
            "Tracks clear"
        },

        upcomingTrains: [],

        lastUpdated:
          new Date().toLocaleTimeString(),

        lastUpdatedLocal:
          new Date().toLocaleString(),

        verifiedTrains: 0,

        apiRequests: 0,

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
// GITHUB ACTIONS
// ============================================================

if (
  process.env.GITHUB_ACTIONS
) {
  updateGateSystem()
    .then(() => {
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
    })
    .catch((error) => {
      console.error(
        "\n❌ Monitor cycle failed:"
      );

      console.error(error);

      process.exit(1);
    });

} else {
  updateGateSystem();

  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}
