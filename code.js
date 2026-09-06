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
    "❌ Firebase service account could not be loaded."
  );

  console.error(
    "Use FIREBASE_SERVICE_ACCOUNT in GitHub Actions or place serviceAccountKey.json beside code.js."
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

const trackingRef =
  db.ref("gudur_gate_tracking");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR GEOMETRY
// ============================================================

const GUDUR_JUNCTION = {
  lat: 14.1451694,
  lng: 79.8443472
};

const CHENNAI_GATE = {
  lat: 14.1396667,
  lng: 79.8441278
};

const TIRUPATI_GATE = {
  lat: 14.1402028,
  lng: 79.8435972
};

// ============================================================
// DISTANCE SETTINGS
// ============================================================

// Used for deciding when a train should be tracked.
const TRACKING_DISTANCE_KM = 1.0;

// Actual physical gate area.
// Gate closes when train reaches this zone.
const GATE_CLOSE_DISTANCE_KM = 0.60;

// After the train has passed beyond this distance,
// it is considered clear.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Keep tracking records only for this long.
const TRACKING_RETENTION_MINUTES = 45;

// Maximum upcoming ETA shown on frontend.
const UPCOMING_MAX_ETA_MINUTES = 360;

// ============================================================
// LIVE API QUOTA CONTROL
// ============================================================
//
// Free RailRadar sandbox = 1000 requests/month.
//
// GitHub Actions runs every 5 minutes.
// Station board ≈ 864 requests/month.
//
// Therefore live train calls MUST NOT happen every run.
//
// One live verification every 20 minutes gives:
// Board: ~864/month
// Live:  ~72/month
// Total:  ~936/month
//
// ============================================================

const LIVE_CHECK_INTERVAL_MINUTES = 20;

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
// DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    (lat2 - lat1) *
    Math.PI /
    180;

  const dLng =
    (lng2 - lng1) *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
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
// BEARING
// ============================================================

function bearingDegrees(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const p1 =
    lat1 * Math.PI / 180;

  const p2 =
    lat2 * Math.PI / 180;

  const dl =
    (lng2 - lng1) *
    Math.PI /
    180;

  const y =
    Math.sin(dl) *
    Math.cos(p2);

  const x =
    Math.cos(p1) *
    Math.sin(p2) -
    Math.sin(p1) *
    Math.cos(p2) *
    Math.cos(dl);

  const brng =
    Math.atan2(y, x) *
    180 /
    Math.PI;

  return (
    brng + 360
  ) % 360;
}

// ============================================================
// ANGULAR DIFFERENCE
// ============================================================

function angleDifference(
  a,
  b
) {
  let d =
    Math.abs(a - b) % 360;

  if (d > 180) {
    d = 360 - d;
  }

  return d;
}

// ============================================================
// GET CURRENT GPS
// ============================================================

function getCurrentCoordinates(
  liveData
) {
  const location =
    liveData?.currentLocation || {};

  const coordinates =
    location.coordinates || {};

  const lat =
    toNumber(
      coordinates.lat ??
      location.lat
    );

  const lng =
    toNumber(
      coordinates.lng ??
      location.lng
    );

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
// GUDUR STATION DETECTION
// ============================================================

function isAtGudurStation(
  liveData
) {
  const location =
    liveData?.currentLocation || {};

  const stationCode =
    normalizeText(
      location.stationCode
    );

  const stationName =
    normalizeText(
      location.stationName
    );

  if (
    stationCode === "GDR"
  ) {
    return true;
  }

  if (
    stationName.includes("GUDUR")
  ) {
    return true;
  }

  return false;
}

// ============================================================
// GUDUR SEQUENCE
// ============================================================

function getGudurSequence(
  liveData
) {
  const route =
    Array.isArray(
      liveData?.route
    )
      ? liveData.route
      : [];

  const gdr =
    route.find(
      (stop) =>
        normalizeText(
          stop.stationCode ||
          stop.code
        ) === "GDR"
    );

  if (
    gdr &&
    Number.isFinite(
      Number(gdr.sequence)
    )
  ) {
    return Number(
      gdr.sequence
    );
  }

  const next =
    liveData?.nextHalt;

  if (
    normalizeText(
      next?.stationCode
    ) === "GDR" &&
    Number.isFinite(
      Number(next?.sequence)
    )
  ) {
    return Number(
      next.sequence
    );
  }

  const previous =
    liveData?.previousHalt;

  if (
    normalizeText(
      previous?.stationCode
    ) === "GDR" &&
    Number.isFinite(
      Number(previous?.sequence)
    )
  ) {
    return Number(
      previous.sequence
    );
  }

  return null;
}

// ============================================================
// HAS TRAIN PASSED GUDUR?
// ============================================================

function hasDepartedGudur(
  liveData
) {
  if (
    isAtGudurStation(liveData)
  ) {
    return false;
  }

  const current =
    liveData?.currentLocation || {};

  const previous =
    liveData?.previousHalt || {};

  const currentSequence =
    toNumber(
      current.sequence
    );

  const previousSequence =
    toNumber(
      previous.sequence
    );

  if (
    normalizeText(
      previous.stationCode
    ) === "GDR" &&
    currentSequence !== null &&
    previousSequence !== null &&
    currentSequence >
      previousSequence
  ) {
    return true;
  }

  const gdrSequence =
    getGudurSequence(
      liveData
    );

  if (
    gdrSequence !== null &&
    currentSequence !== null &&
    currentSequence >
      gdrSequence
  ) {
    return true;
  }

  return (
    normalizeText(
      current.status
    ) === "DEPARTED" &&
    normalizeText(
      previous.stationCode
    ) === "GDR"
  );
}

// ============================================================
// TRAIN MOVING
// ============================================================

function isTrainMoving(
  liveData
) {
  const current =
    liveData?.currentLocation || {};

  const status =
    normalizeText(
      current.status ||
      liveData?.status
    );

  if (
    status.includes("DEPARTED") ||
    status.includes("RUNNING") ||
    status.includes("MOVING")
  ) {
    return true;
  }

  const speed =
    toNumber(
      current.speedKmh ??
      current.speedKmH ??
      current.speed
    );

  if (
    speed !== null &&
    speed > 2
  ) {
    return true;
  }

  return false;
}

// ============================================================
// GET ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const source =
    train?.source;

  if (
    source &&
    typeof source === "object"
  ) {
    return (
      source.name ||
      source.code ||
      ""
    );
  }

  return (
    train?.origin ||
    train?.from ||
    train?.fromStation ||
    item?.origin ||
    item?.source ||
    item?.from ||
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
  const destination =
    train?.destination;

  if (
    destination &&
    typeof destination === "object"
  ) {
    return (
      destination.name ||
      destination.code ||
      ""
    );
  }

  return (
    train?.destinationStation ||
    train?.to ||
    train?.endStation ||
    item?.destination ||
    item?.to ||
    ""
  );
}

// ============================================================
// STATION BOARD TIME
// ============================================================

function parseTimeToMinutes(
  value,
  delayMinutes = 0
) {
  if (!value) {
    return null;
  }

  const str =
    String(value).trim();

  const isoDate =
    new Date(str);

  if (
    !Number.isNaN(
      isoDate.getTime()
    ) &&
    str.includes("T")
  ) {
    return (
      isoDate.getHours() * 60 +
      isoDate.getMinutes() +
      Number(delayMinutes || 0)
    );
  }

  const match =
    str.match(
      /(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return null;
  }

  return (
    Number(match[1]) * 60 +
    Number(match[2]) +
    Number(delayMinutes || 0)
  );
}

// ============================================================
// CURRENT MINUTES
// ============================================================

function currentMinutes() {
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
// BOARD ETA
// ============================================================
//
// IMPORTANT:
//
// Missing ETA = null.
// NEVER convert missing ETA into 0.
//
// 0 is reserved ONLY for a train physically confirmed
// at Gudur Junction.
//

function getBoardEtaMinutes(
  item
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

  const possibleTimes = [
    live.expectedArrivalTime,
    live.expectedArrival,
    stop.arrival,
    item.expectedArrivalTime,
    item.expectedArrival
  ];

  for (
    const value of possibleTimes
  ) {
    const parsed =
      parseTimeToMinutes(
        value,
        delay
      );

    if (
      parsed !== null
    ) {
      const diff =
        calculateTimeDifference(
          parsed,
          currentMinutes()
        );

      if (
        diff !== null
      ) {
        return Math.max(
          0,
          diff
        );
      }
    }
  }

  return null;
}

// ============================================================
// ACTUAL LIVE ETA TO GUDUR
// ============================================================
//
// Used only when RailRadar provides:
//
// - current GPS
// - next GDR
// - speed
//
// This is only an estimate.
//
// It is NEVER used to turn a train into 0m unless the
// live location itself says the train is at GDR.
//

function getLiveEtaToGudur(
  liveData
) {
  if (
    isAtGudurStation(
      liveData
    )
  ) {
    return 0;
  }

  const current =
    liveData?.currentLocation || {};

  const next =
    liveData?.nextHalt || {};

  if (
    normalizeText(
      next.stationCode
    ) !== "GDR"
  ) {
    return null;
  }

  const speed =
    toNumber(
      current.speedKmh ??
      current.speedKmH ??
      current.speed
    );

  if (
    speed === null ||
    speed < 5
  ) {
    return null;
  }

  const distance =
    toNumber(
      next.distance
    );

  if (
    distance === null ||
    distance <= 0
  ) {
    return null;
  }

  return Math.max(
    1,
    Math.round(
      distance / speed * 60
    )
  );
}

// ============================================================
// ETA SELECTION
// ============================================================

function getCorrectEta(
  item,
  liveData
) {
  // ----------------------------------------------------------
  // RULE 1:
  // Actually at Gudur = 0m
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      liveData
    )
  ) {
    return 0;
  }

  // ----------------------------------------------------------
  // RULE 2:
  // Board ETA
  // ----------------------------------------------------------

  const boardEta =
    getBoardEtaMinutes(
      item
    );

  if (
    boardEta !== null
  ) {
    return boardEta;
  }

  // ----------------------------------------------------------
  // RULE 3:
  // GPS speed estimate
  // ----------------------------------------------------------

  const liveEta =
    getLiveEtaToGudur(
      liveData
    );

  if (
    liveEta !== null
  ) {
    return liveEta;
  }

  // ----------------------------------------------------------
  // RULE 4:
  // Unknown ETA = null
  // ----------------------------------------------------------

  return null;
}

// ============================================================
// DETERMINE GATE FROM LIVE POSITION
// ============================================================
//
// We do NOT use:
//   origin = Vijayawada
//   origin = Chennai
//   origin = Tirupati
//
// Instead we use actual live coordinates and movement.
//
// The nearest physical gate is selected only when the
// train is close enough to the Gudur gate area.
//
// ============================================================

function determineGateFromPosition(
  liveData
) {
  const coords =
    getCurrentCoordinates(
      liveData
    );

  if (!coords) {
    return null;
  }

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

  if (
    chennaiDistance === null ||
    tirupatiDistance === null
  ) {
    return null;
  }

  if (
    chennaiDistance <=
    TRACKING_DISTANCE_KM &&
    chennaiDistance <
    tirupatiDistance
  ) {
    return {
      corridor: "MAS",
      gate: "CHENNAI",
      distanceKm:
        chennaiDistance
    };
  }

  if (
    tirupatiDistance <=
    TRACKING_DISTANCE_KM
  ) {
    return {
      corridor: "TPTY",
      gate: "TIRUPATI",
      distanceKm:
        tirupatiDistance
    };
  }

  return null;
}

// ============================================================
// DETERMINE GATE FROM BEARING
// ============================================================
//
// If the train is around Gudur and both gates are close,
// movement bearing helps identify the branch.
//
// ============================================================

function determineGateFromBearing(
  liveData
) {
  const coords =
    getCurrentCoordinates(
      liveData
    );

  if (!coords) {
    return null;
  }

  const current =
    liveData?.currentLocation || {};

  const bearing =
    toNumber(
      current.bearingDegrees
    );

  if (
    bearing === null
  ) {
    return null;
  }

  const chennaiBearing =
    bearingDegrees(
      GUDUR_JUNCTION.lat,
      GUDUR_JUNCTION.lng,
      CHENNAI_GATE.lat,
      CHENNAI_GATE.lng
    );

  const tirupatiBearing =
    bearingDegrees(
      GUDUR_JUNCTION.lat,
      GUDUR_JUNCTION.lng,
      TIRUPATI_GATE.lat,
      TIRUPATI_GATE.lng
    );

  const chennaiDiff =
    angleDifference(
      bearing,
      chennaiBearing
    );

  const tirupatiDiff =
    angleDifference(
      bearing,
      tirupatiBearing
    );

  if (
    chennaiDiff <= 45 &&
    chennaiDiff <
    tirupatiDiff
  ) {
    return {
      corridor: "MAS",
      gate: "CHENNAI"
    };
  }

  if (
    tirupatiDiff <= 45
  ) {
    return {
      corridor: "TPTY",
      gate: "TIRUPATI"
    };
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// We DO NOT classify a train simply because its destination
// is Chennai or Tirupati.
//
// We first need live movement evidence.
//
// ============================================================

function determineCorridor(
  liveData
) {
  const positionGate =
    determineGateFromPosition(
      liveData
    );

  if (
    positionGate
  ) {
    return positionGate;
  }

  const bearingGate =
    determineGateFromBearing(
      liveData
    );

  if (
    bearingGate
  ) {
    return bearingGate;
  }

  return null;
}

// ============================================================
// TRACKING STATE
// ============================================================

const STATES = {
  APPROACHING_GUDUR:
    "APPROACHING_GUDUR",

  AT_GUDUR_STATION:
    "AT_GUDUR_STATION",

  DEPARTED_GUDUR:
    "DEPARTED_GUDUR",

  APPROACHING_GATE:
    "APPROACHING_GATE",

  AT_GATE:
    "AT_GATE",

  PASSED_GATE:
    "PASSED_GATE"
};

// ============================================================
// CREATE TRACKING RECORD
// ============================================================

function createTrackingRecord(
  trainNo,
  trainName,
  origin,
  destination,
  etaMinutes
) {
  return {
    trainNo,

    name:
      trainName,

    origin:
      origin || "Unknown",

    destination:
      destination || "Unknown",

    state:
      STATES.APPROACHING_GUDUR,

    corridor:
      null,

    direction:
      null,

    etaMinutes:
      etaMinutes,

    distanceToGudurKm:
      null,

    distanceToGateKm:
      null,

    lastLiveAt:
      Date.now(),

    updatedAt:
      Date.now()
  };
}

// ============================================================
// UPDATE TRACKING RECORD FROM LIVE DATA
// ============================================================

function updateTrackingRecord(
  record,
  liveData
) {
  const now =
    Date.now();

  const coords =
    getCurrentCoordinates(
      liveData
    );

  const atGudur =
    isAtGudurStation(
      liveData
    );

  const departedGudur =
    hasDepartedGudur(
      liveData
    );

  // ----------------------------------------------------------
  // DISTANCE FROM GUDUR
  // ----------------------------------------------------------

  if (coords) {
    record.distanceToGudurKm =
      Number(
        distanceKm(
          coords.lat,
          coords.lng,
          GUDUR_JUNCTION.lat,
          GUDUR_JUNCTION.lng
        ).toFixed(3)
      );
  }

  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  if (atGudur) {
    record.state =
      STATES.AT_GUDUR_STATION;

    record.corridor =
      null;

    record.direction =
      "AT GUDUR";

    record.etaMinutes =
      0;

    record.distanceToGateKm =
      null;

    record.lastLiveAt =
      now;

    record.updatedAt =
      now;

    return record;
  }

  // ----------------------------------------------------------
  // DEPARTED GUDUR
  // ----------------------------------------------------------

  if (
    departedGudur ||
    record.state ===
      STATES.DEPARTED_GUDUR ||
    record.state ===
      STATES.APPROACHING_GATE ||
    record.state ===
      STATES.AT_GATE
  ) {
    if (
      record.state ===
      STATES.AT_GUDUR_STATION
    ) {
      record.state =
        STATES.DEPARTED_GUDUR;
    }

    // --------------------------------------------------------
    // DETERMINE ACTUAL BRANCH
    // --------------------------------------------------------

    const gate =
      determineCorridor(
        liveData
      );

    if (gate) {
      record.corridor =
        gate.corridor;

      record.direction =
        gate.corridor === "MAS"
          ? "TOWARD CHENNAI GATE"
          : "TOWARD TIRUPATI GATE";

      record.distanceToGateKm =
        Number(
          gate.distanceKm !==
            undefined
            ? gate.distanceKm
            : (
                gate.gate ===
                "CHENNAI"
                  ? distanceKm(
                      coords.lat,
                      coords.lng,
                      CHENNAI_GATE.lat,
                      CHENNAI_GATE.lng
                    )
                  : distanceKm(
                      coords.lat,
                      coords.lng,
                      TIRUPATI_GATE.lat,
                      TIRUPATI_GATE.lng
                    )
              ).toFixed(3)
        );

      // ------------------------------------------------------
      // APPROACHING GATE
      // ------------------------------------------------------

      if (
        record.distanceToGateKm <=
        TRACKING_DISTANCE_KM &&
        record.distanceToGateKm >
        GATE_CLOSE_DISTANCE_KM
      ) {
        record.state =
          STATES.APPROACHING_GATE;
      }

      // ------------------------------------------------------
      // AT GATE
      // ------------------------------------------------------

      if (
        record.distanceToGateKm <=
        GATE_CLOSE_DISTANCE_KM
      ) {
        record.state =
          STATES.AT_GATE;
      }

      // ------------------------------------------------------
      // PASSED GATE
      // ------------------------------------------------------

      if (
        record.state ===
        STATES.AT_GATE &&
        record.distanceToGateKm >=
        GATE_CLEAR_DISTANCE_KM
      ) {
        record.state =
          STATES.PASSED_GATE;
      }
    } else if (
      record.state ===
      STATES.AT_GUDUR_STATION
    ) {
      record.state =
        STATES.DEPARTED_GUDUR;
    }
  } else {
    record.state =
      STATES.APPROACHING_GUDUR;
  }

  // ----------------------------------------------------------
  // NEVER SET ETA 0 UNLESS AT GUDUR
  // ----------------------------------------------------------

  if (
    record.state !==
    STATES.AT_GUDUR_STATION &&
    record.etaMinutes === 0
  ) {
    record.etaMinutes =
      null;
  }

  record.lastLiveAt =
    now;

  record.updatedAt =
    now;

  return record;
}

// ============================================================
// SAFE FIREBASE VALUE
// ============================================================

function cleanFirebaseObject(
  value
) {
  if (
    value === undefined
  ) {
    return null;
  }

  if (
    value === null
  ) {
    return null;
  }

  if (
    Array.isArray(value)
  ) {
    return value.map(
      cleanFirebaseObject
    );
  }

  if (
    typeof value === "object"
  ) {
    const result = {};

    for (
      const [key, val]
      of Object.entries(value)
    ) {
      if (
        val !== undefined
      ) {
        result[key] =
          cleanFirebaseObject(
            val
          );
      }
    }

    return result;
  }

  return value;
}

// ============================================================
// LOAD TRACKING DATA
// ============================================================

async function loadTracking() {
  try {
    const snapshot =
      await trackingRef.get();

    const data =
      snapshot.val();

    if (
      !data ||
      typeof data !== "object"
    ) {
      return {};
    }

    return data;
  } catch (error) {
    console.error(
      "[TRACKING LOAD ERROR]",
      error.message
    );

    return {};
  }
}

// ============================================================
// CLEAN TRACKING DATA
// ============================================================

function cleanupTracking(
  tracking
) {
  const now =
    Date.now();

  for (
    const [trainNo, record]
    of Object.entries(tracking)
  ) {
    const lastLive =
      Number(
        record?.lastLiveAt
      );

    if (
      !Number.isFinite(
        lastLive
      )
    ) {
      console.log(
        `[TRACKING REMOVE] ${trainNo} | invalid timestamp`
      );

      delete tracking[trainNo];

      continue;
    }

    const ageMinutes =
      (
        now -
        lastLive
      ) /
      60000;

    if (
      ageMinutes >
      TRACKING_RETENTION_MINUTES
    ) {
      console.log(
        `[TRACKING REMOVE] ${trainNo} | ${Math.round(ageMinutes)}m old`
      );

      delete tracking[trainNo];

      continue;
    }

    if (
      record.state ===
      STATES.PASSED_GATE
    ) {
      console.log(
        `[TRACKING REMOVE] ${trainNo} | passed gate`
      );

      delete tracking[trainNo];
    }
  }

  return tracking;
}

// ============================================================
// SAVE TRACKING DATA
// ============================================================

async function saveTracking(
  tracking
) {
  await trackingRef.set(
    cleanFirebaseObject(
      tracking
    )
  );
}

// ============================================================
// LIVE TRAIN REQUEST
// ============================================================

async function getLiveTrain(
  trainNo
) {
  try {
    const url =
      `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(trainNo)}/live`;

    const response =
      await axios.get(
        url,
        {
          params: {
            authoritative: "true",
            includeCoordinates: "true",
            geometry: "true",
            format: "geojson"
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

    return (
      response.data?.data ||
      null
    );
  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo} | ${error.message}`
    );

    return null;
  }
}

// ============================================================
// LIVE CHECK THROTTLE
// ============================================================

async function canRunLiveCheck() {
  const snapshot =
    await db
      .ref(
        "gudur_gate_system/lastLiveCheckAt"
      )
      .get();

  const last =
    Number(
      snapshot.val()
    );

  if (
    !Number.isFinite(last)
  ) {
    return true;
  }

  const ageMinutes =
    (
      Date.now() -
      last
    ) /
    60000;

  return (
    ageMinutes >=
    LIVE_CHECK_INTERVAL_MINUTES
  );
}

// ============================================================
// MARK LIVE CHECK
// ============================================================

async function markLiveCheck() {
  await db
    .ref(
      "gudur_gate_system"
    )
    .update({
      lastLiveCheckAt:
        Date.now()
    });
}

// ============================================================
// SELECT LIVE CANDIDATE
// ============================================================
//
// Priority:
//
// 1. Already tracked train
// 2. Train approaching Gudur soon
// 3. Train with ETA <= 20 minutes
//
// Only ONE live request is made per allowed live cycle.
//

function selectLiveCandidate(
  trainsArray,
  tracking
) {
  const candidates = [];

  // ----------------------------------------------------------
  // TRACKED TRAINS FIRST
  // ----------------------------------------------------------

  for (
    const [trainNo, record]
    of Object.entries(tracking)
  ) {
    if (
      record?.state ===
      STATES.PASSED_GATE
    ) {
      continue;
    }

    candidates.push({
      trainNo,
      priority: 1
    });
  }

  // ----------------------------------------------------------
  // BOARD CANDIDATES
  // ----------------------------------------------------------

  for (
    const item of trainsArray
  ) {
    const train =
      item?.train || {};

    const trainNo =
      String(
        train.number || ""
      ).trim();

    if (!trainNo) {
      continue;
    }

    const eta =
      getBoardEtaMinutes(
        item
      );

    if (
      eta !== null &&
      eta <= 20
    ) {
      candidates.push({
        trainNo,
        priority: 2,
        eta
      });
    }
  }

  // ----------------------------------------------------------
  // REMOVE DUPLICATES
  // ----------------------------------------------------------

  const unique =
    new Map();

  for (
    const candidate
    of candidates
  ) {
    if (
      !unique.has(
        candidate.trainNo
      )
    ) {
      unique.set(
        candidate.trainNo,
        candidate
      );
    }
  }

  return Array.from(
    unique.values()
  )
    .sort(
      (a, b) =>
        a.priority -
        b.priority ||
        (
          a.eta ??
          999
        ) -
        (
          b.eta ??
          999
        )
    )[0] || null;
}

// ============================================================
// BUILD BOARD RECORD
// ============================================================

function buildBoardRecord(
  item,
  liveData,
  trackingRecord
) {
  const train =
    item?.train || {};

  const live =
    item?.live || {};

  const trainNo =
    String(
      train.number || ""
    ).trim();

  const trainName =
    train.name ||
    liveData?.train?.name ||
    `Train ${trainNo}`;

  const origin =
    getOrigin(
      train,
      item
    ) ||
    liveData?.train?.source?.name ||
    "Unknown";

  const destination =
    getDestination(
      train,
      item
    ) ||
    liveData?.train?.destination?.name ||
    "Unknown";

  // ----------------------------------------------------------
  // LIVE STATE TAKES PRIORITY
  // ----------------------------------------------------------

  let state =
    trackingRecord?.state ||
    STATES.APPROACHING_GUDUR;

  if (
    liveData
  ) {
    if (
      isAtGudurStation(
        liveData
      )
    ) {
      state =
        STATES.AT_GUDUR_STATION;
    } else if (
      hasDepartedGudur(
        liveData
      )
    ) {
      state =
        trackingRecord?.state ===
          STATES.AT_GATE ||
        trackingRecord?.state ===
          STATES.APPROACHING_GATE
          ? trackingRecord.state
          : STATES.DEPARTED_GUDUR;
    }
  }

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  let eta =
    trackingRecord?.etaMinutes ??
    getCorrectEta(
      item,
      liveData
    );

  // ----------------------------------------------------------
  // HARD RULE:
  // 0 ONLY AT GUDUR
  // ----------------------------------------------------------

  if (
    state ===
    STATES.AT_GUDUR_STATION
  ) {
    eta = 0;
  } else if (
    eta === 0
  ) {
    eta = null;
  }

  // ----------------------------------------------------------
  // CORRIDOR
  // ----------------------------------------------------------

  const corridor =
    trackingRecord?.corridor ||
    (
      liveData
        ? determineCorridor(
            liveData
          )?.corridor
        : null
    );

  const direction =
    trackingRecord?.direction ||
    (
      corridor === "MAS"
        ? "TOWARD CHENNAI GATE"
        : corridor === "TPTY"
          ? "TOWARD TIRUPATI GATE"
          : state ===
              STATES.AT_GUDUR_STATION
            ? "AT GUDUR"
            : "TOWARD GUDUR"
    );

  return {
    trainNo,

    name:
      trainName,

    origin,

    destination,

    etaMinutes:
      eta,

    delayMinutes:
      Number(
        live.delayMinutes ??
        liveData?.delayMinutes ??
        0
      ),

    corridor:
      corridor,

    direction,

    state,

    platform:
      String(
        live.platform ||
        "—"
      )
  };
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  try {
    const now =
      new Date();

    console.log(
      "\n=================================================="
    );

    console.log(
      `[${now.toLocaleString()}] GUDUR GATE MONITOR`
    );

    console.log(
      "=================================================="
    );

    console.log(
      `Gudur Junction : ${GUDUR_JUNCTION.lat}, ${GUDUR_JUNCTION.lng}`
    );

    console.log(
      `Chennai Gate   : ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
    );

    console.log(
      `Tirupati Gate  : ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
    );

    // ----------------------------------------------------------
    // VALIDATE API KEY
    // ----------------------------------------------------------

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY is missing."
      );
    }

    // ----------------------------------------------------------
    // STATION BOARD
    // ----------------------------------------------------------

    console.log(
      "\n[BOARD] Querying RailRadar GDR live board..."
    );

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours: 4,
            includeIntermediate: "true"
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

    const trainsArray =
      boardResponse.data?.data?.trains ||
      [];

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
      `[BOARD] RailRadar returned ${trainsArray.length} trains.`
    );

    // ----------------------------------------------------------
    // LOAD TRACKING
    // ----------------------------------------------------------

    let tracking =
      await loadTracking();

    tracking =
      cleanupTracking(
        tracking
      );

    // ----------------------------------------------------------
    // PROCESS BOARD
    // ----------------------------------------------------------

    const upcomingMap =
      new Map();

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const trainNo =
        String(
          train.number || ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train.name ||
        `Train ${trainNo}`;

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

      const eta =
        getBoardEtaMinutes(
          item
        );

      const liveType =
        normalizeText(
          item?.live?.type
        );

      // --------------------------------------------------------
      // INVALID / PASSED BOARD ENTRIES
      // --------------------------------------------------------

      if (
        liveType === "DEPARTED"
      ) {
        // Do not delete tracked records here.
        // A train can depart GDR and must continue tracking
        // toward the gate.
      }

      // --------------------------------------------------------
      // CREATE TRACKING RECORD FOR UPCOMING TRAIN
      // --------------------------------------------------------

      if (
        !tracking[trainNo] &&
        (
          eta !== null &&
          eta <=
            UPCOMING_MAX_ETA_MINUTES
        )
      ) {
        tracking[trainNo] =
          createTrackingRecord(
            trainNo,
            trainName,
            origin,
            destination,
            eta
          );
      }

      // --------------------------------------------------------
      // UPDATE BOARD ETA
      // --------------------------------------------------------

      if (
        tracking[trainNo]
      ) {
        tracking[trainNo].name =
          trainName;

        tracking[trainNo].origin =
          origin ||
          tracking[trainNo].origin ||
          "Unknown";

        tracking[trainNo].destination =
          destination ||
          tracking[trainNo].destination ||
          "Unknown";

        if (
          eta !== null
        ) {
          tracking[trainNo].etaMinutes =
            eta;
        }
      }
    }

    // ----------------------------------------------------------
    // LIVE VERIFICATION
    // ----------------------------------------------------------

    let liveData =
      null;

    let liveTrainNo =
      null;

    const liveAllowed =
      await canRunLiveCheck();

    if (
      liveAllowed
    ) {
      const candidate =
        selectLiveCandidate(
          trainsArray,
          tracking
        );

      if (
        candidate
      ) {
        console.log(
          `\n[LIVE] Verifying ${candidate.trainNo}...`
        );

        liveTrainNo =
          candidate.trainNo;

        liveData =
          await getLiveTrain(
            candidate.trainNo
          );

        await markLiveCheck();

        if (
          liveData
        ) {
          const record =
            tracking[
              candidate.trainNo
            ];

          if (
            record
          ) {
            updateTrackingRecord(
              record,
              liveData
            );

            // --------------------------------------------------
            // If the train is actually at GDR,
            // force ETA = 0 and OPEN gates.
            // --------------------------------------------------

            if (
              isAtGudurStation(
                liveData
              )
            ) {
              record.state =
                STATES.AT_GUDUR_STATION;

              record.etaMinutes =
                0;

              record.corridor =
                null;

              record.direction =
                "AT GUDUR";

              console.log(
                `[AT GUDUR] ${candidate.trainNo} ${record.name} | ETA 0m | GATE OPEN`
              );
            } else {
              console.log(
                `[LIVE] ${candidate.trainNo} | state=${record.state} | corridor=${record.corridor || "UNKNOWN"} | distance=${record.distanceToGateKm ?? "unknown"}km`
              );
            }
          }
        }
      } else {
        console.log(
          "\n[LIVE] No candidate requiring live verification."
        );
      }
    } else {
      console.log(
        "\n[LIVE] Throttled to protect RailRadar monthly quota."
      );
    }

    // ==========================================================
    // BUILD GATE STATUS
    // ==========================================================

    let chennaiGate = {
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

    let tirupatiGate = {
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
    // PROCESS TRACKING STATES
    // ----------------------------------------------------------

    for (
      const [trainNo, record]
      of Object.entries(
        tracking
      )
    ) {
      if (
        !record
      ) {
        continue;
      }

      // --------------------------------------------------------
      // AT GUDUR = ALWAYS OPEN
      // --------------------------------------------------------

      if (
        record.state ===
        STATES.AT_GUDUR_STATION
      ) {
        record.etaMinutes =
          0;

        continue;
      }

      // --------------------------------------------------------
      // ONLY AT_GATE CAN CLOSE
      // --------------------------------------------------------

      if (
        record.state !==
        STATES.AT_GATE
      ) {
        continue;
      }

      if (
        record.corridor ===
        "MAS"
      ) {
        chennaiGate = {
          status:
            "CLOSED",

          waitMinutes:
            5,

          activeTrain:
            `${trainNo} ${record.name}`,

          direction:
            "TOWARD CHENNAI GATE",

          corridor:
            "MAS"
        };
      }

      if (
        record.corridor ===
        "TPTY"
      ) {
        tirupatiGate = {
          status:
            "CLOSED",

          waitMinutes:
            5,

          activeTrain:
            `${trainNo} ${record.name}`,

          direction:
            "TOWARD TIRUPATI GATE",

          corridor:
            "TPTY"
        };
      }
    }

    // ==========================================================
    // UPCOMING TRAINS
    // ==========================================================

    const upcomingMapFinal =
      new Map();

    // ----------------------------------------------------------
    // BOARD TRAINS
    // ----------------------------------------------------------

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const trainNo =
        String(
          train.number || ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const record =
        tracking[trainNo];

      const boardRecord =
        buildBoardRecord(
          item,
          liveTrainNo ===
            trainNo
            ? liveData
            : null,
          record
        );

      // --------------------------------------------------------
      // DO NOT SHOW PASSED TRAINS
      // --------------------------------------------------------

      if (
        record?.state ===
        STATES.PASSED_GATE
      ) {
        continue;
      }

      // --------------------------------------------------------
      // DO NOT SHOW DEPARTED OLD BOARD ENTRY IF TRACKED
      // --------------------------------------------------------

      if (
        record &&
        record.state ===
          STATES.DEPARTED_GUDUR &&
        boardRecord.etaMinutes ===
          null
      ) {
        // Keep tracked train.
      }

      upcomingMapFinal.set(
        trainNo,
        boardRecord
      );
    }

    // ----------------------------------------------------------
    // ADD TRACKED TRAINS NOT PRESENT IN CURRENT BOARD
    // ----------------------------------------------------------

    for (
      const [trainNo, record]
      of Object.entries(
        tracking
      )
    ) {
      if (
        upcomingMapFinal.has(
          trainNo
        )
      ) {
        continue;
      }

      if (
        record.state ===
        STATES.PASSED_GATE
      ) {
        continue;
      }

      let eta =
        record.etaMinutes;

      // --------------------------------------------------------
      // CRITICAL:
      // Never display 0 unless AT_GUDUR_STATION.
      // --------------------------------------------------------

      if (
        record.state !==
          STATES.AT_GUDUR_STATION &&
        eta === 0
      ) {
        eta = null;
      }

      upcomingMapFinal.set(
        trainNo,
        {
          trainNo,

          name:
            record.name ||
            `Train ${trainNo}`,

          origin:
            record.origin ||
            "Unknown",

          destination:
            record.destination ||
            "Unknown",

          etaMinutes:
            eta,

          delayMinutes:
            0,

          corridor:
            record.corridor,

          direction:
            record.direction,

          state:
            record.state,

          platform:
            "—"
        }
      );
    }

    // ----------------------------------------------------------
    // SORT
    // ----------------------------------------------------------

    const upcoming =
      Array.from(
        upcomingMapFinal.values()
      )
        .filter(
          (train) =>
            train.state !==
            STATES.PASSED_GATE
        )
        .sort(
          (a, b) => {
            const aEta =
              a.etaMinutes ===
              null
                ? 9999
                : a.etaMinutes;

            const bEta =
              b.etaMinutes ===
              null
                ? 9999
                : b.etaMinutes;

            return (
              aEta - bEta
            );
          }
        )
        .slice(
          0,
          10
        );

    // ==========================================================
    // FIREBASE
    // ==========================================================

    const firebasePayload = {
      tirupatiGate:
        tirupatiGate,

      chennaiGate:
        chennaiGate,

      upcomingTrains:
        upcoming,

      lastUpdated:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleTimeString(
          "en-IN",
          {
            hour:
              "2-digit",

            minute:
              "2-digit",

            second:
              "2-digit"
          }
        )
    };

    await gateRef.set(
      cleanFirebaseObject(
        firebasePayload
      )
    );

    await saveTracking(
      tracking
    );

    // ==========================================================
    // LOG
    // ==========================================================

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      `Chennai Gate  : ${chennaiGate.status} (${chennaiGate.activeTrain})`
    );

    console.log(
      `Tirupati Gate : ${tirupatiGate.status} (${tirupatiGate.activeTrain})`
    );

    console.log(
      `Upcoming trains: ${upcoming.length}`
    );

    console.log(
      "\n[UPCOMING TRAINS]"
    );

    if (
      upcoming.length === 0
    ) {
      console.log(
        "None"
      );
    } else {
      upcoming.forEach(
        (
          train,
          index
        ) => {
          const eta =
            train.etaMinutes ===
            null
              ? "ETA unknown"
              : `${train.etaMinutes}m`;

          const corridor =
            train.corridor ||
            "OTHER LINE";

          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${corridor} | ETA ${eta} | ${train.origin} -> ${train.destination} | state=${train.state}`
          );
        }
      );
    }

    console.log(
      "\n[MONITOR] Run completed successfully."
    );

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
  "=================================================="
);

console.log(
  " GUDUR GATE RAILRADAR MONITOR"
);

console.log(
  "=================================================="
);

console.log(
  "Gudur Junction : 14.1451694, 79.8443472"
);

console.log(
  "Chennai Gate   : 14.1396667, 79.8441278"
);

console.log(
  "Tirupati Gate  : 14.1402028, 79.8435972"
);

console.log(
  "Tracking radius: 1.00 km"
);

console.log(
  "Gate close zone: 0.60 km"
);

console.log(
  "Gate clear zone: 0.80 km"
);

console.log(
  "ETA 0 rule     : ONLY when actually at GDR"
);

console.log(
  "Gate rule      : AT GUDUR = OPEN"
);

console.log(
  "Gate rule      : AT_GATE = CLOSED"
);

console.log(
  "Gate rule      : PASSED_GATE = OPEN"
);

console.log(
  "Live API       : quota protected"
);

console.log(
  "=================================================="
);

updateGateSystem();
