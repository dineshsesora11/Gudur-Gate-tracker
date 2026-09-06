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
    serviceAccount = require("./serviceAccountKey.json");

    console.log(
      "Firebase service account: serviceAccountKey.json"
    );
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    "Use FIREBASE_SERVICE_ACCOUNT GitHub Secret or serviceAccountKey.json"
  );

  console.error(error.message);

  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();
const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR / GATE LOCATIONS
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

const UPCOMING_MAX_DISTANCE_KM = 150;

const UPCOMING_MAX_ETA_MINUTES = 360;

const GATE_STOP_DISTANCE_KM = 0.60;

const STATION_BOARD_HOURS = 4;

const MAX_BOARD_CANDIDATES = 22;

const MAX_LIVE_VERIFICATIONS = 7;

const DEFAULT_SPEED_KMH = 55;

const MIN_SPEED_KMH = 5;

// ============================================================
// IMPORTANT
// KNOWN GUDUR CORRIDOR TRAIN NUMBERS
// ============================================================
//
// MAS = Chennai / MGR Chennai Central side
// TPTY = Tirupati / Renigunta side
//
// These numbers are used FIRST because the station-board
// response does not always contain corridor information.
//
// This fixes the previous "OTHER LINE" problem.
//
// ============================================================

const MAS_CORRIDOR_TRAINS = new Set([

  // Current trains seen on the GDR board
  "20850",
  "12839",
  "12512",
  "18521",
  "12616",
  "12655",
  "12626",
  "17644",
  "12604",
  "17210",
  "16032",
  "12760",
  "13352",

  // Additional Chennai-side trains
  "12077",
  "12078",
  "12291",
  "12292",
  "12603",
  "12604",
  "12605",
  "12606",
  "12607",
  "12608",
  "12609",
  "12610",
  "12611",
  "12612",
  "12613",
  "12614",
  "12615",
  "12616",
  "12617",
  "12618",
  "12619",
  "12620",
  "12621",
  "12622",
  "12623",
  "12624",
  "12625",
  "12626",
  "12627",
  "12628",
  "12629",
  "12630",
  "12631",
  "12632",
  "12633",
  "12634",
  "12635",
  "12636",
  "12637",
  "12638",
  "12639",
  "12640",
  "12641",
  "12642",
  "12643",
  "12644",
  "12645",
  "12646",
  "12647",
  "12648",
  "12649",
  "12650",
  "12651",
  "12652",
  "12653",
  "12654",
  "12655",
  "12656",
  "12657",
  "12658",
  "12659",
  "12660",
  "12661",
  "12662",
  "12663",
  "12664",
  "12665",
  "12666",
  "12667",
  "12668",
  "12669",
  "12670",
  "12671",
  "12672",
  "12673",
  "12674",
  "12675",
  "12676",
  "12677",
  "12678",
  "12679",
  "12680",
  "12681",
  "12682",
  "12683",
  "12684",
  "12685",
  "12686",
  "12687",
  "12688",
  "12689",
  "12690",
  "12759",
  "12760",
  "12839",
  "16031",
  "16032",
  "13351",
  "13352"
]);

const TPTY_CORRIDOR_TRAINS = new Set([

  // Current trains seen on the GDR board
  "20630",
  "12734",
  "12764",
  "17247",

  // Tirupati / Renigunta corridor
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
// NUMBER CONVERTER
// ============================================================

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

// ============================================================
// SEARCH NESTED OBJECTS
// ============================================================

function findNested(obj, keys, maxDepth = 4) {
  if (
    obj === null ||
    obj === undefined ||
    maxDepth < 0
  ) {
    return null;
  }

  if (
    typeof obj !== "object"
  ) {
    return null;
  }

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(
        obj,
        key
      )
    ) {
      const value = obj[key];

      if (
        value !== null &&
        value !== undefined &&
        value !== ""
      ) {
        return value;
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const child = obj[key];

    if (
      child &&
      typeof child === "object"
    ) {
      const found = findNested(
        child,
        keys,
        maxDepth - 1
      );

      if (
        found !== null &&
        found !== undefined &&
        found !== ""
      ) {
        return found;
      }
    }
  }

  return null;
}

// ============================================================
// STRING MATCHING
// ============================================================

function containsAny(text, values) {
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
// GET TRAIN NUMBER
// ============================================================

function getTrainNumber(train, item) {
  return String(
    train?.number ||
    train?.trainNumber ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}

// ============================================================
// GET TRAIN NAME
// ============================================================

function getTrainName(train, item) {
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
// GET ORIGIN
// ============================================================

function getOrigin(train, item) {
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
    typeof origin === "object"
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
// GET DESTINATION
// ============================================================

function getDestination(train, item) {
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
    typeof destination === "object"
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
// KNOWN TRAIN NUMBER CORRIDOR
// ============================================================
//
// THIS IS THE PRIMARY FIX FOR "OTHER LINE".
//
// ============================================================

function getKnownTrainCorridor(
  trainNo
) {
  const number =
    String(trainNo || "").trim();

  if (
    MAS_CORRIDOR_TRAINS.has(number)
  ) {
    return "MAS";
  }

  if (
    TPTY_CORRIDOR_TRAINS.has(number)
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// DIRECTION TEXT
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

  return fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
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
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("APPROACHING GUDUR") ||
    direction.includes("INBOUND")
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    direction.includes("FROM GUDUR") ||
    direction.includes("GUDUR OUTBOUND") ||
    direction.includes("AWAY FROM GUDUR") ||
    direction.includes("TO CHENNAI") ||
    direction.includes("TOWARD CHENNAI") ||
    direction.includes("TOWARDS CHENNAI") ||
    direction.includes("TO TIRUPATI") ||
    direction.includes("TOWARD TIRUPATI") ||
    direction.includes("TOWARDS TIRUPATI")
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return null;
}

// ============================================================
// CURRENT ROUTE SEQUENCE
// ============================================================

function getCurrentSequence(
  train,
  live,
  item
) {
  const value = findNested(
    {
      train,
      live,
      item
    },
    [
      "sequence",
      "currentSequence",
      "currentStationSequence",
      "stopSequence"
    ]
  );

  return toNumber(value);
}

// ============================================================
// ROUTE SEQUENCE FOR GUDUR
// ============================================================

function getGudurSequence(
  train,
  live,
  item
) {
  const route =
    train?.route ||
    live?.route ||
    item?.route;

  if (!Array.isArray(route)) {
    return null;
  }

  for (const stop of route) {

    const code =
      stop?.station?.code ||
      stop?.stationCode ||
      stop?.code;

    const name =
      stop?.station?.name ||
      stop?.stationName ||
      stop?.name;

    if (
      normalizeText(code) === "GDR" ||
      containsAny(
        name,
        [
          "GUDUR",
          "GUDUR JUNCTION"
        ]
      )
    ) {
      return toNumber(
        stop?.sequence
      );
    }
  }

  return null;
}

// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// IMPORTANT:
//
// Sequence is checked BEFORE textual status such as
// "DEPARTED".
//
// A train departing a station BEFORE GDR is still moving
// TOWARD GDR.
//
// ============================================================

function getSequenceDirection(
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
// DETERMINE DIRECTION
// ============================================================

function determineDirection(
  train,
  live,
  stop,
  item
) {
  // First use actual route sequence.
  const sequenceDirection =
    getSequenceDirection(
      train,
      live,
      item
    );

  if (
    sequenceDirection
  ) {
    return sequenceDirection;
  }

  // Then explicit direction.
  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicitDirection
  ) {
    return explicitDirection;
  }

  // Then status.
  const status = normalizeText(
    live?.status ||
    item?.status ||
    stop?.status ||
    ""
  );

  if (
    status.includes("AT STATION") ||
    status.includes("ARRIVING") ||
    status.includes("APPROACH")
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    status.includes("DEPARTED")
  ) {
    return "TOWARD_GUDUR";
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// Priority:
//
// 1. Known train number
// 2. Explicit corridor field
// 3. Route anchors
// 4. Origin
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  // ----------------------------------------------------------
  // 1. KNOWN TRAIN NUMBER
  // ----------------------------------------------------------

  const known =
    getKnownTrainCorridor(
      trainNo
    );

  if (known) {
    return known;
  }

  // ----------------------------------------------------------
  // 2. EXPLICIT CORRIDOR
  // ----------------------------------------------------------

  const corridorValue =
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

  const corridorText =
    normalizeText(
      corridorValue
    );

  if (
    corridorText === "MAS" ||
    corridorText.includes("CHENNAI")
  ) {
    return "MAS";
  }

  if (
    corridorText === "TPTY" ||
    corridorText.includes("TIRUPATI")
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // 3. ROUTE ANCHORS
  // ----------------------------------------------------------

  const route =
    train?.route ||
    live?.route ||
    item?.route;

  if (
    Array.isArray(route)
  ) {
    const routeText =
      normalizeText(
        route
          .map(
            (s) =>
              [
                s?.station?.code,
                s?.station?.name,
                s?.stationCode,
                s?.stationName,
                s?.code,
                s?.name
              ]
                .filter(Boolean)
                .join(" ")
          )
          .join(" ")
      );

    const gudurIndex =
      routeText.indexOf(
        "GUDUR"
      );

    const tirupatiIndex =
      routeText.indexOf(
        "TIRUPATI"
      );

    const reniguntaIndex =
      routeText.indexOf(
        "RENIGUNTA"
      );

    const chennaiIndex =
      routeText.indexOf(
        "CHENNAI"
      );

    if (
      tirupatiIndex >= 0 ||
      reniguntaIndex >= 0
    ) {
      return "TPTY";
    }

    if (
      chennaiIndex >= 0
    ) {
      return "MAS";
    }
  }

  // ----------------------------------------------------------
  // 4. ORIGIN FALLBACK
  // ----------------------------------------------------------

  const origin =
    normalizeText(
      getOrigin(
        train,
        item
      )
    );

  if (
    containsAny(
      origin,
      [
        "CHENNAI",
        "MGR CHENNAI CENTRAL",
        "MAS",
        "TAMBARAM",
        "AVADI",
        "PERAMBUR"
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
        "RENIGUNTA"
      ]
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// IST CURRENT TIME
// ============================================================

function getISTNow() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    ).formatToParts(
      new Date()
    );

  const get =
    (type) =>
      Number(
        parts.find(
          (p) =>
            p.type === type
        )?.value || 0
      );

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}

// ============================================================
// IST MINUTES
// ============================================================

function getISTMinutes() {
  const now =
    getISTNow();

  return (
    now.hour * 60 +
    now.minute
  );
}

// ============================================================
// PARSE TIME
// ============================================================
//
// ISO timestamps are parsed as real timestamps.
//
// HH:MM values are interpreted as IST because GitHub Actions
// runs in UTC.
//
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const text =
    String(timeStr).trim();

  // HH:MM
  const simpleMatch =
    text.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (
    simpleMatch
  ) {
    let minutes =
      parseInt(
        simpleMatch[1],
        10
      ) *
        60 +
      parseInt(
        simpleMatch[2],
        10
      );

    minutes += Number(
      delayMinutes || 0
    );

    return minutes;
  }

  // ISO / Date
  const date =
    new Date(text);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    const formatter =
      new Intl.DateTimeFormat(
        "en-GB",
        {
          timeZone:
            "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }
      );

    const parts =
      formatter.formatToParts(
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

  return -1;
}

// ============================================================
// CALCULATE TIME DIFFERENCE
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
      lat2 -
      lat1
    ) *
    Math.PI /
    180;

  const dLon =
    (
      lon2 -
      lon1
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

  return (
    R * c
  );
}

// ============================================================
// GET ACTUAL GPS POSITION
// ============================================================

function extractActualGpsPosition(
  train,
  live,
  item
) {
  const lat =
    toNumber(
      findNested(
        {
          live,
          train,
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
          live,
          train,
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

  const isActual =
    findNested(
      {
        live,
        train,
        item
      },
      [
        "isActualPosition",
        "actualPosition"
      ]
    );

  if (
    isActual === false
  ) {
    return null;
  }

  const speed =
    toNumber(
      findNested(
        {
          live,
          train,
          item
        },
        [
          "speed",
          "speedKmh",
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
// GET ACTUAL STATION POSITION
// ============================================================

function extractActualStationPosition(
  train,
  live,
  item
) {
  const isActual =
    findNested(
      {
        live,
        train,
        item
      },
      [
        "isActualPosition",
        "actualPosition"
      ]
    );

  if (
    isActual === false
  ) {
    return null;
  }

  const stationCode =
    String(
      findNested(
        {
          live,
          train,
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
          live,
          train,
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
    lat: GDR_LAT,
    lng: GDR_LNG,
    speedKmh: null,
    isActualPosition:
      true,
    atGudurStation:
      true
  };
}

// ============================================================
// GET ACTUAL POSITION
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

  const station =
    extractActualStationPosition(
      train,
      live,
      item
    );

  if (station) {
    return station;
  }

  return null;
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
// ETA CALCULATION
// ============================================================

function calculateEta(
  train,
  live,
  stop,
  item,
  currentMin,
  distanceKm
) {
  // ----------------------------------------------------------
  // 1. Direct ETA fields
  // ----------------------------------------------------------

  const directEta =
    toNumber(
      findNested(
        {
          live,
          train,
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
    directEta !== null &&
    directEta >= 0
  ) {
    return directEta;
  }

  // ----------------------------------------------------------
  // 2. Physical distance ETA
  // ----------------------------------------------------------

  if (
    distanceKm !== null &&
    distanceKm >= 0
  ) {
    const speed =
      toNumber(
        findNested(
          {
            live,
            train,
            item
          },
          [
            "speedKmh",
            "speed",
            "currentSpeed"
          ]
        )
      );

    const usableSpeed =
      speed !== null &&
      speed >= MIN_SPEED_KMH
        ? speed
        : DEFAULT_SPEED_KMH;

    const eta =
      (
        distanceKm /
        usableSpeed
      ) *
      60;

    return Math.max(
      0,
      Math.round(
        eta
      )
    );
  }

  // ----------------------------------------------------------
  // 3. Station arrival time
  // ----------------------------------------------------------

  const arrival =
    stop?.arrival ||
    stop?.expectedArrival ||
    live?.expectedArrivalTime ||
    item?.arrival ||
    item?.expectedArrival ||
    "";

  if (arrival) {
    const arrMin =
      parseTimeToMinutes(
        arrival,
        0
      );

    if (
      arrMin !== -1
    ) {
      return Math.max(
        0,
        Math.round(
          calculateTimeDifference(
            arrMin,
            currentMin
          )
        )
      );
    }
  }

  return null;
}

// ============================================================
// BOARD ETA
// ============================================================

function getBoardEta(
  train,
  live,
  stop,
  item,
  currentMin
) {
  // Direct numeric ETA
  const directEta =
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
    directEta !== null
  ) {
    return Math.round(
      directEta
    );
  }

  const arrival =
    stop?.arrival ||
    stop?.expectedArrival ||
    live?.expectedArrivalTime ||
    item?.arrival ||
    item?.expectedArrival ||
    item?.arrivalTime ||
    "";

  if (!arrival) {
    return null;
  }

  const arrMin =
    parseTimeToMinutes(
      arrival,
      0
    );

  if (
    arrMin === -1
  ) {
    return null;
  }

  return Math.round(
    calculateTimeDifference(
      arrMin,
      currentMin
    )
  );
}

// ============================================================
// CHECK UPCOMING BOARD TRAIN
// ============================================================

function isBoardTrainUpcoming(
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

  // Passed more than 15 minutes ago
  if (
    eta < -15
  ) {
    return false;
  }

  // Too far away
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

  // Explicitly outbound = reject
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
// SAFETY RULE:
//
// We DO NOT close the gate based only on timetable ETA.
//
// Actual GPS/station position is required.
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
// FORMAT PLATFORM
// ============================================================

function formatPlatform(
  platform
) {
  if (
    platform === null ||
    platform === undefined ||
    platform === ""
  ) {
    return "1";
  }

  const text =
    String(platform).trim();

  if (
    /^PF\s*/i.test(text)
  ) {
    return text;
  }

  return `PF ${text}`;
}

// ============================================================
// UPDATE GATE SYSTEM
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

    // ----------------------------------------------------------
    // FETCH STATION BOARD
    // ----------------------------------------------------------

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
          timeout: 12000
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
        "RailRadar returned invalid train data."
      );
    }

    console.log(
      `✅ RailRadar returned ${trainsArray.length} trains.`
    );

    // ----------------------------------------------------------
    // DEFAULT GATES
    // ----------------------------------------------------------

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

    // ----------------------------------------------------------
    // UPCOMING
    // ----------------------------------------------------------

    const upcomingMap =
      new Map();

    // ----------------------------------------------------------
    // LIVE VERIFICATION CANDIDATES
    // ----------------------------------------------------------

    const liveCandidates = [];

    // ==========================================================
    // PROCESS STATION BOARD
    // ==========================================================

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

          if (!trainNo) {
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

          const boardEta =
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
              item?.platform ||
              "1"
            );

          console.log(
            `[BOARD ${index + 1}] ${trainNo} ${trainName} | ${corridor || "UNKNOWN"} | ${direction || "UNKNOWN"} | ETA ${boardEta === null ? "UNKNOWN" : `${boardEta}m`}`
          );

          // ------------------------------------------------------
          // UPCOMING TRAIN
          // ------------------------------------------------------

          if (
            isBoardTrainUpcoming(
              train,
              live,
              stop,
              item,
              boardEta
            )
          ) {
            const key =
              `${trainNo}-${corridor || "UNKNOWN"}`;

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
                    boardEta
                  ),

                delayMinutes:
                  Number(
                    live?.delayMinutes ||
                    item?.delayMinutes ||
                    0
                  ),

                corridor:
                  corridor ||
                  "OTHER",

                direction:
                  "TOWARD GUDUR",

                platform,

                distanceKm:
                  null
              }
            );
          }

          // ------------------------------------------------------
          // LIVE VERIFICATION
          //
          // Only known MAS/TPTY trains are sent for live
          // position verification.
          // ------------------------------------------------------

          if (
            corridor === "MAS" ||
            corridor === "TPTY"
          ) {
            if (
              boardEta !== null &&
              boardEta >= -5 &&
              boardEta <= 180
            ) {
              liveCandidates.push({
                trainNo,
                trainName,
                corridor,
                boardEta,
                platform,
                item
              });
            }
          }
        }
      );

    // ==========================================================
    // LIVE VERIFY ONLY THE CLOSEST CANDIDATES
    // ==========================================================

    liveCandidates.sort(
      (a, b) =>
        a.boardEta -
        b.boardEta
    );

    const selectedLiveCandidates =
      liveCandidates.slice(
        0,
        MAX_LIVE_VERIFICATIONS
      );

    const verifiedTrains = [];

    // ==========================================================
    // LIVE TRAIN REQUESTS
    // ==========================================================

    for (
      const candidate of
      selectedLiveCandidates
    ) {
      try {
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
              timeout: 10000
            }
          );

        apiRequests++;

        const liveBody =
          liveRes.data;

        const liveData =
          liveBody?.data ||
          {};

        const liveTrain =
          liveData?.train ||
          {};

        const liveInfo =
          liveData?.live ||
          liveData;

        const liveStop =
          liveData?.stop ||
          {};

        // ------------------------------------------------------
        // ACTUAL POSITION
        // ------------------------------------------------------

        const actualPosition =
          getActualPosition(
            liveTrain,
            liveInfo,
            {
              ...candidate.item,
              ...liveData
            }
          );

        const distanceKm =
          getDistanceToGudur(
            actualPosition
          );

        // ------------------------------------------------------
        // CORRIDOR
        // ------------------------------------------------------

        const corridor =
          determineCorridor(
            liveTrain,
            liveInfo,
            liveStop,
            liveData
          ) ||
          candidate.corridor;

        // ------------------------------------------------------
        // DIRECTION
        // ------------------------------------------------------

        const direction =
          determineDirection(
            liveTrain,
            liveInfo,
            liveStop,
            liveData
          );

        const actualDistanceText =
          distanceKm === null
            ? "unknown"
            : `${distanceKm.toFixed(2)} km`;

        console.log(
          `[LIVE] ${candidate.trainNo} ${candidate.trainName} | ${corridor} | ${direction || "UNKNOWN"} | Actual distance to GDR: ${actualDistanceText}`
        );

        // ------------------------------------------------------
        // GATE CLOSURE
        // ------------------------------------------------------

        if (
          shouldCloseGate(
            actualPosition,
            corridor,
            direction,
            distanceKm
          )
        ) {
          const delay =
            Number(
              liveInfo?.delayMinutes ||
              liveData?.delayMinutes ||
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

            corridor,

            distanceKm:
              Number(
                distanceKm.toFixed(
                  3
                )
              ),

            positionSource:
              actualPosition
                ?.atGudurStation
                ? "station-code"
                : "gps",

            latitude:
              actualPosition?.lat ||
              null,

            longitude:
              actualPosition?.lng ||
              null
          };

          if (
            corridor === "MAS"
          ) {
            masGate =
              payload;
          }

          if (
            corridor === "TPTY"
          ) {
            tptyGate =
              payload;
          }

          console.log(
            `🚨 GATE CLOSED: ${candidate.trainNo} ${candidate.trainName} -> ${corridor}`
          );
        }

        // ------------------------------------------------------
        // VERIFIED TRAIN
        // ------------------------------------------------------

        verifiedTrains.push({
          trainNo:
            candidate.trainNo,

          name:
            candidate.trainName,

          corridor,

          direction:
            direction ||
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
      } catch (liveError) {
        console.error(
          `[LIVE ERROR] ${candidate.trainNo}: ${liveError.message}`
        );
      }
    }

    // ==========================================================
    // UPDATE UPCOMING LIST WITH LIVE DISTANCE
    // ==========================================================

    for (
      const verified of
      verifiedTrains
    ) {
      const key =
        `${verified.trainNo}-${verified.corridor}`;

      const existing =
        upcomingMap.get(
          key
        );

      if (
        existing &&
        verified.actualPosition
      ) {
        existing.distanceKm =
          verified
            .actualPosition
            .distanceToGudurKm;

        // Recalculate ETA from actual physical distance
        const speed =
          verified
            .actualPosition
            .speedKmh;

        const usableSpeed =
          speed !== null &&
          speed >= MIN_SPEED_KMH
            ? speed
            : DEFAULT_SPEED_KMH;

        const distance =
          existing.distanceKm;

        if (
          distance !== null
        ) {
          existing.etaMinutes =
            Math.max(
              0,
              Math.round(
                (
                  distance /
                  usableSpeed
                ) *
                  60
              )
            );
        }
      }
    }

    // ==========================================================
    // FINAL UPCOMING LIST
    // ==========================================================

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

    // ----------------------------------------------------------
    // SORT
    // ----------------------------------------------------------

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ----------------------------------------------------------
    // MAX 5
    // ----------------------------------------------------------

    const safeUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ==========================================================
    // FIREBASE UPDATE
    // ==========================================================

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

    // ==========================================================
    // UPCOMING DISPLAY
    // ==========================================================

    if (
      safeUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      safeUpcoming.forEach(
        (train, index) => {

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

  } catch (err) {

    console.error(
      "\n=========================================="
    );

    console.error(
      "[MONITOR ERROR]"
    );

    console.error(
      err.message
    );

    console.error(
      "=========================================="
    );

    // ----------------------------------------------------------
    // KEEP FIREBASE INFORMED OF ERROR
    // ----------------------------------------------------------

    try {
      await gateRef.update({
        monitorStatus:
          "ERROR",

        monitorError:
          err.message,

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
  "RailRadar API Key: Configured"
);

console.log(
  "Direction: TOWARD GUDUR only for upcoming"
);

console.log(
  "Gate closure: ACTUAL POSITION ONLY"
);

console.log(
  "Known corridor detection: ENABLED"
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
// RUN ONCE
// ============================================================

updateGateSystem();

// ============================================================
// RUN EVERY 3 MINUTES
// ============================================================
//
// GitHub Actions itself can run every 5 minutes.
// This interval is useful when running locally.
//

setInterval(
  updateGateSystem,
  180000
);
