const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");
const fs = require("fs");

// ============================================================
// GUDUR GATE MONITOR
// ============================================================
//
// IMPORTANT ETA RULE:
//
// 1. Train actually at Gudur       -> ETA 0m
// 2. Live ETA to Gudur available    -> use live ETA
// 3. Recent persisted live ETA      -> use it
// 4. Only timetable/scheduled ETA   -> DO NOT use it
// 5. Far-away train                 -> ETA "--"
// 6. After Gudur departure          -> continue gate tracking
//
// This prevents cases such as:
// Andaman Express being at Powerkheda
// but incorrectly showing "23m to Gudur".
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount =
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (
    fs.existsSync("./serviceAccountKey.json")
  ) {
    serviceAccount =
      require("./serviceAccountKey.json");
  } else {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
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
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");


// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  process.exit(1);
}


// ============================================================
// GUDUR / GATE GEOMETRY
// ============================================================

// Gudur Junction
const GUDUR_LAT =
  14.1451694;

const GUDUR_LNG =
  79.8443472;

// Tirupati Gate
const TPTY_GATE_LAT =
  14.1402028;

const TPTY_GATE_LNG =
  79.8435972;

// Chennai Gate
const MAS_GATE_LAT =
  14.1396667;

const MAS_GATE_LNG =
  79.8441278;


// ============================================================
// DISTANCE SETTINGS
// ============================================================

// Start tracking trains within 1 km of the
// physical gate area.
const TRACKING_DISTANCE_KM =
  1.00;

// Physical gate distance.
const GATE_DISTANCE_KM =
  0.52;

// Gate closes when the train is inside
// approximately 600 meters of the gate.
const GATE_CLOSE_DISTANCE_KM =
  0.60;

// Gate becomes clear after train has passed
// approximately 800 meters from the gate.
const GATE_CLEAR_DISTANCE_KM =
  0.80;

// Keep tracking records for this long.
const TRACKING_RETENTION_MINUTES =
  45;

// Upcoming list maximum.
const UPCOMING_MAX_ETA_MINUTES =
  360;

// Maximum trains shown.
const UPCOMING_MAX_TRAINS =
  8;


// ============================================================
// LIVE API QUOTA CONTROL
// ============================================================
//
// Free API usage is limited.
//
// Do NOT call live status for every train.
//
// One live verification approximately every 20 minutes.
//
// ============================================================

const LIVE_CHECK_INTERVAL_MINUTES =
  20;

const LIVE_CHECK_INTERVAL_MS =
  LIVE_CHECK_INTERVAL_MINUTES *
  60 *
  1000;


// ============================================================
// TRAIN NUMBER FALLBACK LISTS
// ============================================================
//
// These are ONLY fallback corridor hints.
// Actual gate closing still requires live
// position/direction evidence.
//
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
// TEXT HELPERS
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


function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
    }
  }

  return null;
}


// ============================================================
// NUMBER HELPERS
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
  if (
    lat1 === null ||
    lng1 === null ||
    lat2 === null ||
    lng2 === null
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    (
      (lat2 - lat1) *
      Math.PI
    ) / 180;

  const dLng =
    (
      (lng2 - lng1) *
      Math.PI
    ) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 * Math.PI / 180
    ) *
    Math.cos(
      lat2 * Math.PI / 180
    ) *
    Math.sin(dLng / 2) ** 2;

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
// COORDINATE EXTRACTION
// ============================================================

function getCoordinates(...objects) {
  for (const obj of objects) {
    if (!obj || typeof obj !== "object") {
      continue;
    }

    const coordinateObjects = [
      obj.coordinates,
      obj.coordinate,
      obj.location,
      obj.position,
      obj.currentLocation,
      obj.currentLocation?.coordinates
    ];

    for (const c of coordinateObjects) {
      if (!c || typeof c !== "object") {
        continue;
      }

      const lat =
        toNumber(
          firstValue(
            c.lat,
            c.latitude
          )
        );

      const lng =
        toNumber(
          firstValue(
            c.lng,
            c.lon,
            c.longitude
          )
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

    const lat =
      toNumber(
        firstValue(
          obj.lat,
          obj.latitude
        )
      );

    const lng =
      toNumber(
        firstValue(
          obj.lng,
          obj.lon,
          obj.longitude
        )
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
// GUDUR STATION DETECTION
// ============================================================

function isGudurStationObject(obj) {
  if (!obj) {
    return false;
  }

  const code =
    normalizeText(
      firstValue(
        obj.stationCode,
        obj.code
      )
    );

  const name =
    normalizeText(
      firstValue(
        obj.stationName,
        obj.name
      )
    );

  return (
    code === "GDR" ||
    name.includes("GUDUR")
  );
}


function isAtGudurStation(
  live
) {
  if (!live) {
    return false;
  }

  const current =
    live.currentLocation ||
    live.location ||
    {};

  if (
    isGudurStationObject(
      current
    )
  ) {
    return true;
  }

  if (
    String(
      current.status || ""
    ).toLowerCase() ===
      "at-station" &&
    isGudurStationObject(
      current
    )
  ) {
    return true;
  }

  return false;
}


// ============================================================
// TRAIN SEQUENCE
// ============================================================

function getCurrentSequence(
  live
) {
  return toNumber(
    firstValue(
      live?.currentLocation?.sequence,
      live?.sequence
    )
  );
}


function getPreviousHaltSequence(
  live
) {
  return toNumber(
    firstValue(
      live?.previousHalt?.sequence
    )
  );
}


function hasDepartedGudur(
  live
) {
  if (!live) {
    return false;
  }

  const currentSeq =
    getCurrentSequence(
      live
    );

  const previousSeq =
    getPreviousHaltSequence(
      live
    );

  if (
    currentSeq !== null &&
    previousSeq !== null &&
    currentSeq > previousSeq &&
    isGudurStationObject(
      live.previousHalt
    )
  ) {
    return true;
  }

  const current =
    live.currentLocation ||
    {};

  const status =
    String(
      current.status || ""
    ).toLowerCase();

  if (
    status === "departed" &&
    isGudurStationObject(
      current
    )
  ) {
    return true;
  }

  return false;
}


// ============================================================
// TRAIN ORIGIN / DESTINATION
// ============================================================

function getOrigin(
  train,
  item,
  live
) {
  const origin =
    firstValue(
      train?.origin,
      train?.source,
      train?.from,
      train?.fromStation,
      train?.startStation,
      train?.start,

      item?.origin,
      item?.source,
      item?.from,
      item?.fromStation,
      item?.startStation,

      live?.train?.origin,
      live?.train?.source
    );

  if (
    typeof origin === "object"
  ) {
    return firstValue(
      origin.name,
      origin.code
    ) || "";
  }

  return String(
    origin || ""
  );
}


function getDestination(
  train,
  item,
  live
) {
  const destination =
    firstValue(
      train?.destination,
      train?.to,
      train?.destinationStation,
      train?.endStation,

      item?.destination,
      item?.to,
      item?.destinationStation,

      live?.train?.destination
    );

  if (
    typeof destination === "object"
  ) {
    return firstValue(
      destination.name,
      destination.code
    ) || "";
  }

  return String(
    destination || ""
  );
}


// ============================================================
// CORRIDOR DETECTION
// ============================================================
//
// MAS:
// Chennai / Arakkonam side
//
// TPTY:
// Tirupati / western side
//
// UNKNOWN:
// Do not close a gate.
//
// ============================================================

function determineCorridor(
  train,
  item,
  live
) {
  const trainNo =
    String(
      train?.number ||
      live?.trainNumber ||
      item?.trainNumber ||
      ""
    ).trim();

  const origin =
    normalizeText(
      getOrigin(
        train,
        item,
        live
      )
    );

  const destination =
    normalizeText(
      getDestination(
        train,
        item,
        live
      )
    );

  // ----------------------------------------------------------
  // TIRUPATI SIDE
  // ----------------------------------------------------------

  const tirupatiOrigin =
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU",
        "KATPADDI",
        "KATPADI"
      ]
    );

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  const chennaiOrigin =
    containsAny(
      origin,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "CHENNAI CENTRAL",
        "AVADI",
        "PERAMBUR",
        "SULLURUPETA",
        "NAYUDUPETA",
        "ARAKKONAM",
        "AJJ"
      ]
    );

  // ----------------------------------------------------------
  // DESTINATION HINTS
  // ----------------------------------------------------------

  const tirupatiDestination =
    containsAny(
      destination,
      [
        "TIRUPATI",
        "TPTY"
      ]
    );

  const chennaiDestination =
    containsAny(
      destination,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI"
      ]
    );

  // ----------------------------------------------------------
  // EXPLICIT ORIGIN HAS PRIORITY
  // ----------------------------------------------------------

  if (tirupatiOrigin) {
    return "TPTY";
  }

  if (chennaiOrigin) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // TRAIN NUMBER FALLBACK
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // DESTINATION ALONE IS NOT ENOUGH TO CLOSE A GATE.
  //
  // We deliberately do not classify MAS merely because
  // destination is Chennai.
  //
  // ----------------------------------------------------------

  if (tirupatiDestination) {
    return "TPTY";
  }

  if (chennaiDestination) {
    return "MAS";
  }

  return null;
}


// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function getDirectionText(
  train,
  item,
  live
) {
  const values = [
    train?.direction,
    train?.travelDirection,
    train?.routeDirection,
    train?.runningDirection,

    item?.direction,
    item?.travelDirection,
    item?.routeDirection,
    item?.runningDirection,

    live?.direction,
    live?.travelDirection,
    live?.routeDirection,
    live?.runningDirection
  ];

  return values
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}


function getExplicitDirection(
  train,
  item,
  live
) {
  const direction =
    getDirectionText(
      train,
      item,
      live
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
    return "AWAY_FROM_GUDUR";
  }

  return null;
}


// ============================================================
// TIME PARSER
// ============================================================

function parseDateValue(
  value
) {
  if (!value) {
    return null;
  }

  if (
    value instanceof Date
  ) {
    return isNaN(
      value.getTime()
    )
      ? null
      : value;
  }

  const str =
    String(value).trim();

  if (!str) {
    return null;
  }

  // ISO / full date
  const direct =
    new Date(str);

  if (
    !isNaN(
      direct.getTime()
    )
  ) {
    return direct;
  }

  return null;
}


function parseTimeToMinutes(
  value
) {
  if (!value) {
    return null;
  }

  const date =
    parseDateValue(
      value
    );

  if (date) {
    return (
      date.getHours() * 60 +
      date.getMinutes()
    );
  }

  const match =
    String(value)
      .trim()
      .match(
        /(\d{1,2}):(\d{2})/
      );

  if (!match) {
    return null;
  }

  return (
    Number(match[1]) * 60 +
    Number(match[2])
  );
}


function currentMinutes() {
  const now =
    new Date();

  return (
    now.getHours() * 60 +
    now.getMinutes()
  );
}


function calculateTimeDifference(
  arrivalMinutes,
  nowMinutes
) {
  if (
    arrivalMinutes === null ||
    nowMinutes === null
  ) {
    return null;
  }

  let diff =
    arrivalMinutes -
    nowMinutes;

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}


// ============================================================
// IMPORTANT: LIVE ETA ONLY
// ============================================================
//
// THIS FUNCTION NEVER USES:
// stop.arrival
// scheduled arrival
// timetable arrival
//
// unless the live API explicitly identifies it as an
// expected/live arrival.
//
// ============================================================

function getLiveEtaMinutes(
  live
) {
  if (!live) {
    return null;
  }

  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      live
    )
  ) {
    return 0;
  }

  // ----------------------------------------------------------
  // LIVE EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const expected =
    firstValue(
      live.expectedArrivalTime,
      live.expectedArrival,
      live.eta,
      live.etaMinutes,
      live.currentLocation?.expectedArrivalTime,
      live.nextHalt?.expectedArrivalTime,
      live.nextHalt?.etaMinutes
    );

  if (
    expected !== null
  ) {
    // Already numeric minutes
    if (
      typeof expected === "number" ||
      (
        typeof expected === "string" &&
        /^\d+(\.\d+)?$/.test(
          expected.trim()
        )
      )
    ) {
      const n =
        Number(expected);

      if (
        Number.isFinite(n) &&
        n >= 0 &&
        n <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        return Math.round(n);
      }
    }

    // Date/time
    const parsed =
      parseTimeToMinutes(
        expected
      );

    if (parsed !== null) {
      const diff =
        calculateTimeDifference(
          parsed,
          currentMinutes()
        );

      if (
        diff !== null &&
        diff >= 0 &&
        diff <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        return Math.round(diff);
      }
    }
  }

  return null;
}


// ============================================================
// VERIFY LIVE TRAIN IS HEADING TO GUDUR
// ============================================================

function isNextHaltGudur(
  live
) {
  if (!live) {
    return false;
  }

  const next =
    live.nextHalt ||
    live.nextStation ||
    {};

  return isGudurStationObject(
    next
  );
}


// ============================================================
// LIVE POSITION DISTANCE
// ============================================================

function getDistanceFromGudur(
  live
) {
  const coords =
    getCoordinates(
      live?.currentLocation,
      live?.location,
      live
    );

  if (!coords) {
    return null;
  }

  return distanceKm(
    coords.lat,
    coords.lng,
    GUDUR_LAT,
    GUDUR_LNG
  );
}


function getDistanceFromGate(
  live,
  corridor
) {
  const coords =
    getCoordinates(
      live?.currentLocation,
      live?.location,
      live
    );

  if (!coords) {
    return null;
  }

  if (
    corridor === "TPTY"
  ) {
    return distanceKm(
      coords.lat,
      coords.lng,
      TPTY_GATE_LAT,
      TPTY_GATE_LNG
    );
  }

  if (
    corridor === "MAS"
  ) {
    return distanceKm(
      coords.lat,
      coords.lng,
      MAS_GATE_LAT,
      MAS_GATE_LNG
    );
  }

  return null;
}


// ============================================================
// BEARING / DIRECTION TO GATE
// ============================================================

function bearingDegrees(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const phi1 =
    lat1 *
    Math.PI /
    180;

  const phi2 =
    lat2 *
    Math.PI /
    180;

  const lambda =
    (
      lng2 -
      lng1
    ) *
    Math.PI /
    180;

  const y =
    Math.sin(lambda) *
    Math.cos(phi2);

  const x =
    Math.cos(phi1) *
      Math.sin(phi2) -
    Math.sin(phi1) *
      Math.cos(phi2) *
      Math.cos(lambda);

  const bearing =
    Math.atan2(
      y,
      x
    ) *
    180 /
    Math.PI;

  return (
    bearing + 360
  ) % 360;
}


function bearingDifference(
  a,
  b
) {
  let d =
    Math.abs(
      a - b
    );

  if (d > 180) {
    d =
      360 - d;
  }

  return d;
}


// ============================================================
// TRACKING STATE
// ============================================================

const trackingRef =
  db.ref(
    "gudur_gates/tracking"
  );


// ============================================================
// TIMESTAMP HELPERS
// ============================================================

function parseStoredTimestamp(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value === "number"
  ) {
    if (
      value > 100000000000
    ) {
      return value;
    }

    if (
      value > 1000000000
    ) {
      return value * 1000;
    }

    return null;
  }

  const n =
    Number(value);

  if (
    Number.isFinite(n) &&
    n > 1000000000
  ) {
    return n > 100000000000
      ? n
      : n * 1000;
  }

  const parsed =
    Date.parse(
      String(value)
    );

  return Number.isNaN(parsed)
    ? null
    : parsed;
}


// ============================================================
// CLEAN TRACKING RECORD
// ============================================================

function isRecentRecord(
  record
) {
  const ts =
    parseStoredTimestamp(
      record?.updatedAt
    );

  if (!ts) {
    return false;
  }

  const age =
    Date.now() - ts;

  return (
    age >= 0 &&
    age <=
      TRACKING_RETENTION_MINUTES *
        60 *
        1000
  );
}


// ============================================================
// TRACKING RECORD CREATOR
// ============================================================

function createTrackingRecord(
  trainNo,
  trainName,
  corridor,
  origin,
  destination
) {
  return {
    trainNo,
    trainName,
    corridor:
      corridor || null,

    origin:
      origin || "",

    destination:
      destination || "",

    state:
      "APPROACHING_GUDUR",

    etaMinutes:
      null,

    distanceFromGudurKm:
      null,

    distanceFromGateKm:
      null,

    direction:
      "TOWARD_GUDUR",

    updatedAt:
      Date.now()
  };
}


// ============================================================
// UPDATE TRACKING RECORD
// ============================================================

async function updateTrackingRecord(
  trainNo,
  trainName,
  corridor,
  origin,
  destination,
  live
) {
  if (!trainNo) {
    return null;
  }

  const ref =
    trackingRef.child(
      trainNo
    );

  const snapshot =
    await ref.once(
      "value"
    );

  let record =
    snapshot.val();

  if (
    !record ||
    !isRecentRecord(record)
  ) {
    record =
      createTrackingRecord(
        trainNo,
        trainName,
        corridor,
        origin,
        destination
      );
  }

  // Never blindly overwrite a known corridor.
  if (
    !record.corridor &&
    corridor
  ) {
    record.corridor =
      corridor;
  }

  if (
    trainName
  ) {
    record.trainName =
      trainName;
  }

  if (
    origin
  ) {
    record.origin =
      origin;
  }

  if (
    destination
  ) {
    record.destination =
      destination;
  }

  // ----------------------------------------------------------
  // LIVE COORDINATES
  // ----------------------------------------------------------

  const distanceGdr =
    getDistanceFromGudur(
      live
    );

  const distanceGate =
    getDistanceFromGate(
      live,
      record.corridor
    );

  if (
    distanceGdr !== null
  ) {
    record.distanceFromGudurKm =
      Number(
        distanceGdr.toFixed(3)
      );
  }

  if (
    distanceGate !== null
  ) {
    record.distanceFromGateKm =
      Number(
        distanceGate.toFixed(3)
      );
  }

  // ----------------------------------------------------------
  // GUDUR STATION
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      live
    )
  ) {
    record.state =
      "AT_GUDUR_STATION";

    record.etaMinutes =
      0;

    record.direction =
      "AT_GUDUR";

    record.updatedAt =
      Date.now();

    await ref.set(
      record
    );

    console.log(
      `[AT GUDUR] ${trainNo} ${trainName}`
    );

    return record;
  }

  // ----------------------------------------------------------
  // DEPARTED GUDUR
  // ----------------------------------------------------------

  if (
    hasDepartedGudur(
      live
    )
  ) {
    record.state =
      "DEPARTED_GUDUR";

    record.direction =
      "AWAY_FROM_GUDUR";

    // IMPORTANT:
    // Do not return here.
    //
    // We MUST continue checking the gate distance.
    // ----------------------------------------------------------

    if (
      distanceGate !== null &&
      distanceGate <=
        GATE_CLOSE_DISTANCE_KM
    ) {
      record.state =
        "AT_GATE";
    } else {
      record.state =
        "APPROACHING_GATE";
    }

    record.etaMinutes =
      null;

    record.updatedAt =
      Date.now();

    await ref.set(
      record
    );

    console.log(
      `[DEPARTED GDR] ${trainNo} ${trainName} | gate=${distanceGate !== null ? distanceGate.toFixed(3) : "--"} km`
    );

    return record;
  }

  // ----------------------------------------------------------
  // TRAIN IS APPROACHING GUDUR
  // ----------------------------------------------------------

  const nextIsGudur =
    isNextHaltGudur(
      live
    );

  if (
    nextIsGudur
  ) {
    record.state =
      "APPROACHING_GUDUR";

    record.direction =
      "TOWARD_GUDUR";

    const liveEta =
      getLiveEtaMinutes(
        live
      );

    // IMPORTANT:
    // null is intentional.
    //
    // NEVER convert unknown ETA to 0.
    //
    record.etaMinutes =
      liveEta;

    record.updatedAt =
      Date.now();

    await ref.set(
      record
    );

    console.log(
      `[APPROACHING GDR] ${trainNo} ${trainName} | ETA=${liveEta !== null ? liveEta + "m" : "--"} | GDR=${distanceGdr !== null ? distanceGdr.toFixed(2) + " km" : "--"}`
    );

    return record;
  }

  // ----------------------------------------------------------
  // UNKNOWN LIVE STATE
  // ----------------------------------------------------------

  record.updatedAt =
    Date.now();

  await ref.set(
    record
  );

  return record;
}


// ============================================================
// LIVE API
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    console.log(
      `[LIVE API] Checking train ${trainNo}...`
    );

    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(trainNo)}/live`,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          params: {
            authoritative:
              true,

            includeCoordinates:
              true,

            geometry:
              true
          },

          timeout:
            15000
        }
      );

    return (
      response.data?.data ||
      response.data ||
      null
    );

  } catch (error) {
    if (
      error.response
    ) {
      console.error(
        `[LIVE ERROR] ${trainNo} HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo}: ${error.message}`
      );
    }

    return null;
  }
}


// ============================================================
// STATION BOARD
// ============================================================

async function fetchStationBoard() {
  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`,
      {
        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,

          Accept:
            "application/json"
        },

        timeout:
          15000
      }
    );

  return (
    response.data?.data?.trains ||
    []
  );
}


// ============================================================
// BOARD TRAIN NAME
// ============================================================

function getTrainNumber(
  item
) {
  return String(
    firstValue(
      item?.train?.number,
      item?.trainNumber,
      item?.number
    ) || ""
  ).trim();
}


function getTrainName(
  item
) {
  return String(
    firstValue(
      item?.train?.name,
      item?.trainName,
      item?.name
    ) ||
      `Train ${getTrainNumber(item)}`
  );
}


// ============================================================
// BOARD LIVE OBJECT
// ============================================================

function getBoardLive(
  item
) {
  return (
    item?.live ||
    null
  );
}


// ============================================================
// SAFE BOARD ETA
// ============================================================
//
// VERY IMPORTANT:
//
// We intentionally do NOT read:
// stop.arrival
// stop.departure
// train.arrival
// train.departure
//
// Those are timetable values.
//
// A train at Powerkheda could have a scheduled
// Gudur arrival in 23 minutes, but that does NOT
// mean it will actually reach Gudur in 23 minutes.
//
// ============================================================

function getSafeBoardEta(
  item,
  trackingRecord
) {
  const live =
    getBoardLive(
      item
    );

  // ----------------------------------------------------------
  // LIVE DATA
  // ----------------------------------------------------------

  if (
    live
  ) {
    const liveEta =
      getLiveEtaMinutes(
        live
      );

    if (
      liveEta !== null
    ) {
      return {
        etaMinutes:
          liveEta,

        source:
          "LIVE"
      };
    }

    if (
      isAtGudurStation(
        live
      )
    ) {
      return {
        etaMinutes:
          0,

        source:
          "LIVE_STATION"
      };
    }
  }

  // ----------------------------------------------------------
  // RECENT PERSISTED LIVE RECORD
  // ----------------------------------------------------------

  if (
    trackingRecord &&
    isRecentRecord(
      trackingRecord
    ) &&
    trackingRecord.etaMinutes !== null &&
    trackingRecord.etaMinutes !== undefined
  ) {
    const eta =
      Number(
        trackingRecord.etaMinutes
      );

    if (
      Number.isFinite(eta) &&
      eta >= 0 &&
      eta <=
        UPCOMING_MAX_ETA_MINUTES
    ) {
      return {
        etaMinutes:
          Math.round(eta),

        source:
          "TRACKING"
      };
    }
  }

  // ----------------------------------------------------------
  // NO LIVE ETA
  // ----------------------------------------------------------
  //
  // DO NOT FALL BACK TO SCHEDULED TIME.
  //
  // This is the fix for the Andaman Express problem.
  //
  // ----------------------------------------------------------

  return {
    etaMinutes:
      null,

    source:
      "UNKNOWN"
  };
}


// ============================================================
// TRACKING RECORDS LOAD
// ============================================================

async function loadTrackingRecords() {
  const snapshot =
    await trackingRef.once(
      "value"
    );

  return (
    snapshot.val() ||
    {}
  );
}


// ============================================================
// CLEAN OLD TRACKING RECORDS
// ============================================================

async function cleanupTrackingRecords(
  records
) {
  const updates =
    {};

  const now =
    Date.now();

  for (
    const [
      trainNo,
      record
    ] of Object.entries(
      records || {}
    )
  ) {
    const ts =
      parseStoredTimestamp(
        record?.updatedAt
      );

    if (!ts) {
      updates[
        trainNo
      ] = null;

      continue;
    }

    const age =
      now - ts;

    if (
      age >
      TRACKING_RETENTION_MINUTES *
        60 *
        1000
    ) {
      updates[
        trainNo
      ] = null;
    }
  }

  if (
    Object.keys(updates)
      .length > 0
  ) {
    await trackingRef.update(
      updates
    );
  }
}


// ============================================================
// LIVE CANDIDATE SELECTION
// ============================================================
//
// Priority:
// 1. Existing gate tracking
// 2. Existing DEPARTED/AT_GATE
// 3. Existing GDR candidates
// 4. Trains closest to Gudur if coordinates exist
//
// Only ONE live call is made per monitor run.
//
// ============================================================

function selectLiveCandidate(
  trains,
  trackingRecords
) {
  const candidates =
    [];

  for (
    const item of trains
  ) {
    const train =
      item?.train ||
      {};

    const trainNo =
      getTrainNumber(
        item
      );

    if (!trainNo) {
      continue;
    }

    const record =
      trackingRecords[
        trainNo
      ];

    const state =
      record?.state ||
      "";

    let priority =
      100;

    if (
      state ===
      "AT_GATE"
    ) {
      priority =
        0;
    } else if (
      state ===
      "APPROACHING_GATE"
    ) {
      priority =
        1;
    } else if (
      state ===
      "DEPARTED_GUDUR"
    ) {
      priority =
        2;
    } else if (
      state ===
      "AT_GUDUR_STATION"
    ) {
      priority =
        3;
    } else if (
      state ===
      "APPROACHING_GUDUR"
    ) {
      priority =
        4;
    }

    const boardLive =
      getBoardLive(
        item
      );

    const distance =
      getDistanceFromGudur(
        boardLive
      );

    if (
      distance !== null
    ) {
      priority -=
        Math.min(
          20,
          Math.max(
            0,
            20 -
              distance * 10
          )
        );
    }

    candidates.push({
      item,
      priority
    });
  }

  candidates.sort(
    (a, b) =>
      a.priority -
      b.priority
  );

  return (
    candidates[0]?.item ||
    null
  );
}


// ============================================================
// BUILD UPCOMING TRAINS
// ============================================================

async function buildUpcomingTrains(
  trains,
  trackingRecords
) {
  const list =
    [];

  for (
    const item of trains
  ) {
    const train =
      item?.train ||
      {};

    const live =
      item?.live ||
      null;

    const trainNo =
      getTrainNumber(
        item
      );

    if (!trainNo) {
      continue;
    }

    const trainName =
      getTrainName(
        item
      );

    const origin =
      getOrigin(
        train,
        item,
        live
      );

    const destination =
      getDestination(
        train,
        item,
        live
      );

    const corridor =
      determineCorridor(
        train,
        item,
        live
      );

    const record =
      trackingRecords[
        trainNo
      ];

    const safeEta =
      getSafeBoardEta(
        item,
        record
      );

    // --------------------------------------------------------
    // AT GUDUR
    // --------------------------------------------------------

    let state =
      record?.state ||
      null;

    if (
      live &&
      isAtGudurStation(
        live
      )
    ) {
      state =
        "AT_GUDUR_STATION";
    }

    // --------------------------------------------------------
    // DEPARTED GUDUR
    // --------------------------------------------------------

    if (
      live &&
      hasDepartedGudur(
        live
      )
    ) {
      state =
        "DEPARTED_GUDUR";
    }

    // --------------------------------------------------------
    // If this is not a live/persisted candidate,
    // still show it only if it has a meaningful
    // relation to Gudur.
    //
    // We do NOT show every train from the board.
    // --------------------------------------------------------

    const nextIsGudur =
      live
        ? isNextHaltGudur(
            live
          )
        : false;

    const isTracked =
      Boolean(
        record &&
        isRecentRecord(
          record
        )
      );

    if (
      !nextIsGudur &&
      !isTracked
    ) {
      continue;
    }

    // --------------------------------------------------------
    // ETA
    // --------------------------------------------------------

    const eta =
      safeEta.etaMinutes;

    // --------------------------------------------------------
    // Reject obviously stale/fake ETA.
    // --------------------------------------------------------

    if (
      eta !== null &&
      (
        eta < 0 ||
        eta >
          UPCOMING_MAX_ETA_MINUTES
      )
    ) {
      continue;
    }

    // --------------------------------------------------------
    // TRAIN OBJECT
    // --------------------------------------------------------

    list.push({
      trainNo,

      name:
        trainName,

      origin:
        origin || "Unknown",

      destination:
        destination || "Gudur",

      etaMinutes:
        eta,

      etaDisplay:
        eta === null
          ? "--"
          : String(
              Math.max(
                0,
                Math.round(eta)
              )
            ),

      etaSource:
        safeEta.source,

      delayMinutes:
        Number(
          firstValue(
            live?.delayMinutes,
            item?.live?.delayMinutes,
            item?.delayMinutes,
            0
          )
        ) || 0,

      corridor:
        corridor ||
        record?.corridor ||
        "OTHER",

      direction:
        state ===
          "DEPARTED_GUDUR" ||
        state ===
          "APPROACHING_GATE" ||
        state ===
          "AT_GATE"
          ? "AWAY_FROM_GUDUR"
          : "TOWARD_GUDUR",

      state:
        state ||
        "APPROACHING_GUDUR",

      platform:
        String(
          firstValue(
            live?.platform,
            item?.live?.platform,
            item?.platform,
            ""
          ) || ""
        )
    });
  }

  // ----------------------------------------------------------
  // SORT
  //
  // Known ETA first.
  // Unknown ETA after known ETA.
  // ----------------------------------------------------------

  list.sort(
    (a, b) => {
      if (
        a.etaMinutes === null &&
        b.etaMinutes !== null
      ) {
        return 1;
      }

      if (
        a.etaMinutes !== null &&
        b.etaMinutes === null
      ) {
        return -1;
      }

      if (
        a.etaMinutes === null &&
        b.etaMinutes === null
      ) {
        return (
          a.trainNo.localeCompare(
            b.trainNo
          )
        );
      }

      return (
        a.etaMinutes -
        b.etaMinutes
      );
    }
  );

  return list.slice(
    0,
    UPCOMING_MAX_TRAINS
  );
}


// ============================================================
// GATE STATE
// ============================================================

function openGate(
  activeTrain =
    "Tracks clear"
) {
  return {
    status:
      "OPEN",

    waitMinutes:
      0,

    activeTrain,

    direction:
      "CLEAR",

    corridor:
      null
  };
}


function closedGate(
  train,
  corridor,
  distanceKmValue
) {
  let waitMinutes =
    5;

  if (
    distanceKmValue !== null
  ) {
    const estimated =
      Math.round(
        Math.max(
          1,
          distanceKmValue *
            3
        )
      );

    waitMinutes =
      Math.min(
        10,
        estimated
      );
  }

  return {
    status:
      "CLOSED",

    waitMinutes,

    activeTrain:
      `${train.trainNo} ${train.name}`,

    direction:
      "AWAY_FROM_GUDUR",

    corridor:
      corridor
  };
}


// ============================================================
// DETERMINE GATE STATES
// ============================================================

async function determineGateStates(
  trackingRecords
) {
  let masGate =
    openGate();

  let tptyGate =
    openGate();

  for (
    const [
      trainNo,
      record
    ] of Object.entries(
      trackingRecords || {}
    )
  ) {
    if (
      !record ||
      !isRecentRecord(record)
    ) {
      continue;
    }

    const corridor =
      record.corridor;

    if (
      corridor !== "MAS" &&
      corridor !== "TPTY"
    ) {
      continue;
    }

    const state =
      record.state;

    // --------------------------------------------------------
    // ONLY AT_GATE CLOSES THE GATE.
    // --------------------------------------------------------

    if (
      state !== "AT_GATE"
    ) {
      continue;
    }

    const distance =
      Number(
        record.distanceFromGateKm
      );

    const validDistance =
      Number.isFinite(
        distance
      );

    if (
      validDistance &&
      distance >
        GATE_CLOSE_DISTANCE_KM
    ) {
      continue;
    }

    const train = {
      trainNo,

      name:
        record.trainName ||
        `Train ${trainNo}`
    };

    const payload =
      closedGate(
        train,
        corridor,
        validDistance
          ? distance
          : null
      );

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
  }

  return {
    masGate,
    tptyGate
  };
}


// ============================================================
// UPDATE TRACKING FROM LIVE TRAIN
// ============================================================

async function processLiveCandidate(
  item,
  trackingRecords
) {
  if (!item) {
    return;
  }

  const train =
    item.train ||
    {};

  const trainNo =
    getTrainNumber(
      item
    );

  if (!trainNo) {
    return;
  }

  const trainName =
    getTrainName(
      item
    );

  const live =
    await fetchLiveTrain(
      trainNo
    );

  if (!live) {
    return;
  }

  const origin =
    getOrigin(
      train,
      item,
      live
    );

  const destination =
    getDestination(
      train,
      item,
      live
    );

  const corridor =
    determineCorridor(
      train,
      item,
      live
    );

  const record =
    await updateTrackingRecord(
      trainNo,
      trainName,
      corridor,
      origin,
      destination,
      live
    );

  trackingRecords[
    trainNo
  ] =
    record;
}


// ============================================================
// MAIN UPDATE
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
      `[${now.toLocaleTimeString()}] GUDUR GATE MONITOR`
    );

    console.log(
      "=========================================="
    );

    // --------------------------------------------------------
    // LOAD TRACKING
    // --------------------------------------------------------

    let trackingRecords =
      await loadTrackingRecords();

    // --------------------------------------------------------
    // CLEAN OLD RECORDS
    // --------------------------------------------------------

    await cleanupTrackingRecords(
      trackingRecords
    );

    // Reload after cleanup.
    trackingRecords =
      await loadTrackingRecords();

    // --------------------------------------------------------
    // STATION BOARD
    // --------------------------------------------------------

    console.log(
      "[BOARD] Querying RailRadar GDR station board..."
    );

    const trains =
      await fetchStationBoard();

    console.log(
      `[BOARD] RailRadar returned ${trains.length} trains.`
    );

    // --------------------------------------------------------
    // SHOW IMPORTANT BOARD INFORMATION
    // --------------------------------------------------------

    for (
      const item of trains
    ) {
      const trainNo =
        getTrainNumber(
          item
        );

      if (!trainNo) {
        continue;
      }

      const live =
        getBoardLive(
          item
        );

      if (
        live
      ) {
        const coords =
          getCoordinates(
            live
          );

        if (
          coords
        ) {
          const distance =
            distanceKm(
              coords.lat,
              coords.lng,
              GUDUR_LAT,
              GUDUR_LNG
            );

          if (
            distance !== null &&
            distance >
              5
          ) {
            console.log(
              `[FAR TRAIN] ${trainNo} ${getTrainName(item)} | GDR ${distance.toFixed(1)} km away`
            );
          }
        }
      }
    }

    // --------------------------------------------------------
    // SELECT ONE LIVE TRAIN
    // --------------------------------------------------------

    const liveCandidate =
      selectLiveCandidate(
        trains,
        trackingRecords
      );

    if (
      liveCandidate
    ) {
      const trainNo =
        getTrainNumber(
          liveCandidate
        );

      console.log(
        `[STAGE 2] Live verification candidate: ${trainNo} ${getTrainName(liveCandidate)}`
      );

      await processLiveCandidate(
        liveCandidate,
        trackingRecords
      );
    } else {
      console.log(
        "[STAGE 2] No live verification candidate."
      );
    }

    // --------------------------------------------------------
    // RELOAD TRACKING AFTER LIVE UPDATE
    // --------------------------------------------------------

    trackingRecords =
      await loadTrackingRecords();

    // --------------------------------------------------------
    // GATE STATES
    // --------------------------------------------------------

    const gateStates =
      await determineGateStates(
        trackingRecords
      );

    // --------------------------------------------------------
    // UPCOMING TRAINS
    // --------------------------------------------------------

    const upcomingTrains =
      await buildUpcomingTrains(
        trains,
        trackingRecords
      );

    // --------------------------------------------------------
    // FIREBASE PAYLOAD
    // --------------------------------------------------------

    const firebasePayload = {
      tirupatiGate:
        gateStates.tptyGate,

      chennaiGate:
        gateStates.masGate,

      upcomingTrains,

      lastUpdated:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleTimeString(),

      monitorStatus:
        "ONLINE"
    };

    // --------------------------------------------------------
    // FIREBASE UPDATE
    // --------------------------------------------------------

    await gateRef.set(
      firebasePayload
    );

    // --------------------------------------------------------
    // LOG GATES
    // --------------------------------------------------------

    console.log(
      "\n[FIREBASE SYNC SUCCESS]"
    );

    console.log(
      ` -> Chennai Gate : ${gateStates.masGate.status}`
    );

    console.log(
      ` -> Tirupati Gate: ${gateStates.tptyGate.status}`
    );

    // --------------------------------------------------------
    // UPCOMING LOG
    // --------------------------------------------------------

    console.log(
      ` -> Upcoming trains: ${upcomingTrains.length}`
    );

    if (
      upcomingTrains.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS]"
      );

      upcomingTrains.forEach(
        (train, index) => {
          console.log(
            ` ${index + 1}. ${train.trainNo} ${train.name} | ETA ${train.etaDisplay}m | ${train.corridor} | ${train.state} | source=${train.etaSource}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS] None"
      );
    }

    // --------------------------------------------------------
    // SPECIFIC SAFETY LOG
    // --------------------------------------------------------

    for (
      const train of upcomingTrains
    ) {
      if (
        train.etaMinutes === null
      ) {
        console.log(
          `[ETA UNKNOWN] ${train.trainNo} ${train.name} - no live Gudur ETA available; scheduled timetable is NOT being used.`
        );
      }
    }

    // --------------------------------------------------------
    // PERFORMANCE
    // --------------------------------------------------------

    console.log(
      `\n[SYNC COMPLETE] ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );

  } catch (error) {
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
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        error.message
      );
    }

    // --------------------------------------------------------
    // IMPORTANT:
    // Do NOT overwrite Firebase with fake OPEN/CLOSED data
    // when the RailRadar request fails.
    // --------------------------------------------------------

    try {
      await gateRef.update({
        monitorStatus:
          "ERROR",

        lastError:
          error.message,

        lastErrorAt:
          new Date().toISOString()
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
// START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " GUDUR REAL-TIME GATE MONITOR"
);

console.log(
  "=========================================="
);

console.log(
  "Gudur Junction:"
);

console.log(
  " 14.1451694, 79.8443472"
);

console.log(
  "Tirupati Gate:"
);

console.log(
  " 14.1402028, 79.8435972"
);

console.log(
  "Chennai Gate:"
);

console.log(
  " 14.1396667, 79.8441278"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Tracking radius : 1.00 km"
);

console.log(
  "Gate close zone : 0.60 km"
);

console.log(
  "Gate clear zone : 0.80 km"
);

console.log(
  "Live API check  : every 20 minutes"
);

console.log(
  "ETA source      : LIVE ONLY"
);

console.log(
  "Scheduled ETA   : NEVER USED AS LIVE ETA"
);

console.log(
  "=========================================="
);


// ============================================================
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();


// ============================================================
// RUN EVERY 5 MINUTES
// ============================================================
//
// Station board:
// every 5 minutes.
//
// Live train verification:
// internally limited by the 20-minute policy above.
//
// ============================================================

setInterval(
  updateGateSystem,
  5 * 60 * 1000
);
