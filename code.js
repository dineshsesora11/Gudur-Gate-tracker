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
  console.error("❌ Could not load Firebase service account.");
  console.error(
    "Set FIREBASE_SERVICE_ACCOUNT or provide serviceAccountKey.json."
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

// Maximum upcoming ETA shown
const UPCOMING_MAX_ETA_MINUTES = 360;

// Maximum number displayed
const UPCOMING_DISPLAY_LIMIT = 5;

// Check trains within this ETA using live API
const LIVE_VERIFY_ETA_MINUTES = 60;

// Maximum live API calls per run
const MAX_LIVE_CALLS = 2;

// Gate closes only inside this distance
const GATE_TRIGGER_DISTANCE_KM = 0.60;

// Distance considered safely past the gate
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Keep an at-station/departed train tracked this long
// even if the station board temporarily stops showing it.
const TRACKING_RETENTION_MINUTES = 45;

// Local loop interval.
// GitHub Actions runs the script every 5 minutes.
const REFRESH_INTERVAL_MS = 180000;

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
// INDIA TIME
// ============================================================

function getIndiaCurrentMinutes() {
  const parts =
    new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone: "Asia/Kolkata",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      }
    ).formatToParts(
      new Date()
    );

  const hour =
    Number(
      parts.find(
        (p) => p.type === "hour"
      )?.value || 0
    );

  const minute =
    Number(
      parts.find(
        (p) => p.type === "minute"
      )?.value || 0
    );

  return (
    hour * 60 +
    minute
  );
}

function getIndiaTimeString() {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "medium"
    }
  ).format(
    new Date()
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

  const text =
    String(timeStr).trim();

  // ISO time
  const isoMatch =
    text.match(
      /T(\d{1,2}):(\d{2})/
    );

  if (isoMatch) {
    return (
      Number(isoMatch[1]) * 60 +
      Number(isoMatch[2]) +
      Number(delayMinutes || 0)
    );
  }

  // HH:MM
  const timeMatch =
    text.match(
      /(\d{1,2}):(\d{2})/
    );

  if (timeMatch) {
    return (
      Number(timeMatch[1]) * 60 +
      Number(timeMatch[2]) +
      Number(delayMinutes || 0)
    );
  }

  return -1;
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

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// DISTANCE
// ============================================================

function calculateDistanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) *
      Math.PI) /
    180;

  const dLng =
    ((lng2 - lng1) *
      Math.PI) /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      (lat1 * Math.PI) / 180
    ) *
      Math.cos(
        (lat2 * Math.PI) / 180
      ) *
      Math.sin(dLng / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// RAILRADAR SOURCE / DESTINATION
// ============================================================

function getRailRadarSource(
  train,
  item
) {
  return (
    train.source ||
    item.train?.source ||
    item.source ||
    {}
  );
}

function getRailRadarDestination(
  train,
  item
) {
  return (
    train.destination ||
    item.train?.destination ||
    item.destination ||
    {}
  );
}

function getSourceCode(
  train,
  item
) {
  const source =
    getRailRadarSource(
      train,
      item
    );

  if (
    typeof source ===
    "string"
  ) {
    return normalizeText(
      source
    );
  }

  return normalizeText(
    source.code ||
      source.stationCode ||
      source.name ||
      ""
  );
}

function getDestinationCode(
  train,
  item
) {
  const destination =
    getRailRadarDestination(
      train,
      item
    );

  if (
    typeof destination ===
    "string"
  ) {
    return normalizeText(
      destination
    );
  }

  return normalizeText(
    destination.code ||
      destination.stationCode ||
      destination.name ||
      ""
  );
}

function getSourceName(
  train,
  item
) {
  const source =
    getRailRadarSource(
      train,
      item
    );

  if (
    typeof source ===
    "string"
  ) {
    return source;
  }

  return (
    source.name ||
    source.code ||
    ""
  );
}

function getDestinationName(
  train,
  item
) {
  const destination =
    getRailRadarDestination(
      train,
      item
    );

  if (
    typeof destination ===
    "string"
  ) {
    return destination;
  }

  return (
    destination.name ||
    destination.code ||
    ""
  );
}

// ============================================================
// DESTINATION GROUPS
// ============================================================

const CHENNAI_SIDE_CODES =
  new Set([
    "MAS",
    "MS",
    "MSB",
    "TBM",
    "CGL",
    "AJJ",
    "PER",
    "AVD",
    "SPE",
    "NYP"
  ]);

const SOUTHERN_SIDE_CODES =
  new Set([
    "TPTY",
    "RU",
    "GTL",
    "DMM",
    "SMVB",
    "SBC",
    "BNC",
    "YPR",
    "KJM",
    "KPD",
    "CCT",
    "COA",
    "NS",

    "TVC",
    "CAPE",
    "TEN",
    "MDU",
    "ERS",
    "KCVL",
    "QLN",
    "ALLP",
    "AWY",
    "KTYM",
    "SRR",
    "MAQ",
    "CAN",
    "CLT",
    "PGT",
    "ED",
    "TCR",
    "KZJ"
  ]);

// ============================================================
// DESTINATION SIDE
// ============================================================

function getDestinationSide(
  train,
  item
) {
  const code =
    getDestinationCode(
      train,
      item
    );

  if (
    CHENNAI_SIDE_CODES.has(
      code
    )
  ) {
    return "CHENNAI";
  }

  if (
    SOUTHERN_SIDE_CODES.has(
      code
    )
  ) {
    return "SOUTH";
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
    train.direction,
    train.travelDirection,
    train.routeDirection,
    train.runningDirection,

    live.direction,
    live.travelDirection,
    live.routeDirection,
    live.runningDirection,

    stop.direction,

    item.direction,
    item.travelDirection,
    item.routeDirection,
    item.runningDirection
  ];

  return fields
    .filter(Boolean)
    .map(normalizeText)
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
// CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// Destination Chennai side
//     => TPTY gate
//
// Destination southern side
//     => MAS gate
//
// This keeps the classification that was already working.
// ============================================================

function determineInboundCorridor(
  train,
  live,
  stop,
  item
) {
  const explicit =
    hasInboundDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicit === false
  ) {
    return null;
  }

  const destinationSide =
    getDestinationSide(
      train,
      item
    );

  if (
    destinationSide ===
    "CHENNAI"
  ) {
    return "TPTY";
  }

  if (
    destinationSide ===
    "SOUTH"
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// TRAIN STATUS
// ============================================================

function getTrainStatus(
  train,
  live,
  item
) {
  return normalizeText(
    live.status ||
      train.status ||
      item.status ||
      ""
  );
}

function isRemovedStatus(
  train,
  live,
  item
) {
  const status =
    getTrainStatus(
      train,
      live,
      item
    );

  return (
    status.includes(
      "CANCELLED"
    ) ||
    status.includes(
      "CANCELED"
    ) ||
    status.includes(
      "TERMINATED"
    ) ||
    status.includes(
      "COMPLETED"
    )
  );
}

// ============================================================
// TRAIN NUMBER / NAME
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return String(
    train.number ||
      item.trainNumber ||
      item.number ||
      ""
  ).trim();
}

function getTrainName(
  train,
  item,
  trainNo
) {
  return (
    train.name ||
    item.trainName ||
    item.name ||
    `Express ${trainNo}`
  );
}

// ============================================================
// ORIGIN / DESTINATION
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    getSourceName(
      train,
      item
    ) ||
    "Southern side"
  );
}

function getDestination(
  train,
  item
) {
  return (
    getDestinationName(
      train,
      item
    ) ||
    "Gudur"
  );
}

// ============================================================
// LIVE COORDINATES
// ============================================================

function getLiveCoordinates(
  currentLocation
) {
  if (!currentLocation) {
    return null;
  }

  const lat =
    Number(
      currentLocation.latitude ??
        currentLocation.lat
    );

  const lng =
    Number(
      currentLocation.longitude ??
        currentLocation.lng ??
        currentLocation.lon
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  return {
    lat,
    lng
  };
}

// ============================================================
// LIVE STATION CODE
// ============================================================

function getCurrentStationCode(
  currentLocation
) {
  if (!currentLocation) {
    return "";
  }

  return normalizeText(
    currentLocation.stationCode ||
      currentLocation.code ||
      ""
  );
}

// ============================================================
// AT GUDUR DETECTION
// ============================================================
//
// This is the critical new logic.
//
// A train at Gudur station/platform must NOT close a gate.
//
// ============================================================

function isAtGudurStation(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  const stationCode =
    getCurrentStationCode(
      currentLocation
    );

  const stationName =
    normalizeText(
      currentLocation.stationName ||
        ""
    );

  const status =
    normalizeText(
      currentLocation.status ||
        ""
    );

  if (
    stationCode ===
    "GDR"
  ) {
    return true;
  }

  if (
    stationName.includes(
      "GUDUR"
    )
  ) {
    return true;
  }

  if (
    status.includes(
      "AT STATION"
    ) &&
    (
      stationCode ===
        "GDR" ||
      stationName.includes(
        "GUDUR"
      )
    )
  ) {
    return true;
  }

  return false;
}

// ============================================================
// DEPARTURE DETECTION
// ============================================================

function isTrainMoving(
  currentLocation,
  liveData
) {
  const status =
    normalizeText(
      currentLocation?.status ||
        liveData?.status ||
        ""
    );

  const speed =
    Number(
      currentLocation?.speedKmh ??
        currentLocation?.speed ??
        0
    );

  if (
    status.includes(
      "RUNNING"
    ) ||
    status.includes(
      "MOVING"
    ) ||
    status.includes(
      "DEPARTED"
    )
  ) {
    return true;
  }

  return speed > 2;
}

// ============================================================
// GATE COORDINATES
// ============================================================

function getGateCoordinates(
  corridor
) {
  if (
    corridor === "MAS"
  ) {
    return {
      lat: CHENNAI_GATE_LAT,
      lng: CHENNAI_GATE_LNG
    };
  }

  return {
    lat: TIRUPATI_GATE_LAT,
    lng: TIRUPATI_GATE_LNG
  };
}

// ============================================================
// FIREBASE TRACKING OBJECT
// ============================================================

function createTrackingRecord(
  candidate
) {
  return {
    trainNo:
      candidate.trainNo,

    name:
      candidate.name,

    origin:
      candidate.origin,

    destination:
      candidate.destination,

    corridor:
      candidate.corridor,

    state:
      "APPROACHING_GUDUR",

    stationStatus:
      "APPROACHING",

    gateStatus:
      "OPEN",

    lastEtaMinutes:
      candidate.etaMinutes,

    lastDistanceKm:
      null,

    lastLatitude:
      null,

    lastLongitude:
      null,

    lastSeenAt:
      Date.now(),

    atGudur:
      false,

    departedGudur:
      false,

    gateApproached:
      false,

    gateCleared:
      false
  };
}

// ============================================================
// FETCH LIVE TRAIN
// ============================================================
//
// geometry=true is requested so RailRadar can provide the
// most detailed position/route information available.
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
      trainNo
    )}/live?authoritative=true&includeCoordinates=true&geometry=true`;

  return axios.get(
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
}

// ============================================================
// UPDATE TRACKING RECORD FROM LIVE DATA
// ============================================================

function updateTrackingFromLive(
  record,
  liveData
) {
  const currentLocation =
    liveData.currentLocation ||
    liveData.location ||
    {};

  const stationCode =
    getCurrentStationCode(
      currentLocation
    );

  const stationName =
    normalizeText(
      currentLocation.stationName ||
        ""
    );

  const atGudur =
    isAtGudurStation(
      currentLocation
    );

  const moving =
    isTrainMoving(
      currentLocation,
      liveData
    );

  const coordinates =
    getLiveCoordinates(
      currentLocation
    );

  const gateCoordinates =
    getGateCoordinates(
      record.corridor
    );

  let distanceKm =
    null;

  if (
    coordinates
  ) {
    distanceKm =
      calculateDistanceKm(
        coordinates.lat,
        coordinates.lng,
        gateCoordinates.lat,
        gateCoordinates.lng
      );
  }

  // ----------------------------------------------------------
  // TRAIN IS AT GUDUR PLATFORM
  // ----------------------------------------------------------

  if (atGudur) {
    record.state =
      "AT_GUDUR_STATION";

    record.stationStatus =
      "AT STATION";

    record.atGudur =
      true;

    record.departedGudur =
      false;

    record.gateStatus =
      "OPEN";

    record.gateApproached =
      false;

    record.gateCleared =
      false;
  }

  // ----------------------------------------------------------
  // TRAIN HAS LEFT GUDUR
  // ----------------------------------------------------------

  if (
    record.atGudur &&
    !atGudur &&
    moving
  ) {
    record.state =
      "DEPARTED_GUDUR";

    record.stationStatus =
      "DEPARTED";

    record.departedGudur =
      true;
  }

  // ----------------------------------------------------------
  // ONCE DEPARTED, USE ACTUAL DISTANCE
  // ----------------------------------------------------------

  if (
    record.departedGudur &&
    distanceKm !== null
  ) {
    record.lastDistanceKm =
      distanceKm;

    // --------------------------------------------------------
    // APPROACHING GATE
    // --------------------------------------------------------

    if (
      distanceKm <=
      GATE_TRIGGER_DISTANCE_KM
    ) {
      record.state =
        "AT_GATE";

      record.gateApproached =
        true;

      record.gateCleared =
        false;

      record.gateStatus =
        "CLOSED";
    }

    // --------------------------------------------------------
    // PASSED GATE
    // --------------------------------------------------------

    else if (
      record.gateApproached &&
      distanceKm >=
        GATE_CLEAR_DISTANCE_KM
    ) {
      record.state =
        "PASSED_GATE";

      record.gateCleared =
        true;

      record.gateStatus =
        "OPEN";
    }

    // --------------------------------------------------------
    // STILL BETWEEN GUDUR AND GATE
    // --------------------------------------------------------

    else {
      record.state =
        "DEPARTED_GUDUR";

      record.gateStatus =
        "OPEN";
    }
  }

  // ----------------------------------------------------------
  // SAVE LAST POSITION
  // ----------------------------------------------------------

  if (
    coordinates
  ) {
    record.lastLatitude =
      coordinates.lat;

    record.lastLongitude =
      coordinates.lng;
  }

  record.lastSeenAt =
    Date.now();

  record.stationCode =
    stationCode;

  record.stationName =
    stationName;

  record.liveStatus =
    normalizeText(
      currentLocation.status ||
        liveData.status ||
        ""
    );

  record.speedKmh =
    Number(
      currentLocation.speedKmh ??
        currentLocation.speed ??
        0
    );

  record.actualPosition =
    currentLocation.isActualPosition ===
      true;

  return {
    record,
    currentLocation,
    coordinates,
    distanceKm,
    atGudur,
    moving
  };
}

// ============================================================
// GATE PAYLOAD
// ============================================================

function createClosedGatePayload(
  record
) {
  return {
    status: "CLOSED",

    waitMinutes: 5,

    activeTrain:
      `${record.trainNo} ${record.name} (Approaching Gate)`,

    direction:
      "TOWARD GUDUR",

    corridor:
      record.corridor,

    distanceKm:
      record.lastDistanceKm !==
      null
        ? Number(
            record.lastDistanceKm.toFixed(
              3
            )
          )
        : null
  };
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  let apiRequests = 0;
  let liveVerifiedCount = 0;

  try {
    const currentMinutes =
      getIndiaCurrentMinutes();

    console.log(
      `\n[${getIndiaTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // ========================================================
    // LOAD EXISTING TRACKING
    // ========================================================

    const trackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const existingTracking =
      trackingSnapshot.val() || {};

    // ========================================================
    // STAGE 1 — STATION BOARD
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
      `RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // GATE DEFAULTS
    // ========================================================

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

    // ========================================================
    // NEW TRACKING STATE
    // ========================================================

    const tracking = {
      ...existingTracking
    };

    const boardCandidates = [];

    // ========================================================
    // PROCESS STATION BOARD
    // ========================================================

    for (
      const item of trainsArray
    ) {
      const train =
        item.train || {};

      const live =
        item.live || {};

      const stop =
        item.stop || {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (!trainNo) {
        continue;
      }

      const trainName =
        getTrainName(
          train,
          item,
          trainNo
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

      const delayMin =
        Number(
          live.delayMinutes ||
            item.delayMinutes ||
            0
        );

      // ------------------------------------------------------
      // Don't remove a train simply because ETA became 0.
      // ------------------------------------------------------

      if (
        isRemovedStatus(
          train,
          live,
          item
        )
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - cancelled/completed`
        );

        continue;
      }

      // ------------------------------------------------------
      // ARRIVAL
      // ------------------------------------------------------

      const arrTimeStr =
        stop.arrival ||
        live.expectedArrivalTime ||
        item.expectedArrivalTime ||
        item.arrival ||
        "";

      const depTimeStr =
        stop.departure ||
        live.expectedDepartureTime ||
        item.expectedDepartureTime ||
        item.departure ||
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
        continue;
      }

      const diff =
        calculateTimeDifference(
          arrMin,
          currentMinutes
        );

      // ------------------------------------------------------
      // IMPORTANT:
      //
      // ETA 0 is valid.
      //
      // A train at Gudur platform must remain visible.
      // ------------------------------------------------------

      if (
        diff <
        -15
      ) {
        console.log(
          `[PASSED STATION TIME] ${trainNo} ${trainName} | ETA ${diff}m`
        );

        // Do NOT immediately delete if we are tracking it.
        if (
          tracking[trainNo]
        ) {
          continue;
        }

        continue;
      }

      if (
        diff >
        UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      // ======================================================
      // CORRIDOR
      // ======================================================

      const corridor =
        determineInboundCorridor(
          train,
          live,
          stop,
          item
        );

      if (!corridor) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} | ${origin} -> ${destination} | corridor not confirmed`
        );

        continue;
      }

      console.log(
        `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${origin} -> ${destination} | ETA ${Math.max(
          0,
          diff
        )}m`
      );

      // ======================================================
      // CREATE / UPDATE TRACKING RECORD
      // ======================================================

      if (
        !tracking[trainNo]
      ) {
        tracking[trainNo] =
          createTrackingRecord(
            {
              trainNo,
              name:
                trainName,
              origin,
              destination,
              corridor,
              etaMinutes:
                Math.max(
                  0,
                  diff
                )
            }
          );
      }

      const record =
        tracking[trainNo];

      record.name =
        trainName;

      record.origin =
        origin;

      record.destination =
        destination;

      record.corridor =
        corridor;

      record.lastEtaMinutes =
        Math.max(
          0,
          diff
        );

      // ------------------------------------------------------
      // BOARD CANDIDATE
      // ------------------------------------------------------

      boardCandidates.push({
        trainNo,

        name:
          trainName,

        origin,

        destination,

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
            live.platform ||
              stop.platform ||
              item.platform ||
              "1"
          )
      });
    }

    // ========================================================
    // SORT BOARD
    // ========================================================

    boardCandidates.sort(
      (a, b) =>
        Number(
          a.etaMinutes
        ) -
        Number(
          b.etaMinutes
        )
    );

    // ========================================================
    // STAGE 2 CANDIDATES
    // ========================================================
    //
    // IMPORTANT:
    //
    // 0m AT GUDUR IS INCLUDED.
    //
    // We check the closest train first.
    // ========================================================

    const candidateMap =
      new Map();

    // --------------------------------------------------------
    // Board candidates
    // --------------------------------------------------------

    for (
      const candidate of
        boardCandidates
    ) {
      if (
        candidate.etaMinutes <=
        LIVE_VERIFY_ETA_MINUTES
      ) {
        candidateMap.set(
          candidate.trainNo,
          candidate
        );
      }
    }

    // --------------------------------------------------------
    // Existing tracked trains
    //
    // This is what prevents a train from disappearing after
    // it leaves the Gudur station board.
    // --------------------------------------------------------

    const nowMs =
      Date.now();

    for (
      const trainNo of
        Object.keys(
          tracking
        )
    ) {
      const record =
        tracking[trainNo];

      const ageMinutes =
        (
          nowMs -
          Number(
            record.lastSeenAt ||
              nowMs
          )
        ) /
        60000;

      if (
        ageMinutes >
        TRACKING_RETENTION_MINUTES
      ) {
        continue;
      }

      if (
        record.state ===
          "AT_GUDUR_STATION" ||
        record.state ===
          "DEPARTED_GUDUR" ||
        record.state ===
          "AT_GATE"
      ) {
        candidateMap.set(
          trainNo,
          {
            trainNo,

            name:
              record.name,

            origin:
              record.origin,

            destination:
              record.destination,

            etaMinutes:
              Number(
                record.lastEtaMinutes ??
                  0
              ),

            delayMinutes:
              0,

            corridor:
              record.corridor,

            direction:
              "TOWARD GUDUR",

            platform:
              record.platform ||
              "1"
          }
        );
      }
    }

    const liveCandidates =
      Array.from(
        candidateMap.values()
      )
        .sort(
          (a, b) =>
            Number(
              a.etaMinutes
            ) -
            Number(
              b.etaMinutes
            )
        );

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    if (
      liveCandidates.length >
      0
    ) {
      console.log(
        "[LIVE QUEUE ORDER]"
      );

      liveCandidates.forEach(
        (
          candidate,
          index
        ) => {
          const record =
            tracking[
              candidate.trainNo
            ];

          console.log(
            `  ${index + 1}. ${candidate.trainNo} ${candidate.name} | ${candidate.corridor} | ETA ${candidate.etaMinutes}m | state=${record?.state || "NEW"}`
          );
        }
      );
    }

    // ========================================================
    // VERIFY CLOSEST TRAINS
    // ========================================================

    const candidatesToVerify =
      liveCandidates.slice(
        0,
        MAX_LIVE_CALLS
      );

    for (
      const candidate of
        candidatesToVerify
    ) {
      console.log(
        `[LIVE] Checking train ${candidate.trainNo}...`
      );

      try {
        const liveRes =
          await fetchLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        const liveData =
          liveRes.data?.data ||
          {};

        const currentLocation =
          liveData.currentLocation ||
          liveData.location ||
          {};

        // ----------------------------------------------------
        // Ensure tracking record exists
        // ----------------------------------------------------

        if (
          !tracking[
            candidate.trainNo
          ]
        ) {
          tracking[
            candidate.trainNo
          ] =
            createTrackingRecord(
              candidate
            );
        }

        const record =
          tracking[
            candidate.trainNo
          ];

        record.name =
          candidate.name;

        record.origin =
          candidate.origin;

        record.destination =
          candidate.destination;

        record.corridor =
          candidate.corridor;

        record.lastEtaMinutes =
          candidate.etaMinutes;

        // ----------------------------------------------------
        // UPDATE LIVE STATE
        // ----------------------------------------------------

        const result =
          updateTrackingFromLive(
            record,
            liveData
          );

        liveVerifiedCount++;

        console.log(
          `[LIVE VERIFIED] ${candidate.trainNo} | ${candidate.corridor} | status=${
            result.currentLocation?.status ||
            liveData.status ||
            "UNKNOWN"
          } | station=${
            result.currentLocation?.stationCode ||
            "unknown"
          } | distance=${
            result.distanceKm !==
            null
              ? result.distanceKm.toFixed(
                  3
                ) +
                " km"
              : "unknown"
          } | actual=${
            record.actualPosition
          } | state=${
            record.state
          }`
        );

        // ====================================================
        // AT GUDUR PLATFORM
        // ====================================================

        if (
          result.atGudur
        ) {
          console.log(
            `🟢 [AT GUDUR PLATFORM] ${candidate.trainNo} ${candidate.name} | ${candidate.corridor} | GATE OPEN`
          );

          // Explicitly keep gate open.
          record.gateStatus =
            "OPEN";

          record.state =
            "AT_GUDUR_STATION";

          record.atGudur =
            true;

          record.departedGudur =
            false;

          continue;
        }

        // ====================================================
        // NO COORDINATES
        // ====================================================

        if (
          result.distanceKm ===
          null
        ) {
          console.log(
            `[LIVE POSITION] ${candidate.trainNo} has no live coordinates. Keeping current tracking state: ${record.state}`
          );

          // If it was known to be at Gudur,
          // DO NOT close gate.
          if (
            record.atGudur &&
            !record.departedGudur
          ) {
            record.gateStatus =
              "OPEN";
          }

          continue;
        }

        // ====================================================
        // DEPARTED GUDUR
        // ====================================================

        if (
          record.departedGudur
        ) {
          console.log(
            `[DEPARTED GUDUR] ${candidate.trainNo} | distance to ${candidate.corridor} gate: ${result.distanceKm.toFixed(
              3
            )} km`
          );
        }

        // ====================================================
        // GATE CLOSURE
        // ====================================================

        if (
          record.departedGudur &&
          record.actualPosition &&
          result.distanceKm <=
            GATE_TRIGGER_DISTANCE_KM
        ) {
          record.state =
            "AT_GATE";

          record.gateApproached =
            true;

          record.gateCleared =
            false;

          record.gateStatus =
            "CLOSED";

          const closedPayload =
            createClosedGatePayload(
              record
            );

          if (
            record.corridor ===
            "MAS"
          ) {
            masGate =
              closedPayload;

            console.log(
              `🚨 [MAS GATE CLOSED] ${candidate.trainNo} ${candidate.name} | distance ${result.distanceKm.toFixed(
                3
              )} km`
            );
          }

          if (
            record.corridor ===
            "TPTY"
          ) {
            tptyGate =
              closedPayload;

            console.log(
              `🚨 [TPTY GATE CLOSED] ${candidate.trainNo} ${candidate.name} | distance ${result.distanceKm.toFixed(
                3
              )} km`
            );
          }

          continue;
        }

        // ====================================================
        // GATE CLEAR
        // ====================================================

        if (
          record.gateApproached &&
          result.distanceKm >=
            GATE_CLEAR_DISTANCE_KM
        ) {
          record.state =
            "PASSED_GATE";

          record.gateCleared =
            true;

          record.gateStatus =
            "OPEN";

          console.log(
            `🟢 [GATE CLEAR] ${candidate.trainNo} ${candidate.name} | ${candidate.corridor} | distance ${result.distanceKm.toFixed(
              3
            )} km`
          );

          continue;
        }

        // ====================================================
        // BETWEEN GUDUR AND GATE
        // ====================================================

        if (
          record.departedGudur
        ) {
          record.state =
            "DEPARTED_GUDUR";

          record.gateStatus =
            "OPEN";

          console.log(
            `🟢 [BETWEEN STATION/GATE] ${candidate.trainNo} | ${candidate.corridor} | ${result.distanceKm.toFixed(
              3
            )} km | GATE OPEN`
          );
        }
      } catch (
        liveError
      ) {
        apiRequests++;

        if (
          liveError.response
        ) {
          console.error(
            `[LIVE ERROR] ${candidate.trainNo} | HTTP ${liveError.response.status}`
          );
        } else {
          console.error(
            `[LIVE ERROR] ${candidate.trainNo} | ${liveError.message}`
          );
        }
      }
    }

    // ========================================================
    // CLEAN UP TRACKING
    // ========================================================
    //
    // A train is removed only when:
    //
    // 1. It has passed the gate, OR
    // 2. Its tracking record has expired.
    //
    // This prevents an ETA=0 train at Gudur from disappearing.
    // ========================================================

    for (
      const trainNo of
        Object.keys(
          tracking
        )
    ) {
      const record =
        tracking[trainNo];

      const ageMinutes =
        (
          Date.now() -
          Number(
            record.lastSeenAt ||
              Date.now()
          )
        ) /
        60000;

      if (
        record.state ===
        "PASSED_GATE"
      ) {
        console.log(
          `[TRACKING COMPLETE] ${trainNo} ${record.name} - gate crossed`
        );

        delete tracking[
          trainNo
        ];

        continue;
      }

      if (
        ageMinutes >
        TRACKING_RETENTION_MINUTES
      ) {
        console.log(
          `[TRACKING EXPIRED] ${trainNo} ${record.name}`
        );

        delete tracking[
          trainNo
        ];
      }
    }

    // ========================================================
    // UPCOMING LIST
    // ========================================================
    //
    // IMPORTANT:
    //
    // Existing AT_GUDUR_STATION trains are kept visible.
    //
    // They are not removed just because ETA = 0.
    // ========================================================

    const upcomingMap =
      new Map();

    // --------------------------------------------------------
    // Current board
    // --------------------------------------------------------

    for (
      const candidate of
        boardCandidates
    ) {
      upcomingMap.set(
        candidate.trainNo,
        candidate
      );
    }

    // --------------------------------------------------------
    // Existing tracked trains
    // --------------------------------------------------------

    for (
      const trainNo of
        Object.keys(
          tracking
        )
    ) {
      const record =
        tracking[trainNo];

      if (
        record.state ===
          "AT_GUDUR_STATION" ||
        record.state ===
          "DEPARTED_GUDUR" ||
        record.state ===
          "AT_GATE"
      ) {
        upcomingMap.set(
          trainNo,
          {
            trainNo,

            name:
              record.name,

            origin:
              record.origin,

            destination:
              record.destination,

            etaMinutes:
              Math.max(
                0,
                Number(
                  record.lastEtaMinutes ??
                    0
                )
              ),

            delayMinutes:
              0,

            corridor:
              record.corridor,

            direction:
              "TOWARD GUDUR",

            platform:
              record.platform ||
              "1"
          }
        );
      }
    }

    const upcomingList =
      Array.from(
        upcomingMap.values()
      )
        .sort(
          (a, b) =>
            Number(
              a.etaMinutes
            ) -
            Number(
              b.etaMinutes
            )
        );

    const topUpcoming =
      upcomingList.slice(
        0,
        UPCOMING_DISPLAY_LIMIT
      );

    // ========================================================
    // SAVE TRACKING
    // ========================================================

    await trackingRef.set(
      tracking
    );

    // ========================================================
    // SAVE GATE DATA
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
    // SUCCESS
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
    // UPCOMING DISPLAY
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
          const record =
            tracking[
              train.trainNo
            ];

          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform} | ${train.origin} -> ${train.destination} | state=${
              record?.state ||
              "APPROACHING"
            }`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }
  } catch (
    error
  ) {
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
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor Active "
);

console.log(
  " Chennai Gate:  14.1396639 N, 79.8441306 E "
);

console.log(
  " Tirupati Gate: 14.1402056 N, 79.8436000 E "
);

console.log(
  "=========================================="
);

console.log(
  "RailRadar API Key: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "Direction: Southern side -> Gudur only"
);

console.log(
  `Live verification: ${LIVE_VERIFY_ETA_MINUTES} minutes`
);

console.log(
  `Maximum live calls: ${MAX_LIVE_CALLS}`
);

console.log(
  "Station arrival is NOT gate closure"
);

console.log(
  "Gudur platform -> departure -> gate tracking enabled"
);

console.log(
  "Closest ETA is always checked first"
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

setInterval(
  updateGateSystem,
  REFRESH_INTERVAL_MS
);
