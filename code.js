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

const systemRef =
  db.ref("gudur_gate_system");

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

// Start monitoring a train once it is within this distance
// of the Gudur gate/junction area.
const TRACKING_DISTANCE_KM = 1.00;

// Physical gate closing zone.
const GATE_CLOSE_DISTANCE_KM = 0.60;

// Train must move beyond this distance from the gate
// before the gate is considered clear.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Old tracking records are removed after this time.
const TRACKING_RETENTION_MINUTES = 45;

// Maximum ETA displayed on frontend.
const UPCOMING_MAX_ETA_MINUTES = 360;

// ============================================================
// RAILRADAR QUOTA
// ============================================================
//
// GitHub Actions runs every 5 minutes.
//
// Station board:
// approximately 864 calls/month.
//
// Live train calls:
// one every 20 minutes maximum.
// approximately 72 calls/month.
//
// Total:
// approximately 936/month.
//
// Free sandbox quota is 1000/month.
//

const LIVE_CHECK_INTERVAL_MINUTES = 20;

// ============================================================
// STATES
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
// BASIC HELPERS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function toNumber(value) {
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
// CURRENT LIVE COORDINATES
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

  const code =
    normalizeText(
      location.stationCode
    );

  const name =
    normalizeText(
      location.stationName
    );

  return (
    code === "GDR" ||
    code === "GUDUR" ||
    name.includes("GUDUR")
  );
}

// ============================================================
// NEXT HALT GUDUR
// ============================================================

function isApproachingGudur(
  liveData
) {
  const next =
    liveData?.nextHalt || {};

  const code =
    normalizeText(
      next.stationCode
    );

  const name =
    normalizeText(
      next.stationName
    );

  return (
    code === "GDR" ||
    code === "GUDUR" ||
    name.includes("GUDUR")
  );
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
          stop?.stationCode ||
          stop?.code
        ) === "GDR"
    );

  if (gdr) {
    const seq =
      toNumber(
        gdr.sequence
      );

    if (seq !== null) {
      return seq;
    }
  }

  const next =
    liveData?.nextHalt || {};

  if (
    normalizeText(
      next.stationCode
    ) === "GDR"
  ) {
    const seq =
      toNumber(
        next.sequence
      );

    if (seq !== null) {
      return seq;
    }
  }

  const previous =
    liveData?.previousHalt || {};

  if (
    normalizeText(
      previous.stationCode
    ) === "GDR"
  ) {
    const seq =
      toNumber(
        previous.sequence
      );

    if (seq !== null) {
      return seq;
    }
  }

  return null;
}

// ============================================================
// DETECT DEPARTURE FROM GUDUR
// ============================================================

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

  const previousCode =
    normalizeText(
      previous.stationCode
    );

  if (
    previousCode === "GDR" &&
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

  const status =
    normalizeText(
      current.status
    );

  return (
    status === "DEPARTED" &&
    previousCode === "GDR"
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
    status.includes("RUNNING") ||
    status.includes("MOVING") ||
    status.includes("DEPARTED")
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
    `Train ${getTrainNumber(
      train,
      item
    )}`
  );
}

// ============================================================
// BOARD ETA
// ============================================================

function parseBoardTime(
  value
) {
  if (!value) {
    return null;
  }

  const text =
    String(value).trim();

  // Full ISO timestamp
  if (
    text.includes("T")
  ) {
    const date =
      new Date(text);

    if (
      !Number.isNaN(
        date.getTime()
      )
    ) {
      return date;
    }
  }

  // HH:mm
  const match =
    text.match(
      /^(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return null;
  }

  const hours =
    Number(match[1]);

  const minutes =
    Number(match[2]);

  const now =
    new Date();

  const candidate =
    new Date(now);

  candidate.setHours(
    hours,
    minutes,
    0,
    0
  );

  const diff =
    (
      candidate.getTime() -
      now.getTime()
    ) /
    60000;

  if (diff < -720) {
    candidate.setDate(
      candidate.getDate() + 1
    );
  }

  if (diff > 720) {
    candidate.setDate(
      candidate.getDate() - 1
    );
  }

  return candidate;
}

// ============================================================
// BOARD ETA MINUTES
// ============================================================

function getBoardEtaMinutes(
  item
) {
  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  // IMPORTANT:
  // Expected arrival has priority.
  // Departure is NEVER used as arrival.

  const values = [
    live.expectedArrivalTime,
    live.expectedArrival,
    item?.expectedArrivalTime,
    item?.expectedArrival,
    stop.arrival
  ];

  for (
    const value of values
  ) {
    const date =
      parseBoardTime(
        value
      );

    if (!date) {
      continue;
    }

    const diff =
      Math.round(
        (
          date.getTime() -
          Date.now()
        ) /
        60000
      );

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

  if (
    !isApproachingGudur(
      liveData
    )
  ) {
    return null;
  }

  const current =
    liveData?.currentLocation || {};

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

  const next =
    liveData?.nextHalt || {};

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
      (
        distance /
        speed
      ) * 60
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
  // ONLY physically at Gudur = 0
  if (
    isAtGudurStation(
      liveData
    )
  ) {
    return 0;
  }

  // Live GPS estimate first when available.
  const liveEta =
    getLiveEtaToGudur(
      liveData
    );

  if (
    liveEta !== null
  ) {
    return liveEta;
  }

  // Board ETA
  const boardEta =
    getBoardEtaMinutes(
      item
    );

  if (
    boardEta !== null
  ) {
    return boardEta;
  }

  // Unknown = null
  return null;
}

// ============================================================
// GATE DISTANCES
// ============================================================

function getGateDistances(
  coords
) {
  if (!coords) {
    return null;
  }

  return {
    chennai:
      distanceKm(
        coords.lat,
        coords.lng,
        CHENNAI_GATE.lat,
        CHENNAI_GATE.lng
      ),

    tirupati:
      distanceKm(
        coords.lat,
        coords.lng,
        TIRUPATI_GATE.lat,
        TIRUPATI_GATE.lng
      )
  };
}

// ============================================================
// DETERMINE BRANCH FROM POSITION
// ============================================================
//
// Position is the strongest physical evidence.
//
// We only assign a gate once the train is physically
// close enough to the two gate locations.
//

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

  const distances =
    getGateDistances(
      coords
    );

  if (!distances) {
    return null;
  }

  if (
    distances.chennai !== null &&
    distances.tirupati !== null
  ) {
    if (
      distances.chennai <=
        TRACKING_DISTANCE_KM &&
      distances.chennai <
        distances.tirupati
    ) {
      return {
        corridor: "MAS",
        gate: "CHENNAI",
        distanceKm:
          distances.chennai
      };
    }

    if (
      distances.tirupati <=
        TRACKING_DISTANCE_KM
    ) {
      return {
        corridor: "TPTY",
        gate: "TIRUPATI",
        distanceKm:
          distances.tirupati
      };
    }
  }

  return null;
}

// ============================================================
// DETERMINE BRANCH FROM BEARING
// ============================================================
//
// Bearing is useful after the train leaves Gudur.
//
// This does NOT classify a train merely from its destination.
//

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

function determineCorridor(
  liveData
) {
  const byPosition =
    determineGateFromPosition(
      liveData
    );

  if (
    byPosition
  ) {
    return byPosition;
  }

  const byBearing =
    determineGateFromBearing(
      liveData
    );

  if (
    byBearing
  ) {
    return byBearing;
  }

  return null;
}

// ============================================================
// CREATE TRACKING RECORD
// ============================================================

function createTrackingRecord(
  trainNo,
  name,
  origin,
  destination,
  eta
) {
  const now =
    Date.now();

  return {
    trainNo,

    name:
      name ||
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
      eta,

    distanceToGudurKm:
      null,

    distanceToGateKm:
      null,

    gateSeen:
      false,

    lastLiveAt:
      now,

    updatedAt:
      now
  };
}

// ============================================================
// UPDATE TRACKING FROM LIVE DATA
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
  // DISTANCE TO GUDUR
  // ----------------------------------------------------------

  if (coords) {
    const distance =
      distanceKm(
        coords.lat,
        coords.lng,
        GUDUR_JUNCTION.lat,
        GUDUR_JUNCTION.lng
      );

    if (
      distance !== null
    ) {
      record.distanceToGudurKm =
        Number(
          distance.toFixed(3)
        );
    }
  }

  // ----------------------------------------------------------
  // ACTUALLY AT GUDUR
  // ----------------------------------------------------------

  if (atGudur) {
    record.state =
      STATES.AT_GUDUR_STATION;

    record.corridor =
      null;

    record.direction =
      "AT GUDUR";

    // THIS is the only place ETA becomes 0.
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
  // IF ALREADY DEPARTED, KEEP DEPARTED STATE
  // ----------------------------------------------------------

  if (
    record.state ===
      STATES.AT_GUDUR_STATION &&
    departedGudur
  ) {
    record.state =
      STATES.DEPARTED_GUDUR;

    record.etaMinutes =
      null;

    record.direction =
      "DEPARTED GUDUR";
  }

  if (
    departedGudur &&
    record.state ===
      STATES.APPROACHING_GUDUR
  ) {
    record.state =
      STATES.DEPARTED_GUDUR;

    record.etaMinutes =
      null;

    record.direction =
      "DEPARTED GUDUR";
  }

  // ----------------------------------------------------------
  // AFTER GUDUR: DETERMINE ACTUAL BRANCH
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
          gate.distanceKm.toFixed(3)
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

        record.etaMinutes =
          null;
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

        record.gateSeen =
          true;

        record.etaMinutes =
          null;
      }
    }
  }

  // ----------------------------------------------------------
  // GATE CLEAR LOGIC
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // Only remove a train after we KNOW it actually reached
  // the gate first.
  //
  // This prevents a train merely passing through the
  // 1 km tracking zone from being deleted.
  //

  if (
    record.gateSeen &&
    record.distanceToGateKm !== null &&
    record.distanceToGateKm >=
      GATE_CLEAR_DISTANCE_KM
  ) {
    record.state =
      STATES.PASSED_GATE;
  }

  // ----------------------------------------------------------
  // APPROACHING GUDUR
  // ----------------------------------------------------------

  if (
    !departedGudur &&
    !atGudur &&
    record.state !==
      STATES.AT_GATE &&
    record.state !==
      STATES.PASSED_GATE
  ) {
    record.state =
      STATES.APPROACHING_GUDUR;
  }

  // ----------------------------------------------------------
  // NEVER SHOW ETA 0 AFTER LEAVING GUDUR
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
// FIREBASE CLEANER
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
    typeof value === "number" &&
    !Number.isFinite(value)
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
    const [trainNo, record]
    of Object.entries(
      tracking
    )
  ) {
    if (
      !record ||
      typeof record !==
        "object"
    ) {
      delete tracking[
        trainNo
      ];

      continue;
    }

    const lastLive =
      Number(
        record.lastLiveAt
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
      ) /
      60000;

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
// LIVE TRAIN API
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

            haltsOnly:
              "false",

            geometry:
              "true",

            format:
              "geojson",

            includeCoordinates:
              "true"
          },

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

    return (
      response.data?.data ||
      null
    );
  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo} | ${error.message}`
    );

    if (
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );
    }

    return null;
  }
}

// ============================================================
// LIVE API THROTTLE
// ============================================================

async function canRunLiveCheck() {
  try {
    const snapshot =
      await systemRef
        .child(
          "lastLiveCheckAt"
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

    const age =
      (
        Date.now() -
        last
      ) /
      60000;

    return (
      age >=
      LIVE_CHECK_INTERVAL_MINUTES
    );
  } catch (error) {
    console.error(
      "[LIVE THROTTLE ERROR]",
      error.message
    );

    // Fail closed to protect quota.
    return false;
  }
}

// ============================================================
// MARK LIVE CHECK
// ============================================================

async function markLiveCheck(
  trainNo
) {
  await systemRef.update({
    lastLiveCheckAt:
      Date.now(),

    lastLiveTrain:
      trainNo || null
  });
}

// ============================================================
// SELECT LIVE CANDIDATE
// ============================================================
//
// Priority:
//
// 1. Train already at/departed Gudur
// 2. Train already approaching a gate
// 3. Train with very small board ETA
// 4. Any approaching-Gudur train
//
// ONE live request only per 20-minute window.
//

function selectLiveCandidate(
  trainsArray,
  tracking
) {
  const candidates =
    [];

  // ----------------------------------------------------------
  // EXISTING TRACKING FIRST
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

    if (
      record.state ===
      STATES.PASSED_GATE
    ) {
      continue;
    }

    let priority =
      4;

    if (
      record.state ===
      STATES.AT_GATE
    ) {
      priority = 1;
    } else if (
      record.state ===
      STATES.APPROACHING_GATE
    ) {
      priority = 1;
    } else if (
      record.state ===
      STATES.DEPARTED_GUDUR
    ) {
      priority = 2;
    } else if (
      record.state ===
      STATES.AT_GUDUR_STATION
    ) {
      priority = 2;
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
    const item of trainsArray
  ) {
    const train =
      item?.train || {};

    const trainNo =
      getTrainNumber(
        train,
        item
      );

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
        priority: 3,
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
    const candidate
    of candidates
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

  return Array.from(
    unique.values()
  )
    .sort(
      (a, b) =>
        a.priority -
          b.priority ||
        (
          a.eta ??
          999999
        ) -
        (
          b.eta ??
          999999
        )
    )[0] || null;
}

// ============================================================
// BUILD UPCOMING RECORD
// ============================================================

function buildUpcomingRecord(
  item,
  trackingRecord
) {
  const train =
    item?.train || {};

  const live =
    item?.live || {};

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
    ) ||
    "Unknown";

  const destination =
    getDestination(
      train,
      item
    ) ||
    "Unknown";

  const boardEta =
    getBoardEtaMinutes(
      item
    );

  let state =
    trackingRecord?.state ||
    STATES.APPROACHING_GUDUR;

  let eta =
    trackingRecord?.etaMinutes ??
    boardEta;

  // ----------------------------------------------------------
  // HARD ETA RULE
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
  // BOARD STATUS
  // ----------------------------------------------------------

  const boardType =
    normalizeText(
      live.type
    );

  // If board says upcoming and we have no tracking
  // state, keep APPROACHING_GUDUR.
  if (
    !trackingRecord &&
    (
      boardType ===
        "UPCOMING" ||
      boardType ===
        "SCHEDULED"
    )
  ) {
    state =
      STATES.APPROACHING_GUDUR;
  }

  return {
    trainNo,

    name,

    origin,

    destination,

    etaMinutes:
      eta,

    delayMinutes:
      Number(
        live.delayMinutes ||
        0
      ),

    corridor:
      trackingRecord?.corridor ||
      null,

    direction:
      trackingRecord?.direction ||
      "TOWARD GUDUR",

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
      `[${now.toLocaleString(
        "en-IN"
      )}] GUDUR GATE MONITOR`
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
    // LOAD TRACKING
    // ----------------------------------------------------------

    let tracking =
      await loadTracking();

    tracking =
      cleanupTracking(
        tracking
      );

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

          timeout:
            12000
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
    // CREATE / UPDATE TRACKING FROM BOARD
    // ----------------------------------------------------------

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (!trainNo) {
        continue;
      }

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

      const eta =
        getBoardEtaMinutes(
          item
        );

      // --------------------------------------------------------
      // Only create tracking records when there is a useful ETA.
      // --------------------------------------------------------

      if (
        !tracking[trainNo] &&
        eta !== null &&
        eta >= 0 &&
        eta <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        tracking[trainNo] =
          createTrackingRecord(
            trainNo,
            name,
            origin,
            destination,
            eta
          );
      }

      // --------------------------------------------------------
      // UPDATE EXISTING RECORD
      // --------------------------------------------------------

      const record =
        tracking[trainNo];

      if (
        record
      ) {
        record.name =
          name ||
          record.name;

        record.origin =
          origin ||
          record.origin ||
          "Unknown";

        record.destination =
          destination ||
          record.destination ||
          "Unknown";

        // Only board-update ETA while approaching GDR.
        // Never overwrite 0 at GDR.
        if (
          record.state ===
          STATES.APPROACHING_GUDUR &&
          eta !== null &&
          eta >= 0
        ) {
          record.etaMinutes =
            eta;
        }
      }
    }

    // ----------------------------------------------------------
    // LIVE VERIFICATION
    // ----------------------------------------------------------

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

        const liveData =
          await getLiveTrain(
            candidate.trainNo
          );

        // Mark after request so a failed request
        // still protects quota.
        await markLiveCheck(
          candidate.trainNo
        );

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

            const coords =
              getCurrentCoordinates(
                liveData
              );

            const gate =
              determineCorridor(
                liveData
              );

            console.log(
              `[LIVE POSITION] ${candidate.trainNo}` +
              ` | state=${record.state}` +
              ` | corridor=${record.corridor || "UNKNOWN"}` +
              ` | GDR=${record.distanceToGudurKm ?? "unknown"}km` +
              ` | gate=${record.distanceToGateKm ?? "unknown"}km` +
              ` | speed=${liveData?.currentLocation?.speedKmh ?? "unknown"}km/h`
            );

            if (
              isAtGudurStation(
                liveData
              )
            ) {
              console.log(
                `[AT GUDUR] ${candidate.trainNo} | ETA 0m | GATES OPEN`
              );
            }

            if (
              gate
            ) {
              console.log(
                `[BRANCH] ${candidate.trainNo} -> ${gate.corridor}`
              );
            }
          }
        } else {
          console.log(
            `[LIVE] No live data for ${candidate.trainNo}`
          );
        }
      } else {
        console.log(
          "\n[LIVE] No candidate requiring verification."
        );
      }
    } else {
      console.log(
        "\n[LIVE] Throttled to protect monthly quota."
      );
    }

    // ========================================================
    // BUILD GATE STATUS
    // ========================================================

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
      // AT GUDUR = OPEN
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
      // PASSED = OPEN
      // --------------------------------------------------------

      if (
        record.state ===
        STATES.PASSED_GATE
      ) {
        continue;
      }

      // --------------------------------------------------------
      // ONLY AT_GATE CLOSES THE GATE
      // --------------------------------------------------------

      if (
        record.state !==
        STATES.AT_GATE
      ) {
        continue;
      }

      const activeTrain =
        `${trainNo} ${record.name}`;

      if (
        record.corridor ===
        "MAS"
      ) {
        chennaiGate = {
          status:
            "CLOSED",

          waitMinutes:
            5,

          activeTrain,

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

          activeTrain,

          direction:
            "TOWARD TIRUPATI GATE",

          corridor:
            "TPTY"
        };
      }
    }

    // ========================================================
    // BUILD UPCOMING LIST
    // ========================================================

    const upcomingMap =
      new Map();

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (!trainNo) {
        continue;
      }

      const record =
        tracking[trainNo];

      if (
        record?.state ===
        STATES.PASSED_GATE
      ) {
        continue;
      }

      const upcomingRecord =
        buildUpcomingRecord(
          item,
          record
        );

      upcomingMap.set(
        trainNo,
        upcomingRecord
      );
    }

    // ----------------------------------------------------------
    // ADD TRACKED TRAINS NOT IN BOARD
    // ----------------------------------------------------------

    for (
      const [trainNo, record]
      of Object.entries(
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

    // ========================================================
    // FINAL UPCOMING LIST
    // ========================================================

    const upcoming =
      Array.from(
        upcomingMap.values()
      )
        .filter(
          (train) => {
            if (
              train.state ===
              STATES.PASSED_GATE
            ) {
              return false;
            }

            if (
              train.etaMinutes ===
              null
            ) {
              return (
                train.state ===
                  STATES.AT_GUDUR_STATION ||
                train.state ===
                  STATES.DEPARTED_GUDUR ||
                train.state ===
                  STATES.APPROACHING_GATE ||
                train.state ===
                  STATES.AT_GATE
              );
            }

            return (
              train.etaMinutes >=
                0 &&
              train.etaMinutes <=
                UPCOMING_MAX_ETA_MINUTES
            );
          }
        )
        .sort(
          (a, b) => {
            const aa =
              a.etaMinutes === null
                ? 999999
                : a.etaMinutes;

            const bb =
              b.etaMinutes === null
                ? 999999
                : b.etaMinutes;

            return aa - bb;
          }
        )
        .slice(
          0,
          10
        );

    // ========================================================
    // SAVE FIREBASE
    // ========================================================

    const firebasePayload =
      cleanFirebaseObject({
        tirupatiGate,

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
      });

    await gateRef.set(
      firebasePayload
    );

    await saveTracking(
      tracking
    );

    // ========================================================
    // LOG
    // ========================================================

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

          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ` +
            `${train.corridor || "UNKNOWN"} | ` +
            `ETA ${eta} | ` +
            `${train.origin} -> ${train.destination} | ` +
            `state=${train.state}`
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

    process.exitCode = 1;
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
  "AT GUDUR       : GATES OPEN"
);

console.log(
  "AT_GATE        : GATE CLOSED"
);

console.log(
  "PASSED_GATE    : GATE OPEN"
);

console.log(
  "Live API       : 20-minute quota protection"
);

console.log(
  "=================================================="
);

updateGateSystem();
