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

// Used for tracking a train around the Gudur area.
const TRACKING_DISTANCE_KM = 1.00;

// Physical gate confirmation zone.
const GATE_CLOSE_DISTANCE_KM = 0.60;

// Distance beyond gate used to consider crossing clear.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Remove old tracking records.
const TRACKING_RETENTION_MINUTES = 45;

// Maximum ETA displayed.
const UPCOMING_MAX_ETA_MINUTES = 360;

// ============================================================
// LIVE API QUOTA
// ============================================================
//
// GitHub Actions runs every 5 minutes.
//
// Station board:
// approximately 864 requests/month.
//
// One live verification every 20 minutes:
// approximately 72 requests/month.
//
// Total:
// approximately 936 requests/month.
//
// This keeps the system below the 1000-request sandbox limit.
//

const LIVE_CHECK_INTERVAL_MINUTES = 20;

// ============================================================
// STATE MACHINE
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
// NUMBER HELPER
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
    lat1 *
    Math.PI /
    180;

  const p2 =
    lat2 *
    Math.PI /
    180;

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
    (brng + 360) %
    360
  );
}

// ============================================================
// ANGULAR DIFFERENCE
// ============================================================

function angleDifference(
  a,
  b
) {
  let d =
    Math.abs(a - b) %
    360;

  if (d > 180) {
    d = 360 - d;
  }

  return d;
}

// ============================================================
// CURRENT GPS
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
// AT GUDUR STATION
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
// DEPARTED GUDUR
// ============================================================
//
// IMPORTANT:
//
// 12734:
// current VKT sequence 94
// GDR sequence 97
//
// Therefore:
// 94 < 97
//
// It has NOT reached Gudur.
//
// A train becomes departed only after:
// current sequence > GDR sequence
// OR previous halt = GDR and current sequence is greater.
//

function hasDepartedGudur(
  liveData
) {
  if (
    isAtGudurStation(
      liveData
    )
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

  return false;
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

  return (
    speed !== null &&
    speed > 2
  );
}

// ============================================================
// ORIGIN
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
// DESTINATION
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
// TIME PARSER
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
// NEVER returns 0 because of missing data.
//
// 0 is reserved for actual GDR confirmation.
//

function getBoardEtaMinutes(
  item
) {
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
      parsed === null
    ) {
      continue;
    }

    const diff =
      calculateTimeDifference(
        parsed,
        currentMinutes()
      );

    if (
      diff === null
    ) {
      continue;
    }

    return Math.max(
      0,
      diff
    );
  }

  return null;
}

// ============================================================
// LIVE ETA TO GUDUR
// ============================================================
//
// Only used when:
// - train is not already at GDR
// - next halt is GDR
// - actual GPS/speed are available
//
// This NEVER creates ETA 0.
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
      distance /
        speed *
        60
    )
  );
}

// ============================================================
// CORRECT ETA
// ============================================================

function getCorrectEta(
  item,
  liveData
) {
  // ----------------------------------------------------------
  // AT GUDUR = EXACTLY 0
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      liveData
    )
  ) {
    return 0;
  }

  // ----------------------------------------------------------
  // BOARD ETA
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
  // LIVE GPS ETA
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
  // UNKNOWN
  // ----------------------------------------------------------

  return null;
}

// ============================================================
// GATE POSITION
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
// GATE BEARING
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
// DETERMINE GATE
// ============================================================
//
// We NEVER use destination alone.
//
// The train must have departed GDR first.
//

function determineGate(
  liveData
) {
  if (
    !hasDepartedGudur(
      liveData
    )
  ) {
    return null;
  }

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
// CREATE TRACKING RECORD
// ============================================================

function createTrackingRecord(
  trainNo,
  trainName,
  origin,
  destination,
  etaMinutes
) {
  const now =
    Date.now();

  return {
    trainNo,

    name:
      trainName ||
      `Train ${trainNo}`,

    origin:
      origin ||
      "Unknown",

    destination:
      destination ||
      "Unknown",

    state:
      STATES.APPROACHING_GUDUR,

    corridor:
      null,

    direction:
      "TOWARD GUDUR",

    etaMinutes:
      etaMinutes,

    distanceToGudurKm:
      null,

    distanceToGateKm:
      null,

    lastLiveAt:
      now,

    updatedAt:
      now
  };
}

// ============================================================
// UPDATE TRACKING RECORD
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
    const d =
      distanceKm(
        coords.lat,
        coords.lng,
        GUDUR_JUNCTION.lat,
        GUDUR_JUNCTION.lng
      );

    if (d !== null) {
      record.distanceToGudurKm =
        Number(
          d.toFixed(3)
        );
    }
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
  // IF NOT YET DEPARTED
  // ----------------------------------------------------------

  if (
    !departedGudur &&
    record.state !==
      STATES.DEPARTED_GUDUR &&
    record.state !==
      STATES.APPROACHING_GATE &&
    record.state !==
      STATES.AT_GATE
  ) {
    record.state =
      STATES.APPROACHING_GUDUR;

    record.direction =
      "TOWARD GUDUR";

    // NEVER allow 0 here.
    if (
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
    // DETERMINE BRANCH
    // --------------------------------------------------------

    const gate =
      determineGate(
        liveData
      );

    if (gate) {
      record.corridor =
        gate.corridor;

      record.direction =
        gate.corridor === "MAS"
          ? "TOWARD CHENNAI GATE"
          : "TOWARD TIRUPATI GATE";

      let gateDistance =
        gate.distanceKm;

      if (
        gateDistance ===
        undefined &&
        coords
      ) {
        gateDistance =
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
              );
      }

      if (
        gateDistance !==
          null &&
        gateDistance !==
          undefined
      ) {
        record.distanceToGateKm =
          Number(
            gateDistance.toFixed(3)
          );
      }

      // ------------------------------------------------------
      // APPROACHING GATE
      // ------------------------------------------------------

      if (
        record.distanceToGateKm !==
          null &&
        record.distanceToGateKm >
          GATE_CLOSE_DISTANCE_KM &&
        record.distanceToGateKm <=
          TRACKING_DISTANCE_KM
      ) {
        record.state =
          STATES.APPROACHING_GATE;
      }

      // ------------------------------------------------------
      // AT GATE
      // ------------------------------------------------------

      if (
        record.distanceToGateKm !==
          null &&
        record.distanceToGateKm <=
          GATE_CLOSE_DISTANCE_KM
      ) {
        record.state =
          STATES.AT_GATE;
      }

      // ------------------------------------------------------
      // PASSED GATE
      // ------------------------------------------------------
      //
      // Only allow this after the train was previously AT_GATE.
      //

      if (
        record.state ===
          STATES.AT_GATE &&
        record.distanceToGateKm !==
          null &&
        record.distanceToGateKm >=
          GATE_CLEAR_DISTANCE_KM
      ) {
        record.state =
          STATES.PASSED_GATE;
      }
    } else {
      // ------------------------------------------------------
      // We know it left GDR,
      // but don't know which branch yet.
      // ------------------------------------------------------

      if (
        record.state !==
          STATES.AT_GATE &&
        record.state !==
          STATES.APPROACHING_GATE
      ) {
        record.state =
          STATES.DEPARTED_GUDUR;
      }

      record.direction =
        "DEPARTED GUDUR";
    }
  }

  // ----------------------------------------------------------
  // NEVER SHOW 0 AFTER GUDUR
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
// CLEAN FIREBASE DATA
// ============================================================

function cleanFirebaseObject(
  value
) {
  if (
    value === undefined ||
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
      const [key, val] of
      Object.entries(value)
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
// LOAD TRACKING
// ============================================================

async function loadTracking() {
  try {
    const snapshot =
      await trackingRef.get();

    const data =
      snapshot.val();

    if (
      !data ||
      typeof data !==
        "object"
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
// CLEAN TRACKING
// ============================================================

function cleanupTracking(
  tracking
) {
  const now =
    Date.now();

  for (
    const [trainNo, record] of
    Object.entries(tracking)
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

      delete tracking[
        trainNo
      ];

      continue;
    }

    const ageMinutes =
      (
        now -
        lastLive
      ) / 60000;

    if (
      ageMinutes >
      TRACKING_RETENTION_MINUTES
    ) {
      console.log(
        `[TRACKING REMOVE] ${trainNo} | ${Math.round(ageMinutes)}m old`
      );

      delete tracking[
        trainNo
      ];

      continue;
    }

    if (
      record.state ===
      STATES.PASSED_GATE
    ) {
      console.log(
        `[TRACKING REMOVE] ${trainNo} | passed gate`
      );

      delete tracking[
        trainNo
      ];
    }
  }

  return tracking;
}

// ============================================================
// SAVE TRACKING
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
      `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
        trainNo
      )}/live`;

    const response =
      await axios.get(
        url,
        {
          params: {
            authoritative:
              "true",

            includeCoordinates:
              "true",

            geometry:
              "true",

            format:
              "geojson"
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
    ) / 60000;

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
// 1. AT_GUDUR / DEPARTED / gate tracking
// 2. Train with ETA <= 20 minutes
//
// One live request per 20-minute quota window.
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
    const [trainNo, record] of
    Object.entries(tracking)
  ) {
    if (
      !record ||
      record.state ===
        STATES.PASSED_GATE
    ) {
      continue;
    }

    let priority = 2;

    if (
      record.state ===
        STATES.AT_GUDUR_STATION ||
      record.state ===
        STATES.DEPARTED_GUDUR ||
      record.state ===
        STATES.APPROACHING_GATE ||
      record.state ===
        STATES.AT_GATE
    ) {
      priority = 1;
    }

    candidates.push({
      trainNo,
      priority,
      eta:
        record.etaMinutes
    });
  }

  // ----------------------------------------------------------
  // BOARD TRAINS
  // ----------------------------------------------------------

  for (
    const item of
    trainsArray
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
  // UNIQUE
  // ----------------------------------------------------------

  const unique =
    new Map();

  for (
    const candidate of
    candidates
  ) {
    const existing =
      unique.get(
        candidate.trainNo
      );

    if (
      !existing ||
      candidate.priority <
        existing.priority
    ) {
      unique.set(
        candidate.trainNo,
        candidate
      );
    }
  }

  return (
    Array.from(
      unique.values()
    )
      .sort(
        (a, b) =>
          a.priority -
            b.priority ||
          (a.eta ?? 9999) -
            (b.eta ?? 9999)
      )[0] ||
    null
  );
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
    liveData?.train?.source
      ?.name ||
    "Unknown";

  const destination =
    getDestination(
      train,
      item
    ) ||
    liveData?.train
      ?.destination?.name ||
    "Unknown";

  // ----------------------------------------------------------
  // STATE
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
      if (
        trackingRecord?.state ===
          STATES.AT_GATE ||
        trackingRecord?.state ===
          STATES.APPROACHING_GATE
      ) {
        state =
          trackingRecord.state;
      } else {
        state =
          STATES.DEPARTED_GUDUR;
      }
    }
  }

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  let eta =
    getCorrectEta(
      item,
      liveData
    );

  // Existing tracking ETA can be used only when it is valid.
  if (
    trackingRecord &&
    Number.isFinite(
      Number(
        trackingRecord.etaMinutes
      )
    ) &&
    trackingRecord.state !==
      STATES.AT_GUDUR_STATION
  ) {
    eta =
      Number(
        trackingRecord.etaMinutes
      );
  }

  // ----------------------------------------------------------
  // HARD 0 RULE
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
        ? determineGate(
            liveData
          )?.corridor ||
          null
        : null
    );

  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  let direction =
    trackingRecord?.direction;

  if (!direction) {
    if (
      state ===
      STATES.AT_GUDUR_STATION
    ) {
      direction =
        "AT GUDUR";
    } else if (
      corridor === "MAS"
    ) {
      direction =
        "TOWARD CHENNAI GATE";
    } else if (
      corridor === "TPTY"
    ) {
      direction =
        "TOWARD TIRUPATI GATE";
    } else if (
      state ===
      STATES.DEPARTED_GUDUR
    ) {
      direction =
        "DEPARTED GUDUR";
    } else {
      direction =
        "TOWARD GUDUR";
    }
  }

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

    direction:
      direction,

    state:
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
    // API KEY
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
            includeIntermediate:
              "true"
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
      boardResponse.data?.data
        ?.trains || [];

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

    for (
      const item of
      trainsArray
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

      // --------------------------------------------------------
      // CREATE TRACKING RECORD
      // --------------------------------------------------------

      if (
        !tracking[trainNo] &&
        eta !== null &&
        eta <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        tracking[trainNo] =
          createTrackingRecord(
            trainNo,
            trainName,
            origin,
            destination,
            eta
          );

        console.log(
          `[TRACKING ADD] ${trainNo} ${trainName} | ETA ${eta}m`
        );
      }

      // --------------------------------------------------------
      // UPDATE BASIC INFO
      // --------------------------------------------------------

      const record =
        tracking[trainNo];

      if (!record) {
        continue;
      }

      record.name =
        trainName;

      if (origin) {
        record.origin =
          origin;
      }

      if (destination) {
        record.destination =
          destination;
      }

      // --------------------------------------------------------
      // IMPORTANT:
      // Don't overwrite 0 AT GUDUR with board data.
      // Don't turn missing ETA into 0.
      // --------------------------------------------------------

      if (
        eta !== null &&
        record.state !==
          STATES.AT_GUDUR_STATION
      ) {
        record.etaMinutes =
          eta;
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

            const location =
              liveData.currentLocation ||
              {};

            const coords =
              getCurrentCoordinates(
                liveData
              );

            console.log(
              `[LIVE RESULT] ${candidate.trainNo} | station=${location.stationCode || "unknown"} | status=${location.status || "unknown"} | seq=${location.sequence ?? "unknown"} | GPS=${coords ? `${coords.lat},${coords.lng}` : "none"} | state=${record.state}`
            );

            if (
              record.state ===
              STATES.AT_GUDUR_STATION
            ) {
              console.log(
                `[AT GUDUR] ${candidate.trainNo} | ETA 0m | GATE OPEN`
              );
            }

            if (
              record.state ===
              STATES.AT_GATE
            ) {
              console.log(
                `[AT GATE] ${candidate.trainNo} | ${record.corridor} | ${record.distanceToGateKm}km`
              );
            }
          }
        } else {
          console.log(
            `[LIVE] No usable live response for ${candidate.trainNo}.`
          );
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
    // GATE STATUS
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
    // PROCESS TRACKING
    // ----------------------------------------------------------

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (!record) {
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
      // ONLY AT_GATE CLOSES
      // --------------------------------------------------------

      if (
        record.state !==
        STATES.AT_GATE
      ) {
        continue;
      }

      // --------------------------------------------------------
      // CHENNAI GATE
      // --------------------------------------------------------

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

        console.log(
          `[GATE CLOSED] CHENNAI | ${trainNo} ${record.name}`
        );
      }

      // --------------------------------------------------------
      // TIRUPATI GATE
      // --------------------------------------------------------

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

        console.log(
          `[GATE CLOSED] TIRUPATI | ${trainNo} ${record.name}`
        );
      }
    }

    // ==========================================================
    // UPCOMING TRAINS
    // ==========================================================

    const upcomingMap =
      new Map();

    // ----------------------------------------------------------
    // CURRENT BOARD TRAINS
    // ----------------------------------------------------------

    for (
      const item of
      trainsArray
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

      if (
        record?.state ===
        STATES.PASSED_GATE
      ) {
        continue;
      }

      // --------------------------------------------------------
      // DO NOT SHOW INVALID ZERO
      // --------------------------------------------------------

      if (
        boardRecord.state !==
          STATES.AT_GUDUR_STATION &&
        boardRecord.etaMinutes ===
          0
      ) {
        boardRecord.etaMinutes =
          null;
      }

      upcomingMap.set(
        trainNo,
        boardRecord
      );
    }

    // ----------------------------------------------------------
    // ADD TRACKED TRAINS NOT ON BOARD
    // ----------------------------------------------------------

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        upcomingMap.has(
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

      if (
        record.state !==
          STATES.AT_GUDUR_STATION &&
        eta === 0
      ) {
        eta = null;
      }

      upcomingMap.set(
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

    // ==========================================================
    // SORT UPCOMING
    // ==========================================================

    const upcoming =
      Array.from(
        upcomingMap.values()
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
                : Number(
                    a.etaMinutes
                  );

            const bEta =
              b.etaMinutes ===
              null
                ? 9999
                : Number(
                    b.etaMinutes
                  );

            return (
              aEta -
              bEta
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
      upcoming.length ===
      0
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
  "Gudur station  : ALWAYS OPEN"
);

console.log(
  "Departed GDR   : TRACKING"
);

console.log(
  "At gate        : CLOSED"
);

console.log(
  "Passed gate    : OPEN + REMOVE"
);

console.log(
  "Live API       : quota protected"
);

console.log(
  "=================================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem();
