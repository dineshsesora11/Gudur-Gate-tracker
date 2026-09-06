const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE
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
    "Use FIREBASE_SERVICE_ACCOUNT or serviceAccountKey.json."
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
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GATE LOCATIONS
// ============================================================

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_ETA_MINUTES = 360;

const LIVE_VERIFY_ETA_MINUTES = 60;

const MAX_LIVE_CALLS = 2;

const GATE_TRIGGER_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

const TRACKING_RETENTION_MINUTES = 45;

// ============================================================
// NORMALIZER
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

// ============================================================
// SAFE STRING
// ============================================================

function safeString(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (
    typeof value === "object"
  ) {
    return (
      value.code ||
      value.name ||
      value.stationCode ||
      value.stationName ||
      ""
    );
  }

  return String(value);
}

// ============================================================
// GET STATION VALUE
// ============================================================

function stationValue(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return String(value);
  }

  if (
    typeof value === "object"
  ) {
    return (
      value.code ||
      value.name ||
      value.stationCode ||
      value.stationName ||
      ""
    );
  }

  return "";
}

// ============================================================
// GET ORIGIN
// ============================================================
//
// RailRadar can return origin/source as either:
//   "MAS"
// or:
//   { code:"MAS", name:"MGR Chennai Central" }
//
// This function supports both.
//

function getOrigin(
  train,
  item
) {
  const candidates = [
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

    item?.train?.origin,
    item?.train?.source
  ];

  for (
    const value of candidates
  ) {
    const result =
      stationValue(value);

    if (result) {
      return result;
    }
  }

  return "";
}

// ============================================================
// GET DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const candidates = [
    train?.destination,
    train?.to,
    train?.destinationStation,
    train?.endStation,

    item?.destination,
    item?.to,
    item?.destinationStation,
    item?.endStation,

    item?.train?.destination
  ];

  for (
    const value of candidates
  ) {
    const result =
      stationValue(value);

    if (result) {
      return result;
    }
  }

  return "";
}

// ============================================================
// STATION CODE
// ============================================================

function getStationCode(
  value
) {
  if (!value) {
    return "";
  }

  if (
    typeof value === "object"
  ) {
    return normalizeText(
      value.code ||
        value.stationCode ||
        ""
    );
  }

  const text =
    normalizeText(value);

  const knownCodes = [
    "MAS",
    "TPTY",
    "TBM",
    "CGL",
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
    "KZJ",
    "GTL",
    "DMM",
    "SMVB",
    "BNC"
  ];

  for (
    const code of knownCodes
  ) {
    if (
      text === code ||
      text.includes(` ${code} `)
    ) {
      return code;
    }
  }

  const match =
    text.match(
      /\b[A-Z]{2,5}\b/
    );

  return match
    ? match[0]
    : "";
}

// ============================================================
// DESTINATION TEXT
// ============================================================

function getDestinationCode(
  train,
  item
) {
  const destination =
    getDestination(
      train,
      item
    );

  return getStationCode(
    destination
  );
}

// ============================================================
// SOUTHERN DESTINATIONS
// ============================================================

const SOUTHERN_DESTINATIONS = new Set([
  "TPTY",
  "RU",
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
  "KZJ",
  "GTL",
  "DMM"
]);

// ============================================================
// CHENNAI-SIDE DESTINATIONS
// ============================================================

const CHENNAI_DESTINATIONS = new Set([
  "MAS",
  "TBM",
  "CGL"
]);

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// Destination TPTY/GTL/DMM/etc.
//     => approaching Gudur from Chennai side
//     => MAS corridor
//
// Destination MAS/TBM/CGL
//     => approaching Gudur from southern side
//     => TPTY corridor
//
// Unknown destination:
//     => ignore
//

function determineCorridor(
  train,
  item
) {
  const destination =
    getDestination(
      train,
      item
    );

  const destinationText =
    normalizeText(
      destination
    );

  const destinationCode =
    getStationCode(
      destination
    );

  // ----------------------------------------------------------
  // TOWARD TIRUPATI / SOUTHERN SIDE
  // ----------------------------------------------------------

  if (
    destinationCode ===
      "TPTY" ||
    destinationText.includes(
      "TIRUPATI"
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // TOWARD CHENNAI
  // ----------------------------------------------------------

  if (
    CHENNAI_DESTINATIONS.has(
      destinationCode
    ) ||
    destinationText.includes(
      "CHENNAI"
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // OTHER SOUTHERN DESTINATION
  // ----------------------------------------------------------

  if (
    SOUTHERN_DESTINATIONS.has(
      destinationCode
    )
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  value,
  delayMinutes = 0
) {
  if (!value) {
    return -1;
  }

  // ----------------------------------------------------------
  // Date object / ISO timestamp
  // ----------------------------------------------------------

  if (
    value instanceof Date
  ) {
    if (
      !isNaN(
        value.getTime()
      )
    ) {
      return (
        value.getHours() * 60 +
        value.getMinutes() +
        Number(
          delayMinutes || 0
        )
      );
    }
  }

  const text =
    String(value).trim();

  if (!text) {
    return -1;
  }

  // ----------------------------------------------------------
  // ISO date
  // ----------------------------------------------------------

  const date =
    new Date(text);

  if (
    !isNaN(
      date.getTime()
    ) &&
    (
      text.includes("-") ||
      text.includes("T") ||
      text.includes("/")
    )
  ) {
    return (
      date.getHours() * 60 +
      date.getMinutes() +
      Number(
        delayMinutes || 0
      )
    );
  }

  // ----------------------------------------------------------
  // HH:MM
  // ----------------------------------------------------------

  const match =
    text.match(
      /(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return -1;
  }

  return (
    parseInt(
      match[1],
      10
    ) *
      60 +
    parseInt(
      match[2],
      10
    ) +
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

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) *
      Math.PI) /
    180;

  const dLon =
    ((lon2 - lon1) *
      Math.PI) /
    180;

  const a =
    Math.sin(dLat / 2) **
      2 +
    Math.cos(
      (lat1 * Math.PI) /
        180
    ) *
      Math.cos(
        (lat2 * Math.PI) /
          180
      ) *
      Math.sin(dLon / 2) **
        2;

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
        currentLocation.lat ??
        currentLocation.location
          ?.latitude ??
        currentLocation.location
          ?.lat ??
        currentLocation.coordinates
          ?.latitude ??
        currentLocation.coordinates
          ?.lat
    );

  const lng =
    Number(
      currentLocation.longitude ??
        currentLocation.lng ??
        currentLocation.lon ??
        currentLocation.location
          ?.longitude ??
        currentLocation.location
          ?.lng ??
        currentLocation.coordinates
          ?.longitude ??
        currentLocation.coordinates
          ?.lng
    );

  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat !== 0 &&
    lng !== 0
  ) {
    return {
      lat,
      lng
    };
  }

  return null;
}

// ============================================================
// LIVE STATUS
// ============================================================

function getLiveStatus(
  currentLocation
) {
  return normalizeText(
    currentLocation?.status ||
      ""
  );
}

// ============================================================
// LIVE STATION
// ============================================================

function getLiveStationCode(
  currentLocation
) {
  return normalizeText(
    currentLocation?.stationCode ||
      currentLocation?.station
        ?.code ||
      ""
  );
}

// ============================================================
// EXPLICIT DEPARTED
// ============================================================

function isExplicitlyDeparted(
  currentLocation
) {
  const status =
    getLiveStatus(
      currentLocation
    );

  return (
    status.includes(
      "DEPARTED"
    ) ||
    status.includes(
      "LEFT"
    ) ||
    status.includes(
      "DEPARTURE"
    )
  );
}

// ============================================================
// AT GUDUR
// ============================================================

function isAtGudurStation(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  // DEPARTED ALWAYS OVERRIDES STATION CODE
  if (
    isExplicitlyDeparted(
      currentLocation
    )
  ) {
    return false;
  }

  const stationCode =
    getLiveStationCode(
      currentLocation
    );

  const stationName =
    normalizeText(
      currentLocation.stationName ||
        currentLocation.station
          ?.name ||
        ""
    );

  const status =
    getLiveStatus(
      currentLocation
    );

  if (
    stationCode !== "GDR" &&
    !stationName.includes(
      "GUDUR"
    )
  ) {
    return false;
  }

  if (
    status.includes(
      "RUNNING"
    ) ||
    status.includes(
      "MOVING"
    )
  ) {
    return false;
  }

  return (
    status.includes(
      "AT STATION"
    ) ||
    status.includes(
      "HALT"
    ) ||
    status.includes(
      "ARRIVED"
    ) ||
    currentLocation.isHalt ===
      true
  );
}

// ============================================================
// TRAIN MOVING
// ============================================================

function isTrainMoving(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  const status =
    getLiveStatus(
      currentLocation
    );

  const speed =
    Number(
      currentLocation.speedKmh ||
        currentLocation.speed ||
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
// LIVE STATE
// ============================================================

function determineLiveState(
  currentLocation,
  previousRecord
) {
  // ----------------------------------------------------------
  // AT GUDUR PLATFORM
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      currentLocation
    )
  ) {
    return "AT_GUDUR_STATION";
  }

  // ----------------------------------------------------------
  // EXPLICIT DEPARTURE
  // ----------------------------------------------------------

  if (
    isExplicitlyDeparted(
      currentLocation
    )
  ) {
    return "DEPARTED_GUDUR";
  }

  // ----------------------------------------------------------
  // MOVING AFTER PLATFORM
  // ----------------------------------------------------------

  if (
    previousRecord?.state ===
      "AT_GUDUR_STATION" &&
    isTrainMoving(
      currentLocation
    )
  ) {
    return "DEPARTED_GUDUR";
  }

  // ----------------------------------------------------------
  // ALREADY DEPARTED
  // ----------------------------------------------------------

  if (
    previousRecord?.state ===
    "DEPARTED_GUDUR"
  ) {
    return "DEPARTED_GUDUR";
  }

  // ----------------------------------------------------------
  // ALREADY AT GATE
  // ----------------------------------------------------------

  if (
    previousRecord?.state ===
    "AT_GATE"
  ) {
    return "AT_GATE";
  }

  return (
    previousRecord?.state ||
    "APPROACHING_GUDUR"
  );
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
      lat:
        CHENNAI_GATE_LAT,
      lng:
        CHENNAI_GATE_LNG
    };
  }

  if (
    corridor === "TPTY"
  ) {
    return {
      lat:
        TIRUPATI_GATE_LAT,
      lng:
        TIRUPATI_GATE_LNG
    };
  }

  return null;
}

// ============================================================
// UPDATE LIVE TRACKING
// ============================================================

function updateTrackingFromLive(
  train,
  liveData,
  previousRecord
) {
  const currentLocation =
    liveData?.currentLocation ||
    {};

  const state =
    determineLiveState(
      currentLocation,
      previousRecord
    );

  const coords =
    getLiveCoordinates(
      currentLocation
    );

  const gate =
    getGateCoordinates(
      train.corridor
    );

  let distanceToGate =
    null;

  if (
    coords &&
    gate
  ) {
    distanceToGate =
      distanceKm(
        coords.lat,
        coords.lng,
        gate.lat,
        gate.lng
      );
  }

  let finalState =
    state;

  let gateStatus =
    "OPEN";

  // ==========================================================
  // AT PLATFORM
  // ==========================================================

  if (
    state ===
    "AT_GUDUR_STATION"
  ) {
    finalState =
      "AT_GUDUR_STATION";

    gateStatus =
      "OPEN";

    console.log(
      `🟢 [AT GUDUR PLATFORM] ${train.trainNo} ${train.name} | ${train.corridor} | GATE OPEN`
    );
  }

  // ==========================================================
  // DEPARTED
  // ==========================================================

  else if (
    state ===
    "DEPARTED_GUDUR"
  ) {
    gateStatus =
      "OPEN";

    if (
      distanceToGate !== null &&
      distanceToGate <=
        GATE_TRIGGER_DISTANCE_KM
    ) {
      finalState =
        "AT_GATE";

      gateStatus =
        "CLOSED";

      console.log(
        `🔴 [GATE APPROACH] ${train.trainNo} ${train.name} | ${train.corridor} | ${distanceToGate.toFixed(
          3
        )} km | GATE CLOSED`
      );
    } else {
      console.log(
        `🟢 [DEPARTED GUDUR] ${train.trainNo} ${train.name} | ${train.corridor} | ${
          distanceToGate !== null
            ? `${distanceToGate.toFixed(
                3
              )} km from gate`
            : "GPS unavailable"
        } | GATE OPEN`
      );
    }
  }

  // ==========================================================
  // AT GATE
  // ==========================================================

  else if (
    state ===
    "AT_GATE"
  ) {
    if (
      distanceToGate !== null &&
      distanceToGate >=
        GATE_CLEAR_DISTANCE_KM
    ) {
      finalState =
        "PASSED_GATE";

      gateStatus =
        "OPEN";

      console.log(
        `🟢 [PASSED GATE] ${train.trainNo} ${train.name} | ${train.corridor} | ${distanceToGate.toFixed(
          3
        )} km | GATE OPEN`
      );
    } else {
      finalState =
        "AT_GATE";

      gateStatus =
        "CLOSED";

      console.log(
        `🔴 [AT GATE] ${train.trainNo} ${train.name} | ${train.corridor} | ${
          distanceToGate !== null
            ? `${distanceToGate.toFixed(
                3
              )} km`
            : "GPS unavailable"
        } | GATE CLOSED`
      );
    }
  }

  // ==========================================================
  // PASSED
  // ==========================================================

  else if (
    state ===
    "PASSED_GATE"
  ) {
    finalState =
      "PASSED_GATE";

    gateStatus =
      "OPEN";
  }

  // ==========================================================
  // APPROACHING
  // ==========================================================

  else {
    finalState =
      "APPROACHING_GUDUR";

    gateStatus =
      "OPEN";
  }

  return {
    ...train,

    state:
      finalState,

    gateStatus:
      gateStatus,

    distanceToGate:
      distanceToGate,

    liveStatus:
      getLiveStatus(
        currentLocation
      ),

    liveStation:
      getLiveStationCode(
        currentLocation
      ),

    actualPosition:
      currentLocation.isActualPosition ===
      true,

    speedKmh:
      Number(
        currentLocation.speedKmh ||
          currentLocation.speed ||
          0
      ),

    lastLiveCheck:
      new Date().toISOString()
  };
}

// ============================================================
// LIVE FETCH
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${trainNo}/live` +
    `?authoritative=true&includeCoordinates=true&geometry=true`;

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
    response.data?.data ||
    null
  );
}

// ============================================================
// VALID BOARD TRAIN
// ============================================================

function isBoardTrainValid(
  item
) {
  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  const status =
    normalizeText(
      live.status ||
        item?.status ||
        ""
    );

  if (
    status.includes(
      "CANCELLED"
    ) ||
    status.includes(
      "CANCELED"
    ) ||
    status.includes(
      "TERMINATED"
    )
  ) {
    return false;
  }

  // Do NOT reject merely because another status field says
  // something unexpected. We need the station arrival time.

  const arrival =
    stop.arrival ||
    live.expectedArrivalTime ||
    item.arrival ||
    item.arrivalTime ||
    "";

  return Boolean(
    arrival
  );
}

// ============================================================
// VALID TRACKING RECORD
// ============================================================
//
// This prevents old/corrupt records from producing:
//
// ETA undefined
// 29812131 minutes
//

function isValidTrackingRecord(
  record
) {
  if (
    !record ||
    typeof record !==
      "object"
  ) {
    return false;
  }

  const trainNo =
    String(
      record.trainNo ||
        ""
    ).trim();

  if (!trainNo) {
    return false;
  }

  const validStates =
    new Set([
      "APPROACHING_GUDUR",
      "AT_GUDUR_STATION",
      "DEPARTED_GUDUR",
      "AT_GATE",
      "PASSED_GATE"
    ]);

  if (
    record.state &&
    !validStates.has(
      record.state
    )
  ) {
    return false;
  }

  return true;
}

// ============================================================
// SAFE ETA
// ============================================================

function safeEta(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  if (
    Number.isFinite(
      number
    )
  ) {
    return Math.max(
      0,
      Math.round(number)
    );
  }

  return fallback;
}

// ============================================================
// MAIN
// ============================================================

async function updateGateSystem() {
  try {
    const now =
      new Date();

    const currentMin =
      now.getHours() * 60 +
      now.getMinutes();

    console.log(
      `\n[${now.toLocaleString(
        "en-IN"
      )}] Querying RailRadar Live Station Board for GDR...`
    );

    // ========================================================
    // STAGE 1 - STATION BOARD
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

    const trainsArray =
      boardRes.data?.data
        ?.trains || [];

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
      `RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // LOAD TRACKING
    // ========================================================

    const trackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const oldTracking =
      trackingSnapshot.val() ||
      {};

    const tracking =
      {};

    // --------------------------------------------------------
    // Only import valid old records.
    // --------------------------------------------------------

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        oldTracking
      )
    ) {
      if (
        !isValidTrackingRecord(
          record
        )
      ) {
        console.log(
          `[TRACKING RESET] Ignoring invalid old record ${trainNo}`
        );

        continue;
      }

      tracking[
        trainNo
      ] = {
        ...record
      };
    }

    // ========================================================
    // DEFAULT GATES
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
    // BOARD CANDIDATES
    // ========================================================

    const boardCandidates =
      [];

    // ========================================================
    // PROCESS STATION BOARD
    // ========================================================

    for (
      const item of
        trainsArray
    ) {
      const train =
        item?.train || {};

      const live =
        item?.live || {};

      const stop =
        item?.stop || {};

      const trainNo =
        String(
          train.number ||
            item.trainNumber ||
            item.number ||
            ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train.name ||
        item.trainName ||
        item.name ||
        `Express ${trainNo}`;

      if (
        !isBoardTrainValid(
          item
        )
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - train is no longer valid on station board`
        );

        continue;
      }

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
          train,
          item
        );

      // ------------------------------------------------------
      // IMPORTANT FALLBACK:
      // If API provides no origin/destination object but the
      // train name itself identifies the corridor, use the
      // known route only for these known trains.
      // ------------------------------------------------------

      let finalCorridor =
        corridor;

      if (
        !finalCorridor
      ) {
        const nameText =
          normalizeText(
            trainName
          );

        if (
          nameText.includes(
            "TIRUPATI"
          )
        ) {
          finalCorridor =
            "MAS";
        }

        if (
          nameText.includes(
            "CHENNAI"
          ) ||
          nameText.includes(
            "TAMBARAM"
          )
        ) {
          finalCorridor =
            "TPTY";
        }
      }

      if (
        !finalCorridor
      ) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} | ${origin || "?"} -> ${
            destination || "?"
          } | corridor not confirmed`
        );

        continue;
      }

      const delayMinutes =
        Number(
          live.delayMinutes ||
            live.delay ||
            item.delayMinutes ||
            0
        );

      const arrivalTime =
        stop.arrival ||
        live.expectedArrivalTime ||
        item.arrival ||
        item.arrivalTime ||
        "";

      const departureTime =
        stop.departure ||
        live.expectedDepartureTime ||
        item.departure ||
        item.departureTime ||
        arrivalTime;

      const arrivalMinutes =
        parseTimeToMinutes(
          arrivalTime,
          delayMinutes
        );

      const departureMinutes =
        parseTimeToMinutes(
          departureTime,
          delayMinutes
        );

      if (
        arrivalMinutes ===
        -1
      ) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} - no usable arrival time`
        );

        continue;
      }

      const diff =
        calculateTimeDifference(
          arrivalMinutes,
          currentMin
        );

      if (
        diff < -15 ||
        diff >
          UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      const previous =
        tracking[
          trainNo
        ] || {};

      // ------------------------------------------------------
      // NEVER allow invalid ETA from old tracking
      // ------------------------------------------------------

      const etaMinutes =
        Math.max(
          0,
          Math.round(
            diff
          )
        );

      const record = {
        trainNo,

        name:
          trainName,

        origin:
          origin ||
          "Southern side",

        destination:
          destination ||
          "Gudur",

        corridor:
          finalCorridor,

        etaMinutes:
          etaMinutes,

        delayMinutes:
          delayMinutes,

        direction:
          "TOWARD GUDUR",

        platform:
          String(
            live.platform ||
              stop.platform ||
              item.platform ||
              "—"
          ),

        state:
          previous.state ||
          "APPROACHING_GUDUR",

        gateStatus:
          previous.gateStatus ||
          "OPEN",

        lastSeen:
          new Date().toISOString()
      };

      // ------------------------------------------------------
      // If train is already passed, don't resurrect it.
      // ------------------------------------------------------

      if (
        previous.state ===
        "PASSED_GATE"
      ) {
        continue;
      }

      tracking[
        trainNo
      ] = {
        ...previous,
        ...record
      };

      boardCandidates.push(
        record
      );

      console.log(
        `[INBOUND ${finalCorridor}] ${trainNo} ${trainName} | ${origin || "?"} -> ${
          destination || "?"
        } | ETA ${etaMinutes}m | state=${
          record.state
        }`
      );
    }

    // ========================================================
    // STAGE 2
    // ========================================================

    const liveCandidates =
      boardCandidates
        .filter(
          (train) =>
            safeEta(
              train.etaMinutes,
              999
            ) <=
            LIVE_VERIFY_ETA_MINUTES
        )
        .sort(
          (a, b) =>
            safeEta(
              a.etaMinutes,
              999
            ) -
            safeEta(
              b.etaMinutes,
              999
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
        "\n[LIVE QUEUE ORDER]"
      );

      liveCandidates.forEach(
        (
          train,
          index
        ) => {
          console.log(
            `  ${
              index + 1
            }. ${
              train.trainNo
            } ${
              train.name
            } | ${
              train.corridor
            } | ETA ${
              safeEta(
                train.etaMinutes
              )
            }m | state=${
              train.state
            }`
          );
        }
      );
    }

    // ========================================================
    // LIVE CHECK
    // ========================================================

    let liveVerifiedCount =
      0;

    let apiRequests =
      1;

    for (
      const train of
        liveCandidates.slice(
          0,
          MAX_LIVE_CALLS
        )
    ) {
      try {
        console.log(
          `\n[LIVE] Checking train ${train.trainNo}...`
        );

        const liveData =
          await fetchLiveTrain(
            train.trainNo
          );

        apiRequests++;

        if (
          !liveData
        ) {
          console.log(
            `[LIVE FAILED] ${train.trainNo} - empty response`
          );

          continue;
        }

        liveVerifiedCount++;

        const currentLocation =
          liveData.currentLocation ||
          {};

        const liveStatus =
          getLiveStatus(
            currentLocation
          );

        const liveStation =
          getLiveStationCode(
            currentLocation
          );

        const actual =
          currentLocation.isActualPosition ===
          true;

        const coords =
          getLiveCoordinates(
            currentLocation
          );

        const gate =
          getGateCoordinates(
            train.corridor
          );

        let liveDistance =
          null;

        if (
          coords &&
          gate
        ) {
          liveDistance =
            distanceKm(
              coords.lat,
              coords.lng,
              gate.lat,
              gate.lng
            );
        }

        const previous =
          tracking[
            train.trainNo
          ] || {};

        console.log(
          `[LIVE VERIFIED] ${train.trainNo} | ${train.corridor} | status=${
            liveStatus ||
            "unknown"
          } | station=${
            liveStation ||
            "unknown"
          } | distance=${
            liveDistance !== null
              ? `${liveDistance.toFixed(
                  3
                )} km`
              : "unknown"
          } | actual=${actual} | previousState=${
            previous.state ||
            train.state
          }`
        );

        // ------------------------------------------------------
        // UPDATE STATE
        // ------------------------------------------------------

        const updatedRecord =
          updateTrackingFromLive(
            train,
            liveData,
            previous
          );

        tracking[
          train.trainNo
        ] = {
          ...tracking[
            train.trainNo
          ],

          ...updatedRecord,

          // ALWAYS keep current ETA.
          etaMinutes:
            safeEta(
              train.etaMinutes,
              0
            ),

          lastLiveCheck:
            new Date().toISOString()
        };

        // ------------------------------------------------------
        // GATE CLOSED
        // ------------------------------------------------------

        if (
          updatedRecord.state ===
            "AT_GATE" &&
          updatedRecord.gateStatus ===
            "CLOSED"
        ) {
          const payload = {
            status:
              "CLOSED",

            waitMinutes:
              Math.max(
                1,
                safeEta(
                  train.etaMinutes,
                  1
                ) + 2
              ),

            activeTrain:
              `${train.trainNo} ${train.name}`,

            direction:
              "TOWARD GUDUR",

            corridor:
              train.corridor,

            trainNo:
              train.trainNo,

            state:
              "AT_GATE"
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

      } catch (error) {
        apiRequests++;

        if (
          error.response
        ) {
          console.error(
            `[LIVE ERROR] ${train.trainNo} | HTTP ${error.response.status}`
          );
        } else {
          console.error(
            `[LIVE ERROR] ${train.trainNo} | ${error.message}`
          );
        }
      }
    }

    // ========================================================
    // REBUILD UPCOMING
    // ========================================================

    const merged =
      new Map();

    // --------------------------------------------------------
    // Current board trains ALWAYS get current ETA.
    // --------------------------------------------------------

    for (
      const train of
        boardCandidates
    ) {
      const tracked =
        tracking[
          train.trainNo
        ] || {};

      if (
        tracked.state ===
        "PASSED_GATE"
      ) {
        continue;
      }

      merged.set(
        train.trainNo,
        {
          ...tracked,
          ...train,

          // Current board ETA ALWAYS wins.
          etaMinutes:
            safeEta(
              train.etaMinutes,
              0
            )
        }
      );
    }

    // --------------------------------------------------------
    // Keep tracked platform/departed/gate trains.
    // --------------------------------------------------------

    for (
      const [
        trainNo,
        tracked
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !isValidTrackingRecord(
          tracked
        )
      ) {
        continue;
      }

      if (
        tracked.state ===
        "PASSED_GATE"
      ) {
        continue;
      }

      if (
        tracked.state !==
          "AT_GUDUR_STATION" &&
        tracked.state !==
          "DEPARTED_GUDUR" &&
        tracked.state !==
          "AT_GATE"
      ) {
        continue;
      }

      if (
        !merged.has(
          trainNo
        )
      ) {
        merged.set(
          trainNo,
          {
            ...tracked,

            etaMinutes:
              safeEta(
                tracked.etaMinutes,
                0
              )
          }
        );
      }
    }

    // ========================================================
    // UPCOMING FINAL LIST
    // ========================================================

    const upcomingList =
      Array.from(
        merged.values()
      )
        .filter(
          (train) =>
            train.state !==
            "PASSED_GATE"
        )
        .map(
          (train) => ({
            ...train,

            etaMinutes:
              safeEta(
                train.etaMinutes,
                0
              )
          })
        )
        .sort(
          (a, b) =>
            a.etaMinutes -
            b.etaMinutes
        )
        .slice(
          0,
          5
        );

    // ========================================================
    // TRACKING CLEANUP
    // ========================================================
    //
    // IMPORTANT:
    // Never use an invalid timestamp.
    // Never calculate millions of minutes.
    //

    const nowMs =
      Date.now();

    for (
      const [
        trainNo,
        record
      ] of Object.entries(
        tracking
      )
    ) {
      if (
        !isValidTrackingRecord(
          record
        )
      ) {
        delete tracking[
          trainNo
        ];

        continue;
      }

      // ------------------------------------------------------
      // PASSED GATE
      // ------------------------------------------------------

      if (
        record.state ===
        "PASSED_GATE"
      ) {
        delete tracking[
          trainNo
        ];

        continue;
      }

      // ------------------------------------------------------
      // If train is currently on board, keep it.
      // ------------------------------------------------------

      if (
        boardCandidates.some(
          (train) =>
            train.trainNo ===
            trainNo
        )
      ) {
        continue;
      }

      // ------------------------------------------------------
      // Parse timestamp safely.
      // ------------------------------------------------------

      const timestamp =
        record.lastLiveCheck ||
        record.lastSeen;

      if (!timestamp) {
        continue;
      }

      const timestampMs =
        new Date(
          timestamp
        ).getTime();

      if (
        !Number.isFinite(
          timestampMs
        ) ||
        timestampMs <= 0
      ) {
        console.log(
          `[TRACKING RESET] Invalid timestamp for ${trainNo}`
        );

        delete tracking[
          trainNo
        ];

        continue;
      }

      const ageMinutes =
        (
          nowMs -
          timestampMs
        ) /
        60000;

      if (
        ageMinutes >
          TRACKING_RETENTION_MINUTES
      ) {
        console.log(
          `[TRACKING CLEANUP] Removing ${trainNo} after ${Math.round(
            ageMinutes
          )} minutes`
        );

        delete tracking[
          trainNo
        ];
      }
    }

    // ========================================================
    // FIREBASE
    // ========================================================

    await trackingRef.set(
      tracking
    );

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        upcomingList,

      lastUpdated:
        now.toLocaleTimeString(
          "en-IN"
        )
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
      `Upcoming trains: ${upcomingList.length}`
    );

    console.log(
      `Live verified: ${liveVerifiedCount}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    // ========================================================
    // UPCOMING
    // ========================================================

    if (
      upcomingList.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      upcomingList.forEach(
        (
          train,
          index
        ) => {
          console.log(
            `${index + 1}. ${
              train.trainNo
            } ${
              train.name
            } | ${
              train.corridor
            } LINE | ETA ${
              safeEta(
                train.etaMinutes,
                0
              )
            }m | PF ${
              train.platform ||
              "—"
            } | ${
              train.origin ||
              "?"
            } -> ${
              train.destination ||
              "?"
            } | state=${
              train.state ||
              "APPROACHING_GUDUR"
            }`
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
  " Chennai Gate:  14.1396639 N, 79.8441306 E  "
);

console.log(
  " Tirupati Gate: 14.1402056 N, 79.8436000 E  "
);

console.log(
  "=========================================="
);

console.log(
  `RailRadar API Key: ${
    RAILRADAR_API_KEY
      ? "Configured"
      : "MISSING"
  }`
);

console.log(
  "Firebase: Configured"
);

console.log(
  "Direction: Southern side -> Gudur only"
);

console.log(
  "Live verification: 60 minutes"
);

console.log(
  "Maximum live calls: 2"
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
  "RailRadar departed status overrides missing GPS"
);

console.log(
  "Gate closure requires usable live gate position"
);

console.log(
  "Invalid old tracking records are ignored"
);

console.log(
  "Current board ETA always overrides old ETA"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN
// ============================================================

updateGateSystem();

// ============================================================
// EVERY 3 MINUTES
// ============================================================

setInterval(
  updateGateSystem,
  180000
);
