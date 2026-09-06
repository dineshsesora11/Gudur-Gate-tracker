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
  } else {
    serviceAccount = require("./serviceAccountKey.json");
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    "Set FIREBASE_SERVICE_ACCOUNT or place serviceAccountKey.json beside code.js."
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
const TIRUPATI_GATE_LNG = 79.8436;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;
const UPCOMING_MAX_ETA_MINUTES = 360;

const LIVE_VERIFY_ETA_MINUTES = 60;

const MAX_LIVE_CALLS = 2;

const GATE_TRIGGER_DISTANCE_KM = 0.60;

// ============================================================
// KNOWN SOUTHERN / TIRUPATI-SIDE TRAINS
// ============================================================
//
// These are used only as a fallback when RailRadar's route
// information is incomplete.
//
// IMPORTANT:
// A fallback classification does NOT override an explicit
// outbound direction.
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
    "07670",

    // Bengaluru / southern corridor trains
    "12845"
  ]);

// ============================================================
// STATION CODES — CHENNAI SIDE
// ============================================================

const CHENNAI_SIDE_CODES =
  new Set([
    "MAS",
    "MS",
    "MSB",
    "AJJ",
    "AVD",
    "PER",
    "PERAMBUR",
    "SPE",
    "SULLURUPETA",
    "NYP",
    "NAYUDUPETA"
  ]);

// ============================================================
// STATION CODES — TIRUPATI / SOUTHERN SIDE
// ============================================================

const SOUTHERN_SIDE_CODES =
  new Set([
    "TPTY",
    "RU",

    // Bengaluru
    "SBC",
    "SMVB",
    "YPR",
    "KJM",
    "BNC",
    "BNCE",

    // Andhra / Rayalaseema
    "TIRUPATI",
    "RENIGUNTA",
    "KATPADI",
    "KPD",
    "JTJ",

    // Other common southern origin points
    "MYS",
    "MYSURU",
    "UBL",
    "DMM",
    "DWR",
    "BWT"
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
    )
    .trim();
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
// OBJECT -> SEARCHABLE TEXT
// ============================================================
//
// RailRadar may return:
//
// source: {
//   code: "MAS",
//   name: "MGR Chennai Central",
//   lat: ...,
//   lng: ...
// }
//
// The previous code did not properly handle this.
//
// This function converts nested objects into searchable text.
//

function objectToSearchText(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return normalizeText(
      value
    );
  }

  if (
    typeof value ===
    "number"
  ) {
    return String(value);
  }

  if (
    Array.isArray(value)
  ) {
    return value
      .map(
        objectToSearchText
      )
      .filter(Boolean)
      .join(" ");
  }

  if (
    typeof value ===
    "object"
  ) {
    const importantFields = [
      "code",
      "stationCode",
      "name",
      "stationName",
      "shortName",
      "label",
      "city",
      "station",
      "source",
      "destination",
      "from",
      "to"
    ];

    return importantFields
      .map(
        (key) =>
          value[key]
      )
      .map(
        objectToSearchText
      )
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

// ============================================================
// EXTRACT STATION CODE
// ============================================================

function extractStationCode(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    const normalized =
      normalizeText(value);

    // Exact 2-5 character code
    if (
      /^[A-Z0-9]{2,5}$/.test(
        normalized
      )
    ) {
      return normalized;
    }

    return "";
  }

  if (
    typeof value ===
    "object"
  ) {
    return normalizeText(
      value.code ||
      value.stationCode ||
      value.station?.code ||
      ""
    );
  }

  return "";
}

// ============================================================
// GET ORIGIN OBJECT / TEXT
// ============================================================

function getOriginValue(
  train,
  item
) {
  return (
    train?.origin ??
    train?.source ??
    train?.from ??
    train?.fromStation ??
    train?.startStation ??
    train?.start ??
    item?.origin ??
    item?.source ??
    item?.from ??
    item?.fromStation ??
    item?.startStation ??
    ""
  );
}

// ============================================================
// GET DESTINATION OBJECT / TEXT
// ============================================================

function getDestinationValue(
  train,
  item
) {
  return (
    train?.destination ??
    train?.to ??
    train?.destinationStation ??
    train?.endStation ??
    item?.destination ??
    item?.to ??
    item?.destinationStation ??
    ""
  );
}

// ============================================================
// DISPLAY ORIGIN
// ============================================================

function getOriginDisplay(
  train,
  item
) {
  const value =
    getOriginValue(
      train,
      item
    );

  if (
    typeof value ===
    "object"
  ) {
    return (
      value.name ||
      value.stationName ||
      value.code ||
      ""
    );
  }

  return String(
    value || ""
  );
}

// ============================================================
// DISPLAY DESTINATION
// ============================================================

function getDestinationDisplay(
  train,
  item
) {
  const value =
    getDestinationValue(
      train,
      item
    );

  if (
    typeof value ===
    "object"
  ) {
    return (
      value.name ||
      value.stationName ||
      value.code ||
      ""
    );
  }

  return String(
    value || ""
  );
}

// ============================================================
// ORIGIN SEARCH TEXT
// ============================================================

function getOriginSearchText(
  train,
  item
) {
  return objectToSearchText(
    getOriginValue(
      train,
      item
    )
  );
}

// ============================================================
// DESTINATION SEARCH TEXT
// ============================================================

function getDestinationSearchText(
  train,
  item
) {
  return objectToSearchText(
    getDestinationValue(
      train,
      item
    )
  );
}

// ============================================================
// GET DIRECTION TEXT
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  return [
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
  ]
    .map(
      objectToSearchText
    )
    .filter(Boolean)
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function hasInboundDirection(
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

  // ----------------------------------------------------------
  // INBOUND
  // ----------------------------------------------------------

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
    return true;
  }

  // ----------------------------------------------------------
  // OUTBOUND
  // ----------------------------------------------------------

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
    return false;
  }

  return null;
}

// ============================================================
// ROUTE STATION CODE EXTRACTION
// ============================================================

function getRouteStationCode(
  station
) {
  return normalizeText(
    station?.stationCode ||
    station?.code ||
    station?.station?.code ||
    station?.station?.stationCode ||
    ""
  );
}

// ============================================================
// ROUTE SEQUENCE
// ============================================================

function getStationSequence(
  route,
  stationCodes
) {
  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  const wanted =
    stationCodes.map(
      normalizeText
    );

  for (
    const station of route
  ) {
    const code =
      getRouteStationCode(
        station
      );

    if (
      wanted.includes(code)
    ) {
      const sequence =
        Number(
          station?.sequence
        );

      if (
        Number.isFinite(
          sequence
        )
      ) {
        return sequence;
      }
    }
  }

  return null;
}

// ============================================================
// ROUTE CONTAINS STATION
// ============================================================

function routeContainsStation(
  route,
  stationCodes
) {
  if (
    !Array.isArray(route)
  ) {
    return false;
  }

  const wanted =
    stationCodes.map(
      normalizeText
    );

  return route.some(
    (station) =>
      wanted.includes(
        getRouteStationCode(
          station
        )
      )
  );
}

// ============================================================
// ROUTE TEXT
// ============================================================

function getRouteSearchText(
  route
) {
  if (
    !Array.isArray(route)
  ) {
    return "";
  }

  return route
    .map(
      (station) =>
        objectToSearchText(
          station
        )
    )
    .filter(Boolean)
    .join(" ");
}

// ============================================================
// DETERMINE CORRIDOR FROM ROUTE
// ============================================================
//
// Strongest method.
//
// MAS -> GDR means Chennai-side train.
// TPTY/RU -> GDR means southern/Tirupati-side train.
//
// Sequence is important.
//
// We only classify a southern station as useful if it appears
// BEFORE GDR in the route.
//

function determineCorridorFromRoute(
  train,
  live,
  stop,
  item,
  route
) {
  const explicitDirection =
    hasInboundDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicitDirection ===
    false
  ) {
    return null;
  }

  if (
    !Array.isArray(route) ||
    route.length === 0
  ) {
    return null;
  }

  const gudurSeq =
    getStationSequence(
      route,
      ["GDR"]
    );

  const chennaiSeq =
    getStationSequence(
      route,
      [
        "MAS",
        "MS",
        "MSB"
      ]
    );

  const southernSeq =
    getStationSequence(
      route,
      [
        "TPTY",
        "RU",
        "SBC",
        "SMVB",
        "YPR",
        "KJM",
        "BNC",
        "MYS"
      ]
    );

  if (
    gudurSeq === null
  ) {
    return null;
  }

  // Chennai -> GDR
  if (
    chennaiSeq !== null &&
    chennaiSeq < gudurSeq
  ) {
    return "MAS";
  }

  // Southern/Tirupati -> GDR
  if (
    southernSeq !== null &&
    southernSeq < gudurSeq
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR FROM SOURCE / DESTINATION
// ============================================================
//
// This is the important v2 improvement.
//
// Example:
//
// source = {
//   code: "SMVB",
//   name: "SMVT Bengaluru"
// }
//
// That is southern side.
//
// destination = Howrah
//
// Therefore the train is travelling north from Bengaluru and
// approaches Gudur from the southern side.
//

function determineCorridorFromSourceDestination(
  train,
  item
) {
  const origin =
    getOriginValue(
      train,
      item
    );

  const destination =
    getDestinationValue(
      train,
      item
    );

  const originCode =
    extractStationCode(
      origin
    );

  const destinationCode =
    extractStationCode(
      destination
    );

  const originText =
    getOriginSearchText(
      train,
      item
    );

  const destinationText =
    getDestinationSearchText(
      train,
      item
    );

  // ----------------------------------------------------------
  // Chennai origin
  // ----------------------------------------------------------

  if (
    CHENNAI_SIDE_CODES.has(
      originCode
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      originText,
      [
        "CHENNAI",
        "MGR CHENNAI CENTRAL",
        "CHENNAI CENTRAL",
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
  // Southern origin
  // ----------------------------------------------------------

  if (
    SOUTHERN_SIDE_CODES.has(
      originCode
    )
  ) {
    return "TPTY";
  }

  if (
    containsAny(
      originText,
      [
        "TIRUPATI",
        "RENIGUNTA",
        "SMVT BENGALURU",
        "SMVB",
        "BENGALURU",
        "BANGALORE",
        "MYSURU",
        "MYSORE"
      ]
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Destination can help reject outbound trains.
  // ----------------------------------------------------------

  if (
    destinationCode ===
      "TPTY" ||
    destinationCode ===
      "RU"
  ) {
    return null;
  }

  if (
    containsAny(
      destinationText,
      [
        "TIRUPATI",
        "RENIGUNTA"
      ]
    )
  ) {
    return null;
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// Priority:
//
// 1. Explicit outbound rejection
// 2. Actual route sequence
// 3. Source / destination
// 4. Known TPTY train number
//
// Never guess MAS.
//

function determineCorridor(
  train,
  live,
  stop,
  item,
  route
) {
  const explicitDirection =
    hasInboundDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicitDirection ===
    false
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // Route
  // ----------------------------------------------------------

  const routeCorridor =
    determineCorridorFromRoute(
      train,
      live,
      stop,
      item,
      route
    );

  if (
    routeCorridor
  ) {
    return routeCorridor;
  }

  // ----------------------------------------------------------
  // Source / destination
  // ----------------------------------------------------------

  const sourceCorridor =
    determineCorridorFromSourceDestination(
      train,
      item
    );

  if (
    sourceCorridor
  ) {
    return sourceCorridor;
  }

  // ----------------------------------------------------------
  // Known TPTY train
  // ----------------------------------------------------------

  const trainNo =
    String(
      train?.number ||
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
// UPCOMING STATUS
// ============================================================

function isUpcomingStatus(
  live,
  stop
) {
  const status =
    String(
      live?.type ||
      live?.status ||
      stop?.status ||
      ""
    )
      .trim()
      .toLowerCase();

  return (
    status ===
      "upcoming" ||
    status ===
      "scheduled"
  );
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
    new Date(timeStr);

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
// DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const a =
    Number(lat1);

  const b =
    Number(lon1);

  const c =
    Number(lat2);

  const d =
    Number(lon2);

  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    !Number.isFinite(c) ||
    !Number.isFinite(d)
  ) {
    return null;
  }

  const R =
    6371;

  const dLat =
    (c - a) *
    Math.PI /
    180;

  const dLon =
    (d - b) *
    Math.PI /
    180;

  const x =
    Math.sin(
      dLat / 2
    ) **
      2 +
    Math.cos(
      a *
        Math.PI /
        180
    ) *
      Math.cos(
        c *
          Math.PI /
          180
      ) *
      Math.sin(
        dLon / 2
      ) **
        2;

  const y =
    2 *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(
        1 - x
      )
    );

  return (
    R * y
  );
}

// ============================================================
// LIVE POSITION
// ============================================================

function getLivePosition(
  liveData
) {
  const current =
    liveData?.currentLocation;

  if (!current) {
    return null;
  }

  const lat =
    Number(
      current.lat ??
      current.latitude
    );

  const lng =
    Number(
      current.lng ??
      current.longitude
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  return {
    lat,
    lng,

    stationCode:
      normalizeText(
        current.stationCode ||
        current.code ||
        ""
      ),

    stationName:
      current.stationName ||
      "",

    status:
      current.status ||
      "",

    sequence:
      Number.isFinite(
        Number(
          current.sequence
        )
      )
        ? Number(
            current.sequence
          )
        : null,

    speedKmh:
      Number.isFinite(
        Number(
          current.speedKmh
        )
      )
        ? Number(
            current.speedKmh
          )
        : null,

    isActualPosition:
      current.isActualPosition ===
      true
  };
}

// ============================================================
// CHECK WHETHER TRAIN PASSED GUDUR
// ============================================================

function hasPassedGudurFromLive(
  liveData
) {
  if (!liveData) {
    return false;
  }

  const current =
    liveData.currentLocation ||
    {};

  const stationCode =
    normalizeText(
      current.stationCode ||
      current.code ||
      ""
    );

  const status =
    normalizeText(
      current.status ||
      ""
    );

  // ----------------------------------------------------------
  // At Gudur
  // ----------------------------------------------------------

  if (
    stationCode ===
    "GDR"
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Route sequence
  // ----------------------------------------------------------

  const route =
    Array.isArray(
      liveData.route
    )
      ? liveData.route
      : [];

  const gudurSeq =
    getStationSequence(
      route,
      ["GDR"]
    );

  const currentSeq =
    Number(
      current.sequence
    );

  if (
    gudurSeq !== null &&
    Number.isFinite(
      currentSeq
    ) &&
    currentSeq >
      gudurSeq
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Explicit passed/departed at GDR
  // ----------------------------------------------------------

  if (
    stationCode ===
      "GDR" &&
    (
      status ===
        "DEPARTED" ||
      status ===
        "AT STATION"
    )
  ) {
    return true;
  }

  return false;
}

// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
      trainNo
    )}/live?authoritative=true&includeCoordinates=true`;

  const response =
    await axios.get(
      url,
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

  return (
    response?.data?.data ||
    null
  );
}

// ============================================================
// CHECK LIVE GATE DISTANCE
// ============================================================

function getGateDistance(
  position,
  corridor
) {
  if (!position) {
    return null;
  }

  if (
    corridor ===
    "TPTY"
  ) {
    return distanceKm(
      position.lat,
      position.lng,
      TIRUPATI_GATE_LAT,
      TIRUPATI_GATE_LNG
    );
  }

  if (
    corridor ===
    "MAS"
  ) {
    return distanceKm(
      position.lat,
      position.lng,
      CHENNAI_GATE_LAT,
      CHENNAI_GATE_LNG
    );
  }

  return null;
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  let apiRequests = 0;

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
      `[${now.toLocaleTimeString()}] Stage 1: Reading GDR live board...`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // STAGE 1 — LIVE STATION BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`,
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

    // ========================================================
    // DEFAULT GATE STATUS
    // ========================================================

    let masGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

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
        "CLEAR",

      corridor:
        "TPTY"
    };

    // ========================================================
    // BOARD CANDIDATES
    // ========================================================

    const boardCandidates =
      [];

    // ========================================================
    // PROCESS EACH TRAIN
    // ========================================================

    for (
      const item of
        trainsArray
    ) {
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
        String(
          train?.number ||
          item?.trainNumber ||
          ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train?.name ||
        item?.trainName ||
        `Express ${trainNo}`;

      const origin =
        getOriginDisplay(
          train,
          item
        );

      const destination =
        getDestinationDisplay(
          train,
          item
        );

      const delayMin =
        Number(
          live?.delayMinutes ||
          item?.delayMinutes ||
          0
        );

      const boardStatus =
        String(
          live?.type ||
          live?.status ||
          stop?.status ||
          item?.status ||
          ""
        )
          .trim()
          .toLowerCase();

      // ======================================================
      // REMOVE DEPARTED
      // ======================================================

      if (
        boardStatus ===
          "departed" ||
        boardStatus ===
          "passed"
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - RailRadar status: ${boardStatus}`
        );

        continue;
      }

      // ======================================================
      // ARRIVAL / DEPARTURE
      // ======================================================

      const arrTimeStr =
        stop?.arrival ||
        live?.expectedArrivalTime ||
        item?.expectedArrivalTime ||
        "";

      const depTimeStr =
        stop?.departure ||
        live?.expectedDepartureTime ||
        item?.expectedDepartureTime ||
        arrTimeStr;

      const arrMin =
        parseTimeToMinutes(
          arrTimeStr,
          delayMin
        );

      const depMin =
        parseTimeToMinutes(
          depTimeStr,
          delayMin
        );

      if (
        arrMin === -1
      ) {
        console.log(
          `[NO ETA] ${trainNo} ${trainName}`
        );

        continue;
      }

      const diff =
        calculateTimeDifference(
          arrMin,
          currentMin
        );

      // ======================================================
      // REMOVE OLD TRAIN
      // ======================================================

      if (
        diff < -15
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - ETA passed ${Math.abs(
            diff
          )}m ago`
        );

        continue;
      }

      // ======================================================
      // REMOVE TOO-FAR TRAIN
      // ======================================================

      if (
        diff >
        UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      // ======================================================
      // DETERMINE ROUTE
      // ======================================================

      const boardRoute =
        item?.route ||
        train?.route ||
        stop?.route ||
        live?.route ||
        [];

      // ======================================================
      // DETERMINE CORRIDOR
      // ======================================================

      const corridor =
        determineCorridor(
          train,
          live,
          stop,
          item,
          boardRoute
        );

      if (!corridor) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} | ${origin || "Unknown"} -> ${destination || "Unknown"} | corridor not confirmed`
        );

        continue;
      }

      // ======================================================
      // AT STATION
      // ======================================================

      const isAtStation =
        boardStatus ===
          "at-station" ||
        (
          currentMin >=
            arrMin &&
          currentMin <=
            (
              depMin !== -1
                ? depMin
                : arrMin + 5
            )
        );

      // ======================================================
      // UPCOMING
      // ======================================================

      const upcoming =
        isUpcomingStatus(
          live,
          stop
        );

      // ======================================================
      // STORE VALID CANDIDATE
      // ======================================================

      if (
        upcoming ||
        isAtStation ||
        (
          diff >= 0 &&
          diff <=
            UPCOMING_MAX_ETA_MINUTES
        )
      ) {
        boardCandidates.push({
          trainNo,

          trainName,

          origin:
            origin ||
            "Southern side",

          destination:
            destination ||
            "Gudur",

          etaMinutes:
            Math.max(
              0,
              diff
            ),

          delayMinutes:
            delayMin,

          corridor,

          direction:
            "TOWARD GUDUR",

          platform:
            String(
              live?.platform ||
              stop?.platform ||
              item?.platform ||
              "1"
            ),

          boardStatus,

          isAtStation
        });

        console.log(
          `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${origin || "Unknown"} -> ${destination || "Unknown"} | ETA ${Math.max(
            0,
            diff
          )}m`
        );
      }
    }

    // ========================================================
    // STAGE 2 — LIVE VERIFICATION
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "Stage 2: Actual-position verification"
    );

    console.log(
      "=========================================="
    );

    const liveCandidates =
      boardCandidates
        .filter(
          (train) =>
            train.etaMinutes <=
            LIVE_VERIFY_ETA_MINUTES
        )
        .sort(
          (a, b) =>
            a.etaMinutes -
            b.etaMinutes
        )
        .slice(
          0,
          MAX_LIVE_CALLS
        );

    console.log(
      `Live verification candidates: ${liveCandidates.length}`
    );

    const verifiedTrains =
      [];

    const crossedNumbers =
      new Set();

    // ========================================================
    // LIVE CHECK
    // ========================================================

    for (
      const candidate of
        liveCandidates
    ) {
      try {
        console.log(
          `[LIVE CHECK] ${candidate.trainNo} ${candidate.trainName}`
        );

        const liveData =
          await fetchLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        if (!liveData) {
          console.log(
            `[LIVE SKIP] ${candidate.trainNo} - no live data`
          );

          verifiedTrains.push(
            candidate
          );

          continue;
        }

        // ====================================================
        // CHECK IF CROSSED GUDUR
        // ====================================================

        if (
          hasPassedGudurFromLive(
            liveData
          )
        ) {
          console.log(
            `[CROSSED / REMOVED] ${candidate.trainNo} ${candidate.trainName} - train already passed Gudur`
          );

          crossedNumbers.add(
            candidate.trainNo
          );

          continue;
        }

        // ====================================================
        // GET LIVE ROUTE
        // ====================================================

        const liveRoute =
          Array.isArray(
            liveData.route
          )
            ? liveData.route
            : [];

        // ====================================================
        // RE-CHECK CORRIDOR USING LIVE ROUTE
        // ====================================================

        const liveCorridor =
          determineCorridor(
            candidate,
            liveData,
            {},
            {
              train:
                candidate,
              live:
                liveData
            },
            liveRoute
          ) ||
          candidate.corridor;

        // ====================================================
        // LIVE POSITION
        // ====================================================

        const position =
          getLivePosition(
            liveData
          );

        if (
          position
        ) {
          const gateDistance =
            getGateDistance(
              position,
              liveCorridor
            );

          candidate.liveDistanceKm =
            gateDistance;

          candidate.liveSpeedKmh =
            position.speedKmh;

          candidate.actualPosition =
            position.isActualPosition;

          console.log(
            `[LIVE POSITION] ${candidate.trainNo} | ${liveCorridor} | ${gateDistance !== null ? gateDistance.toFixed(
              3
            ) : "?"} km from gate | ${
              position.speedKmh ??
              "?"
            } km/h | station ${
              position.stationCode ||
              "GPS"
            }`
          );

          // ==================================================
          // GATE CLOSURE
          // ==================================================

          if (
            gateDistance !==
              null &&
            gateDistance <=
              GATE_TRIGGER_DISTANCE_KM
          ) {
            const waitTime =
              Math.max(
                1,
                candidate.etaMinutes +
                  2
              );

            const payload =
              {
                status:
                  "CLOSED",

                waitMinutes:
                  waitTime,

                activeTrain:
                  `${candidate.trainNo} ${candidate.trainName}`,

                direction:
                  "TOWARD GUDUR",

                corridor:
                  liveCorridor
              };

            if (
              liveCorridor ===
              "TPTY"
            ) {
              tptyGate =
                payload;
            }

            if (
              liveCorridor ===
              "MAS"
            ) {
              masGate =
                payload;
            }

            console.log(
              `[GATE CLOSED] ${liveCorridor} | ${candidate.trainNo} ${candidate.trainName} | ${gateDistance.toFixed(
                3
              )} km`
            );
          }
        }

        // ====================================================
        // KEEP VERIFIED TRAIN
        // ====================================================

        verifiedTrains.push(
          {
            ...candidate,
            corridor:
              liveCorridor
          }
        );

      } catch (error) {
        console.error(
          `[LIVE ERROR] ${candidate.trainNo}: ${error.message}`
        );

        // If live API fails, don't delete the train.
        // Keep the station-board information.
        verifiedTrains.push(
          candidate
        );
      }
    }

    // ========================================================
    // REMOVE CROSSED TRAINS FROM UPCOMING LIST
    // ========================================================

    const finalUpcoming =
      boardCandidates.filter(
        (train) =>
          !crossedNumbers.has(
            train.trainNo
          )
      );

    // ========================================================
    // SORT
    // ========================================================

    finalUpcoming.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ========================================================
    // MAXIMUM 5
    // ========================================================

    const topUpcoming =
      finalUpcoming
        .slice(
          0,
          5
        )
        .map(
          (train) => ({
            trainNo:
              train.trainNo,

            name:
              train.trainName,

            origin:
              train.origin,

            destination:
              train.destination,

            etaMinutes:
              train.etaMinutes,

            delayMinutes:
              train.delayMinutes,

            corridor:
              train.corridor,

            direction:
              "TOWARD GUDUR",

            platform:
              train.platform
          })
        );

    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      monitorMode:
        "TWO-STAGE-V2",

      liveVerified:
        verifiedTrains.length,

      apiRequests:
        apiRequests
    });

    // ========================================================
    // SUCCESS LOG
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      `Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );

    console.log(
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live verified: ${verifiedTrains.length}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    // ========================================================
    // UPCOMING LIST
    // ========================================================

    if (
      topUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (
          train,
          index
        ) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    // ========================================================
    // CROSSED TRAINS
    // ========================================================

    if (
      crossedNumbers.size >
      0
    ) {
      console.log(
        "\n[CROSSED / REMOVED TRAINS]"
      );

      for (
        const trainNo of
          crossedNumbers
      ) {
        console.log(
          `   ${trainNo}`
        );
      }
    }

    console.log(
      "==========================================\n"
    );

  } catch (err) {
    console.error(
      "\n[MONITOR ERROR]"
    );

    if (
      err.response
    ) {
      console.error(
        `HTTP ${err.response.status}`
      );

      console.error(
        JSON.stringify(
          err.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        err.message
      );
    }

    console.error(
      "=========================================="
    );
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
  `RailRadar API Key: ${
    RAILRADAR_API_KEY
      ? "Configured"
      : "MISSING"
  }`
);

console.log(
  "MODE: TWO-STAGE-V2"
);

console.log(
  "Stage 1: Strong source + destination + route detection"
);

console.log(
  "Stage 2: Actual position → gate closure"
);

console.log(
  `Upcoming max ETA: ${UPCOMING_MAX_ETA_MINUTES} minutes`
);

console.log(
  `Live verification window: ${LIVE_VERIFY_ETA_MINUTES} minutes`
);

console.log(
  `Gate trigger distance: ${GATE_TRIGGER_DISTANCE_KM} km`
);

console.log(
  `Maximum live calls: ${MAX_LIVE_CALLS}`
);

console.log(
  "Crossed trains: AUTOMATICALLY REMOVED"
);

console.log(
  "Unknown direction: IGNORED"
);

console.log(
  "GitHub Actions: RUN ONCE"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem();
