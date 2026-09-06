const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

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
    serviceAccount =
      require("./serviceAccountKey.json");

    console.log(
      "Firebase service account: serviceAccountKey.json"
    );
  }
} catch (error) {
  console.error(
    "❌ Firebase service account could not be loaded."
  );

  console.error(
    "Use FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json"
  );

  console.error(error.message);

  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// LOCATIONS
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

// Upcoming trains can be shown up to 6 hours ahead.
const UPCOMING_MAX_ETA_MINUTES = 360;

// Only show upcoming trains within this distance when
// physical distance is available.
const UPCOMING_MAX_DISTANCE_KM = 150;

// Actual gate closure distance.
const GATE_STOP_DISTANCE_KM = 0.60;

// Station board request.
const STATION_BOARD_HOURS = 4;

// Maximum board trains processed.
const MAX_BOARD_CANDIDATES = 22;

// Maximum live requests used for gate verification.
// Keep this limited because RailRadar API requests are costly.
const MAX_LIVE_VERIFICATIONS = 7;

// Default train speed when GPS speed is unavailable.
const DEFAULT_SPEED_KMH = 55;

const MIN_SPEED_KMH = 5;

// ============================================================
// TIRUPATI-SIDE FALLBACK TRAINS
// ============================================================
//
// IMPORTANT:
//
// This is NOT used to determine whether a train is physically
// close to the gate.
//
// It is only a fallback for identifying the TPTY corridor
// when RailRadar does not expose route information.
//
// ============================================================

const TPTY_FALLBACK_TRAINS =
  new Set([
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
    "07670"
  ]);

// ============================================================
// NORMALIZE TEXT
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
// NUMBER
// ============================================================

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// ============================================================
// NESTED VALUE FINDER
// ============================================================

function findNested(
  object,
  keys,
  depth = 5
) {
  if (
    object === null ||
    object === undefined ||
    depth < 0
  ) {
    return null;
  }

  if (
    typeof object !== "object"
  ) {
    return null;
  }

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(
        object,
        key
      )
    ) {
      const value =
        object[key];

      if (
        value !== null &&
        value !== undefined &&
        value !== ""
      ) {
        return value;
      }
    }
  }

  for (
    const key of Object.keys(object)
  ) {
    const child =
      object[key];

    if (
      child &&
      typeof child === "object"
    ) {
      const result =
        findNested(
          child,
          keys,
          depth - 1
        );

      if (
        result !== null &&
        result !== undefined &&
        result !== ""
      ) {
        return result;
      }
    }
  }

  return null;
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return String(
    train?.number ||
    train?.trainNumber ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  train,
  item
) {
  return (
    train?.name ||
    train?.trainName ||
    item?.trainName ||
    item?.name ||
    `Express ${getTrainNumber(
      train,
      item
    )}`
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const origin =
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
    item?.start;

  if (
    typeof origin ===
    "object"
  ) {
    return (
      origin.name ||
      origin.stationName ||
      origin.code ||
      ""
    );
  }

  return origin || "";
}

// ============================================================
// DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const destination =
    train?.destination ||
    train?.to ||
    train?.destinationStation ||
    train?.endStation ||
    item?.destination ||
    item?.to ||
    item?.destinationStation ||
    item?.endStation;

  if (
    typeof destination ===
    "object"
  ) {
    return (
      destination.name ||
      destination.stationName ||
      destination.code ||
      ""
    );
  }

  return destination || "";
}

// ============================================================
// ROUTE ARRAY
// ============================================================

function getRoute(
  train,
  live,
  item
) {
  if (
    Array.isArray(
      train?.route
    )
  ) {
    return train.route;
  }

  if (
    Array.isArray(
      live?.route
    )
  ) {
    return live.route;
  }

  if (
    Array.isArray(
      item?.route
    )
  ) {
    return item.route;
  }

  return null;
}

// ============================================================
// ROUTE STOP CODE
// ============================================================

function getStopCode(
  stop
) {
  return String(
    stop?.station?.code ||
    stop?.stationCode ||
    stop?.code ||
    ""
  )
    .trim()
    .toUpperCase();
}

// ============================================================
// ROUTE STOP NAME
// ============================================================

function getStopName(
  stop
) {
  return normalizeText(
    stop?.station?.name ||
    stop?.stationName ||
    stop?.name ||
    ""
  );
}

// ============================================================
// ROUTE STOP SEQUENCE
// ============================================================

function getStopSequence(
  stop
) {
  return toNumber(
    stop?.sequence ??
    stop?.seq ??
    stop?.stationSequence
  );
}

// ============================================================
// GUDUR ROUTE SEQUENCE
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

  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  for (
    const stop of route
  ) {
    const code =
      getStopCode(stop);

    const name =
      getStopName(stop);

    if (
      code === "GDR" ||
      name.includes(
        "GUDUR"
      )
    ) {
      return getStopSequence(
        stop
      );
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
    findNested(
      {
        train,
        live,
        item
      },
      [
        "currentSequence",
        "currentStationSequence",
        "sequence",
        "stopSequence",
        "currentStopSequence"
      ]
    );

  return toNumber(
    current
  );
}

// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// This is the most important direction calculation.
//
// current sequence < GDR sequence
//     = train is BEFORE Gudur
//     = moving toward Gudur
//
// current sequence > GDR sequence
//     = train is AFTER Gudur
//     = moving away from Gudur
//
// ============================================================

function getRouteDirection(
  train,
  live,
  item
) {
  const current =
    getCurrentSequence(
      train,
      live,
      item
    );

  const gudur =
    getGudurSequence(
      train,
      live,
      item
    );

  if (
    current !== null &&
    gudur !== null
  ) {
    if (
      current < gudur
    ) {
      return "TOWARD_GUDUR";
    }

    if (
      current > gudur
    ) {
      return "AWAY_FROM_GUDUR";
    }

    return "AT_GUDUR";
  }

  return null;
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function getExplicitDirection(
  train,
  live,
  stop,
  item
) {
  const values = [
    train?.direction,
    train?.travelDirection,
    train?.routeDirection,
    train?.runningDirection,
    train?.towards,

    live?.direction,
    live?.travelDirection,
    live?.routeDirection,
    live?.runningDirection,
    live?.towards,

    stop?.direction,
    stop?.towards,

    item?.direction,
    item?.travelDirection,
    item?.routeDirection,
    item?.runningDirection,
    item?.towards
  ];

  const text =
    values
      .filter(Boolean)
      .map(
        normalizeText
      )
      .join(" ");

  if (!text) {
    return null;
  }

  if (
    text.includes(
      "TOWARD GUDUR"
    ) ||
    text.includes(
      "TOWARDS GUDUR"
    ) ||
    text.includes(
      "TO GUDUR"
    ) ||
    text.includes(
      "GUDUR INBOUND"
    ) ||
    text.includes(
      "APPROACHING GUDUR"
    )
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    text.includes(
      "FROM GUDUR"
    ) ||
    text.includes(
      "GUDUR OUTBOUND"
    ) ||
    text.includes(
      "AWAY FROM GUDUR"
    ) ||
    text.includes(
      "TO CHENNAI"
    ) ||
    text.includes(
      "TOWARD CHENNAI"
    ) ||
    text.includes(
      "TOWARDS CHENNAI"
    ) ||
    text.includes(
      "TO TIRUPATI"
    ) ||
    text.includes(
      "TOWARD TIRUPATI"
    ) ||
    text.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return null;
}

// ============================================================
// DETERMINE DIRECTION
// ============================================================

function determineDirection(
  train,
  live,
  stop,
  item
) {
  // ----------------------------------------------------------
  // 1. ROUTE SEQUENCE
  // ----------------------------------------------------------

  const routeDirection =
    getRouteDirection(
      train,
      live,
      item
    );

  if (
    routeDirection
  ) {
    return routeDirection;
  }

  // ----------------------------------------------------------
  // 2. EXPLICIT DIRECTION
  // ----------------------------------------------------------

  const explicit =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicit
  ) {
    return explicit;
  }

  // ----------------------------------------------------------
  // 3. STATUS
  // ----------------------------------------------------------

  const status =
    normalizeText(
      live?.status ||
      item?.status ||
      stop?.status ||
      ""
    );

  if (
    status.includes(
      "AT STATION"
    ) ||
    status.includes(
      "ARRIVING"
    ) ||
    status.includes(
      "APPROACH"
    )
  ) {
    return "TOWARD_GUDUR";
  }

  return null;
}

// ============================================================
// CORRIDOR FROM ROUTE
// ============================================================
//
// We determine which side of GDR the train approaches from.
//
// We look at the route BEFORE GDR.
//
// If the route immediately before GDR contains:
//   Chennai / Sullurupeta / Nayudupeta etc.
//       => MAS
//
// If it contains:
//   Tirupati / Renigunta
//       => TPTY
//
// ============================================================

function getCorridorFromRoute(
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

  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  let gudurIndex =
    -1;

  for (
    let i = 0;
    i < route.length;
    i++
  ) {
    const code =
      getStopCode(
        route[i]
      );

    const name =
      getStopName(
        route[i]
      );

    if (
      code === "GDR" ||
      name.includes(
        "GUDUR"
      )
    ) {
      gudurIndex = i;
      break;
    }
  }

  if (
    gudurIndex <= 0
  ) {
    return null;
  }

  // Examine stations immediately before Gudur.
  const start =
    Math.max(
      0,
      gudurIndex - 6
    );

  const beforeGudur =
    route
      .slice(
        start,
        gudurIndex
      )
      .map(
        (stop) =>
          [
            getStopCode(stop),
            getStopName(stop)
          ]
            .filter(Boolean)
            .join(" ")
      )
      .join(" ");

  const text =
    normalizeText(
      beforeGudur
    );

  // ----------------------------------------------------------
  // TIRUPATI SIDE
  // ----------------------------------------------------------

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
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  if (
    containsAny(
      text,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI CENTRAL",
        "SULLURUPETA",
        "NAYUDUPETA",
        "PERAMBUR",
        "AVADI",
        "CHENNAI CENTRAL",
        "TAMBARAM"
      ]
    )
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// CORRIDOR FROM ORIGIN
// ============================================================
//
// Origin is only a fallback.
// It does NOT override route information.
//
// ============================================================

function getCorridorFromOrigin(
  train,
  item
) {
  const origin =
    normalizeText(
      getOrigin(
        train,
        item
      )
    );

  if (!origin) {
    return null;
  }

  if (
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA"
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
        "MGR CHENNAI CENTRAL",
        "MAS",
        "SULLURUPETA",
        "NAYUDUPETA",
        "TAMBARAM",
        "AVADI",
        "PERAMBUR"
      ]
    )
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// No giant MAS train-number list.
//
// Route information is preferred.
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  // ----------------------------------------------------------
  // 1. Explicit RailRadar corridor
  // ----------------------------------------------------------

  const explicit =
    findNested(
      {
        train,
        live,
        stop,
        item
      },
      [
        "corridor",
        "line",
        "railwayLine",
        "routeLine",
        "lineCode"
      ]
    );

  const explicitText =
    normalizeText(
      explicit
    );

  if (
    explicitText === "MAS" ||
    explicitText.includes(
      "CHENNAI LINE"
    ) ||
    explicitText.includes(
      "MAS LINE"
    )
  ) {
    return "MAS";
  }

  if (
    explicitText === "TPTY" ||
    explicitText.includes(
      "TIRUPATI LINE"
    ) ||
    explicitText.includes(
      "TPTY LINE"
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // 2. Actual route
  // ----------------------------------------------------------

  const routeCorridor =
    getCorridorFromRoute(
      train,
      live,
      item
    );

  if (
    routeCorridor
  ) {
    return routeCorridor;
  }

  // ----------------------------------------------------------
  // 3. TPTY fallback
  //
  // Only use this small list.
  // We do NOT maintain a huge MAS list.
  // ----------------------------------------------------------

  const trainNo =
    getTrainNumber(
      train,
      item
    );

  if (
    TPTY_FALLBACK_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // 4. Origin fallback
  // ----------------------------------------------------------

  const originCorridor =
    getCorridorFromOrigin(
      train,
      item
    );

  if (
    originCorridor
  ) {
    return originCorridor;
  }

  // ----------------------------------------------------------
  // UNKNOWN
  // ----------------------------------------------------------

  return null;
}

// ============================================================
// IST TIME
// ============================================================

function getISTMinutes() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }
    ).formatToParts(
      new Date()
    );

  const hour =
    Number(
      parts.find(
        (p) =>
          p.type === "hour"
      )?.value || 0
    );

  const minute =
    Number(
      parts.find(
        (p) =>
          p.type === "minute"
      )?.value || 0
    );

  return (
    hour * 60 +
    minute
  );
}

// ============================================================
// PARSE TIME
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

  // HH:MM
  const match =
    text.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (
    match
  ) {
    return (
      Number(
        match[1]
      ) *
        60 +
      Number(
        match[2]
      ) +
      Number(
        delayMinutes || 0
      )
    );
  }

  // ISO timestamp
  const date =
    new Date(text);

  if (
    isNaN(
      date.getTime()
    )
  ) {
    return -1;
  }

  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }
    ).formatToParts(
      date
    );

  const hour =
    Number(
      parts.find(
        (p) =>
          p.type === "hour"
      )?.value || 0
    );

  const minute =
    Number(
      parts.find(
        (p) =>
          p.type === "minute"
      )?.value || 0
    );

  return (
    hour * 60 +
    minute +
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
// GET BOARD ETA
// ============================================================

function getBoardEta(
  train,
  live,
  stop,
  item,
  currentMin
) {
  const direct =
    toNumber(
      findNested(
        {
          train,
          live,
          stop,
          item
        },
        [
          "etaMinutes",
          "estimatedMinutes",
          "minutesToArrival",
          "arrivalInMinutes"
        ]
      )
    );

  if (
    direct !== null
  ) {
    return Math.round(
      direct
    );
  }

  const arrival =
    stop?.arrival ||
    stop?.expectedArrival ||
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
    item?.arrival ||
    item?.expectedArrival ||
    item?.arrivalTime ||
    "";

  if (!arrival) {
    return null;
  }

  const arrivalMinutes =
    parseTimeToMinutes(
      arrival,
      0
    );

  if (
    arrivalMinutes === -1
  ) {
    return null;
  }

  return Math.round(
    calculateTimeDifference(
      arrivalMinutes,
      currentMin
    )
  );
}

// ============================================================
// GPS POSITION
// ============================================================

function getActualGpsPosition(
  train,
  live,
  item
) {
  const lat =
    toNumber(
      findNested(
        {
          train,
          live,
          item
        },
        [
          "latitude",
          "lat",
          "currentLatitude"
        ]
      )
    );

  const lng =
    toNumber(
      findNested(
        {
          train,
          live,
          item
        },
        [
          "longitude",
          "lng",
          "lon",
          "currentLongitude"
        ]
      )
    );

  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  if (
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }

  const actual =
    findNested(
      {
        train,
        live,
        item
      },
      [
        "isActualPosition",
        "actualPosition"
      ]
    );

  if (
    actual === false
  ) {
    return null;
  }

  const speed =
    toNumber(
      findNested(
        {
          train,
          live,
          item
        },
        [
          "speedKmh",
          "speed",
          "currentSpeed"
        ]
      )
    );

  return {
    lat,
    lng,
    speedKmh:
      speed !== null
        ? speed
        : null,

    isActualPosition:
      true
  };
}

// ============================================================
// STATION POSITION
// ============================================================

function getActualStationPosition(
  train,
  live,
  item
) {
  const actual =
    findNested(
      {
        train,
        live,
        item
      },
      [
        "isActualPosition",
        "actualPosition"
      ]
    );

  if (
    actual === false
  ) {
    return null;
  }

  const stationCode =
    String(
      findNested(
        {
          train,
          live,
          item
        },
        [
          "stationCode",
          "currentStationCode"
        ]
      ) || ""
    )
      .trim()
      .toUpperCase();

  const stationName =
    normalizeText(
      findNested(
        {
          train,
          live,
          item
        },
        [
          "stationName",
          "currentStationName"
        ]
      )
    );

  if (
    stationCode !== "GDR" &&
    !stationName.includes(
      "GUDUR"
    )
  ) {
    return null;
  }

  return {
    lat:
      GDR_LAT,

    lng:
      GDR_LNG,

    speedKmh:
      null,

    isActualPosition:
      true,

    atGudurStation:
      true
  };
}

// ============================================================
// ACTUAL POSITION
// ============================================================

function getActualPosition(
  train,
  live,
  item
) {
  return (
    getActualGpsPosition(
      train,
      live,
      item
    ) ||
    getActualStationPosition(
      train,
      live,
      item
    )
  );
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
  const R =
    6371;

  const dLat =
    (
      lat2 -
      lat1
    ) *
    Math.PI /
    180;

  const dLng =
    (
      lng2 -
      lng1
    ) *
    Math.PI /
    180;

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
      dLng / 2
    ) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        1 - a
      )
    );

  return (
    R * c
  );
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
// UPCOMING TRAIN CHECK
// ============================================================

function isUpcoming(
  train,
  live,
  stop,
  item,
  eta
) {
  if (
    eta === null ||
    eta === undefined
  ) {
    return false;
  }

  if (
    eta < -15
  ) {
    return false;
  }

  if (
    eta >
    UPCOMING_MAX_ETA_MINUTES
  ) {
    return false;
  }

  const direction =
    determineDirection(
      train,
      live,
      stop,
      item
    );

  // Never show an explicitly outbound train.
  if (
    direction ===
    "AWAY_FROM_GUDUR"
  ) {
    return false;
  }

  return true;
}

// ============================================================
// GATE CLOSURE
// ============================================================
//
// Gate closes ONLY when:
//   1. Actual position exists
//   2. Actual position is confirmed
//   3. Corridor is MAS/TPTY
//   4. Train is not moving away
//   5. Train is within 0.60 km of GDR
//
// ============================================================

function shouldCloseGate(
  actualPosition,
  corridor,
  direction,
  distanceKm
) {
  if (
    !actualPosition
  ) {
    return false;
  }

  if (
    !actualPosition.isActualPosition
  ) {
    return false;
  }

  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return false;
  }

  if (
    direction ===
    "AWAY_FROM_GUDUR"
  ) {
    return false;
  }

  if (
    distanceKm === null
  ) {
    return false;
  }

  return (
    distanceKm <=
    GATE_STOP_DISTANCE_KM
  );
}

// ============================================================
// PLATFORM
// ============================================================

function formatPlatform(
  platform
) {
  if (
    platform === null ||
    platform === undefined ||
    platform === ""
  ) {
    return "PF 1";
  }

  const text =
    String(
      platform
    ).trim();

  if (
    /^PF\s*/i.test(
      text
    )
  ) {
    return text;
  }

  return `PF ${text}`;
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  let apiRequests = 0;

  try {
    const now =
      new Date();

    const currentMin =
      getISTMinutes();

    console.log(
      "\n=========================================="
    );

    console.log(
      `[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=${STATION_BOARD_HOURS}`,
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

    apiRequests++;

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
        "RailRadar returned invalid station-board data."
      );
    }

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
    // UPCOMING MAP
    // ========================================================

    const upcomingMap =
      new Map();

    // ========================================================
    // LIVE CANDIDATES
    // ========================================================

    const liveCandidates =
      [];

    // ========================================================
    // PROCESS BOARD
    // ========================================================

    trainsArray
      .slice(
        0,
        MAX_BOARD_CANDIDATES
      )
      .forEach(
        (
          item,
          index
        ) => {
          const train =
            item?.train ||
            {};

          const live =
            item?.live ||
            {};

          const stop =
            item?.stop ||
            {};

          const trainNo =
            getTrainNumber(
              train,
              item
            );

          if (
            !trainNo
          ) {
            return;
          }

          const trainName =
            getTrainName(
              train,
              item
            );

          const corridor =
            determineCorridor(
              train,
              live,
              stop,
              item
            );

          const direction =
            determineDirection(
              train,
              live,
              stop,
              item
            );

          const eta =
            getBoardEta(
              train,
              live,
              stop,
              item,
              currentMin
            );

          const platform =
            formatPlatform(
              live?.platform ||
              stop?.platform ||
              item?.platform
            );

          console.log(
            `[BOARD ${index + 1}] ${trainNo} ${trainName} | ${corridor || "UNKNOWN"} | ${direction || "UNKNOWN"} | ETA ${eta === null ? "UNKNOWN" : `${eta}m`}`
          );

          // ==================================================
          // UPCOMING
          // ==================================================

          if (
            isUpcoming(
              train,
              live,
              stop,
              item,
              eta
            )
          ) {
            // Do not insert an unknown corridor into Firebase.
            //
            // If route information is unavailable, the train
            // is held back until we can determine the corridor.
            //
            if (
              corridor === "MAS" ||
              corridor === "TPTY"
            ) {
              const key =
                `${trainNo}-${corridor}`;

              upcomingMap.set(
                key,
                {
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

                  etaMinutes:
                    Math.max(
                      0,
                      eta
                    ),

                  delayMinutes:
                    Number(
                      live?.delayMinutes ||
                      item?.delayMinutes ||
                      0
                    ),

                  corridor,

                  direction:
                    "TOWARD_GUDUR",

                  platform,

                  distanceKm:
                    null
                }
              );
            }
          }

          // ==================================================
          // LIVE VERIFICATION
          // ==================================================

          if (
            (
              corridor === "MAS" ||
              corridor === "TPTY"
            ) &&
            eta !== null &&
            eta >= -5 &&
            eta <= 180
          ) {
            liveCandidates.push({
              trainNo,

              trainName,

              corridor,

              eta,

              platform,

              item
            });
          }
        }
      );

    // ========================================================
    // SORT LIVE CANDIDATES
    // ========================================================

    liveCandidates.sort(
      (a, b) =>
        a.eta -
        b.eta
    );

    const selected =
      liveCandidates.slice(
        0,
        MAX_LIVE_VERIFICATIONS
      );

    const verifiedTrains =
      [];

    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    for (
      const candidate of
      selected
    ) {
      try {
        console.log(
          `   Live request: /trains/${candidate.trainNo}/live`
        );

        const liveRes =
          await axios.get(
            `${RAILRADAR_BASE_URL}/trains/${candidate.trainNo}/live`,
            {
              headers: {
                Authorization:
                  `Bearer ${RAILRADAR_API_KEY}`,

                Accept:
                  "application/json"
              },

              timeout:
                10000
            }
          );

        apiRequests++;

        const body =
          liveRes.data;

        const data =
          body?.data ||
          {};

        const liveTrain =
          data?.train ||
          {};

        const liveInfo =
          data?.live ||
          data;

        const liveStop =
          data?.stop ||
          {};

        // ====================================================
        // ACTUAL POSITION
        // ====================================================

        const actualPosition =
          getActualPosition(
            liveTrain,
            liveInfo,
            data
          );

        const distanceKm =
          getDistanceToGudur(
            actualPosition
          );

        // ====================================================
        // ROUTE CORRIDOR
        // ====================================================

        const actualCorridor =
          determineCorridor(
            liveTrain,
            liveInfo,
            liveStop,
            data
          ) ||
          candidate.corridor;

        // ====================================================
        // DIRECTION
        // ====================================================

        const actualDirection =
          determineDirection(
            liveTrain,
            liveInfo,
            liveStop,
            data
          );

        console.log(
          `[LIVE] ${candidate.trainNo} ${candidate.trainName} | ${actualCorridor} | ${actualDirection || "UNKNOWN"} | ${distanceKm === null ? "distance unknown" : `${distanceKm.toFixed(2)} km to GDR`}`
        );

        // ====================================================
        // GATE CLOSURE
        // ====================================================

        if (
          shouldCloseGate(
            actualPosition,
            actualCorridor,
            actualDirection,
            distanceKm
          )
        ) {
          const delay =
            Number(
              liveInfo?.delayMinutes ||
              data?.delayMinutes ||
              0
            );

          const statusText =
            delay > 0
              ? `${delay}m late`
              : "On Time";

          const label =
            `${candidate.trainNo} ${candidate.trainName} (${statusText})`;

          const waitMinutes =
            actualPosition?.atGudurStation
              ? 5
              : Math.max(
                  1,
                  Math.round(
                    (
                      distanceKm /
                      DEFAULT_SPEED_KMH
                    ) *
                      60 +
                      2
                  )
                );

          const payload = {
            status:
              "CLOSED",

            waitMinutes,

            activeTrain:
              label,

            direction:
              "TOWARD GUDUR",

            corridor:
              actualCorridor,

            distanceKm:
              Number(
                distanceKm.toFixed(
                  3
                )
              ),

            positionSource:
              actualPosition?.atGudurStation
                ? "station-code"
                : "gps",

            latitude:
              actualPosition.lat,

            longitude:
              actualPosition.lng
          };

          if (
            actualCorridor ===
            "MAS"
          ) {
            masGate =
              payload;
          }

          if (
            actualCorridor ===
            "TPTY"
          ) {
            tptyGate =
              payload;
          }

          console.log(
            `🚨 GATE CLOSED -> ${actualCorridor} -> ${candidate.trainNo} ${candidate.trainName}`
          );
        }

        // ====================================================
        // VERIFIED TRAIN
        // ====================================================

        verifiedTrains.push({
          trainNo:
            candidate.trainNo,

          name:
            candidate.trainName,

          corridor:
            actualCorridor,

          direction:
            actualDirection ||
            "UNKNOWN",

          actualPosition:
            actualPosition
              ? {
                  latitude:
                    actualPosition.lat,

                  longitude:
                    actualPosition.lng,

                  speedKmh:
                    actualPosition.speedKmh,

                  distanceToGudurKm:
                    distanceKm !== null
                      ? Number(
                          distanceKm.toFixed(
                            3
                          )
                        )
                      : null
                }
              : null
        });

        // ====================================================
        // UPDATE UPCOMING WITH REAL DISTANCE
        // ====================================================

        const key =
          `${candidate.trainNo}-${actualCorridor}`;

        const upcoming =
          upcomingMap.get(
            key
          );

        if (
          upcoming &&
          distanceKm !== null
        ) {
          upcoming.distanceKm =
            Number(
              distanceKm.toFixed(
                3
              )
            );

          const speed =
            actualPosition?.speedKmh;

          const usableSpeed =
            speed !== null &&
            speed !== undefined &&
            speed >= MIN_SPEED_KMH
              ? speed
              : DEFAULT_SPEED_KMH;

          upcoming.etaMinutes =
            Math.max(
              0,
              Math.round(
                (
                  distanceKm /
                  usableSpeed
                ) *
                  60
              )
            );
        }

      } catch (
        liveError
      ) {
        console.error(
          `[LIVE ERROR] ${candidate.trainNo}: ${liveError.message}`
        );
      }
    }

    // ========================================================
    // FINAL UPCOMING
    // ========================================================

    let upcomingList =
      Array.from(
        upcomingMap.values()
      );

    upcomingList =
      upcomingList.filter(
        (train) => {

          if (
            train.corridor !==
              "MAS" &&
            train.corridor !==
              "TPTY"
          ) {
            return false;
          }

          if (
            train.etaMinutes <
            0
          ) {
            return false;
          }

          if (
            train.etaMinutes >
            UPCOMING_MAX_ETA_MINUTES
          ) {
            return false;
          }

          if (
            train.distanceKm !==
              null &&
            train.distanceKm >
              UPCOMING_MAX_DISTANCE_KM
          ) {
            return false;
          }

          return true;
        }
      );

    // ========================================================
    // SORT BY ETA
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ========================================================
    // MAX 5
    // ========================================================

    const safeUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        startedAt
      ) /
      1000;

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        safeUpcoming,

      lastUpdated:
        new Date().toLocaleTimeString(
          "en-IN",
          {
            timeZone:
              "Asia/Kolkata"
          }
        ),

      lastUpdatedLocal:
        new Date().toLocaleString(
          "en-IN",
          {
            timeZone:
              "Asia/Kolkata"
          }
        ),

      lastUpdatedAt:
        new Date().toISOString(),

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
      ` -> Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );

    console.log(
      ` -> Upcoming     : ${safeUpcoming.length}`
    );

    console.log(
      ` -> Verified     : ${verifiedTrains.length}`
    );

    console.log(
      ` -> API Requests : ${apiRequests}`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // UPCOMING LOG
    // ========================================================

    if (
      safeUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      safeUpcoming.forEach(
        (
          train,
          index
        ) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} | ETA ${train.etaMinutes}m | ${train.platform}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    return true;

  } catch (
    error
  ) {
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
        "HTTP:",
        error.response.status
      );

      console.error(
        "Response:",
        error.response.data
      );
    }

    console.error(
      "=========================================="
    );

    try {
      await gateRef.update({
        monitorStatus:
          "ERROR",

        monitorError:
          error.message,

        lastUpdated:
          new Date().toLocaleTimeString(
            "en-IN",
            {
              timeZone:
                "Asia/Kolkata"
            }
          ),

        lastUpdatedAt:
          new Date().toISOString(),

        apiRequests
      });
    } catch (
      firebaseError
    ) {
      console.error(
        "Firebase error update failed:",
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
  "RailRadar API Key: Configured"
);

console.log(
  "Corridor: ACTUAL ROUTE FIRST"
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
  "=========================================="
);

// ============================================================
// RUN NOW
// ============================================================

updateGateSystem();

// ============================================================
// LOCAL REFRESH
// ============================================================

setInterval(
  updateGateSystem,
  180000
);
