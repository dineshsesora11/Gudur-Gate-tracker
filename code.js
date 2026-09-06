const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// GUDUR CROSSING RADAR
// COMPLETE BACKEND
// ============================================================
//
// IMPORTANT:
//
// 1. Station board = source for UPCOMING GUDUR trains.
// 2. Never reuse an old Firebase ETA.
// 3. Never use old tracking ETA as current ETA.
// 4. ETA is recalculated on every monitor run.
// 5. If RailRadar does not provide a trustworthy ETA,
//    display "--" instead of inventing a number.
// 6. AT GUDUR = ETA 0m.
// 7. After leaving GUDUR = continue tracking.
// 8. Gate closes only when actual live position reaches
//    the gate closing zone.
// 9. Passed gate = remove tracking record.
// 10. GitHub Actions runs every 5 minutes.
// 11. Only one full live-train API call is allowed every
//     20 minutes to protect the monthly quota.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";


// ------------------------------------------------------------
// Firebase service account
// ------------------------------------------------------------

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
    "Set FIREBASE_SERVICE_ACCOUNT in GitHub Secrets."
  );

  console.error(error.message);

  process.exit(1);
}


// ------------------------------------------------------------
// Firebase initialization
// ------------------------------------------------------------

if (!admin.apps.length) {
  admin.initializeApp({
    credential: cert(serviceAccount),
    databaseURL: FIREBASE_DATABASE_URL
  });
}

const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");

const trackingRef =
  db.ref("gudur_gates/tracking");

const metaRef =
  db.ref("gudur_gates/meta");


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
// GUDUR GEOMETRY
// ============================================================

// Gudur Junction
const GUDUR_LAT = 14.1451694;
const GUDUR_LNG = 79.8443472;


// Tirupati Gate
const TPTY_GATE_LAT = 14.1402028;
const TPTY_GATE_LNG = 79.8435972;


// Chennai Gate
const MAS_GATE_LAT = 14.1396667;
const MAS_GATE_LNG = 79.8441278;


// ============================================================
// DISTANCE SETTINGS
// ============================================================

// Start monitoring a train once it is within 1 km
// of Gudur station/gate area.
const TRACKING_DISTANCE_KM = 1.00;


// Physical distance between Gudur Junction and gates.
const GATE_DISTANCE_KM = 0.52;


// Close the gate when the actual live position
// enters this zone around the gate.
const GATE_CLOSE_DISTANCE_KM = 0.60;


// Consider the train clear after it has moved
// beyond this distance from the gate.
const GATE_CLEAR_DISTANCE_KM = 0.80;


// Remove stale tracking records after this period.
const TRACKING_RETENTION_MINUTES = 45;


// Maximum number of trains shown in frontend.
const UPCOMING_MAX_TRAINS = 10;


// Maximum station-board horizon.
const UPCOMING_MAX_ETA_MINUTES = 360;


// Full live-train API throttle.
//
// One live call every 20 minutes.
//
// Approximately:
// 864 station-board calls/month
// + ~72 live calls/month
// = ~936 requests/month.
const LIVE_CHECK_INTERVAL_MINUTES = 20;


// ============================================================
// TRAIN NUMBER ROUTE OVERRIDES
// ============================================================
//
// These are ONLY used to improve corridor labels.
//
// They do NOT by themselves close a gate.
//
// Actual gate closure still requires live coordinates
// near the physical gate.
//
// ============================================================


// ------------------------------------------------------------
// TPTY / RENIGUNTA / KATPADi / BENGALURU SIDE
// ------------------------------------------------------------

const TPTY_CORRIDOR_TRAINS =
  new Set([
    "03251",
    "04717",
    "05074",
    "06510",
    "12762",
    "12763",
    "12764",
    "12765",
    "12766",
    "12793",
    "12794",
    "12845",
    "12846",
    "17261",
    "17262",
    "17479",
    "17480",
    "17487",
    "17488"
  ]);


// ------------------------------------------------------------
// MAS / CHENNAI SIDE
// ------------------------------------------------------------

const MAS_CORRIDOR_TRAINS =
  new Set([
    "12077",
    "12078",
    "12295",
    "12296",
    "12621",
    "12622",
    "12625",
    "12626",
    "12759",
    "12760",
    "12839",
    "12840",
    "16031",
    "16032",
    "17643",
    "17644"
  ]);


// ============================================================
// GENERAL HELPERS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}


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


function firstDefined(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}


function safeNumber(value) {
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
  const aLat = Number(lat1);
  const aLng = Number(lng1);
  const bLat = Number(lat2);
  const bLng = Number(lng2);

  if (
    !Number.isFinite(aLat) ||
    !Number.isFinite(aLng) ||
    !Number.isFinite(bLat) ||
    !Number.isFinite(bLng)
  ) {
    return null;
  }

  const earthRadiusKm = 6371;

  const dLat =
    (
      (bLat - aLat) *
      Math.PI
    ) / 180;

  const dLng =
    (
      (bLng - aLng) *
      Math.PI
    ) / 180;

  const lat1Rad =
    aLat * Math.PI / 180;

  const lat2Rad =
    bLat * Math.PI / 180;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) *
    Math.cos(lat2Rad) *
    Math.sin(dLng / 2) ** 2;

  return (
    2 *
    earthRadiusKm *
    Math.asin(
      Math.sqrt(h)
    )
  );
}


// ============================================================
// TRAIN INFORMATION
// ============================================================

function getTrainObject(item) {
  return item?.train || {};
}


function getLiveObject(item) {
  return item?.live || {};
}


function getStopObject(item) {
  return item?.stop || {};
}


function getTrainNumber(item) {
  const train =
    getTrainObject(item);

  return String(
    firstDefined(
      train.number,
      item.trainNumber,
      item.number
    ) || ""
  ).trim();
}


function getTrainName(item) {
  const train =
    getTrainObject(item);

  return (
    firstDefined(
      train.name,
      item.trainName,
      item.name
    ) ||
    `Train ${getTrainNumber(item)}`
  );
}


// ============================================================
// ORIGIN / DESTINATION
// ============================================================

function getOriginObject(item) {
  const train =
    getTrainObject(item);

  return firstDefined(
    train.source,
    train.origin,
    item.source,
    item.origin,
    item.from,
    item.fromStation
  );
}


function getDestinationObject(item) {
  const train =
    getTrainObject(item);

  return firstDefined(
    train.destination,
    train.to,
    item.destination,
    item.to,
    item.destinationStation
  );
}


function objectText(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return [
    value.code,
    value.name,
    value.stationCode,
    value.stationName
  ]
    .filter(Boolean)
    .join(" ");
}


function getOriginText(item) {
  return objectText(
    getOriginObject(item)
  );
}


function getDestinationText(item) {
  return objectText(
    getDestinationObject(item)
  );
}


// ============================================================
// CORRIDOR CLASSIFICATION
// ============================================================
//
// MAS:
//
// Chennai / Tambaram / Sullurupeta direction.
//
// TPTY:
//
// Tirupati / Renigunta / Katpadi direction.
//
// IMPORTANT:
//
// A train can have Bengaluru as destination and still
// use the TPTY-side route through GDR -> RU -> KPD.
//
// Therefore known train-number overrides are included.
//
// ============================================================

function determineCorridor(item) {
  const trainNo =
    getTrainNumber(item);

  const origin =
    normalizeText(
      getOriginText(item)
    );

  const destination =
    normalizeText(
      getDestinationText(item)
    );

  // ----------------------------------------------------------
  // Explicit known train route overrides
  // ----------------------------------------------------------

  if (
    TPTY_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  if (
    MAS_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "MAS";
  }


  // ----------------------------------------------------------
  // Destination-based classification
  // ----------------------------------------------------------

  if (
    containsAny(
      destination,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU",
        "KATPAD",
        "KPD"
      ]
    )
  ) {
    return "TPTY";
  }


  if (
    containsAny(
      destination,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "CHENNAI CENTRAL",
        "CHENNAI EGMORE",
        "TAMBARAM",
        "TBM"
      ]
    )
  ) {
    return "MAS";
  }


  // ----------------------------------------------------------
  // Origin / destination route clues
  // ----------------------------------------------------------

  if (
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU",
        "KATPAD",
        "KPD"
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
        "MAS",
        "TAMBARAM",
        "TBM",
        "SULLURUPETA",
        "SPE",
        "NAYUDUPETA",
        "NYP"
      ]
    )
  ) {
    return "MAS";
  }


  return "OTHER";
}


// ============================================================
// LIVE COORDINATES
// ============================================================

function getCoordinatesFromObject(obj) {
  if (!obj) {
    return null;
  }

  const coordinates =
    obj.coordinates ||
    obj.location ||
    obj.currentLocation?.coordinates ||
    null;

  if (
    coordinates &&
    Number.isFinite(
      Number(coordinates.lat)
    ) &&
    Number.isFinite(
      Number(coordinates.lng)
    )
  ) {
    return {
      lat: Number(coordinates.lat),
      lng: Number(coordinates.lng)
    };
  }

  if (
    Number.isFinite(
      Number(obj.lat)
    ) &&
    Number.isFinite(
      Number(obj.lng)
    )
  ) {
    return {
      lat: Number(obj.lat),
      lng: Number(obj.lng)
    };
  }

  if (
    Number.isFinite(
      Number(obj.latitude)
    ) &&
    Number.isFinite(
      Number(obj.longitude)
    )
  ) {
    return {
      lat: Number(obj.latitude),
      lng: Number(obj.longitude)
    };
  }

  return null;
}


function getLiveCoordinates(live) {
  return getCoordinatesFromObject(
    live?.currentLocation ||
    live
  );
}


// ============================================================
// GUDUR DETECTION
// ============================================================

function isAtGudurStation(live) {
  if (!live) {
    return false;
  }

  const current =
    live.currentLocation ||
    live;

  const stationCode =
    normalizeText(
      current.stationCode ||
      current.code
    );

  const stationName =
    normalizeText(
      current.stationName ||
      current.name
    );

  const status =
    normalizeText(
      current.status
    );

  return (
    stationCode === "GDR" ||
    stationName.includes(
      "GUDUR"
    )
  ) &&
  (
    status.includes(
      "AT STATION"
    ) ||
    status.includes(
      "ATSTATION"
    ) ||
    current.isHalt === true ||
    current.isActualPosition === true
  );
}


// ============================================================
// DEPARTURE FROM GUDUR
// ============================================================

function hasDepartedGudur(live) {
  if (!live) {
    return false;
  }

  const current =
    live.currentLocation ||
    {};

  const currentSeq =
    safeNumber(
      current.sequence
    );

  const previousHalt =
    live.previousHalt ||
    {};

  const previousCode =
    normalizeText(
      previousHalt.stationCode ||
      previousHalt.code
    );

  const previousSeq =
    safeNumber(
      previousHalt.sequence
    );

  // Strongest sequence evidence.
  if (
    previousCode === "GDR" &&
    currentSeq !== null &&
    previousSeq !== null &&
    currentSeq > previousSeq
  ) {
    return true;
  }


  // Explicit live status.
  const status =
    normalizeText(
      current.status ||
      live.status
    );

  if (
    status.includes("DEPARTED")
  ) {
    return true;
  }


  // If next halt is after GDR and current
  // station is clearly beyond GDR.
  const nextHalt =
    live.nextHalt ||
    {};

  const nextCode =
    normalizeText(
      nextHalt.stationCode ||
      nextHalt.code
    );

  if (
    previousCode === "GDR" &&
    nextCode !== "GDR"
  ) {
    return true;
  }


  return false;
}


// ============================================================
// LIVE ETA
// ============================================================
//
// IMPORTANT:
//
// We do NOT use stop.arrival.
//
// stop.arrival is normally timetable/scheduled data.
//
// We only use fields explicitly representing expected/live
// arrival.
//
// ============================================================

function parseDateTime(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    !Number.isNaN(
      date.getTime()
    )
  ) {
    return date;
  }

  return null;
}


function minutesUntil(value, now) {
  const date =
    parseDateTime(value);

  if (!date) {
    return null;
  }

  const diff =
    (
      date.getTime() -
      now.getTime()
    ) / 60000;

  if (
    !Number.isFinite(diff)
  ) {
    return null;
  }

  return Math.round(
    diff
  );
}


// ============================================================
// BOARD ETA
// ============================================================

function getBoardEtaMinutes(
  item,
  now
) {
  const live =
    getLiveObject(item);

  const current =
    live.currentLocation ||
    {};

  // ----------------------------------------------------------
  // At Gudur = exactly 0
  // ----------------------------------------------------------

  if (
    isAtGudurStation(live)
  ) {
    return {
      etaMinutes: 0,
      source: "AT_GUDUR"
    };
  }


  // ----------------------------------------------------------
  // Live expected arrival
  // ----------------------------------------------------------

  const liveExpected =
    firstDefined(
      live.expectedArrivalTime,
      live.expectedArrival,
      live.estimatedArrivalTime,
      live.etaTime,
      current.expectedArrivalTime,
      live.nextHalt?.expectedArrivalTime,
      live.nextHalt?.expectedArrival
    );

  if (liveExpected) {
    const eta =
      minutesUntil(
        liveExpected,
        now
      );

    if (
      eta !== null &&
      eta >= 0 &&
      eta <= UPCOMING_MAX_ETA_MINUTES
    ) {
      return {
        etaMinutes: eta,
        source: "LIVE_EXPECTED"
      };
    }
  }


  // ----------------------------------------------------------
  // Board-level EXPECTED arrival
  //
  // We allow fields explicitly named expectedArrival.
  //
  // We DO NOT use:
  //
  // stop.arrival
  // stop.departure
  // scheduledArrival
  //
  // ----------------------------------------------------------

  const boardExpected =
    firstDefined(
      item.expectedArrivalTime,
      item.expectedArrival,
      item.estimatedArrivalTime
    );

  if (boardExpected) {
    const eta =
      minutesUntil(
        boardExpected,
        now
      );

    if (
      eta !== null &&
      eta >= 0 &&
      eta <= UPCOMING_MAX_ETA_MINUTES
    ) {
      return {
        etaMinutes: eta,
        source: "BOARD_EXPECTED"
      };
    }
  }


  // ----------------------------------------------------------
  // Some RailRadar responses expose ETA directly.
  // ----------------------------------------------------------

  const directEta =
    firstDefined(
      live.etaMinutes,
      live.eta,
      item.etaMinutes,
      item.eta
    );

  const numericEta =
    safeNumber(
      directEta
    );

  if (
    numericEta !== null &&
    numericEta >= 0 &&
    numericEta <= UPCOMING_MAX_ETA_MINUTES
  ) {
    return {
      etaMinutes:
        Math.round(
          numericEta
        ),
      source: "LIVE_ETA"
    };
  }


  // ----------------------------------------------------------
  // No trustworthy ETA.
  // ----------------------------------------------------------

  return {
    etaMinutes: null,
    source: "UNKNOWN"
  };
}


// ============================================================
// PLATFORM
// ============================================================

function getPlatform(item) {
  const train =
    getTrainObject(item);

  const live =
    getLiveObject(item);

  const stop =
    getStopObject(item);

  return String(
    firstDefined(
      live.platform,
      stop.platform,
      item.platform,
      train.platform,
      "—"
    )
  );
}


// ============================================================
// DELAY
// ============================================================

function getDelayMinutes(item) {
  const train =
    getTrainObject(item);

  const live =
    getLiveObject(item);

  return (
    safeNumber(
      firstDefined(
        live.delayMinutes,
        item.delayMinutes,
        train.delayMinutes
      )
    ) || 0
  );
}


// ============================================================
// BOARD STATUS
// ============================================================

function getBoardStatus(item) {
  const live =
    getLiveObject(item);

  const current =
    live.currentLocation ||
    {};

  return normalizeText(
    firstDefined(
      live.status,
      current.status,
      item.status
    )
  );
}


// ============================================================
// IS BOARD ENTRY RELEVANT?
// ============================================================
//
// Since this request comes from:
//
// /stations/GDR/live
//
// the returned records are GDR station-board records.
//
// We should NOT require a full live nextHalt object.
//
// That was the reason the previous version eventually
// displayed "No upcoming trains".
//
// ============================================================

function isUsefulBoardEntry(item) {
  const status =
    getBoardStatus(item);

  if (
    status.includes("DEPARTED")
  ) {
    return false;
  }

  if (
    status.includes("CANCEL")
  ) {
    return false;
  }

  return true;
}


// ============================================================
// TRACKING RECORD HELPERS
// ============================================================

function recordAgeMinutes(record, now) {
  if (!record) {
    return Infinity;
  }

  const raw =
    firstDefined(
      record.updatedAtMs,
      record.updatedAt,
      record.timestamp
    );

  if (!raw) {
    return Infinity;
  }

  let timestamp =
    safeNumber(raw);

  if (
    timestamp === null
  ) {
    const parsed =
      Date.parse(
        String(raw)
      );

    if (
      Number.isNaN(parsed)
    ) {
      return Infinity;
    }

    timestamp = parsed;
  }

  // Handle seconds timestamps.
  if (
    timestamp < 100000000000
  ) {
    timestamp *= 1000;
  }

  return (
    now.getTime() -
    timestamp
  ) / 60000;
}


function isRecentRecord(record, now) {
  return (
    recordAgeMinutes(
      record,
      now
    ) <=
    TRACKING_RETENTION_MINUTES
  );
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
    "AT_GATE"
};


// ============================================================
// LIVE POSITION DISTANCE
// ============================================================

function getGateDistance(
  corridor,
  coords
) {
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


function getGudurDistance(coords) {
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


// ============================================================
// STATE TRANSITION FROM LIVE DATA
// ============================================================

function calculateLiveState(
  corridor,
  live,
  previousRecord
) {
  const atGudur =
    isAtGudurStation(
      live
    );

  const departed =
    hasDepartedGudur(
      live
    );

  const coords =
    getLiveCoordinates(
      live
    );

  const gateDistance =
    getGateDistance(
      corridor,
      coords
    );


  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  if (atGudur) {
    return {
      state:
        STATES.AT_GUDUR_STATION,

      gateDistanceKm:
        gateDistance,

      gudurDistanceKm:
        0
    };
  }


  // ----------------------------------------------------------
  // AFTER GUDUR
  // ----------------------------------------------------------

  if (
    departed
  ) {

    if (
      gateDistance !== null
    ) {

      // Already inside closing zone.
      if (
        gateDistance <=
        GATE_CLOSE_DISTANCE_KM
      ) {
        return {
          state:
            STATES.AT_GATE,

          gateDistanceKm:
            gateDistance,

          gudurDistanceKm:
            getGudurDistance(
              coords
            )
        };
      }


      // Approaching physical gate.
      return {
        state:
          STATES.APPROACHING_GATE,

        gateDistanceKm:
          gateDistance,

        gudurDistanceKm:
          getGudurDistance(
            coords
          )
      };
    }


    // Departed but no coordinates.
    return {
      state:
        STATES.DEPARTED_GUDUR,

      gateDistanceKm:
        null,

      gudurDistanceKm:
        null
    };
  }


  // ----------------------------------------------------------
  // Preserve existing gate state if live data
  // is temporarily incomplete.
  // ----------------------------------------------------------

  if (
    previousRecord &&
    (
      previousRecord.state ===
        STATES.AT_GATE ||
      previousRecord.state ===
        STATES.APPROACHING_GATE ||
      previousRecord.state ===
        STATES.DEPARTED_GUDUR
    )
  ) {
    return {
      state:
        previousRecord.state,

      gateDistanceKm:
        previousRecord.gateDistanceKm ??
        null,

      gudurDistanceKm:
        previousRecord.gudurDistanceKm ??
        null
    };
  }


  // ----------------------------------------------------------
  // Still approaching Gudur.
  // ----------------------------------------------------------

  return {
    state:
      STATES.APPROACHING_GUDUR,

    gateDistanceKm:
      null,

    gudurDistanceKm:
      getGudurDistance(
        coords
      )
  };
}


// ============================================================
// LIVE API
// ============================================================

async function fetchLiveTrain(trainNumber) {
  console.log(
    `[LIVE REQUEST] ${trainNumber}`
  );

  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}/trains/${trainNumber}/live`,
      {
        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,

          Accept:
            "application/json"
        },

        params: {
          authoritative: true,
          haltsOnly: false,
          includeCoordinates: true
        },

        timeout: 12000
      }
    );

  return (
    response.data?.data ||
    response.data ||
    null
  );
}


// ============================================================
// LIVE THROTTLE
// ============================================================

async function canRunLiveCheck(now) {
  const snapshot =
    await metaRef
      .child(
        "lastLiveCheckAt"
      )
      .once("value");

  const raw =
    snapshot.val();

  if (!raw) {
    return true;
  }

  let last =
    safeNumber(raw);

  if (
    last === null
  ) {
    last =
      Date.parse(
        String(raw)
      );
  }

  if (
    !Number.isFinite(last)
  ) {
    return true;
  }

  if (
    last < 100000000000
  ) {
    last *= 1000;
  }

  const elapsedMinutes =
    (
      now.getTime() -
      last
    ) / 60000;

  return (
    elapsedMinutes >=
    LIVE_CHECK_INTERVAL_MINUTES
  );
}


async function markLiveCheck(now) {
  await metaRef
    .child(
      "lastLiveCheckAt"
    )
    .set(
      now.getTime()
    );
}


// ============================================================
// SELECT ONE LIVE TRAIN
// ============================================================
//
// Priority:
//
// 1. Existing AT_GATE train
// 2. Existing APPROACHING_GATE train
// 3. Existing DEPARTED_GUDUR train
// 4. Train closest to Gudur based on board data
// 5. Any upcoming board train
//
// This allows the single live call to be used where
// it matters most for gate control.
//
// ============================================================

function selectLiveCandidate(
  boardItems,
  trackingRecords
) {
  const now =
    new Date();


  // ----------------------------------------------------------
  // Existing gate records first
  // ----------------------------------------------------------

  for (
    const state of [
      STATES.AT_GATE,
      STATES.APPROACHING_GATE,
      STATES.DEPARTED_GUDUR
    ]
  ) {

    const matching =
      Object.values(
        trackingRecords || {}
      )
        .filter(
          (record) =>
            record &&
            record.state ===
              state &&
            isRecentRecord(
              record,
              now
            )
        )
        .sort(
          (a, b) =>
            Number(
              a.gateDistanceKm ??
              999
            ) -
            Number(
              b.gateDistanceKm ??
              999
            )
        );

    if (
      matching.length > 0
    ) {
      return String(
        matching[0].trainNo
      );
    }
  }


  // ----------------------------------------------------------
  // Use board live coordinates if available.
  // ----------------------------------------------------------

  const coordinateCandidates =
    boardItems
      .map(
        (item) => {

          const live =
            getLiveObject(item);

          const coords =
            getLiveCoordinates(
              live
            );

          if (!coords) {
            return null;
          }

          return {
            trainNo:
              getTrainNumber(item),

            distance:
              getGudurDistance(
                coords
              )
          };
        }
      )
      .filter(
        Boolean
      )
      .sort(
        (a, b) =>
          a.distance -
          b.distance
      );

  if (
    coordinateCandidates.length > 0
  ) {
    return coordinateCandidates[0]
      .trainNo;
  }


  // ----------------------------------------------------------
  // Otherwise first board train.
  // ----------------------------------------------------------

  if (
    boardItems.length > 0
  ) {
    return getTrainNumber(
      boardItems[0]
    );
  }


  return null;
}


// ============================================================
// APPLY LIVE DATA TO TRACKING
// ============================================================

async function processLiveCandidate(
  trainNumber,
  boardItems,
  trackingRecords,
  now
) {
  if (!trainNumber) {
    return;
  }

  let liveData;

  try {
    liveData =
      await fetchLiveTrain(
        trainNumber
      );
  } catch (error) {

    if (error.response) {
      console.error(
        `[LIVE ERROR] ${trainNumber} HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[LIVE ERROR] ${trainNumber} ${error.message}`
      );
    }

    return;
  }


  if (!liveData) {
    console.log(
      `[LIVE] No live data for ${trainNumber}`
    );

    return;
  }


  const item =
    boardItems.find(
      (entry) =>
        getTrainNumber(entry) ===
        String(trainNumber)
    );


  const corridor =
    item
      ? determineCorridor(item)
      : (
          TPTY_CORRIDOR_TRAINS.has(
            String(trainNumber)
          )
            ? "TPTY"
            : (
                MAS_CORRIDOR_TRAINS.has(
                  String(trainNumber)
                )
                  ? "MAS"
                  : "OTHER"
              )
        );


  // Never allow OTHER to close a gate.
  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    console.log(
      `[LIVE IGNORED] ${trainNumber} is OTHER LINE`
    );

    return;
  }


  const previousRecord =
    trackingRecords[
      String(trainNumber)
    ] || null;


  const stateInfo =
    calculateLiveState(
      corridor,
      liveData,
      previousRecord
    );


  const coords =
    getLiveCoordinates(
      liveData
    );


  const record = {
    trainNo:
      String(trainNumber),

    name:
      item
        ? getTrainName(item)
        : (
            previousRecord?.name ||
            `Train ${trainNumber}`
          ),

    corridor,

    state:
      stateInfo.state,

    gateDistanceKm:
      stateInfo.gateDistanceKm,

    gudurDistanceKm:
      stateInfo.gudurDistanceKm,

    latitude:
      coords?.lat ??
      null,

    longitude:
      coords?.lng ??
      null,

    direction:
      stateInfo.state ===
      STATES.AT_GUDUR_STATION
        ? "AT GUDUR"
        : "AFTER GUDUR",

    updatedAt:
      now.toISOString(),

    updatedAtMs:
      now.getTime()
  };


  // ----------------------------------------------------------
  // PASSED GATE
  // ----------------------------------------------------------

  if (
    previousRecord &&
    (
      previousRecord.state ===
        STATES.AT_GATE ||
      previousRecord.state ===
        STATES.APPROACHING_GATE
    ) &&
    stateInfo.gateDistanceKm !== null &&
    stateInfo.gateDistanceKm >=
      GATE_CLEAR_DISTANCE_KM
  ) {

    console.log(
      `[PASSED GATE] ${trainNumber} ${getTrainName(item || {})}`
    );

    await trackingRef
      .child(
        String(trainNumber)
      )
      .remove();

    return;
  }


  await trackingRef
    .child(
      String(trainNumber)
    )
    .set(
      record
    );


  console.log(
    `[TRACKING] ${trainNumber} ${record.name} | ${corridor} | ${record.state} | gate=${record.gateDistanceKm === null ? "--" : record.gateDistanceKm.toFixed(3) + "km"}`
  );
}


// ============================================================
// CLEAN TRACKING
// ============================================================

async function cleanupTracking(
  records,
  now
) {
  for (
    const [
      trainNo,
      record
    ] of Object.entries(
      records || {}
    )
  ) {

    if (
      !record
    ) {
      continue;
    }

    if (
      !isRecentRecord(
        record,
        now
      )
    ) {

      console.log(
        `[TRACKING REMOVE] ${trainNo} | stale record`
      );

      await trackingRef
        .child(trainNo)
        .remove();
    }
  }
}


// ============================================================
// DETERMINE GATE STATUS
// ============================================================

function buildGateState(
  corridor,
  records,
  clearText
) {
  const matching =
    Object.values(
      records || {}
    )
      .filter(
        (record) =>
          record &&
          record.corridor ===
            corridor &&
          (
            record.state ===
              STATES.AT_GATE ||
            record.state ===
              STATES.APPROACHING_GATE
          )
      )
      .sort(
        (a, b) =>
          Number(
            a.gateDistanceKm ??
            999
          ) -
          Number(
            b.gateDistanceKm ??
            999
          )
      );


  // ----------------------------------------------------------
  // No gate train
  // ----------------------------------------------------------

  if (
    matching.length === 0
  ) {
    return {
      status: "OPEN",

      waitMinutes: 0,

      activeTrain:
        clearText,

      direction:
        "CLEAR",

      corridor
    };
  }


  const record =
    matching[0];


  const distance =
    safeNumber(
      record.gateDistanceKm
    );


  // ----------------------------------------------------------
  // ONLY AT_GATE closes the gate.
  // ----------------------------------------------------------

  if (
    record.state !==
    STATES.AT_GATE
  ) {

    return {
      status: "OPEN",

      waitMinutes: 0,

      activeTrain:
        record.name ||
        record.trainNo,

      direction:
        record.direction ||
        "APPROACHING",

      corridor
    };
  }


  // ----------------------------------------------------------
  // Estimate waiting time.
  //
  // This is NOT used for ETA to Gudur.
  // It is only gate wait duration.
  // ----------------------------------------------------------

  let waitMinutes = 3;

  if (
    distance !== null
  ) {

    if (
      distance <= 0.15
    ) {
      waitMinutes = 5;

    } else if (
      distance <= 0.30
    ) {
      waitMinutes = 4;

    } else {
      waitMinutes = 3;
    }
  }


  return {
    status: "CLOSED",

    waitMinutes,

    activeTrain:
      `${record.trainNo} ${record.name || ""}`.trim(),

    direction:
      record.direction ||
      "AFTER GUDUR",

    corridor
  };
}


// ============================================================
// BUILD UPCOMING TRAINS
// ============================================================
//
// IMPORTANT:
//
// We DO NOT read ETA from tracking records.
//
// Every board run gets a fresh ETA.
//
// This fixes:
//
// 16032 = stale 7m
// 12622 = stale 24m
//
// and prevents old Firebase values from reappearing.
//
// ============================================================

function buildUpcomingTrains(
  boardItems,
  now,
  trackingRecords
) {
  const results = [];


  for (
    const item of boardItems
  ) {

    if (
      !isUsefulBoardEntry(item)
    ) {
      continue;
    }


    const trainNo =
      getTrainNumber(item);

    if (!trainNo) {
      continue;
    }


    const trainName =
      getTrainName(item);


    const corridor =
      determineCorridor(item);


    const origin =
      getOriginText(item);


    const destination =
      getDestinationText(item);


    const delayMinutes =
      getDelayMinutes(item);


    const platform =
      getPlatform(item);


    const live =
      getLiveObject(item);


    const liveState =
      trackingRecords[
        trainNo
      ]?.state ||
      null;


    // --------------------------------------------------------
    // Current GDR board ETA
    // --------------------------------------------------------

    const eta =
      getBoardEtaMinutes(
        item,
        now
      );


    let state =
      liveState ||
      STATES.APPROACHING_GUDUR;


    if (
      isAtGudurStation(live)
    ) {
      state =
        STATES.AT_GUDUR_STATION;

    } else if (
      hasDepartedGudur(live)
    ) {

      state =
        liveState ===
          STATES.AT_GATE ||
        liveState ===
          STATES.APPROACHING_GATE
          ? liveState
          : STATES.DEPARTED_GUDUR;
    }


    // --------------------------------------------------------
    // If train is currently at/after GDR, keep it visible
    // for tracking but do not pretend it has an ETA to GDR.
    // --------------------------------------------------------

    const isAfterGudur =
      state ===
        STATES.DEPARTED_GUDUR ||
      state ===
        STATES.APPROACHING_GATE ||
      state ===
        STATES.AT_GATE;


    let etaMinutes =
      eta.etaMinutes;


    let etaSource =
      eta.source;


    if (
      isAfterGudur &&
      state !==
        STATES.AT_GUDUR_STATION
    ) {
      etaMinutes = null;
      etaSource =
        "AFTER_GUDUR";
    }


    // --------------------------------------------------------
    // Do NOT include extremely distant scheduled trains.
    //
    // However, since this is the GDR station board, we trust
    // the board itself to select GDR-relevant trains.
    //
    // --------------------------------------------------------

    results.push({

      trainNo,

      trainNumber:
        trainNo,

      name:
        trainName,

      origin:
        origin ||
        "Unknown",

      destination:
        destination ||
        "Gudur Junction",

      corridor,

      platform,

      delayMinutes,

      etaMinutes,

      etaSource,

      state,

      direction:
        state ===
          STATES.AT_GUDUR_STATION
          ? "AT GUDUR"
          : (
              isAfterGudur
                ? "AFTER GUDUR"
                : "TOWARD GUDUR"
            ),

      // Helpful frontend/debug information.
      liveVerified:
        Boolean(
          live &&
          (
            live.currentLocation ||
            live.expectedArrivalTime
          )
        )
    });
  }


  // ----------------------------------------------------------
  // Sort:
  //
  // Numeric ETA first.
  // Unknown ETA last.
  // ----------------------------------------------------------

  results.sort(
    (a, b) => {

      const aEta =
        Number.isFinite(
          Number(
            a.etaMinutes
          )
        )
          ? Number(
              a.etaMinutes
            )
          : 99999;


      const bEta =
        Number.isFinite(
          Number(
            b.etaMinutes
          )
        )
          ? Number(
              b.etaMinutes
            )
          : 99999;


      if (
        aEta !== bEta
      ) {
        return aEta - bEta;
      }


      return String(
        a.trainNo
      ).localeCompare(
        String(
          b.trainNo
        )
      );
    }
  );


  return results.slice(
    0,
    UPCOMING_MAX_TRAINS
  );
}


// ============================================================
// FETCH GDR BOARD
// ============================================================

async function fetchGudurBoard() {
  console.log(
    "\n[BOARD] Querying RailRadar Live Station Board for GDR..."
  );


  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live`,
      {
        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,

          Accept:
            "application/json"
        },

        params: {
          hours: 4,

          includeIntermediate:
            true
        },

        timeout: 12000
      }
    );


  const body =
    response.data;


  const trains =
    body?.data?.trains ||
    body?.trains ||
    [];


  if (
    !Array.isArray(trains)
  ) {
    throw new Error(
      "RailRadar returned invalid GDR board data."
    );
  }


  console.log(
    `[BOARD] RailRadar returned ${trains.length} trains.`
  );


  return trains;
}


// ============================================================
// MAIN MONITOR
// ============================================================

async function updateGateSystem() {
  const now =
    new Date();


  console.log(
    "\n============================================================"
  );

  console.log(
    `[MONITOR] ${now.toLocaleString("en-IN")}`
  );

  console.log(
    "============================================================"
  );


  try {

    // --------------------------------------------------------
    // READ EXISTING TRACKING
    // --------------------------------------------------------

    const trackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const trackingRecords =
      trackingSnapshot.val() ||
      {};


    // --------------------------------------------------------
    // FETCH CURRENT GDR BOARD
    // --------------------------------------------------------

    const boardItems =
      await fetchGudurBoard();


    // --------------------------------------------------------
    // LIVE VERIFICATION
    // --------------------------------------------------------

    const shouldRunLive =
      await canRunLiveCheck(
        now
      );


    if (
      shouldRunLive
    ) {

      const candidate =
        selectLiveCandidate(
          boardItems,
          trackingRecords
        );


      if (
        candidate
      ) {

        console.log(
          `[LIVE] Selected ${candidate} for live verification.`
        );


        await markLiveCheck(
          now
        );


        await processLiveCandidate(
          candidate,
          boardItems,
          trackingRecords,
          now
        );

      } else {

        console.log(
          "[LIVE] No suitable train candidate."
        );
      }

    } else {

      console.log(
        "[LIVE] Throttled to protect monthly quota."
      );
    }


    // --------------------------------------------------------
    // RE-READ TRACKING AFTER LIVE UPDATE
    // --------------------------------------------------------

    const updatedTrackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const updatedTrackingRecords =
      updatedTrackingSnapshot.val() ||
      {};


    // --------------------------------------------------------
    // CLEAN OLD RECORDS
    // --------------------------------------------------------

    await cleanupTracking(
      updatedTrackingRecords,
      now
    );


    // --------------------------------------------------------
    // BUILD FRESH UPCOMING LIST
    // --------------------------------------------------------

    const upcoming =
      buildUpcomingTrains(
        boardItems,
        now,
        updatedTrackingRecords
      );


    // --------------------------------------------------------
    // GATE STATES
    // --------------------------------------------------------

    const masGate =
      buildGateState(
        "MAS",
        updatedTrackingRecords,
        "Tracks Clear"
      );


    const tptyGate =
      buildGateState(
        "TPTY",
        updatedTrackingRecords,
        "Tracks Clear"
      );


    // --------------------------------------------------------
    // TIMESTAMPS
    // --------------------------------------------------------

    const lastUpdatedAt =
      now.toISOString();


    const lastUpdatedLocal =
      now.toLocaleString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );


    const lastUpdated =
      now.toLocaleTimeString(
        "en-IN",
        {
          timeZone:
            "Asia/Kolkata"
        }
      );


    // --------------------------------------------------------
    // FIREBASE PAYLOAD
    // --------------------------------------------------------

    const payload = {

      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        upcoming,

      lastUpdated,

      lastUpdatedAt,

      lastUpdatedLocal,

      station:
        "GDR",

      trackingDistanceKm:
        TRACKING_DISTANCE_KM,

      gateDistanceKm:
        GATE_DISTANCE_KM,

      gateCloseDistanceKm:
        GATE_CLOSE_DISTANCE_KM,

      gateClearDistanceKm:
        GATE_CLEAR_DISTANCE_KM
    };


    // --------------------------------------------------------
    // WRITE FIREBASE
    // --------------------------------------------------------

    await gateRef.set(
      payload
    );


    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
    );


    console.log(
      ` -> Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );


    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );


    console.log(
      ` -> Upcoming trains: ${upcoming.length}`
    );


    // --------------------------------------------------------
    // DISPLAY UPCOMING
    // --------------------------------------------------------

    console.log(
      "\n[UPCOMING GDR TRAINS]"
    );


    if (
      upcoming.length === 0
    ) {

      console.log(
        "   None"
      );

    } else {

      upcoming.forEach(
        (train, index) => {

          const etaText =
            Number.isFinite(
              Number(
                train.etaMinutes
              )
            )
              ? `${train.etaMinutes}m`
              : "--";


          console.log(
            `   ${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} | ETA ${etaText} | ${train.etaSource} | state=${train.state}`
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


    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Do NOT overwrite Firebase with fake/old ETA data
    // when RailRadar fails.
    //
    // Existing Firebase data remains visible.
    //
    // --------------------------------------------------------

    console.error(
      "[MONITOR] Firebase was NOT overwritten because the current RailRadar update failed."
    );
  }
}


// ============================================================
// START
// ============================================================

console.log(
  "============================================================"
);

console.log(
  " GUDUR CROSSING RADAR - LIVE MONITOR"
);

console.log(
  "============================================================"
);

console.log(
  "Station       : GDR / Gudur Junction"
);

console.log(
  "Chennai Gate  : 14.1396667, 79.8441278"
);

console.log(
  "Tirupati Gate : 14.1402028, 79.8435972"
);

console.log(
  "Gudur Junction: 14.1451694, 79.8443472"
);

console.log(
  "Tracking      : 1.00 km"
);

console.log(
  "Gate close    : 0.60 km"
);

console.log(
  "Gate clear    : 0.80 km"
);

console.log(
  "Live API      : Maximum 1 call / 20 minutes"
);

console.log(
  "Board horizon : 4 hours"
);

console.log(
  "Firebase      : Configured"
);

console.log(
  "RailRadar     : Configured"
);

console.log(
  "============================================================"
);


// ============================================================
// RUN
// ============================================================

updateGateSystem();


// ============================================================
// SAFETY:
// The GitHub Actions workflow normally starts a new process
// every 5 minutes, so no setInterval() is needed here.
//
// This is intentional.
//
// GitHub Actions schedule:
//
// */5 * * * *
//
// ============================================================
