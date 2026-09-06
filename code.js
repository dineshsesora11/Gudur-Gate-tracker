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
    "Use FIREBASE_SERVICE_ACCOUNT or place serviceAccountKey.json beside code.js."
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

// Train must be this close before the gate closes.
const GATE_TRIGGER_DISTANCE_KM = 0.60;

// Once train is this far beyond the gate, gate can reopen.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Only trains within this ETA are candidates for live checking.
const LIVE_VERIFY_ETA_MINUTES = 60;

// Maximum RailRadar live calls per run.
const MAX_LIVE_CALLS = 2;

// Keep historical train tracking for this long.
const TRACKING_RETENTION_MINUTES = 45;

// ============================================================
// TRAIN CORRIDOR CODES
// ============================================================
//
// MAS = Chennai-side train approaching Gudur
// TPTY = Tirupati-side train approaching Gudur
//
// We determine the corridor primarily from destination.
//
// A train whose destination is Chennai/MAS is coming from
// the southern side and therefore approaches the TPTY-side
// corridor.
//
// A train whose destination is Tirupati/TPTY is coming from
// the Chennai/northern side and therefore approaches the
// MAS-side corridor.
//

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
// CONTAINS ANY
// ============================================================

function containsAny(text, values) {
  const normalized =
    normalizeText(text);

  return values.some((value) =>
    normalized.includes(
      normalizeText(value)
    )
  );
}

// ============================================================
// GET ORIGIN
// ============================================================

function getOrigin(train, item) {
  return (
    train.origin?.code ||
    train.origin?.name ||
    train.source?.code ||
    train.source?.name ||
    train.from?.code ||
    train.from?.name ||
    train.fromStation?.code ||
    train.fromStation?.name ||
    train.startStation?.code ||
    train.startStation?.name ||
    item.origin?.code ||
    item.origin?.name ||
    item.source?.code ||
    item.source?.name ||
    item.from?.code ||
    item.from?.name ||
    item.fromStation?.code ||
    item.fromStation?.name ||
    ""
  );
}

// ============================================================
// GET DESTINATION
// ============================================================

function getDestination(train, item) {
  return (
    train.destination?.code ||
    train.destination?.name ||
    train.to?.code ||
    train.to?.name ||
    train.destinationStation?.code ||
    train.destinationStation?.name ||
    train.endStation?.code ||
    train.endStation?.name ||
    item.destination?.code ||
    item.destination?.name ||
    item.to?.code ||
    item.to?.name ||
    item.destinationStation?.code ||
    item.destinationStation?.name ||
    ""
  );
}

// ============================================================
// SOUTHERN DESTINATIONS
// ============================================================

const SOUTHERN_DESTINATIONS = [
  "TPTY",
  "TIRUPATI",

  "RU",
  "RENIGUNTA",

  "TVC",
  "THIRUVANANTHAPURAM",

  "CAPE",
  "KANYAKUMARI",

  "TEN",
  "TIRUNELVELI",

  "MDU",
  "MADURAI",

  "ERS",
  "ERNAKULAM",

  "KCVL",
  "KCVL",

  "QLN",
  "KOLLAM",

  "ALLP",
  "ALLEPPEY",

  "AWY",
  "ALUVA",

  "KTYM",
  "KOTTAYAM",

  "SRR",
  "SHORANUR",

  "MAQ",
  "MANGALURU",

  "CAN",
  "KANNUR",

  "CLT",
  "KOZHIKODE",

  "PGT",
  "PALAKKAD",

  "ED",
  "ERODE",

  "TCR",
  "THRISSUR",

  "KZJ",
  "KAZIPET"
];

// ============================================================
// CHENNAI DESTINATIONS
// ============================================================

const CHENNAI_DESTINATIONS = [
  "MAS",
  "CHENNAI",
  "CHENNAI CENTRAL",
  "MGR CHENNAI CENTRAL",

  "TBM",
  "TAMBARAM",

  "CGL",
  "CHENGALPATTU"
];

// ============================================================
// DESTINATION CODE EXTRACTION
// ============================================================

function extractStationCode(value) {
  const text =
    normalizeText(value);

  const match =
    text.match(/\b[A-Z]{2,5}\b/);

  return match
    ? match[0]
    : "";
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// Destination = Tirupati
//     => train is coming from Chennai/north
//     => MAS corridor
//
// Destination = Chennai
//     => train is coming from south
//     => TPTY corridor
//
// Unknown destination
//     => do NOT guess.
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
    normalizeText(destination);

  const destinationCode =
    extractStationCode(
      destination
    );

  // ----------------------------------------------------------
  // TOWARD TIRUPATI
  // ----------------------------------------------------------

  if (
    destinationCode === "TPTY" ||
    containsAny(
      destinationText,
      CHENNAI_DESTINATIONS.map(() => "")
    )
  ) {
    // This branch intentionally does nothing.
    // Destination classification below is explicit.
  }

  if (
    destinationCode === "TPTY" ||
    destinationText.includes("TIRUPATI")
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // TOWARD CHENNAI
  // ----------------------------------------------------------

  if (
    destinationCode === "MAS" ||
    destinationText.includes("CHENNAI")
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // OTHER SOUTHERN DESTINATION
  // ----------------------------------------------------------

  if (
    SOUTHERN_DESTINATIONS.includes(
      destinationCode
    ) ||
    SOUTHERN_DESTINATIONS.some(
      (value) =>
        destinationText.includes(value)
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
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const value =
    String(timeStr).trim();

  // ISO/date format
  const date =
    new Date(value);

  if (!isNaN(date.getTime())) {
    return (
      date.getHours() * 60 +
      date.getMinutes() +
      Number(delayMinutes || 0)
    );
  }

  // HH:MM
  const match =
    value.match(
      /(\d{1,2}):(\d{2})/
    );

  if (!match) {
    return -1;
  }

  return (
    parseInt(match[1], 10) * 60 +
    parseInt(match[2], 10) +
    Number(delayMinutes || 0)
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
// DISTANCE CALCULATION
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) / 180;

  const dLon =
    ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos(
      (lat1 * Math.PI) / 180
    ) *
      Math.cos(
        (lat2 * Math.PI) / 180
      ) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

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
// GET LIVE COORDINATES
// ============================================================

function getLiveCoordinates(
  currentLocation
) {
  if (!currentLocation) {
    return null;
  }

  const lat = Number(
    currentLocation.latitude ??
      currentLocation.lat ??
      currentLocation.location?.lat ??
      currentLocation.coordinates?.lat
  );

  const lng = Number(
    currentLocation.longitude ??
      currentLocation.lng ??
      currentLocation.lon ??
      currentLocation.location?.lng ??
      currentLocation.coordinates?.lng
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
// LIVE STATUS NORMALIZATION
// ============================================================

function getLiveStatus(
  currentLocation
) {
  return normalizeText(
    currentLocation?.status
  );
}

// ============================================================
// STATION CODE
// ============================================================

function getLiveStationCode(
  currentLocation
) {
  return normalizeText(
    currentLocation?.stationCode ||
      currentLocation?.station?.code ||
      ""
  );
}

// ============================================================
// IS DEPARTED STATUS?
// ============================================================
//
// IMPORTANT FIX:
//
// If RailRadar says "departed", this takes priority over
// missing GPS coordinates.
//
// This is the fix for 18521.
//

function isExplicitlyDeparted(
  currentLocation
) {
  const status =
    getLiveStatus(
      currentLocation
    );

  return (
    status.includes("DEPARTED") ||
    status.includes("LEFT") ||
    status.includes("DEPARTURE")
  );
}

// ============================================================
// IS AT GUDUR PLATFORM?
// ============================================================

function isAtGudurStation(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  const stationCode =
    getLiveStationCode(
      currentLocation
    );

  const stationName =
    normalizeText(
      currentLocation.stationName ||
        currentLocation.station?.name ||
        ""
    );

  const status =
    getLiveStatus(
      currentLocation
    );

  // ----------------------------------------------------------
  // CRITICAL:
  // A train marked DEPARTED is NOT considered at Gudur,
  // even if RailRadar still reports stationCode = GDR.
  // ----------------------------------------------------------

  if (
    isExplicitlyDeparted(
      currentLocation
    )
  ) {
    return false;
  }

  if (
    status.includes("RUNNING") ||
    status.includes("MOVING")
  ) {
    return false;
  }

  if (
    stationCode === "GDR" ||
    stationName.includes("GUDUR")
  ) {
    return (
      status.includes("AT STATION") ||
      status.includes("HALT") ||
      status.includes("ARRIVED") ||
      status === "" ||
      currentLocation.isHalt === true
    );
  }

  return false;
}

// ============================================================
// IS TRAIN MOVING?
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
    status.includes("RUNNING") ||
    status.includes("MOVING") ||
    status.includes("DEPARTED")
  ) {
    return true;
  }

  return speed > 2;
}

// ============================================================
// DETERMINE LIVE STATE
// ============================================================

function determineLiveState(
  currentLocation,
  previousRecord
) {
  // ----------------------------------------------------------
  // 1. AT GUDUR PLATFORM
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      currentLocation
    )
  ) {
    return "AT_GUDUR_STATION";
  }

  // ----------------------------------------------------------
  // 2. EXPLICIT DEPARTURE
  // ----------------------------------------------------------
  //
  // This is the major fix.
  //
  // Even without GPS, RailRadar's authoritative
  // "departed" status means the train has left the platform.
  //

  if (
    isExplicitlyDeparted(
      currentLocation
    )
  ) {
    return "DEPARTED_GUDUR";
  }

  // ----------------------------------------------------------
  // 3. MOVING AFTER BEING AT GUDUR
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
  // 4. ALREADY DEPARTED
  // ----------------------------------------------------------

  if (
    previousRecord?.state ===
      "DEPARTED_GUDUR"
  ) {
    return "DEPARTED_GUDUR";
  }

  // ----------------------------------------------------------
  // 5. ALREADY AT GATE
  // ----------------------------------------------------------

  if (
    previousRecord?.state ===
      "AT_GATE"
  ) {
    return "AT_GATE";
  }

  // ----------------------------------------------------------
  // 6. ALREADY PASSED GATE
  // ----------------------------------------------------------

  if (
    previousRecord?.state ===
      "PASSED_GATE"
  ) {
    return "PASSED_GATE";
  }

  // ----------------------------------------------------------
  // 7. DEFAULT
  // ----------------------------------------------------------

  return (
    previousRecord?.state ||
    "APPROACHING_GUDUR"
  );
}

// ============================================================
// GET GATE COORDINATES
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

  if (
    corridor === "TPTY"
  ) {
    return {
      lat: TIRUPATI_GATE_LAT,
      lng: TIRUPATI_GATE_LNG
    };
  }

  return null;
}

// ============================================================
// UPDATE TRACKING FROM LIVE RESPONSE
// ============================================================

function updateTrackingFromLive(
  trainRecord,
  liveData,
  previousRecord
) {
  const currentLocation =
    liveData?.currentLocation ||
    {};

  const now =
    new Date().toISOString();

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
      trainRecord.corridor
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
  // AT GUDUR PLATFORM
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
      `🟢 [AT GUDUR PLATFORM] ${trainRecord.trainNo} ${trainRecord.name} | ${trainRecord.corridor} | GATE OPEN`
    );
  }

  // ==========================================================
  // DEPARTED GUDUR
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
        `🔴 [GATE APPROACH] ${trainRecord.trainNo} ${trainRecord.name} | ${trainRecord.corridor} | ${distanceToGate.toFixed(
          3
        )} km | GATE CLOSED`
      );
    } else {
      console.log(
        `🟢 [DEPARTED GUDUR] ${trainRecord.trainNo} ${trainRecord.name} | ${trainRecord.corridor} | GATE OPEN${
          distanceToGate !== null
            ? ` | ${distanceToGate.toFixed(
                3
              )} km from gate`
            : " | GPS unavailable"
        }`
      );
    }
  }

  // ==========================================================
  // ALREADY AT GATE
  // ==========================================================

  else if (
    state === "AT_GATE"
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
        `🟢 [PASSED GATE] ${trainRecord.trainNo} ${trainRecord.name} | ${trainRecord.corridor} | ${distanceToGate.toFixed(
          3
        )} km | GATE OPEN`
      );
    } else {
      finalState =
        "AT_GATE";

      gateStatus =
        "CLOSED";

      console.log(
        `🔴 [AT GATE] ${trainRecord.trainNo} ${trainRecord.name} | ${trainRecord.corridor} | ${
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
  // PASSED GATE
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
  // APPROACHING GUDUR
  // ==========================================================

  else {
    finalState =
      "APPROACHING_GUDUR";

    gateStatus =
      "OPEN";

    console.log(
      `🟢 [APPROACHING GUDUR] ${trainRecord.trainNo} ${trainRecord.name} | ${trainRecord.corridor} | GATE OPEN`
    );
  }

  return {
    ...trainRecord,

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

    lastLiveUpdate:
      now
  };
}

// ============================================================
// CREATE GATE PAYLOAD
// ============================================================

function createGatePayload(
  trainRecord,
  waitMinutes
) {
  return {
    status: "CLOSED",

    waitMinutes:
      Math.max(
        1,
        Math.ceil(
          Number(waitMinutes || 1)
        )
      ),

    activeTrain:
      `${trainRecord.trainNo} ${trainRecord.name}`,

    direction:
      "TOWARD GUDUR",

    corridor:
      trainRecord.corridor,

    trainNo:
      trainRecord.trainNo,

    state:
      "AT_GATE"
  };
}

// ============================================================
// IS UPCOMING BOARD STATUS
// ============================================================

function isUpcomingStatus(
  item
) {
  const live =
    item.live || {};

  const stop =
    item.stop || {};

  const status =
    normalizeText(
      live.status ||
        item.status ||
        ""
    );

  if (
    status.includes("DEPARTED") ||
    status.includes("CANCELLED") ||
    status.includes("CANCELED") ||
    status.includes("TERMINATED")
  ) {
    return false;
  }

  const arrival =
    stop.arrival ||
    live.expectedArrivalTime ||
    "";

  return Boolean(
    arrival
  );
}

// ============================================================
// FETCH LIVE TRAIN
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
// UPDATE GATE SYSTEM
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
    // STAGE 1
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

      return;
    }

    console.log(
      `RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // LOAD TRACKING STATE
    // ========================================================

    const trackingSnapshot =
      await trackingRef.once(
        "value"
      );

    const previousTracking =
      trackingSnapshot.val() ||
      {};

    const tracking =
      {
        ...previousTracking
      };

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
    // UPCOMING BOARD LIST
    // ========================================================

    const boardCandidates =
      [];

    // ========================================================
    // PROCESS BOARD
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
        String(
          train.number ||
            item.trainNumber ||
            ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train.name ||
        item.trainName ||
        `Express ${trainNo}`;

      // ------------------------------------------------------
      // Ignore explicitly terminated/departed board entries
      // ------------------------------------------------------

      if (
        !isUpcomingStatus(
          item
        )
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - RailRadar says train is no longer upcoming`
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

      if (!corridor) {
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
            0
        );

      const arrivalTime =
        stop.arrival ||
        live.expectedArrivalTime ||
        "";

      const departureTime =
        stop.departure ||
        live.expectedDepartureTime ||
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
        arrivalMinutes === -1
      ) {
        continue;
      }

      const diff =
        calculateTimeDifference(
          arrivalMinutes,
          currentMin
        );

      // ------------------------------------------------------
      // Ignore trains far outside useful window
      // ------------------------------------------------------

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
      // If board shows ETA 0 but live state previously
      // passed gate, don't resurrect the train.
      // ------------------------------------------------------

      if (
        previous.state ===
        "PASSED_GATE"
      ) {
        continue;
      }

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

        corridor,

        etaMinutes:
          Math.max(
            0,
            diff
          ),

        delayMinutes,

        direction:
          "TOWARD GUDUR",

        platform:
          String(
            live.platform ||
              stop.platform ||
              "1"
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
      // Store / refresh tracking
      // ------------------------------------------------------

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
        `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${origin || "?"} -> ${
          destination || "?"
        } | ETA ${Math.max(
          0,
          diff
        )}m | state=${
          record.state
        }`
      );
    }

    // ========================================================
    // STAGE 2
    // LIVE VERIFICATION QUEUE
    // ========================================================

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
        (train, index) => {
          console.log(
            `  ${index + 1}. ${
              train.trainNo
            } ${
              train.name
            } | ${
              train.corridor
            } | ETA ${
              train.etaMinutes
            }m | state=${
              train.state
            }`
          );
        }
      );
    }

    // ========================================================
    // LIVE CALLS
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

        if (!liveData) {
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

        // ======================================================
        // UPDATE STATE
        // ======================================================

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

          liveStatus:
            liveStatus,

          liveStation:
            liveStation,

          lastLiveCheck:
            new Date().toISOString()
        };

        // ======================================================
        // GATE CONTROL
        // ======================================================

        if (
          updatedRecord.state ===
            "AT_GATE" &&
          updatedRecord.gateStatus ===
            "CLOSED"
        ) {
          const payload =
            createGatePayload(
              updatedRecord,
              Math.max(
                1,
                train.etaMinutes + 2
              )
            );

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

        // ======================================================
        // PASSED GATE
        // ======================================================

        if (
          updatedRecord.state ===
          "PASSED_GATE"
        ) {
          console.log(
            `🟢 [GATE CLEAR] ${train.trainNo} ${train.name} | ${train.corridor}`
          );
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
    // REBUILD UPCOMING LIST
    // ========================================================
    //
    // IMPORTANT:
    //
    // A train at Gudur platform must remain visible.
    //
    // A train that has departed Gudur must also remain visible
    // while it is being tracked toward the gate.
    //

    const merged =
      new Map();

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
          ...train,
          ...tracked
        }
      );
    }

    // --------------------------------------------------------
    // Add tracked trains that disappeared temporarily from
    // station board.
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
        tracked.state ===
        "PASSED_GATE"
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
          tracked
        );
      }
    }

    // ========================================================
    // FINAL UPCOMING LIST
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
        .sort(
          (a, b) =>
            Number(
              a.etaMinutes || 0
            ) -
            Number(
              b.etaMinutes || 0
            )
        )
        .slice(0, 5);

    // ========================================================
    // CLEAN OLD TRACKING RECORDS
    // ========================================================

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
      const lastSeenMs =
        new Date(
          record.lastLiveCheck ||
            record.lastSeen ||
            0
        ).getTime();

      const ageMinutes =
        (
          nowMs -
          lastSeenMs
        ) /
        60000;

      // Remove passed trains immediately.
      if (
        record.state ===
        "PASSED_GATE"
      ) {
        delete tracking[
          trainNo
        ];

        continue;
      }

      // Remove stale tracking records.
      if (
        Number.isFinite(
          ageMinutes
        ) &&
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
    // FIREBASE UPDATE
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
    // SUCCESS LOG
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
    // UPCOMING DISPLAY
    // ========================================================

    if (
      upcomingList.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      upcomingList.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${
              train.trainNo
            } ${
              train.name
            } | ${
              train.corridor
            } LINE | ETA ${
              train.etaMinutes
            }m | PF ${
              train.platform ||
              "1"
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
  "RailRadar API Key: " +
    (
      RAILRADAR_API_KEY
        ? "Configured"
        : "MISSING"
    )
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
  180000
);
