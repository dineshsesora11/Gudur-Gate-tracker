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
  // Preferred: GitHub Actions secret
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else if (fs.existsSync("./serviceAccountKey.json")) {
    // Optional local development
    serviceAccount = require("./serviceAccountKey.json");
  } else {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
    );
  }
} catch (error) {
  console.error("❌ Firebase service account could not be loaded.");
  console.error(error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );
  process.exit(1);
}

// ============================================================
// GUDUR GEOMETRY
// ============================================================

// Gudur Junction
const GUDUR_LAT = 14.1451694;
const GUDUR_LNG = 79.8443472;

// Physical railway crossing gates
const TIRUPATI_GATE = {
  lat: 14.1402028,
  lng: 79.8435972
};

const CHENNAI_GATE = {
  lat: 14.1396667,
  lng: 79.8441278
};

// ============================================================
// DISTANCE SETTINGS
// ============================================================

// Train must be within this distance from Gudur before
// we allow a numeric ETA to appear.
//
// IMPORTANT:
//
// 1 km is NOT the gate-closing distance.
//
// It is the "verified approaching Gudur" radius.
const APPROACHING_GUDUR_DISTANCE_KM = 1.0;

// Physical distance from Gudur Junction to gates
const GATE_DISTANCE_KM = 0.52;

// Gate closes when a departed train reaches this radius
// around the appropriate crossing.
const GATE_CLOSE_DISTANCE_KM = 0.60;

// Gate is considered safely passed after this distance.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Maximum upcoming trains displayed
const UPCOMING_LIMIT = 10;

// Maximum future ETA that can be shown
const MAX_DISPLAY_ETA_MINUTES = 60;

// Live API refresh interval.
//
// GitHub Actions runs every 5 minutes, but we persist this
// timestamp in Firebase so live calls are NOT repeated every
// GitHub run.
const LIVE_REFRESH_MINUTES = 20;

// ============================================================
// CORRIDOR TRAIN KNOWLEDGE
// ============================================================
//
// These are used ONLY to identify the railway branch.
//
// They are NOT used to manufacture an ETA.
//
// ETA ALWAYS requires current verified position.
//

const TPTY_TRAIN_NUMBERS = new Set([
  "03251",
  "05074",
  "04717",
  "12296",
  "12762",
  "12764"
]);

const MAS_TRAIN_NUMBERS = new Set([
  "12622",
  "12625",
  "12760",
  "16032"
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
  const normalized = normalizeText(text);

  return values.some((value) =>
    normalized.includes(normalizeText(value))
  );
}

// ============================================================
// NUMBER HELPERS
// ============================================================

function finiteNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const aLat = finiteNumber(lat1);
  const aLon = finiteNumber(lon1);
  const bLat = finiteNumber(lat2);
  const bLon = finiteNumber(lon2);

  if (
    aLat === null ||
    aLon === null ||
    bLat === null ||
    bLon === null
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    (bLat - aLat) *
    Math.PI /
    180;

  const dLon =
    (bLon - aLon) *
    Math.PI /
    180;

  const lat1Rad =
    aLat *
    Math.PI /
    180;

  const lat2Rad =
    bLat *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(dLon / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// EXTRACT COORDINATES
// ============================================================

function getCoordinates(data) {
  const possibleLocations = [
    data?.currentLocation?.coordinates,
    data?.live?.currentLocation?.coordinates,
    data?.currentLocation,
    data?.live?.currentLocation,
    data?.coordinates
  ];

  for (const location of possibleLocations) {
    if (!location) {
      continue;
    }

    const lat = finiteNumber(
      location.lat ??
      location.latitude
    );

    const lng = finiteNumber(
      location.lng ??
      location.lon ??
      location.longitude
    );

    if (
      lat !== null &&
      lng !== null
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
// GET STATION CODE
// ============================================================

function getCurrentStationCode(data) {
  return String(
    data?.currentLocation?.stationCode ||
    data?.live?.currentLocation?.stationCode ||
    ""
  )
    .trim()
    .toUpperCase();
}

// ============================================================
// GET CURRENT LOCATION STATUS
// ============================================================

function getCurrentLocationStatus(data) {
  return normalizeText(
    data?.currentLocation?.status ||
    data?.live?.currentLocation?.status ||
    ""
  );
}

// ============================================================
// GET CURRENT SEQUENCE
// ============================================================

function getCurrentSequence(data) {
  return finiteNumber(
    data?.currentLocation?.sequence ??
    data?.live?.currentLocation?.sequence
  );
}

// ============================================================
// GET GUDUR SEQUENCE
// ============================================================

function getGudurSequence(data) {
  return finiteNumber(
    data?.nextHalt?.stationCode === "GDR"
      ? data?.nextHalt?.sequence
      : null
  );
}

// ============================================================
// TRAIN ORIGIN
// ============================================================

function getOrigin(train, item, liveData = null) {
  return (
    train?.source?.name ||
    train?.origin?.name ||
    train?.origin ||
    train?.source ||
    train?.from ||
    train?.fromStation ||
    item?.origin ||
    item?.source ||
    item?.from ||
    liveData?.train?.source?.name ||
    liveData?.origin?.name ||
    liveData?.origin ||
    ""
  );
}

// ============================================================
// TRAIN DESTINATION
// ============================================================

function getDestination(
  train,
  item,
  liveData = null
) {
  return (
    train?.destination?.name ||
    train?.destination ||
    train?.to ||
    train?.destinationStation ||
    item?.destination ||
    item?.to ||
    liveData?.train?.destination?.name ||
    liveData?.destination?.name ||
    liveData?.destination ||
    ""
  );
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(train, item, liveData = null) {
  return (
    train?.name ||
    item?.trainName ||
    liveData?.trainName ||
    `Train ${train?.number || item?.trainNumber || ""}`
  );
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(train, item) {
  return String(
    train?.number ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}

// ============================================================
// CORRIDOR DETECTION
// ============================================================
//
// IMPORTANT:
//
// Corridor != ETA.
//
// Corridor only tells us which gate branch the train
// belongs to.
//
// The actual gate only closes after live coordinates
// confirm that the train is physically near the gate.
//

function determineCorridor(
  trainNo,
  train,
  item,
  liveData
) {
  const no = String(trainNo).trim();

  // ----------------------------------------------------------
  // Explicit train number mappings
  // ----------------------------------------------------------

  if (TPTY_TRAIN_NUMBERS.has(no)) {
    return "TPTY";
  }

  if (MAS_TRAIN_NUMBERS.has(no)) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Important known OTHER trains
  // ----------------------------------------------------------

  if (no === "12743") {
    return "OTHER";
  }

  if (no === "67226") {
    return "OTHER";
  }

  // ----------------------------------------------------------
  // Build route text
  // ----------------------------------------------------------

  const name = getTrainName(
    train,
    item,
    liveData
  );

  const origin = getOrigin(
    train,
    item,
    liveData
  );

  const destination = getDestination(
    train,
    item,
    liveData
  );

  const routeText = normalizeText(
    `${name} ${origin} ${destination}`
  );

  // ----------------------------------------------------------
  // TIRUPATI SIDE
  // ----------------------------------------------------------

  if (
    containsAny(routeText, [
      "TIRUPATI",
      "TPTY",
      "RENIGUNTA",
      "KATPAD I",
      "KATPA DI",
      "KATPAD",
      "SMVT BENGALURU",
      "SMVT BENGALURU",
      "KSR BENGALURU",
      "YESVANTPUR",
      "YPR",
      "BENGALURU",
      "BANGALORE"
    ])
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  if (
    containsAny(routeText, [
      "CHENNAI",
      "MAS",
      "MGR CHENNAI",
      "TAMBARAM",
      "SULLURUPETA",
      "ARAKKONAM",
      "CHARMINAR",
      "TAMIL NADU EXPRESS",
      "ANDAMAN EXPRESS",
      "KERALA EXPRESS"
    ])
  ) {
    return "MAS";
  }

  return "OTHER";
}

// ============================================================
// CHECK WHETHER LIVE DATA IS AT GUDUR
// ============================================================
//
// 0m is allowed ONLY here.
//
// This prevents:
//
// 05074 -> 0m
// 12743 -> 0m
// 67226 -> 0m
//
// merely because they appear on the station board.
//

function isAtGudurStation(liveData) {
  if (!liveData) {
    return false;
  }

  const stationCode =
    getCurrentStationCode(liveData);

  const status =
    getCurrentLocationStatus(liveData);

  const sequence =
    getCurrentSequence(liveData);

  const coordinates =
    getCoordinates(liveData);

  // ----------------------------------------------------------
  // Strongest confirmation:
  // current station is GDR
  // ----------------------------------------------------------

  if (
    stationCode === "GDR"
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Coordinate confirmation
  // ----------------------------------------------------------

  if (coordinates) {
    const dist =
      distanceKm(
        coordinates.lat,
        coordinates.lng,
        GUDUR_LAT,
        GUDUR_LNG
      );

    if (
      dist !== null &&
      dist <= 0.20
    ) {
      return true;
    }
  }

  // ----------------------------------------------------------
  // Do NOT use status alone.
  //
  // "at-station" without GDR is NOT Gudur.
  // ----------------------------------------------------------

  return false;
}

// ============================================================
// CHECK WHETHER TRAIN HAS DEPARTED GUDUR
// ============================================================

function hasDepartedGudur(liveData) {
  if (!liveData) {
    return false;
  }

  const stationCode =
    getCurrentStationCode(liveData);

  if (
    stationCode === "GDR"
  ) {
    return false;
  }

  const currentSeq =
    getCurrentSequence(liveData);

  const previousHalt =
    liveData?.previousHalt;

  const previousCode =
    String(
      previousHalt?.stationCode || ""
    )
      .trim()
      .toUpperCase();

  const previousSeq =
    finiteNumber(
      previousHalt?.sequence
    );

  // If previous halt was GDR and current sequence
  // is later, train has departed Gudur.

  if (
    previousCode === "GDR" &&
    currentSeq !== null &&
    previousSeq !== null &&
    currentSeq > previousSeq
  ) {
    return true;
  }

  return false;
}

// ============================================================
// GET DISTANCE FROM GUDUR
// ============================================================

function getDistanceFromGudur(liveData) {
  const coordinates =
    getCoordinates(liveData);

  if (!coordinates) {
    return null;
  }

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    GUDUR_LAT,
    GUDUR_LNG
  );
}

// ============================================================
// GET DISTANCE FROM GATE
// ============================================================

function getDistanceFromGate(
  liveData,
  corridor
) {
  const coordinates =
    getCoordinates(liveData);

  if (!coordinates) {
    return null;
  }

  const gate =
    corridor === "MAS"
      ? CHENNAI_GATE
      : corridor === "TPTY"
        ? TIRUPATI_GATE
        : null;

  if (!gate) {
    return null;
  }

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    gate.lat,
    gate.lng
  );
}

// ============================================================
// LIVE ETA EXTRACTION
// ============================================================
//
// We only accept an ETA from LIVE DATA.
//
// We DO NOT use:
//
// stop.arrival
// scheduled arrival
// old Firebase etaMinutes
// previous ETA
// timetable-only ETA
//
// Those can produce exactly the "4m while far away"
// problem.
//

function getLiveExpectedArrival(
  liveData
) {
  if (!liveData) {
    return null;
  }

  const candidates = [
    liveData?.nextHalt?.expectedArrivalTime,
    liveData?.nextHalt?.expectedArrival,
    liveData?.currentLocation?.expectedArrivalTime,
    liveData?.currentLocation?.expectedArrival,
    liveData?.expectedArrivalTime,
    liveData?.expectedArrival,
    liveData?.live?.expectedArrivalTime,
    liveData?.live?.expectedArrival
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    const date =
      new Date(value);

    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

// ============================================================
// ETA FROM LIVE EXPECTED ARRIVAL
// ============================================================

function calculateLiveEtaMinutes(
  liveData,
  now
) {
  const arrival =
    getLiveExpectedArrival(
      liveData
    );

  if (!arrival) {
    return null;
  }

  const diff =
    (
      arrival.getTime() -
      now.getTime()
    ) /
    60000;

  if (!Number.isFinite(diff)) {
    return null;
  }

  return Math.max(
    0,
    Math.round(diff)
  );
}

// ============================================================
// ETA FROM DISTANCE + SPEED
// ============================================================
//
// Used only when:
//
// 1. Current coordinates exist.
// 2. Train is within 1 km of Gudur.
// 3. Current speed is valid.
//
// This is a secondary fallback.
//
// We NEVER calculate ETA from timetable distance.
//

function calculateDistanceSpeedEta(
  liveData,
  distanceToGudurKm
) {
  if (
    distanceToGudurKm === null ||
    distanceToGudurKm < 0
  ) {
    return null;
  }

  const speed =
    finiteNumber(
      liveData?.currentLocation?.speedKmh ??
      liveData?.live?.currentLocation?.speedKmh ??
      liveData?.speedKmh
    );

  if (
    speed === null ||
    speed <= 5
  ) {
    return null;
  }

  const hours =
    distanceToGudurKm /
    speed;

  const minutes =
    hours * 60;

  if (!Number.isFinite(minutes)) {
    return null;
  }

  return Math.max(
    0,
    Math.round(minutes)
  );
}

// ============================================================
// STRICT APPROACHING-GUDUR ETA
// ============================================================
//
// THIS IS THE MOST IMPORTANT FUNCTION.
//
// Numeric ETA is returned ONLY when:
//
// - live position exists
// - train is physically within 1 km of Gudur
// - train has not departed Gudur
//
// Otherwise:
//
// return null
//
// Therefore frontend displays:
//
// --m
//
// instead of a fake number.
//

function getVerifiedApproachingEta(
  liveData,
  now
) {
  if (!liveData) {
    return null;
  }

  // ----------------------------------------------------------
  // If physically at Gudur:
  // ETA = 0
  // ----------------------------------------------------------

  if (
    isAtGudurStation(liveData)
  ) {
    return 0;
  }

  // ----------------------------------------------------------
  // If already departed Gudur:
  // It is NOT approaching Gudur anymore.
  // ----------------------------------------------------------

  if (
    hasDepartedGudur(liveData)
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // Must have actual coordinates
  // ----------------------------------------------------------

  const distanceToGudur =
    getDistanceFromGudur(
      liveData
    );

  if (
    distanceToGudur === null
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // HARD 1 KM RULE
  // ----------------------------------------------------------

  if (
    distanceToGudur >
    APPROACHING_GUDUR_DISTANCE_KM
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // FIRST CHOICE:
  // RailRadar live expected arrival
  // ----------------------------------------------------------

  let eta =
    calculateLiveEtaMinutes(
      liveData,
      now
    );

  // ----------------------------------------------------------
  // SECOND CHOICE:
  // Current distance / actual speed
  // ----------------------------------------------------------

  if (eta === null) {
    eta =
      calculateDistanceSpeedEta(
        liveData,
        distanceToGudur
      );
  }

  if (eta === null) {
    return null;
  }

  // ----------------------------------------------------------
  // Protect against impossible ETA
  // ----------------------------------------------------------

  if (
    eta < 0 ||
    eta > MAX_DISPLAY_ETA_MINUTES
  ) {
    return null;
  }

  return eta;
}

// ============================================================
// PERSISTENT LIVE CHECK
// ============================================================

async function shouldRefreshLive() {
  try {
    const ref =
      gateRef.child(
        "meta/lastLiveCheckAt"
      );

    const snapshot =
      await ref.once("value");

    const value =
      snapshot.val();

    if (!value) {
      return true;
    }

    const previous =
      new Date(value);

    if (
      isNaN(previous.getTime())
    ) {
      return true;
    }

    const elapsed =
      (
        Date.now() -
        previous.getTime()
      ) /
      60000;

    return (
      elapsed >=
      LIVE_REFRESH_MINUTES
    );
  } catch (error) {
    console.error(
      "⚠️ Could not read live-check timestamp:",
      error.message
    );

    return true;
  }
}

// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${trainNo}/live`,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,
            Accept: "application/json"
          },
          params: {
            authoritative: "true",
            includeCoordinates: "true"
          },
          timeout: 12000
        }
      );

    return (
      response.data?.data ||
      response.data ||
      null
    );
  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo}:`,
      error.response?.status ||
        error.message
    );

    return null;
  }
}

// ============================================================
// FETCH GDR BOARD
// ============================================================

async function fetchGudurBoard() {
  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live`,
      {
        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,
          Accept: "application/json"
        },
        params: {
          hours: 4,
          includeIntermediate: true
        },
        timeout: 12000
      }
    );

  return (
    response.data?.data?.trains ||
    []
  );
}

// ============================================================
// NORMALIZE BOARD ITEM
// ============================================================

function normalizeBoardItem(item) {
  const train =
    item?.train || {};

  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  const trainNo =
    getTrainNumber(
      train,
      item
    );

  const name =
    getTrainName(
      train,
      item
    );

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

  const corridor =
    determineCorridor(
      trainNo,
      train,
      item,
      null
    );

  const platform =
    String(
      live?.platform ||
      stop?.platform ||
      item?.platform ||
      "--"
    );

  const delay =
    finiteNumber(
      live?.delayMinutes ??
      item?.delayMinutes ??
      0
    ) ?? 0;

  return {
    raw: item,
    train,
    live,
    stop,
    trainNo,
    name,
    origin,
    destination,
    corridor,
    platform,
    delay
  };
}

// ============================================================
// PROCESS TRAIN
// ============================================================

async function processTrain(
  normalized,
  liveData,
  now
) {
  const {
    raw,
    train,
    live,
    stop,
    trainNo,
    name,
    origin,
    destination,
    platform,
    delay
  } = normalized;

  if (!trainNo) {
    return null;
  }

  // ----------------------------------------------------------
  // Use fresh live data when available.
  // ----------------------------------------------------------

  const effectiveLive =
    liveData || null;

  let corridor =
    determineCorridor(
      trainNo,
      train,
      raw,
      effectiveLive
    );

  // ----------------------------------------------------------
  // If live data confirms actual route information,
  // allow corridor update.
  // ----------------------------------------------------------

  const liveDestination =
    getDestination(
      train,
      raw,
      effectiveLive
    );

  const liveOrigin =
    getOrigin(
      train,
      raw,
      effectiveLive
    );

  corridor =
    determineCorridor(
      trainNo,
      {
        ...train,
        origin:
          liveOrigin || train?.origin,
        destination:
          liveDestination ||
          train?.destination
      },
      raw,
      effectiveLive
    );

  // ----------------------------------------------------------
  // Numeric ETA ONLY from verified approaching logic.
  // ----------------------------------------------------------

  const verifiedEta =
    getVerifiedApproachingEta(
      effectiveLive,
      now
    );

  // ----------------------------------------------------------
  // Determine whether this is physically approaching Gudur.
  // ----------------------------------------------------------

  const distanceToGudur =
    effectiveLive
      ? getDistanceFromGudur(
          effectiveLive
        )
      : null;

  const atGudur =
    effectiveLive
      ? isAtGudurStation(
          effectiveLive
        )
      : false;

  const departedGudur =
    effectiveLive
      ? hasDepartedGudur(
          effectiveLive
        )
      : false;

  const approachingGudur =
    verifiedEta !== null &&
    !departedGudur &&
    (
      atGudur ||
      (
        distanceToGudur !== null &&
        distanceToGudur <=
          APPROACHING_GUDUR_DISTANCE_KM
      )
    );

  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // If no verified numeric ETA:
  // etaMinutes = null
  //
  // NEVER:
  // etaMinutes = 0
  // etaMinutes = old ETA
  // etaMinutes = timetable ETA
  // etaMinutes = board arrival difference
  // ----------------------------------------------------------

  const etaMinutes =
    approachingGudur
      ? verifiedEta
      : null;

  // ----------------------------------------------------------
  // GATE DISTANCE
  // ----------------------------------------------------------

  const distanceToGate =
    effectiveLive &&
    (
      corridor === "MAS" ||
      corridor === "TPTY"
    )
      ? getDistanceFromGate(
          effectiveLive,
          corridor
        )
      : null;

  // ----------------------------------------------------------
  // Gate status
  //
  // Gate can close only when:
  //
  // 1. Correct corridor
  // 2. Train departed Gudur
  // 3. Live coordinates exist
  // 4. Train is physically near gate
  // ----------------------------------------------------------

  let gateState =
    "OPEN";

  if (
    (corridor === "MAS" ||
      corridor === "TPTY") &&
    departedGudur &&
    distanceToGate !== null &&
    distanceToGate <=
      GATE_CLOSE_DISTANCE_KM
  ) {
    gateState =
      "CLOSED";
  }

  return {
    trainNo,
    name,

    origin:
      origin ||
      liveOrigin ||
      "Unknown origin",

    destination:
      destination ||
      liveDestination ||
      "Gudur",

    corridor,

    direction:
      approachingGudur
        ? "TOWARD GUDUR"
        : departedGudur
          ? "AFTER GUDUR"
          : "UNKNOWN",

    platform,

    delayMinutes:
      delay,

    // --------------------------------------------------------
    // THIS IS THE ONLY ETA FIELD USED BY FRONTEND.
    // --------------------------------------------------------

    etaMinutes,

    // Extra diagnostic data
    distanceToGudurKm:
      distanceToGudur !== null
        ? Number(
            distanceToGudur.toFixed(3)
          )
        : null,

    distanceToGateKm:
      distanceToGate !== null
        ? Number(
            distanceToGate.toFixed(3)
          )
        : null,

    atGudur,
    departedGudur,
    approachingGudur,

    gateState,

    etaSource:
      etaMinutes === null
        ? "UNVERIFIED"
        : atGudur
          ? "LIVE_AT_GUDUR"
          : "LIVE_APPROACHING_GUDUR"
  };
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  const now =
    new Date();

  console.log(
    "\n=================================================="
  );

  console.log(
    `[${now.toLocaleTimeString()}] Gudur Gate Monitor`
  );

  console.log(
    "=================================================="
  );

  try {
    // ----------------------------------------------------------
    // GET STATION BOARD
    // ----------------------------------------------------------

    console.log(
      "📡 Fetching GDR station board..."
    );

    const board =
      await fetchGudurBoard();

    if (
      !Array.isArray(board)
    ) {
      throw new Error(
        "RailRadar returned invalid station board."
      );
    }

    console.log(
      `✅ Board returned ${board.length} trains.`
    );

    // ----------------------------------------------------------
    // DETERMINE WHETHER LIVE API CAN BE USED
    // ----------------------------------------------------------

    const refreshLive =
      await shouldRefreshLive();

    console.log(
      refreshLive
        ? "🔴 Live refresh: REQUIRED"
        : "🟢 Live refresh: SKIPPED (20-minute persistent throttle)"
    );

    if (refreshLive) {
      await gateRef
        .child(
          "meta/lastLiveCheckAt"
        )
        .set(
          now.toISOString()
        );
    }

    // ----------------------------------------------------------
    // NORMALIZE BOARD
    // ----------------------------------------------------------

    const normalizedTrains =
      board
        .map(
          normalizeBoardItem
        )
        .filter(
          (x) =>
            Boolean(x.trainNo)
        );

    // ----------------------------------------------------------
    // LIVE DATA
    // ----------------------------------------------------------

    const liveMap =
      new Map();

    // ----------------------------------------------------------
    // Only ask live API when persistent throttle permits.
    //
    // We inspect trains that are likely relevant.
    //
    // Maximum 8 live requests per refresh.
    // ----------------------------------------------------------

    if (refreshLive) {
      const candidates =
        normalizedTrains
          .filter(
            (x) =>
              x.corridor === "MAS" ||
              x.corridor === "TPTY" ||
              x.trainNo === "12743" ||
              x.trainNo === "67226"
          )
          .slice(0, 8);

      console.log(
        `📍 Requesting live position for ${candidates.length} candidate trains...`
      );

      for (
        const candidate
        of candidates
      ) {
        const liveData =
          await fetchLiveTrain(
            candidate.trainNo
          );

        if (liveData) {
          liveMap.set(
            candidate.trainNo,
            liveData
          );

          const distance =
            getDistanceFromGudur(
              liveData
            );

          console.log(
            `[LIVE] ${candidate.trainNo} ${candidate.name} | Gudur distance: ${
              distance !== null
                ? distance.toFixed(2) + " km"
                : "unknown"
            }`
          );
        }
      }
    }

    // ----------------------------------------------------------
    // PROCESS ALL BOARD TRAINS
    // ----------------------------------------------------------

    const processed =
      [];

    for (
      const normalized
      of normalizedTrains
    ) {
      const liveData =
        liveMap.get(
          normalized.trainNo
        ) || null;

      const result =
        await processTrain(
          normalized,
          liveData,
          now
        );

      if (!result) {
        continue;
      }

      processed.push(
        result
      );

      // --------------------------------------------------------
      // Debug ETA decision
      // --------------------------------------------------------

      if (
        result.etaMinutes !== null
      ) {
        console.log(
          `[ETA VERIFIED] ${result.trainNo} ${result.name} -> ${result.etaMinutes}m | ${result.distanceToGudurKm} km from GDR`
        );
      } else {
        console.log(
          `[ETA BLOCKED] ${result.trainNo} ${result.name} | ${
            result.distanceToGudurKm !== null
              ? result.distanceToGudurKm + " km from GDR"
              : "position unknown"
          }`
        );
      }
    }

    // ========================================================
    // UPCOMING TRAINS
    // ========================================================
    //
    // ONLY trains that are actually approaching Gudur
    // receive numeric ETA.
    //
    // Far trains can remain visible, but ETA is "--".
    //
    // This prevents:
    //
    // Tamil Nadu Express = 4m while far away
    // 05074 = 0m while far away
    // 12743 = 0m merely because it is on the board
    //
    // ========================================================

    const upcoming =
      processed
        .filter(
          (train) =>
            !train.departedGudur
        )
        .sort(
          (a, b) => {

            const aEta =
              a.etaMinutes !== null
                ? a.etaMinutes
                : 9999;

            const bEta =
              b.etaMinutes !== null
                ? b.etaMinutes
                : 9999;

            return (
              aEta - bEta
            );
          }
        )
        .slice(
          0,
          UPCOMING_LIMIT
        );

    // ========================================================
    // GATE STATES
    // ========================================================

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain: "Tracks clear",
      direction: "NONE",
      corridor: "MAS"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain: "Tracks clear",
      direction: "NONE",
      corridor: "TPTY"
    };

    // --------------------------------------------------------
    // Find active gate trains
    // --------------------------------------------------------

    for (
      const train
      of processed
    ) {
      if (
        train.gateState !==
        "CLOSED"
      ) {
        continue;
      }

      const distance =
        train.distanceToGateKm;

      let waitMinutes =
        3;

      if (
        distance !== null
      ) {
        // Conservative crossing wait estimate.
        //
        // Minimum 2 minutes.
        //
        // We do not use timetable arrival here.
        waitMinutes =
          Math.max(
            2,
            Math.min(
              10,
              Math.round(
                distance * 4
              )
            )
          );
      }

      const payload = {
        status: "CLOSED",

        waitMinutes,

        activeTrain:
          `${train.trainNo} ${train.name}`,

        direction:
          "TOWARD GATE",

        corridor:
          train.corridor
      };

      if (
        train.corridor ===
        "MAS"
      ) {
        masGate =
          payload;
      }

      if (
        train.corridor ===
        "TPTY"
      ) {
        tptyGate =
          payload;
      }
    }

    // ========================================================
    // FIREBASE UPCOMING DATA
    // ========================================================

    const upcomingFirebase =
      upcoming.map(
        (train) => ({
          trainNo:
            train.trainNo,

          name:
            train.name,

          origin:
            train.origin,

          destination:
            train.destination,

          corridor:
            train.corridor,

          direction:
            train.direction,

          platform:
            train.platform,

          delayMinutes:
            train.delayMinutes,

          // CRITICAL:
          //
          // null for far/unverified trains.
          //
          // Never reuse an old Firebase value.
          //
          etaMinutes:
            train.etaMinutes,

          etaSource:
            train.etaSource,

          distanceToGudurKm:
            train.distanceToGudurKm,

          approachingGudur:
            train.approachingGudur,

          atGudur:
            train.atGudur
        })
      );

    // ========================================================
    // FIREBASE WRITE
    // ========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        upcomingFirebase,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleString(),

      meta: {
        lastLiveCheckAt:
          refreshLive
            ? now.toISOString()
            : (
                await gateRef
                  .child(
                    "meta/lastLiveCheckAt"
                  )
                  .once("value")
              ).val(),

        approachingRule:
          "Numeric ETA only when verified live position is within 1 km of Gudur",

        numericEtaRule:
          "ETA must be null when train is far, unverified, or departed Gudur",

        zeroEtaRule:
          "0m only when live position is actually at Gudur Junction",

        approachingRadiusKm:
          APPROACHING_GUDUR_DISTANCE_KM,

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM
      }
    });

    // ========================================================
    // SUMMARY
    // ========================================================

    console.log(
      "\n================ SYNC SUCCESS ================"
    );

    console.log(
      `MAS Gate   : ${masGate.status}`
    );

    console.log(
      `TPTY Gate  : ${tptyGate.status}`
    );

    console.log(
      `Upcoming   : ${upcomingFirebase.length}`
    );

    console.log(
      "=============================================="
    );

    // --------------------------------------------------------
    // UPCOMING DISPLAY
    // --------------------------------------------------------

    console.log(
      "\n[UPCOMING TRAINS]"
    );

    if (
      upcomingFirebase.length === 0
    ) {
      console.log(
        "None"
      );
    } else {
      upcomingFirebase.forEach(
        (train) => {

          const etaText =
            train.etaMinutes === null
              ? "--"
              : `${train.etaMinutes}m`;

          const distanceText =
            train.distanceToGudurKm === null
              ? "distance unknown"
              : `${train.distanceToGudurKm} km`;

          console.log(
            `${train.trainNo} | ${train.name} | ${train.corridor} | ETA ${etaText} | ${distanceText}`
          );
        }
      );
    }

  } catch (error) {
    console.error(
      "\n❌ MONITOR ERROR"
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
  }
}

// ============================================================
// START
// ============================================================

console.log(
  "=================================================="
);

console.log(
  "   GUDUR CROSSING RADAR - REAL TIME MONITOR"
);

console.log(
  "=================================================="
);

console.log(
  "Gudur Junction : 14.1451694, 79.8443472"
);

console.log(
  "Tirupati Gate  : 14.1402028, 79.8435972"
);

console.log(
  "Chennai Gate   : 14.1396667, 79.8441278"
);

console.log(
  "Approaching ETA radius : 1.00 km"
);

console.log(
  "Gate close radius      : 0.60 km"
);

console.log(
  "Gate clear radius      : 0.80 km"
);

console.log(
  "Live refresh           : every 20 minutes"
);

console.log(
  "Numeric ETA rule       : VERIFIED APPROACH ONLY"
);

console.log(
  "=================================================="
);

// ============================================================
// RUN
// ============================================================

updateGateSystem();

// ============================================================
// GITHUB ACTIONS RUNS EVERY 5 MINUTES
// ============================================================
//
// The process itself stays alive only for the current
// GitHub Actions execution.
//
// GitHub Actions should therefore run code.js every 5 min.
//
// The live API is separately throttled through Firebase
// meta/lastLiveCheckAt.
//

setInterval(
  updateGateSystem,
  300000
);
