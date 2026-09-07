const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

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
    "Set FIREBASE_SERVICE_ACCOUNT or place serviceAccountKey.json beside code.js."
  );
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db = admin.database();

const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY ||
  "YOUR_RAILRADAR_API_KEY";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// LOCATION CONFIGURATION
// ============================================================

const GDR = {
  lat: 14.14842,
  lng: 79.84524
};

const CHENNAI_GATE = {
  lat: 14.1396639,
  lng: 79.8441306
};

const TIRUPATI_GATE = {
  lat: 14.1402056,
  lng: 79.8436000
};

// ============================================================
// DISTANCE SETTINGS
// ============================================================

const WARNING_DISTANCE_KM = 1.00;

const CLOSE_DISTANCE_KM = 0.60;

const CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// UPCOMING TRAIN SETTINGS
// ============================================================

// Increased from 4 hours to 8 hours so more trains can
// appear in the upcoming list.

const UPCOMING_WINDOW_MINUTES = 480;

// Maximum number of trains displayed in Firebase.

const MAX_UPCOMING_TRAINS = 10;

// Maximum live GPS requests in one cycle.

const MAX_LIVE_REQUESTS = 7;

// ============================================================
// TIMEZONE
// ============================================================

const INDIA_TIMEZONE = "Asia/Kolkata";

// ============================================================
// APPROVED TRAIN LISTS
// ============================================================
//
// IMPORTANT:
//
// These lists are used for GATE CONTROL.
//
// Do NOT add random train numbers just to make the
// upcoming display longer.
//
// The upcoming display has separate logic.
//

const APPROVED_TPTY_TRAINS = new Set([
  "03251",
  "05074",
  "04717",
  "07669",
  "07670",
  "12296",
  "12733",
  "12734",
  "12762",
  "12763",
  "12764",
  "14723",
  "17261",
  "17262",
  "17479",
  "17480",
  "17487",
  "17488",
  "22871"
]);

const APPROVED_MAS_TRAINS = new Set([
  "12622",
  "12625",
  "12626",
  "12759",
  "12760",
  "12851",
  "16031",
  "16032",
  "17237"
]);

const APPROVED_OTHER_TRAINS = new Set([
  "12743",
  "12744",
  "20498",
  "67226"
]);

const ALL_APPROVED_TRAINS = new Set([
  ...APPROVED_TPTY_TRAINS,
  ...APPROVED_MAS_TRAINS,
  ...APPROVED_OTHER_TRAINS
]);

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
// GENERIC TEXT MATCHING
// ============================================================

function containsAny(text, values) {
  const normalized = normalizeText(text);

  return values.some((value) =>
    normalized.includes(
      normalizeText(value)
    )
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(train, item) {
  return (
    train.origin ||
    train.source ||
    train.from ||
    train.fromStation ||
    train.startStation ||
    train.start ||
    item.origin ||
    item.source ||
    item.from ||
    item.fromStation ||
    item.startStation ||
    ""
  );
}

// ============================================================
// DESTINATION
// ============================================================

function getDestination(train, item) {
  return (
    train.destination ||
    train.to ||
    train.destinationStation ||
    train.endStation ||
    item.destination ||
    item.to ||
    item.destinationStation ||
    item.endStation ||
    ""
  );
}

// ============================================================
// CHENNAI SIDE DETECTION
// ============================================================

function isFromChennaiSide(train, item) {
  const origin = getOrigin(
    train,
    item
  );

  const text = normalizeText(origin);

  if (!text) {
    return false;
  }

  return containsAny(text, [
    "CHENNAI",
    "CHENNAI CENTRAL",
    "MGR CHENNAI CENTRAL",
    "DR MGR CHENNAI CENTRAL",
    "PURATCHI THALAIVAR DR MGR CENTRAL",
    "MAS",
    "AVADI",
    "PERAMBUR",
    "SULLURUPETA",
    "NAYUDUPETA"
  ]);
}

// ============================================================
// TIRUPATI SIDE DETECTION
// ============================================================

function isFromTirupatiSide(train, item) {
  const origin = getOrigin(
    train,
    item
  );

  const text = normalizeText(origin);

  if (!text) {
    return false;
  }

  return containsAny(text, [
    "TIRUPATI",
    "TIRUPATI MAIN",
    "TPTY",
    "RENIGUNTA"
  ]);
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function getExplicitDirection(
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

  const direction = fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");

  if (!direction) {
    return null;
  }

  // ----------------------------------------------------------
  // TOWARD GUDUR
  // ----------------------------------------------------------

  if (
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("APPROACHING GUDUR") ||
    direction.includes("ARRIVING GUDUR")
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // AWAY FROM GUDUR
  // ----------------------------------------------------------

  if (
    direction.includes("FROM GUDUR") ||
    direction.includes("GUDUR OUTBOUND") ||
    direction.includes("OUTBOUND") ||
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

  return null;
}

// ============================================================
// APPROVED CORRIDOR
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo = String(
    train.number || ""
  ).trim();

  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // EXPLICITLY OUTBOUND
  // ----------------------------------------------------------

  if (explicitDirection === false) {
    return null;
  }

  // ----------------------------------------------------------
  // TIRUPATI
  // ----------------------------------------------------------

  if (
    APPROVED_TPTY_TRAINS.has(trainNo)
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI
  // ----------------------------------------------------------

  if (
    APPROVED_MAS_TRAINS.has(trainNo)
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // OTHER APPROVED
  // ----------------------------------------------------------

  if (
    APPROVED_OTHER_TRAINS.has(trainNo)
  ) {
    return "OTHER";
  }

  return null;
}

// ============================================================
// DISPLAY CORRIDOR
// ============================================================
//
// This is intentionally separate from gate-control corridor.
//
// It allows the Upcoming Trains list to show relevant
// Chennai/Tirupati-side trains even when the train number
// is not present in the strict gate-control list.
//
// GATE CONTROL NEVER uses this function.
//

function determineDisplayCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo = String(
    train.number || ""
  ).trim();

  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  // Never show an explicitly outbound train.

  if (explicitDirection === false) {
    return null;
  }

  // ----------------------------------------------------------
  // ORIGIN BASED CLASSIFICATION
  // ----------------------------------------------------------

  if (
    isFromChennaiSide(
      train,
      item
    )
  ) {
    return "MAS";
  }

  if (
    isFromTirupatiSide(
      train,
      item
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // APPROVED TRAIN FALLBACK
  // ----------------------------------------------------------

  if (
    APPROVED_MAS_TRAINS.has(trainNo)
  ) {
    return "MAS";
  }

  if (
    APPROVED_TPTY_TRAINS.has(trainNo)
  ) {
    return "TPTY";
  }

  if (
    APPROVED_OTHER_TRAINS.has(trainNo)
  ) {
    return "OTHER";
  }

  // ----------------------------------------------------------
  // UNKNOWN
  // ----------------------------------------------------------

  return null;
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

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// BEARING
// ============================================================

function calculateBearing(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const startLat =
    (lat1 * Math.PI) / 180;

  const startLon =
    (lon1 * Math.PI) / 180;

  const endLat =
    (lat2 * Math.PI) / 180;

  const endLon =
    (lon2 * Math.PI) / 180;

  const y =
    Math.sin(
      endLon - startLon
    ) *
    Math.cos(endLat);

  const x =
    Math.cos(startLat) *
      Math.sin(endLat) -
    Math.sin(startLat) *
      Math.cos(endLat) *
      Math.cos(
        endLon - startLon
      );

  const bearing =
    (Math.atan2(y, x) *
      180) /
    Math.PI;

  return (
    (bearing + 360) % 360
  );
}

// ============================================================
// BEARING DIFFERENCE
// ============================================================

function bearingDifference(
  a,
  b
) {
  let diff =
    Math.abs(a - b);

  if (diff > 180) {
    diff = 360 - diff;
  }

  return diff;
}

// ============================================================
// GET LIVE COORDINATES
// ============================================================

function getLiveCoordinates(
  liveData
) {
  const possible =
    liveData?.currentLocation ||
    liveData?.location ||
    liveData?.currentPosition ||
    liveData?.position ||
    null;

  if (!possible) {
    return null;
  }

  const lat = Number(
    possible.lat ??
      possible.latitude
  );

  const lng = Number(
    possible.lng ??
      possible.lon ??
      possible.longitude
  );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  if (
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }

  return {
    lat,
    lng
  };
}

// ============================================================
// LIVE DIRECTION CHECK
// ============================================================

function isTowardGudur(
  liveData,
  trainLat,
  trainLng
) {
  if (
    !liveData
  ) {
    return false;
  }

  const directionText =
    normalizeText(
      liveData.direction ||
        liveData.travelDirection ||
        liveData.runningDirection ||
        ""
    );

  // ----------------------------------------------------------
  // EXPLICIT DIRECTION
  // ----------------------------------------------------------

  if (
    directionText.includes(
      "TOWARD GUDUR"
    ) ||
    directionText.includes(
      "TOWARDS GUDUR"
    ) ||
    directionText.includes(
      "TO GUDUR"
    ) ||
    directionText.includes(
      "INBOUND"
    )
  ) {
    return true;
  }

  if (
    directionText.includes(
      "FROM GUDUR"
    ) ||
    directionText.includes(
      "OUTBOUND"
    ) ||
    directionText.includes(
      "TO CHENNAI"
    ) ||
    directionText.includes(
      "TO TIRUPATI"
    )
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  const distanceToGDR =
    distanceKm(
      trainLat,
      trainLng,
      GDR.lat,
      GDR.lng
    );

  if (
    distanceToGDR <=
    CLEAR_DISTANCE_KM
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // UNKNOWN
  // ----------------------------------------------------------
  //
  // Unknown direction is NOT automatically accepted.
  //
  // This protects against closing the gate for an
  // outbound train.
  //

  return false;
}

// ============================================================
// INDIA TIME FORMATTER
// ============================================================

function formatIndiaDateTime(
  date
) {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone:
        INDIA_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).format(date);
}

function formatIndiaTime(
  date
) {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone:
        INDIA_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).format(date);
}

// ============================================================
// GET INDIA MINUTES
// ============================================================

function getIndiaMinutes(
  date
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone:
          INDIA_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(date);

  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (
      part.type === "hour"
    ) {
      hour =
        Number(part.value);
    }

    if (
      part.type === "minute"
    ) {
      minute =
        Number(part.value);
    }
  }

  return (
    hour * 60 +
    minute
  );
}

// ============================================================
// TIME PARSER
// ============================================================
//
// RailRadar can provide either:
//  - ISO datetime
//  - HH:mm
//
// Bare HH:mm is explicitly interpreted as IST.
//

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const value =
    String(timeStr).trim();

  // ----------------------------------------------------------
  // HH:mm
  // ----------------------------------------------------------

  const simpleMatch =
    value.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (simpleMatch) {
    const hour =
      Number(
        simpleMatch[1]
      );

    const minute =
      Number(
        simpleMatch[2]
      );

    if (
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      return (
        hour * 60 +
        minute +
        Number(
          delayMinutes || 0
        )
      );
    }
  }

  // ----------------------------------------------------------
  // ISO / DATE STRING
  // ----------------------------------------------------------

  const date =
    new Date(value);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    return (
      getIndiaMinutes(date) +
      Number(
        delayMinutes || 0
      )
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
// GET BOARD ARRIVAL
// ============================================================

function getBoardArrival(
  train,
  live,
  stop,
  item
) {
  return (
    stop.arrival ||
    live.expectedArrivalTime ||
    live.arrivalTime ||
    item.arrival ||
    item.arrivalTime ||
    train.arrival ||
    ""
  );
}

// ============================================================
// GET BOARD DEPARTURE
// ============================================================

function getBoardDeparture(
  train,
  live,
  stop,
  item,
  arrival
) {
  return (
    stop.departure ||
    live.expectedDepartureTime ||
    live.departureTime ||
    item.departure ||
    item.departureTime ||
    train.departure ||
    arrival ||
    ""
  );
}

// ============================================================
// BUILD UPCOMING LIST
// ============================================================
//
// IMPORTANT:
//
// This function is for DISPLAY ONLY.
//
// It does NOT control gates.
//
// The display list uses:
// 1. explicit direction
// 2. origin
// 3. approved train fallback
//
// This prevents the Upcoming Trains list from being
// restricted only to the small gate-control train list.
//

function buildUpcomingFromBoard(
  trainsArray,
  now
) {
  const currentMinutes =
    getIndiaMinutes(now);

  const upcoming = [];

  for (
    const item of trainsArray
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
          item.number ||
          ""
      ).trim();

    if (!trainNo) {
      continue;
    }

    const trainName =
      train.name ||
      item.name ||
      `Train ${trainNo}`;

    // --------------------------------------------------------
    // DISPLAY CORRIDOR
    // --------------------------------------------------------

    const corridor =
      determineDisplayCorridor(
        train,
        live,
        stop,
        item
      );

    if (!corridor) {
      continue;
    }

    // --------------------------------------------------------
    // ARRIVAL
    // --------------------------------------------------------

    const arrivalStr =
      getBoardArrival(
        train,
        live,
        stop,
        item
      );

    const delayMinutes =
      Number(
        live.delayMinutes ||
          item.delayMinutes ||
          train.delayMinutes ||
          0
      );

    const arrivalMinutes =
      parseTimeToMinutes(
        arrivalStr,
        delayMinutes
      );

    if (
      arrivalMinutes === -1
    ) {
      continue;
    }

    // --------------------------------------------------------
    // ETA
    // --------------------------------------------------------

    const eta =
      calculateTimeDifference(
        arrivalMinutes,
        currentMinutes
      );

    // Only show trains in the configured window.

    if (
      eta < -30 ||
      eta >
        UPCOMING_WINDOW_MINUTES
    ) {
      continue;
    }

    // --------------------------------------------------------
    // DEPARTURE
    // --------------------------------------------------------

    const departureStr =
      getBoardDeparture(
        train,
        live,
        stop,
        item,
        arrivalStr
      );

    const departureMinutes =
      parseTimeToMinutes(
        departureStr,
        delayMinutes
      );

    // --------------------------------------------------------
    // ORIGIN / DESTINATION
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // EXPLICIT DIRECTION
    // --------------------------------------------------------

    const explicitDirection =
      getExplicitDirection(
        train,
        live,
        stop,
        item
      );

    // --------------------------------------------------------
    // REMOVE DUPLICATES
    // --------------------------------------------------------

    const existing =
      upcoming.find(
        (entry) =>
          entry.trainNo ===
            trainNo &&
          entry.corridor ===
            corridor
      );

    if (existing) {
      continue;
    }

    // --------------------------------------------------------
    // ADD
    // --------------------------------------------------------

    upcoming.push({
      trainNo,

      name:
        trainName,

      origin:
        origin ||
        (
          corridor === "MAS"
            ? "Chennai side"
            : corridor === "TPTY"
              ? "Tirupati side"
              : "Southern side"
        ),

      destination:
        destination ||
        "Gudur",

      etaMinutes:
        Math.max(
          0,
          Math.round(eta)
        ),

      delayMinutes:
        delayMinutes,

      corridor:

        corridor,

      direction:
        explicitDirection ===
        true
          ? "TOWARD GUDUR"
          : "GUDUR STATION APPROACH",

      platform:
        String(
          live.platform ||
            item.platform ||
            "1"
        ),

      arrival:
        arrivalStr || "",

      departure:
        departureStr || "",

      arrivalMinutes:
        arrivalMinutes,

      departureMinutes:
        departureMinutes
    });
  }

  // ----------------------------------------------------------
  // SORT
  // ----------------------------------------------------------

  upcoming.sort(
    (a, b) =>
      a.etaMinutes -
      b.etaMinutes
  );

  // ----------------------------------------------------------
  // MAXIMUM 10
  // ----------------------------------------------------------

  return upcoming.slice(
    0,
    MAX_UPCOMING_TRAINS
  );
}

// ============================================================
// FIND LIVE CANDIDATES
// ============================================================
//
// Gate-control candidates remain STRICT.
//
// Only approved trains are allowed here.
//

function findLiveCandidates(
  trainsArray,
  now
) {
  const currentMinutes =
    getIndiaMinutes(now);

  const candidates = [];

  for (
    const item of trainsArray
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
          item.number ||
          ""
      ).trim();

    if (!trainNo) {
      continue;
    }

    // STRICT gate-control list.

    if (
      !ALL_APPROVED_TRAINS.has(
        trainNo
      )
    ) {
      continue;
    }

    // STRICT corridor.

    const corridor =
      determineCorridor(
        train,
        live,
        stop,
        item
      );

    if (!corridor) {
      continue;
    }

    const arrivalStr =
      getBoardArrival(
        train,
        live,
        stop,
        item
      );

    const delayMinutes =
      Number(
        live.delayMinutes ||
          item.delayMinutes ||
          0
      );

    const arrivalMinutes =
      parseTimeToMinutes(
        arrivalStr,
        delayMinutes
      );

    if (
      arrivalMinutes === -1
    ) {
      continue;
    }

    const eta =
      calculateTimeDifference(
        arrivalMinutes,
        currentMinutes
      );

    // Candidate range for live GPS lookup.

    if (
      eta < -30 ||
      eta > 90
    ) {
      continue;
    }

    candidates.push({
      item,
      train,
      live,
      stop,
      trainNo,
      corridor,
      eta
    });
  }

  candidates.sort(
    (a, b) =>
      Math.abs(a.eta) -
      Math.abs(b.eta)
  );

  return candidates.slice(
    0,
    MAX_LIVE_REQUESTS
  );
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
        `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
          trainNo
        )}/live`,
        {
          params: {
            authoritative: true,
            includeCoordinates: true
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
      response.data ||
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
// PROCESS LIVE TRAIN
// ============================================================

function processLiveTrain(
  candidate,
  liveResponse
) {
  if (!liveResponse) {
    return null;
  }

  const liveData =
    liveResponse.live ||
    liveResponse;

  const coordinates =
    getLiveCoordinates(
      liveData
    );

  if (!coordinates) {
    console.log(
      `[NO GPS] ${candidate.trainNo} - no live coordinates`
    );

    return null;
  }

  // ----------------------------------------------------------
  // DISTANCE TO GDR
  // ----------------------------------------------------------

  const distanceToGDR =
    distanceKm(
      coordinates.lat,
      coordinates.lng,
      GDR.lat,
      GDR.lng
    );

  // ----------------------------------------------------------
  // DISTANCE TO CORRESPONDING GATE
  // ----------------------------------------------------------

  const gate =
    candidate.corridor ===
    "TPTY"
      ? TIRUPATI_GATE
      : candidate.corridor ===
        "MAS"
        ? CHENNAI_GATE
        : null;

  if (!gate) {
    return null;
  }

  const distanceToGate =
    distanceKm(
      coordinates.lat,
      coordinates.lng,
      gate.lat,
      gate.lng
    );

  // ----------------------------------------------------------
  // AT GDR
  // ----------------------------------------------------------

  const atGDR =
    distanceToGDR <=
    CLEAR_DISTANCE_KM;

  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  const towardGudur =
    isTowardGudur(
      liveData,
      coordinates.lat,
      coordinates.lng
    );

  // ----------------------------------------------------------
  // BEARING
  // ----------------------------------------------------------

  let bearing = null;

  if (
    liveData.bearing !==
      undefined &&
    liveData.bearing !== null
  ) {
    const value =
      Number(
        liveData.bearing
      );

    if (
      Number.isFinite(value)
    ) {
      bearing = value;
    }
  }

  // ----------------------------------------------------------
  // RESULT
  // ----------------------------------------------------------

  const result = {
    trainNo:
      candidate.trainNo,

    corridor:
      candidate.corridor,

    lat:
      coordinates.lat,

    lng:
      coordinates.lng,

    distanceToGDRKm:
      Number(
        distanceToGDR.toFixed(3)
      ),

    distanceToGateKm:
      Number(
        distanceToGate.toFixed(3)
      ),

    atGDR,

    towardGudur,

    bearing,

    etaMinutes:
      Math.max(
        0,
        Math.round(
          candidate.eta
        )
      )
  };

  console.log(
    `[GPS] ${candidate.trainNo} ${candidate.corridor} | ` +
    `distance GDR=${result.distanceToGDRKm}km | ` +
    `gate=${result.distanceToGateKm}km | ` +
    `towardGudur=${towardGudur} | ` +
    `atGDR=${atGDR}`
  );

  return result;
}

// ============================================================
// CREATE GATE STATE
// ============================================================

function createOpenGate(
  label
) {
  return {
    status: "OPEN",

    waitMinutes: 0,

    activeTrain:
      label ||
      "Tracks clear",

    direction:
      "TRACKS CLEAR",

    corridor:
      null,

    distanceKm:
      null,

    lastKnownLocation:
      null
  };
}

// ============================================================
// UPDATE GATE FROM LIVE RESULT
// ============================================================

function evaluateGate(
  currentGate,
  candidate,
  liveResult
) {
  if (!liveResult) {
    return currentGate;
  }

  // ----------------------------------------------------------
  // ONLY MAS/TPTY
  // ----------------------------------------------------------

  if (
    candidate.corridor !==
      "MAS" &&
    candidate.corridor !==
      "TPTY"
  ) {
    return currentGate;
  }

  // ----------------------------------------------------------
  // MUST BE TOWARD GUDUR
  // ----------------------------------------------------------

  if (
    !liveResult.towardGudur
  ) {
    console.log(
      `[GATE IGNORED] ${candidate.trainNo} ${candidate.corridor} - direction not confirmed toward Gudur`
    );

    return currentGate;
  }

  // ----------------------------------------------------------
  // DISTANCE
  // ----------------------------------------------------------

  const distance =
    liveResult.distanceToGateKm;

  // ----------------------------------------------------------
  // OUTSIDE WARNING RANGE
  // ----------------------------------------------------------

  if (
    distance >
    WARNING_DISTANCE_KM
  ) {
    return currentGate;
  }

  const trainLabel =
    `${candidate.trainNo} ${candidate.train.name || "Train"}`;

  // ----------------------------------------------------------
  // CLOSED
  // ----------------------------------------------------------

  if (
    distance <=
    CLOSE_DISTANCE_KM
  ) {
    const waitMinutes =
      Math.max(
        1,
        Math.ceil(
          Math.min(
            15,
            Math.max(
              1,
              liveResult.etaMinutes + 2
            )
          )
        )
      );

    return {
      status: "CLOSED",

      waitMinutes,

      activeTrain:
        `${trainLabel} (Approaching)`,

      direction:
        "TOWARD GUDUR",

      corridor:
        candidate.corridor,

      distanceKm:
        distance,

      lastKnownLocation: {
        lat:
          liveResult.lat,

        lng:
          liveResult.lng
      }
    };
  }

  // ----------------------------------------------------------
  // WARNING
  // ----------------------------------------------------------

  return {
    status: "WARNING",

    waitMinutes:
      Math.max(
        1,
        Math.ceil(
          liveResult.etaMinutes + 2
        )
      ),

    activeTrain:
      `${trainLabel} (Approaching)`,

    direction:
      "TOWARD GUDUR",

    corridor:
      candidate.corridor,

    distanceKm:
      distance,

    lastKnownLocation: {
      lat:
        liveResult.lat,

      lng:
        liveResult.lng
    }
  };
}

// ============================================================
// MAIN UPDATE FUNCTION
// ============================================================

async function updateGateSystem() {
  const now =
    new Date();

  console.log(
    "\n=========================================="
  );

  console.log(
    `[${formatIndiaDateTime(
      now
    )}] GUDUR CROSSING RADAR`
  );

  console.log(
    "=========================================="
  );

  // ----------------------------------------------------------
  // VALIDATE API KEY
  // ----------------------------------------------------------

  if (
    !RAILRADAR_API_KEY ||
    RAILRADAR_API_KEY ===
      "YOUR_RAILRADAR_API_KEY"
  ) {
    throw new Error(
      "RAILRADAR_API_KEY is missing."
    );
  }

  // ----------------------------------------------------------
  // GET STATION BOARD
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // 8 HOURS instead of 4 HOURS.
  //

  console.log(
    "\n[1/5] Querying RailRadar GDR 8-hour station board..."
  );

  const boardResponse =
    await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live`,
      {
        params: {
          hours: 8
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

  const responseBody =
    boardResponse.data;

  const trainsArray =
    responseBody?.data?.trains ||
    [];

  if (
    !Array.isArray(
      trainsArray
    )
  ) {
    throw new Error(
      "RailRadar returned invalid station-board data."
    );
  }

  console.log(
    `✅ RailRadar returned ${trainsArray.length} trains.`
  );

  // ----------------------------------------------------------
  // BUILD UPCOMING DISPLAY
  // ----------------------------------------------------------

  console.log(
    "\n[2/5] Building upcoming train list..."
  );

  const upcomingList =
    buildUpcomingFromBoard(
      trainsArray,
      now
    );

  console.log(
    `✅ Upcoming display trains: ${upcomingList.length}`
  );

  // ----------------------------------------------------------
  // DEFAULT GATES
  // ----------------------------------------------------------

  let chennaiGate =
    createOpenGate(
      "Tracks clear"
    );

  let tirupatiGate =
    createOpenGate(
      "Tracks clear"
    );

  // ----------------------------------------------------------
  // FIND STRICT LIVE CANDIDATES
  // ----------------------------------------------------------

  console.log(
    "\n[3/5] Finding strict gate-control candidates..."
  );

  const candidates =
    findLiveCandidates(
      trainsArray,
      now
    );

  console.log(
    `✅ Live candidates: ${candidates.length}`
  );

  if (
    candidates.length === 0
  ) {
    console.log(
      "No approved trains currently need live GPS checking."
    );
  }

  // ----------------------------------------------------------
  // FETCH LIVE DATA IN PARALLEL
  // ----------------------------------------------------------

  console.log(
    "\n[4/5] Fetching live GPS..."
  );

  const liveResults =
    await Promise.all(
      candidates.map(
        async (
          candidate
        ) => {
          const liveResponse =
            await fetchLiveTrain(
              candidate.trainNo
            );

          return {
            candidate,

            liveResult:
              processLiveTrain(
                candidate,
                liveResponse
              )
          };
        }
      )
    );

  // ----------------------------------------------------------
  // EVALUATE GATES
  // ----------------------------------------------------------

  for (
    const result of liveResults
  ) {
    const {
      candidate,
      liveResult
    } = result;

    if (!liveResult) {
      continue;
    }

    if (
      candidate.corridor ===
      "MAS"
    ) {
      chennaiGate =
        evaluateGate(
          chennaiGate,
          candidate,
          liveResult
        );
    }

    if (
      candidate.corridor ===
      "TPTY"
    ) {
      tirupatiGate =
        evaluateGate(
          tirupatiGate,
          candidate,
          liveResult
        );
    }
  }

  // ----------------------------------------------------------
  // FIREBASE OBJECT
  // ----------------------------------------------------------

  const upcomingObject = {};

  upcomingList.forEach(
    (
      train,
      index
    ) => {
      upcomingObject[
        String(index)
      ] = train;
    }
  );

  const firebasePayload = {
    tirupatiGate,

    chennaiGate,

    upcomingTrains:
      upcomingObject,

    lastUpdated:
      formatIndiaTime(
        now
      ),

    lastUpdatedAt:
      now.toISOString(),

    lastUpdatedLocal:
      formatIndiaDateTime(
        now
      ),

    apiRequestsThisCycle:
      1 +
      candidates.length,

    meta: {
      version:
        "GUDUR-CROSSING-RADAR-V8.2",

      station:
        "GDR",

      upcomingWindowMinutes:
        UPCOMING_WINDOW_MINUTES,

      maxUpcomingTrains:
        MAX_UPCOMING_TRAINS,

      maxLiveRequests:
        MAX_LIVE_REQUESTS,

      warningDistanceKm:
        WARNING_DISTANCE_KM,

      closeDistanceKm:
        CLOSE_DISTANCE_KM,

      clearDistanceKm:
        CLEAR_DISTANCE_KM,

      directionRule:
        "TOWARD GUDUR ONLY",

      gateControl:
        "LIVE GPS ONLY",

      stationBoardHours:
        8
    }
  };

  // ----------------------------------------------------------
  // FIREBASE WRITE
  // ----------------------------------------------------------

  console.log(
    "\n[5/5] Updating Firebase..."
  );

  await gateRef.set(
    firebasePayload
  );

  // ----------------------------------------------------------
  // VERIFY FIREBASE
  // ----------------------------------------------------------

  const verifySnapshot =
    await gateRef.once(
      "value"
    );

  const verified =
    verifySnapshot.val();

  if (!verified) {
    throw new Error(
      "Firebase verification failed: no data returned."
    );
  }

  console.log(
    "✅ Firebase write verified."
  );

  // ----------------------------------------------------------
  // LOG GATES
  // ----------------------------------------------------------

  console.log(
    "\n------------------------------------------"
  );

  console.log(
    `Chennai Gate : ${chennaiGate.status}`
  );

  console.log(
    `Train       : ${chennaiGate.activeTrain}`
  );

  if (
    chennaiGate.distanceKm !==
    null
  ) {
    console.log(
      `Distance    : ${chennaiGate.distanceKm} km`
    );
  }

  console.log(
    "------------------------------------------"
  );

  console.log(
    `Tirupati Gate: ${tirupatiGate.status}`
  );

  console.log(
    `Train        : ${tirupatiGate.activeTrain}`
  );

  if (
    tirupatiGate.distanceKm !==
    null
  ) {
    console.log(
      `Distance     : ${tirupatiGate.distanceKm} km`
    );
  }

  console.log(
    "------------------------------------------"
  );

  // ----------------------------------------------------------
  // UPCOMING LIST
  // ----------------------------------------------------------

  console.log(
    "\n[UPCOMING TRAINS]"
  );

  if (
    upcomingList.length === 0
  ) {
    console.log(
      "None"
    );
  } else {
    upcomingList.forEach(
      (
        train,
        index
      ) => {
        console.log(
          `${index + 1}. ` +
          `${train.corridor} | ` +
          `${train.trainNo} | ` +
          `${train.name} | ` +
          `${train.origin} -> ${train.destination} | ` +
          `ETA ${train.etaMinutes}m`
        );
      }
    );
  }

  console.log(
    "\n=========================================="
  );

  console.log(
    "✅ GUDUR CROSSING RADAR SYNC COMPLETE"
  );

  console.log(
    "==========================================\n"
  );
}

// ============================================================
// START APPLICATION
// ============================================================
//
// IMPORTANT:
//
// DO NOT USE setInterval() HERE.
//
// GitHub Actions needs the Node process to finish.
// The workflow itself runs every 5 minutes.
//

(async () => {
  try {
    await updateGateSystem();

    console.log(
      "✅ Monitor cycle completed successfully."
    );

    console.log(
      "✅ Node.js process can now exit."
    );

    process.exit(0);
  } catch (error) {
    console.error(
      "\n❌ Monitor cycle failed."
    );

    if (
      error.response
    ) {
      console.error(
        `HTTP ${error.response.status}`
      );

      console.error(
        "Response:",
        error.response.data
      );
    } else {
      console.error(
        error.message
      );
    }

    process.exit(1);
  }
})();
