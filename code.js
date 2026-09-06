const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT || ""
  );
} catch (error) {
  console.error(
    "❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing or invalid."
  );
  console.error(
    "GitHub Actions must provide FIREBASE_SERVICE_ACCOUNT as a JSON secret."
  );
  process.exit(1);
}

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

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
// SYSTEM SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;
const UPCOMING_MAX_ETA_MINUTES = 360;

// Train must be this close to the actual crossing
// before the corresponding gate is CLOSED.
const GATE_TRIGGER_DISTANCE_KM = 0.60;

// Live verification starts when board ETA is <= 60 minutes.
const LIVE_VERIFY_ETA_MINUTES = 60;

// Free API quota protection.
// Do not live-check every train.
const MAX_LIVE_CALLS = 2;

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
// VALUE TO STRING
// ============================================================
//
// RailRadar may return a station as:
// "MAS"
//
// or:
//
// { code: "MAS", name: "MGR Chennai Central", ... }
//
// This helper handles both.
// ============================================================

function stationToText(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    return [
      value.code,
      value.name,
      value.stationCode,
      value.stationName
    ]
      .filter(Boolean)
      .join(" ");
  }

  return String(value);
}

// ============================================================
// STATION CODE EXTRACTION
// ============================================================

function getStationCode(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    const text = value.trim().toUpperCase();

    // If it looks like a station code, return it.
    if (/^[A-Z0-9]{2,6}$/.test(text)) {
      return text;
    }

    // Try to find a code inside text.
    const match = text.match(/\b[A-Z]{2,5}\b/);

    return match ? match[0] : "";
  }

  if (typeof value === "object") {
    return String(
      value.code ||
      value.stationCode ||
      ""
    )
      .trim()
      .toUpperCase();
  }

  return "";
}

// ============================================================
// CONTAINS ANY
// ============================================================

function containsAny(text, values) {
  const normalized = normalizeText(text);

  return values.some((value) => {
    const target = normalizeText(value);

    return (
      target &&
      normalized.includes(target)
    );
  });
}

// ============================================================
// GET RAILRADAR SOURCE
// ============================================================
//
// IMPORTANT:
//
// We intentionally prioritize:
//
// train.source
//
// before generic fields such as:
//
// train.origin
// train.from
//
// because the previous version was reading misleading fields.
// ============================================================

function getRailRadarSource(train, item) {
  const sourceCandidates = [
    train?.source,
    item?.train?.source,

    // Only use these as secondary fallbacks.
    item?.source
  ];

  for (const candidate of sourceCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

// ============================================================
// GET RAILRADAR DESTINATION
// ============================================================
//
// IMPORTANT:
//
// We intentionally prioritize:
//
// train.destination
//
// and do NOT put train.origin/train.destination-style
// ambiguous fields ahead of the documented source/destination.
// ============================================================

function getRailRadarDestination(train, item) {
  const destinationCandidates = [
    train?.destination,
    item?.train?.destination,

    // Secondary fallback.
    item?.destination
  ];

  for (const candidate of destinationCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

// ============================================================
// GET SOURCE TEXT
// ============================================================

function getSourceText(train, item) {
  return stationToText(
    getRailRadarSource(train, item)
  );
}

// ============================================================
// GET DESTINATION TEXT
// ============================================================

function getDestinationText(train, item) {
  return stationToText(
    getRailRadarDestination(train, item)
  );
}

// ============================================================
// CHENNAI-SIDE STATIONS
// ============================================================
//
// These are stations/origins that indicate a train is coming
// toward Gudur from the Chennai/north side.
//
// MAS = MGR Chennai Central
// MS  = Chennai Egmore
// AVD = Avadi
// PER = Perambur
// SPE = Sullurupeta
// NYP = Nayudupeta
// GPD = Gudur-side northern approach
//
// NOTE:
// We do NOT use destination to classify a train as MAS.
// Source is what matters for direction.
// ============================================================

const CHENNAI_SIDE_CODES = new Set([
  "MAS",
  "MS",
  "MSB",
  "AVD",
  "PER",
  "SPE",
  "NYP"
]);

const CHENNAI_SIDE_NAMES = [
  "CHENNAI",
  "MGR CHENNAI CENTRAL",
  "CHENNAI CENTRAL",
  "MGR CHENNAI",
  "DR MGR CHENNAI CENTRAL",
  "CHENNAI EGMORE",
  "AVADI",
  "PERAMBUR",
  "SULLURUPETA",
  "NAYUDUPETA"
];

// ============================================================
// SOUTHERN / TIRUPATI-SIDE STATIONS
// ============================================================
//
// These stations indicate that the train is approaching Gudur
// from the southern/western side of the Gudur junction.
//
// TPTY = Tirupati
// RU   = Renigunta
// SMVB = Sir M Visvesvaraya Terminal Bengaluru
// SBC  = KSR Bengaluru
// BNC  = Bengaluru Cantt
//
// Additional major southern-side origins are included only
// where they are useful for route direction classification.
// ============================================================

const SOUTHERN_SIDE_CODES = new Set([
  "TPTY",
  "RU",
  "SMVB",
  "SBC",
  "BNC",
  "YPR",
  "KJM",
  "BWT",
  "KPD"
]);

const SOUTHERN_SIDE_NAMES = [
  "TIRUPATI",
  "TIRUPATI MAIN",
  "RENIGUNTA",
  "SIR M VISVESVARAYA TERMINAL",
  "SMVT BENGALURU",
  "SMVB",
  "KSR BENGALURU",
  "KSR BENGALURU CITY",
  "BENGALURU CANTT",
  "BANGALORE",
  "BENGALURU"
];

// ============================================================
// DETECT CHENNAI-SIDE SOURCE
// ============================================================

function isChennaiSideSource(source) {
  const text = normalizeText(source);
  const code = getStationCode(source);

  if (
    code &&
    CHENNAI_SIDE_CODES.has(code)
  ) {
    return true;
  }

  return containsAny(
    text,
    CHENNAI_SIDE_NAMES
  );
}

// ============================================================
// DETECT SOUTHERN-SIDE SOURCE
// ============================================================

function isSouthernSideSource(source) {
  const text = normalizeText(source);
  const code = getStationCode(source);

  if (
    code &&
    SOUTHERN_SIDE_CODES.has(code)
  ) {
    return true;
  }

  return containsAny(
    text,
    SOUTHERN_SIDE_NAMES
  );
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
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION DETECTION
// ============================================================

function hasExplicitInboundDirection(
  train,
  live,
  stop,
  item
) {
  const direction = getDirectionText(
    train,
    live,
    stop,
    item
  );

  if (!direction) {
    return null;
  }

  // ----------------------------------------------------------
  // EXPLICITLY TOWARD GUDUR
  // ----------------------------------------------------------

  if (
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("APPROACHING GUDUR")
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // EXPLICITLY AWAY FROM GUDUR
  // ----------------------------------------------------------

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
    return false;
  }

  // Generic inbound/outbound should NOT be trusted by itself
  // because inbound may mean something other than Gudur.
  if (direction.includes("OUTBOUND")) {
    return false;
  }

  return null;
}

// ============================================================
// DETERMINE INBOUND CORRIDOR
// ============================================================
//
// Returns:
//
// MAS
// TPTY
// null
//
// VERY IMPORTANT:
//
// We do not use a hard-coded train-number list here.
//
// The gate decision is based on actual source/direction data.
// ============================================================

function determineInboundCorridor(
  train,
  live,
  stop,
  item
) {
  const source =
    getRailRadarSource(
      train,
      item
    );

  const destination =
    getRailRadarDestination(
      train,
      item
    );

  const sourceText =
    stationToText(source);

  const destinationText =
    stationToText(destination);

  const explicitDirection =
    hasExplicitInboundDirection(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // If RailRadar explicitly says the train is moving away,
  // NEVER close a gate.
  // ----------------------------------------------------------

  if (explicitDirection === false) {
    return null;
  }

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  if (
    isChennaiSideSource(source)
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // SOUTHERN / TIRUPATI SIDE
  // ----------------------------------------------------------

  if (
    isSouthernSideSource(source)
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // EXPLICIT "TOWARD GUDUR"
  //
  // If RailRadar explicitly confirms the train is approaching
  // Gudur but source isn't one of our known stations, do NOT
  // guess the gate.
  //
  // This is intentional for safety.
  // ----------------------------------------------------------

  if (
    explicitDirection === true
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // UNKNOWN
  // ----------------------------------------------------------

  console.log(
    `[DIRECTION UNKNOWN] ${train?.number || "?"} | ${sourceText || "NO SOURCE"} -> ${destinationText || "NO DESTINATION"}`
  );

  return null;
}

// ============================================================
// TIME PARSER
// ============================================================
//
// Important correction:
//
// GitHub Actions runs in UTC.
//
// We must NOT use:
//
// new Date(time).getHours()
//
// for RailRadar's +05:30 timestamps because that converts
// the time to the runner's timezone.
//
// This parser preserves the clock time represented by RailRadar.
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

  // ----------------------------------------------------------
  // ISO / DATETIME WITH TIME
  // ----------------------------------------------------------

  const isoMatch =
    text.match(
      /T(\d{1,2}):(\d{2})(?::(\d{2}))?/
    );

  if (isoMatch) {
    const hours =
      parseInt(
        isoMatch[1],
        10
      );

    const minutes =
      parseInt(
        isoMatch[2],
        10
      );

    return (
      hours * 60 +
      minutes +
      Number(delayMinutes || 0)
    );
  }

  // ----------------------------------------------------------
  // HH:MM
  // ----------------------------------------------------------

  const timeMatch =
    text.match(
      /(\d{1,2}):(\d{2})/
    );

  if (timeMatch) {
    const hours =
      parseInt(
        timeMatch[1],
        10
      );

    const minutes =
      parseInt(
        timeMatch[2],
        10
      );

    return (
      hours * 60 +
      minutes +
      Number(delayMinutes || 0)
    );
  }

  return -1;
}

// ============================================================
// CURRENT TIME
// ============================================================
//
// RailRadar operates in India time.
//
// GitHub Actions runner is normally UTC.
//
// Use Intl to get current India time.
// ============================================================

function getIndiaCurrentMinutes() {
  const now = new Date();

  const parts =
    new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone:
          "Asia/Kolkata",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      }
    )
      .formatToParts(now);

  const hour =
    parseInt(
      parts.find(
        (p) =>
          p.type === "hour"
      )?.value || "0",
      10
    );

  const minute =
    parseInt(
      parts.find(
        (p) =>
          p.type === "minute"
      )?.value || "0",
      10
    );

  return (
    hour * 60 +
    minute
  );
}

// ============================================================
// INDIA TIME DISPLAY
// ============================================================

function getIndiaTimeString() {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone:
        "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }
  ).format(
    new Date()
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

  // Midnight crossing.
  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// NUMBER PARSER
// ============================================================

function toNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// ============================================================
// DISTANCE BETWEEN COORDINATES
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

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
    Math.sin(dLat / 2) ** 2 +
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
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(a)
    )
  );
}

// ============================================================
// EXTRACT LIVE COORDINATES
// ============================================================

function getLiveCoordinates(
  live
) {
  const latCandidates = [
    live?.latitude,
    live?.lat,
    live?.currentLatitude,
    live?.currentLocation?.latitude,
    live?.currentLocation?.lat,
    live?.currentLocation?.coordinates?.lat
  ];

  const lngCandidates = [
    live?.longitude,
    live?.lng,
    live?.lon,
    live?.currentLongitude,
    live?.currentLocation?.longitude,
    live?.currentLocation?.lng,
    live?.currentLocation?.lon,
    live?.currentLocation?.coordinates?.lng
  ];

  let lat = null;
  let lng = null;

  for (const value of latCandidates) {
    const number =
      toNumber(value);

    if (
      number !== null &&
      Math.abs(number) <= 90
    ) {
      lat = number;
      break;
    }
  }

  for (const value of lngCandidates) {
    const number =
      toNumber(value);

    if (
      number !== null &&
      Math.abs(number) <= 180
    ) {
      lng = number;
      break;
    }
  }

  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  return {
    lat,
    lng
  };
}

// ============================================================
// EXTRACT LIVE DISTANCE FROM GUDUR
// ============================================================

function getDistanceFromGudur(
  live
) {
  const coordinate =
    getLiveCoordinates(
      live
    );

  if (coordinate) {
    return distanceKm(
      coordinate.lat,
      coordinate.lng,
      GDR_LAT,
      GDR_LNG
    );
  }

  // Some RailRadar responses may provide distance directly.
  const candidates = [
    live?.distanceFromGudurKm,
    live?.currentLocation?.distanceFromGudurKm
  ];

  for (const value of candidates) {
    const number =
      toNumber(value);

    if (
      number !== null &&
      number >= 0
    ) {
      return number;
    }
  }

  return null;
}

// ============================================================
// DETERMINE IF TRAIN HAS DEPARTED / PASSED
// ============================================================

function isDepartedStatus(
  live
) {
  const status =
    normalizeText(
      live?.status ||
      live?.currentLocation?.status ||
      ""
    );

  return (
    status.includes("DEPARTED") ||
    status.includes("PASSED") ||
    status.includes("COMPLETED") ||
    status.includes("TERMINATED") ||
    status.includes("CANCELLED")
  );
}

// ============================================================
// UPCOMING STATUS CHECK
// ============================================================

function isUpcomingStatus(
  live
) {
  const status =
    normalizeText(
      live?.status ||
      live?.currentLocation?.status ||
      ""
    );

  if (!status) {
    return true;
  }

  if (
    status.includes("DEPARTED") ||
    status.includes("PASSED") ||
    status.includes("COMPLETED") ||
    status.includes("CANCELLED") ||
    status.includes("TERMINATED")
  ) {
    return false;
  }

  return true;
}

// ============================================================
// GET TRAIN DELAY
// ============================================================

function getDelayMinutes(
  live,
  item
) {
  const candidates = [
    live?.delayMinutes,
    live?.delay,
    live?.currentLocation?.delayMinutes,
    item?.live?.delayMinutes
  ];

  for (const value of candidates) {
    const number =
      toNumber(value);

    if (number !== null) {
      return number;
    }
  }

  return 0;
}

// ============================================================
// GET ARRIVAL TIME
// ============================================================

function getArrivalTime(
  train,
  live,
  stop,
  item
) {
  return (
    stop?.arrival ||
    stop?.scheduledArrival ||
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
    item?.arrival ||
    item?.arrivalTime ||
    ""
  );
}

// ============================================================
// GET DEPARTURE TIME
// ============================================================

function getDepartureTime(
  train,
  live,
  stop,
  item
) {
  return (
    stop?.departure ||
    stop?.scheduledDeparture ||
    live?.expectedDepartureTime ||
    live?.departureTime ||
    item?.departure ||
    item?.departureTime ||
    ""
  );
}

// ============================================================
// GET PLATFORM
// ============================================================

function getPlatform(
  train,
  live,
  stop,
  item
) {
  return String(
    live?.platform ||
    stop?.platform ||
    item?.platform ||
    "1"
  );
}

// ============================================================
// LIVE TRAIN VERIFICATION
// ============================================================

async function getLiveTrainData(
  trainNo
) {
  try {
    const url =
      `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
        trainNo
      )}/live?authoritative=true&includeCoordinates=true`;

    console.log(
      `[LIVE] Checking train ${trainNo}...`
    );

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

    if (
      !response.data?.success
    ) {
      console.log(
        `[LIVE] ${trainNo} returned unsuccessful response.`
      );

      return null;
    }

    return (
      response.data?.data ||
      null
    );
  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// APPLY LIVE TRAIN INFORMATION
// ============================================================

function applyLiveInformation(
  candidate,
  liveData
) {
  if (!liveData) {
    return candidate;
  }

  const currentLocation =
    liveData.currentLocation ||
    {};

  const liveCoordinates =
    getLiveCoordinates(
      liveData
    );

  const distance =
    getDistanceFromGudur(
      liveData
    );

  const status =
    normalizeText(
      liveData.status ||
      currentLocation.status ||
      ""
    );

  const delay =
    toNumber(
      liveData.delayMinutes
    );

  if (
    delay !== null
  ) {
    candidate.delayMinutes =
      delay;
  }

  candidate.liveStatus =
    status ||
    candidate.liveStatus ||
    "";

  candidate.liveVerified =
    true;

  if (
    liveCoordinates
  ) {
    candidate.liveLatitude =
      liveCoordinates.lat;

    candidate.liveLongitude =
      liveCoordinates.lng;
  }

  if (
    distance !== null
  ) {
    candidate.distanceFromGudurKm =
      distance;
  }

  // Actual position is important for gate closure.
  candidate.isActualPosition =
    Boolean(
      currentLocation.isActualPosition
    );

  candidate.positionSource =
    currentLocation.positionSource ||
    "";

  candidate.segmentProgress =
    currentLocation.segmentProgress ??
    null;

  candidate.speedKmh =
    currentLocation.speedKmh ??
    null;

  candidate.bearingDegrees =
    currentLocation.bearingDegrees ??
    null;

  return candidate;
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  let apiRequests = 0;
  let liveVerifiedCount = 0;

  try {
    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY environment variable is missing."
      );
    }

    const indiaTime =
      getIndiaTimeString();

    const currentMin =
      getIndiaCurrentMinutes();

    console.log(
      `\n[${indiaTime}] Querying RailRadar Live Station Board for GDR...`
    );

    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardUrl =
      `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`;

    const boardRes =
      await axios.get(
        boardUrl,
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
      console.error(
        "❌ RailRadar returned invalid train data."
      );

      console.error(
        JSON.stringify(
          responseBody,
          null,
          2
        )
      );

      return;
    }

    console.log(
      `✅ RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // INITIAL GATE STATE
    // ========================================================

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear",
      direction:
        "NO INBOUND TRAIN",
      corridor:
        "MAS"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear",
      direction:
        "NO INBOUND TRAIN",
      corridor:
        "TPTY"
    };

    const upcomingList = [];

    const liveCandidates = [];

    // ========================================================
    // PROCESS BOARD
    // ========================================================

    for (
      const item of trainsArray
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

      const source =
        getRailRadarSource(
          train,
          item
        );

      const destination =
        getRailRadarDestination(
          train,
          item
        );

      const sourceText =
        stationToText(
          source
        );

      const destinationText =
        stationToText(
          destination
        );

      const delayMinutes =
        getDelayMinutes(
          live,
          item
        );

      const arrivalTime =
        getArrivalTime(
          train,
          live,
          stop,
          item
        );

      const departureTime =
        getDepartureTime(
          train,
          live,
          stop,
          item
        );

      const arrivalMin =
        parseTimeToMinutes(
          arrivalTime,
          delayMinutes
        );

      const departureMin =
        parseTimeToMinutes(
          departureTime,
          delayMinutes
        );

      if (
        arrivalMin === -1
      ) {
        continue;
      }

      const diff =
        calculateTimeDifference(
          arrivalMin,
          currentMin
        );

      // ------------------------------------------------------
      // REMOVE TRAINS THAT ARE TOO FAR IN TIME
      // ------------------------------------------------------

      if (
        diff < -15 ||
        diff > UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      // ------------------------------------------------------
      // REMOVE TRAINS RAILRADAR ALREADY SAYS DEPARTED
      // ------------------------------------------------------

      if (
        isDepartedStatus(
          live
        )
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - RailRadar status: ${live.status || live.currentLocation?.status}`
        );

        continue;
      }

      // ------------------------------------------------------
      // DIRECTION / CORRIDOR
      // ------------------------------------------------------

      const corridor =
        determineInboundCorridor(
          train,
          live,
          stop,
          item
        );

      if (!corridor) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} | ${sourceText || "UNKNOWN"} -> ${destinationText || "UNKNOWN"} | corridor not confirmed`
        );

        continue;
      }

      console.log(
        `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${sourceText || "UNKNOWN"} -> ${destinationText || "UNKNOWN"} | ETA ${Math.max(0, diff)}m`
      );

      // ------------------------------------------------------
      // CREATE UPCOMING ENTRY
      // ------------------------------------------------------

      const candidate = {
        trainNo,
        name: trainName,

        origin:
          sourceText ||
          "Southern side",

        destination:
          destinationText ||
          "Gudur",

        etaMinutes:
          Math.max(
            0,
            diff
          ),

        delayMinutes,

        corridor,

        direction:
          "TOWARD GUDUR",

        platform:
          getPlatform(
            train,
            live,
            stop,
            item
          ),

        liveVerified:
          false,

        distanceFromGudurKm:
          null,

        isActualPosition:
          false
      };

      // ------------------------------------------------------
      // LIVE VERIFICATION CANDIDATE
      // ------------------------------------------------------

      if (
        diff >= 0 &&
        diff <= LIVE_VERIFY_ETA_MINUTES
      ) {
        liveCandidates.push({
          trainNo,
          corridor,
          candidate
        });
      }

      upcomingList.push(
        candidate
      );
    }

    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    // Closest first.
    liveCandidates.sort(
      (a, b) =>
        a.candidate.etaMinutes -
        b.candidate.etaMinutes
    );

    const selectedLiveCandidates =
      liveCandidates.slice(
        0,
        MAX_LIVE_CALLS
      );

    for (
      const selected of selectedLiveCandidates
    ) {
      const liveData =
        await getLiveTrainData(
          selected.trainNo
        );

      apiRequests++;

      if (!liveData) {
        continue;
      }

      liveVerifiedCount++;

      applyLiveInformation(
        selected.candidate,
        liveData
      );

      console.log(
        `[LIVE VERIFIED] ${selected.trainNo} | ${selected.corridor} | status=${selected.candidate.liveStatus || "unknown"} | distance=${selected.candidate.distanceFromGudurKm !== null ? selected.candidate.distanceFromGudurKm.toFixed(3) + " km" : "unknown"} | actual=${selected.candidate.isActualPosition}`
      );
    }

    // ========================================================
    // GATE DECISION
    // ========================================================
    //
    // IMPORTANT:
    //
    // Gate closes only when:
    //
    // 1. Train is confirmed inbound.
    // 2. Train is within 0.60 km of the actual gate.
    // 3. If live position is available, it must be an actual
    //    position.
    //
    // This prevents an incorrect board ETA from immediately
    // closing the gate when the train is still far away.
    // ========================================================

    for (
      const entry of upcomingList
    ) {
      let shouldClose =
        false;

      let distanceToGate =
        null;

      // ------------------------------------------------------
      // LIVE GPS POSITION
      // ------------------------------------------------------

      if (
        entry.liveVerified
      ) {
        const lat =
          toNumber(
            entry.liveLatitude
          );

        const lng =
          toNumber(
            entry.liveLongitude
          );

        if (
          lat !== null &&
          lng !== null &&
          entry.isActualPosition
        ) {
          if (
            entry.corridor === "MAS"
          ) {
            distanceToGate =
              distanceKm(
                lat,
                lng,
                CHENNAI_GATE_LAT,
                CHENNAI_GATE_LNG
              );
          }

          if (
            entry.corridor === "TPTY"
          ) {
            distanceToGate =
              distanceKm(
                lat,
                lng,
                TIRUPATI_GATE_LAT,
                TIRUPATI_GATE_LNG
              );
          }

          if (
            distanceToGate !== null &&
            distanceToGate <=
              GATE_TRIGGER_DISTANCE_KM
          ) {
            shouldClose =
              true;
          }
        }
      }

      // ------------------------------------------------------
      // FALLBACK:
      //
      // If RailRadar confirms the train is at Gudur / very
      // close to Gudur but coordinates aren't available,
      // use the board arrival/departure timing.
      //
      // We keep this conservative.
      // ------------------------------------------------------

      if (
        !shouldClose &&
        entry.liveVerified &&
        entry.liveStatus
      ) {
        const status =
          normalizeText(
            entry.liveStatus
          );

        if (
          status.includes(
            "AT STATION"
          ) ||
          status.includes(
            "AT STATION"
          )
        ) {
          shouldClose =
            true;
        }
      }

      // ------------------------------------------------------
      // DO NOT CLOSE BASED ONLY ON "ETA <= 4 MINUTES".
      //
      // This was intentionally removed.
      //
      // A train can have a bad ETA while still being several
      // kilometres away.
      // ------------------------------------------------------

      if (
        shouldClose
      ) {
        let waitTime =
          Math.max(
            1,
            Math.ceil(
              entry.etaMinutes
            ) + 2
          );

        if (
          entry.liveStatus
            ?.toUpperCase()
            .includes(
              "AT STATION"
            )
        ) {
          waitTime = 5;
        }

        const trainStatus =
          entry.delayMinutes > 0
            ? `${entry.delayMinutes}m late`
            : "On Time";

        const label =
          `${entry.trainNo} ${entry.name} (${trainStatus})`;

        const payload = {
          status:
            "CLOSED",

          waitMinutes:
            waitTime,

          activeTrain:
            label,

          direction:
            "TOWARD GUDUR",

          corridor:
            entry.corridor,

          distanceFromGudurKm:
            distanceToGate !== null
              ? Number(
                  distanceToGate.toFixed(
                    3
                  )
                )
              : null,

          liveVerified:
            Boolean(
              entry.liveVerified
            ),

          isActualPosition:
            Boolean(
              entry.isActualPosition
            )
        };

        if (
          entry.corridor === "MAS"
        ) {
          // Keep the closest / strongest
          // MAS train.
          if (
            masGate.status ===
              "OPEN" ||
            entry.etaMinutes <
              (
                masGate.etaMinutes ??
                Infinity
              )
          ) {
            masGate = {
              ...payload,
              etaMinutes:
                entry.etaMinutes
            };
          }
        }

        if (
          entry.corridor === "TPTY"
        ) {
          if (
            tptyGate.status ===
              "OPEN" ||
            entry.etaMinutes <
              (
                tptyGate.etaMinutes ??
                Infinity
              )
          ) {
            tptyGate = {
              ...payload,
              etaMinutes:
                entry.etaMinutes
            };
          }
        }

        console.log(
          `[GATE CLOSE] ${entry.corridor} | ${entry.trainNo} ${entry.name} | distance=${distanceToGate !== null ? distanceToGate.toFixed(3) + " km" : "station"}`
        );
      }
    }

    // ========================================================
    // SORT UPCOMING
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ========================================================
    // MAXIMUM 5 TRAINS
    // ========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
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
        getIndiaTimeString(),

      apiRequests,

      liveVerified:
        liveVerifiedCount
    });

    // ========================================================
    // LOG RESULTS
    // ========================================================

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
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
      `Live verified: ${liveVerifiedCount}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    // ========================================================
    // UPCOMING TRAIN LIST
    // ========================================================

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform} | ${train.origin} -> ${train.destination}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

  } catch (error) {
    console.error(
      "\n[MONITOR ERROR]"
    );

    if (
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );

      console.error(
        "RailRadar response:",
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        error.message
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
  " RailRadar Real-time Gate Monitor Active "
);

console.log(
  " Chennai Gate:  14.1396639 N, 79.8441306 E"
);

console.log(
  " Tirupati Gate: 14.1402056 N, 79.8436000 E"
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
  "Direction: Chennai/Tirupati-side -> Gudur only"
);

console.log(
  "Live verification window: 60 minutes"
);

console.log(
  "Maximum live calls per run: 2"
);

console.log(
  "Gate trigger distance: 0.60 km"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();

// ============================================================
// RUN EVERY 3 MINUTES
// ============================================================
//
// GitHub Actions itself runs every 5 minutes.
// This interval is useful when running the script manually
// on a server/local machine.
// ============================================================

setInterval(
  updateGateSystem,
  180000
);
