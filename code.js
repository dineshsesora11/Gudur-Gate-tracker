const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================
//
// GitHub Actions must provide:
//
// FIREBASE_SERVICE_ACCOUNT
//
// The secret should contain the COMPLETE Firebase service
// account JSON as one string.
//

const FIREBASE_SERVICE_ACCOUNT =
  process.env.FIREBASE_SERVICE_ACCOUNT || "";

if (!FIREBASE_SERVICE_ACCOUNT) {
  throw new Error(
    "FIREBASE_SERVICE_ACCOUNT is missing. Add it to GitHub Secrets."
  );
}

let serviceAccount;

try {
  serviceAccount =
    typeof FIREBASE_SERVICE_ACCOUNT === "string"
      ? JSON.parse(FIREBASE_SERVICE_ACCOUNT)
      : FIREBASE_SERVICE_ACCOUNT;
} catch (error) {
  throw new Error(
    `FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${error.message}`
  );
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db = admin.database();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

if (!RAILRADAR_API_KEY) {
  throw new Error(
    "RAILRADAR_API_KEY is missing. Add it to GitHub Secrets."
  );
}

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR LOCATION
// ============================================================
//
// Gudur Junction
//

const GUDUR = {
  lat: 14.14842,
  lng: 79.84524
};

// ============================================================
// GATE LOCATIONS
// ============================================================

const CHENNAI_GATE = {
  lat: 14.1396639,
  lng: 79.8441306
};

const TIRUPATI_GATE = {
  lat: 14.1402056,
  lng: 79.8436000
};

// ============================================================
// GATE DISTANCE RULES
// ============================================================
//
// More than 4 km
//     OPEN
//
// 4 km to 3 km
//     WARNING
//
// 3 km or less
//     CLOSED
//
// ============================================================

const WARNING_DISTANCE_KM = 4.00;
const CLOSE_DISTANCE_KM = 3.00;

// Used only to determine whether a train is essentially
// at Gudur for logging / telemetry.
const CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// API LIMIT
// ============================================================
//
// The station board itself is one request.
//
// Live train requests are limited because RailRadar quota
// can be limited.
//
// We sort by ETA first, so the closest upcoming trains
// receive live GPS checks first.
//

const MAX_LIVE_REQUESTS = 10;

// ============================================================
// UPCOMING WINDOW
// ============================================================

const UPCOMING_WINDOW_MINUTES = 480;

// Maximum trains shown by Firebase/frontend.
const MAX_UPCOMING_TRAINS = 10;

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
// GENERIC TEXT MATCH
// ============================================================

function containsAny(text, values) {
  const normalized = normalizeText(text);

  return values.some((value) =>
    normalized.includes(normalizeText(value))
  );
}

// ============================================================
// CURRENT MINUTES
// ============================================================

function getCurrentMinutes() {
  const now = new Date();

  return (
    now.getHours() * 60 +
    now.getMinutes()
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

  let totalMinutes = -1;

  const date = new Date(timeStr);

  if (!isNaN(date.getTime())) {
    totalMinutes =
      date.getHours() * 60 +
      date.getMinutes();
  } else {
    const match = String(timeStr)
      .trim()
      .match(/(\d{1,2}):(\d{2})/);

    if (match) {
      totalMinutes =
        parseInt(match[1], 10) * 60 +
        parseInt(match[2], 10);
    }
  }

  if (totalMinutes === -1) {
    return -1;
  }

  return (
    totalMinutes +
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
// GET TRAIN ORIGIN
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
// GET TRAIN DESTINATION
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
// GET DIRECTION TEXT
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
// EXPLICIT DIRECTION CHECK
// ============================================================
//
// true  = definitely toward Gudur
// false = definitely away from Gudur
// null  = direction not available
//

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

  // ----------------------------------------------------------
  // TOWARD GUDUR
  // ----------------------------------------------------------

  if (
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("INBOUND") ||
    direction.includes("APPROACHING GUDUR")
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
// CHENNAI SIDE DETECTION
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const possibleOrigins = [
    train.origin,
    train.source,
    train.from,
    train.fromStation,
    train.startStation,
    train.start,

    item.origin,
    item.source,
    item.from,
    item.fromStation,
    item.startStation
  ];

  const originText =
    possibleOrigins
      .filter(Boolean)
      .join(" ");

  return containsAny(
    originText,
    [
      "CHENNAI",
      "MAS",
      "CHENNAI CENTRAL",
      "MGR CHENNAI CENTRAL",
      "DR MGR CHENNAI CENTRAL",
      "PURATCHI THALAIVAR DR MGR CENTRAL",
      "AVADI",
      "PERAMBUR",
      "SULLURUPETA",
      "NAYUDUPETA"
    ]
  );
}

// ============================================================
// TIRUPATI SIDE DETECTION
// ============================================================

function isFromTirupatiSide(
  train,
  item
) {
  const possibleOrigins = [
    train.origin,
    train.source,
    train.from,
    train.fromStation,
    train.startStation,
    train.start,

    item.origin,
    item.source,
    item.from,
    item.fromStation,
    item.startStation
  ];

  const originText =
    possibleOrigins
      .filter(Boolean)
      .join(" ");

  return containsAny(
    originText,
    [
      "TIRUPATI",
      "TPTY",
      "TIRUPATI MAIN",
      "RENIGUNTA",
      "RU"
    ]
  );
}

// ============================================================
// CORRIDOR DETECTION
// ============================================================
//
// MAS  = Chennai-side approach
// TPTY = Tirupati-side approach
// null = cannot determine
//
// IMPORTANT:
// This function is NOT used to remove trains from the
// upcoming list.
//
// It is only used for gate-control decisions.
//

function determineDisplayCorridor(
  train,
  live,
  stop,
  item
) {
  const explicitDirection =
    hasInboundDirection(
      train,
      live,
      stop,
      item
    );

  // Explicitly outbound = never control a gate.
  if (explicitDirection === false) {
    return null;
  }

  const fromChennai =
    isFromChennaiSide(
      train,
      item
    );

  const fromTirupati =
    isFromTirupatiSide(
      train,
      item
    );

  // Prefer explicit origin information.
  if (fromChennai) {
    return "MAS";
  }

  if (fromTirupati) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // ROUTE / DESTINATION FALLBACK
  // ----------------------------------------------------------

  const routeText = [
    train.route,
    train.routeName,
    train.line,
    train.corridor,
    train.destination,
    train.to,
    item.route,
    item.routeName,
    item.line,
    item.corridor,
    item.destination,
    item.to
  ]
    .filter(Boolean)
    .join(" ");

  if (
    containsAny(
      routeText,
      [
        "CHENNAI",
        "MAS"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      routeText,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA"
      ]
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // LIVE GPS SIDE FALLBACK
  // ----------------------------------------------------------
  //
  // If live coordinates are available, determine which side
  // of Gudur the train is currently on.
  //
  // This is useful when RailRadar does not provide origin.
  //

  const coords =
    getLiveCoordinates(
      live
    );

  if (coords) {
    const side =
      determineSideFromLiveCoordinates(
        coords.lat,
        coords.lng
      );

    if (side === "MAS") {
      return "MAS";
    }

    if (side === "TPTY") {
      return "TPTY";
    }
  }

  // Unknown corridor.
  return null;
}

// ============================================================
// LIVE COORDINATE EXTRACTION
// ============================================================

function getLiveCoordinates(
  live
) {
  const possible =
    live.currentLocation ||
    live.location ||
    live.currentPosition ||
    live.position ||
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

  return {
    lat,
    lng
  };
}

// ============================================================
// DETERMINE LIVE GPS SIDE
// ============================================================
//
// Gudur:
//
//        NORTH
//          ↑
//          |
//      GUDUR
//          |
//          ↓
//        SOUTH
//
// Chennai side and Tirupati side are separated by the
// railway approach geometry. This function uses longitude/
// latitude relative to Gudur as a fallback only.
//
// It should NOT override an explicit origin.
// ============================================================

function determineSideFromLiveCoordinates(
  lat,
  lng
) {
  const latDifference =
    lat - GUDUR.lat;

  const lngDifference =
    lng - GUDUR.lng;

  const distance =
    calculateDistanceKm(
      lat,
      lng,
      GUDUR.lat,
      GUDUR.lng
    );

  if (distance < 0.8) {
    return null;
  }

  // Gudur's railway corridor is approximately north/south.
  //
  // Chennai-side trains are generally approaching from
  // the southern side.
  //
  // Tirupati-side trains approach from the western /
  // south-western side.
  //

  if (
    latDifference < 0 &&
    Math.abs(lngDifference) < 0.035
  ) {
    return "MAS";
  }

  if (
    lngDifference < -0.005
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// DISTANCE CALCULATOR
// ============================================================

function calculateDistanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const R = 6371;

  const dLat =
    degreesToRadians(
      lat2 - lat1
    );

  const dLng =
    degreesToRadians(
      lng2 - lng1
    );

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos(
      degreesToRadians(lat1)
    ) *
      Math.cos(
        degreesToRadians(lat2)
      ) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// DEGREES TO RADIANS
// ============================================================

function degreesToRadians(
  degrees
) {
  return (
    degrees *
    Math.PI /
    180
  );
}

// ============================================================
// TRAIN NUMBER EXTRACTION
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return String(
    train.number ||
    train.trainNumber ||
    item.trainNumber ||
    item.number ||
    ""
  ).trim();
}

// ============================================================
// ARRIVAL TIME EXTRACTION
// ============================================================

function getArrivalTime(
  train,
  live,
  stop,
  item
) {
  return (
    stop.arrival ||
    stop.expectedArrival ||
    stop.scheduledArrival ||
    stop.arrivalTime ||

    live.expectedArrivalTime ||
    live.arrivalTime ||
    live.etaTime ||

    item.arrival ||
    item.expectedArrival ||
    item.scheduledArrival ||
    item.arrivalTime ||

    train.arrival ||
    train.arrivalTime ||
    ""
  );
}

// ============================================================
// DEPARTURE TIME EXTRACTION
// ============================================================

function getDepartureTime(
  train,
  live,
  stop,
  item,
  arrivalTime
) {
  return (
    stop.departure ||
    stop.expectedDeparture ||
    stop.scheduledDeparture ||
    stop.departureTime ||

    live.expectedDepartureTime ||
    live.departureTime ||

    item.departure ||
    item.expectedDeparture ||
    item.scheduledDeparture ||
    item.departureTime ||

    train.departure ||
    train.departureTime ||

    arrivalTime
  );
}

// ============================================================
// ETA EXTRACTION
// ============================================================

function getBoardEtaMinutes(
  train,
  live,
  stop,
  item
) {
  const directEta =
    live.etaMinutes ??
    live.eta ??
    item.etaMinutes ??
    item.eta ??
    train.etaMinutes ??
    train.eta;

  if (
    directEta !== undefined &&
    directEta !== null &&
    Number.isFinite(
      Number(directEta)
    )
  ) {
    return Number(directEta);
  }

  return null;
}

// ============================================================
// DETERMINE WHETHER ITEM IS DEPARTED
// ============================================================

function isDepartedItem(
  train,
  live,
  stop,
  item
) {
  const status =
    normalizeText(
      item.status ||
      live.status ||
      stop.status ||
      train.status ||
      ""
    );

  return (
    status.includes("DEPARTED") ||
    status.includes("CANCELLED") ||
    status.includes("CANCELED")
  );
}

// ============================================================
// BUILD UPCOMING LIST
// ============================================================
//
// IMPORTANT FIX:
//
// We DO NOT filter by MAS/TPTY here.
//
// Every valid upcoming GDR train is allowed into the list.
//
// If corridor cannot be determined:
//
//     corridor = OTHER
//
// The gate-control logic later decides whether that train
// can actually control a gate.
//

function buildUpcomingFromBoard(
  trainsArray
) {
  const upcoming = [];

  const currentMinutes =
    getCurrentMinutes();

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

    if (
      isDepartedItem(
        train,
        live,
        stop,
        item
      )
    ) {
      continue;
    }

    const trainName =
      train.name ||
      item.trainName ||
      item.name ||
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

    const delayMin =
      Number(
        live.delayMinutes ||
        item.delayMinutes ||
        train.delayMinutes ||
        0
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
        item,
        arrivalTime
      );

    // --------------------------------------------------------
    // ETA
    // --------------------------------------------------------

    let etaMinutes =
      getBoardEtaMinutes(
        train,
        live,
        stop,
        item
      );

    if (
      etaMinutes === null &&
      arrivalTime
    ) {
      const arrivalMinutes =
        parseTimeToMinutes(
          arrivalTime,
          delayMin
        );

      if (
        arrivalMinutes !== -1
      ) {
        etaMinutes =
          calculateTimeDifference(
            arrivalMinutes,
            currentMinutes
          );
      }
    }

    // --------------------------------------------------------
    // If ETA is known, remove trains outside the window.
    // --------------------------------------------------------

    if (
      etaMinutes !== null
    ) {
      if (
        etaMinutes < -15
      ) {
        continue;
      }

      if (
        etaMinutes >
        UPCOMING_WINDOW_MINUTES
      ) {
        continue;
      }

      etaMinutes =
        Math.max(
          0,
          etaMinutes
        );
    }

    // --------------------------------------------------------
    // Corridor is ONLY a label here.
    // NEVER reject the train because it is unknown.
    // --------------------------------------------------------

    const corridor =
      determineDisplayCorridor(
        train,
        live,
        stop,
        item
      );

    const direction =
      hasInboundDirection(
        train,
        live,
        stop,
        item
      );

    upcoming.push({
      trainNo,

      name:
        trainName,

      origin:
        origin ||
        "Unknown",

      destination:
        destination ||
        "Gudur",

      etaMinutes,

      delayMinutes:
        delayMin,

      corridor:
        corridor ||
        "OTHER",

      direction:
        direction === false
          ? "AWAY FROM GUDUR"
          : "TOWARD GUDUR",

      platform:
        String(
          live.platform ||
          stop.platform ||
          item.platform ||
          train.platform ||
          "1"
        ),

      arrival:
        arrivalTime ||
        "",

      departure:
        departureTime ||
        ""
    });
  }

  // ==========================================================
  // SORT
  // ==========================================================

  upcoming.sort(
    (a, b) => {
      if (
        a.etaMinutes === null &&
        b.etaMinutes === null
      ) {
        return 0;
      }

      if (
        a.etaMinutes === null
      ) {
        return 1;
      }

      if (
        b.etaMinutes === null
      ) {
        return -1;
      }

      return (
        a.etaMinutes -
        b.etaMinutes
      );
    }
  );

  // ==========================================================
  // MAXIMUM 10
  // ==========================================================

  return upcoming.slice(
    0,
    MAX_UPCOMING_TRAINS
  );
}

// ============================================================
// FIND LIVE CANDIDATES
// ============================================================
//
// We use the ACTUAL RailRadar upcoming GDR board.
//
// No hardcoded train-number approval is performed here.
//

function findLiveCandidates(
  trainsArray
) {
  const candidates = [];

  const currentMinutes =
    getCurrentMinutes();

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

    if (
      isDepartedItem(
        train,
        live,
        stop,
        item
      )
    ) {
      continue;
    }

    const arrivalTime =
      getArrivalTime(
        train,
        live,
        stop,
        item
      );

    const delayMin =
      Number(
        live.delayMinutes ||
        item.delayMinutes ||
        train.delayMinutes ||
        0
      );

    let etaMinutes =
      getBoardEtaMinutes(
        train,
        live,
        stop,
        item
      );

    if (
      etaMinutes === null &&
      arrivalTime
    ) {
      const arrivalMinutes =
        parseTimeToMinutes(
          arrivalTime,
          delayMin
        );

      if (
        arrivalMinutes !== -1
      ) {
        etaMinutes =
          calculateTimeDifference(
            arrivalMinutes,
            currentMinutes
          );
      }
    }

    // If ETA is completely unavailable,
    // still allow the candidate because the station
    // board itself has identified it as an active train.
    if (
      etaMinutes === null
    ) {
      etaMinutes = 999;
    }

    // We only need trains reasonably close to their
    // scheduled GDR arrival.
    if (
      etaMinutes < -30
    ) {
      continue;
    }

    if (
      etaMinutes >
      UPCOMING_WINDOW_MINUTES
    ) {
      continue;
    }

    const corridor =
      determineDisplayCorridor(
        train,
        live,
        stop,
        item
      );

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Unknown corridor does NOT remove the train from the
    // upcoming list.
    //
    // But unknown corridor cannot control a gate.
    //
    // --------------------------------------------------------

    candidates.push({
      item,
      train,
      live,
      stop,
      trainNo,
      corridor,
      etaMinutes
    });
  }

  // Closest ETA first.
  candidates.sort(
    (a, b) =>
      a.etaMinutes -
      b.etaMinutes
  );

  return candidates.slice(
    0,
    MAX_LIVE_REQUESTS
  );
}

// ============================================================
// RAILRADAR LIVE TRAIN REQUEST
// ============================================================

async function fetchLiveTrain(
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
    if (
      error.response
    ) {
      console.error(
        `[LIVE ERROR] ${trainNo}: HTTP ${error.response.status}`
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
        `[LIVE ERROR] ${trainNo}: ${error.message}`
      );
    }

    return null;
  }
}

// ============================================================
// EXTRACT LIVE DATA
// ============================================================

function extractLiveObject(
  liveResponse
) {
  if (!liveResponse) {
    return {};
  }

  return (
    liveResponse.live ||
    liveResponse
  );
}

// ============================================================
// EXTRACT LIVE COORDINATES FROM RESPONSE
// ============================================================

function extractCoordinatesFromLiveResponse(
  liveResponse
) {
  if (!liveResponse) {
    return null;
  }

  const live =
    liveResponse.live ||
    liveResponse;

  return getLiveCoordinates(
    live
  );
}

// ============================================================
// GATE STATE FROM DISTANCE
// ============================================================
//
// CLOSED has higher priority than WARNING.
//
// This function returns:
//
// OPEN
// WARNING
// CLOSED
//

function getGateStateFromDistance(
  distanceKm
) {
  if (
    distanceKm <=
    CLOSE_DISTANCE_KM
  ) {
    return "CLOSED";
  }

  if (
    distanceKm <=
    WARNING_DISTANCE_KM
  ) {
    return "WARNING";
  }

  return "OPEN";
}

// ============================================================
// GATE PRIORITY
// ============================================================

function gateStatePriority(
  status
) {
  if (
    status === "CLOSED"
  ) {
    return 3;
  }

  if (
    status === "WARNING"
  ) {
    return 2;
  }

  return 1;
}

// ============================================================
// BUILD GATE PAYLOAD
// ============================================================

function buildGatePayload(
  status,
  trainInfo,
  distanceKm,
  corridor
) {
  const trainNo =
    trainInfo.trainNo;

  const trainName =
    trainInfo.trainName;

  const delayMin =
    trainInfo.delayMinutes || 0;

  let waitMinutes = 0;

  if (
    status === "CLOSED"
  ) {
    waitMinutes =
      Math.max(
        1,
        Math.ceil(
          Math.min(
            10,
            distanceKm * 2
          )
        )
      );
  } else if (
    status === "WARNING"
  ) {
    waitMinutes = 1;
  }

  let trainStatus =
    "Approaching";

  if (
    trainInfo.atStation
  ) {
    trainStatus =
      "At Station";
  } else if (
    delayMin > 0
  ) {
    trainStatus =
      `${delayMin}m late`;
  } else {
    trainStatus =
      "On Time";
  }

  return {
    status,

    waitMinutes,

    activeTrain:
      `${trainNo} ${trainName} (${trainStatus})`,

    direction:
      "TOWARD GUDUR",

    corridor,

    distanceKm:
      Number(
        distanceKm.toFixed(3)
      ),

    trainNo,

    trainName,

    delayMinutes:
      delayMin
  };
}

// ============================================================
// PROCESS LIVE CANDIDATE
// ============================================================

async function processLiveCandidate(
  candidate
) {
  const {
    item,
    train,
    live: boardLive,
    stop,
    trainNo,
    corridor
  } = candidate;

  // ----------------------------------------------------------
  // If corridor cannot be determined, do not control gate.
  // ----------------------------------------------------------

  if (!corridor) {
    console.log(
      `[NO GATE] ${trainNo} - corridor unknown`
    );

    return null;
  }

  // ----------------------------------------------------------
  // Explicit outbound direction = reject.
  // ----------------------------------------------------------

  const explicitDirection =
    hasInboundDirection(
      train,
      boardLive,
      stop,
      item
    );

  if (
    explicitDirection === false
  ) {
    console.log(
      `[OUTBOUND IGNORED] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // LIVE GPS REQUEST
  // ----------------------------------------------------------

  const liveResponse =
    await fetchLiveTrain(
      trainNo
    );

  if (!liveResponse) {
    return null;
  }

  const live =
    extractLiveObject(
      liveResponse
    );

  const coordinates =
    extractCoordinatesFromLiveResponse(
      liveResponse
    );

  if (!coordinates) {
    console.log(
      `[NO GPS] ${trainNo} - RailRadar returned no coordinates`
    );

    return null;
  }

  // ----------------------------------------------------------
  // DISTANCE TO GATE
  // ----------------------------------------------------------

  const gate =
    corridor === "MAS"
      ? CHENNAI_GATE
      : TIRUPATI_GATE;

  const distanceToGate =
    calculateDistanceKm(
      coordinates.lat,
      coordinates.lng,
      gate.lat,
      gate.lng
    );

  const distanceToGudur =
    calculateDistanceKm(
      coordinates.lat,
      coordinates.lng,
      GUDUR.lat,
      GUDUR.lng
    );

  // ----------------------------------------------------------
  // CURRENT LIVE DIRECTION
  // ----------------------------------------------------------

  const liveDirection =
    hasInboundDirection(
      train,
      live,
      stop,
      item
    );

  if (
    liveDirection === false
  ) {
    console.log(
      `[LIVE OUTBOUND IGNORED] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // Gate state
  // ----------------------------------------------------------

  const gateStatus =
    getGateStateFromDistance(
      distanceToGate
    );

  const trainName =
    train.name ||
    item.trainName ||
    `Train ${trainNo}`;

  const delayMin =
    Number(
      live.delayMinutes ??
      boardLive.delayMinutes ??
      item.delayMinutes ??
      train.delayMinutes ??
      0
    );

  const atStation =
    distanceToGudur <=
    CLEAR_DISTANCE_KM;

  const trainInfo = {
    trainNo,

    trainName,

    delayMinutes:
      delayMin,

    atStation
  };

  console.log(
    `[LIVE ${corridor}] ${trainNo} ${trainName} | ` +
    `GPS ${coordinates.lat},${coordinates.lng} | ` +
    `Gate ${distanceToGate.toFixed(2)} km | ` +
    `GDR ${distanceToGudur.toFixed(2)} km | ` +
    `${gateStatus}`
  );

  return {
    corridor,

    status:
      gateStatus,

    distanceToGate,

    distanceToGudur,

    payload:
      buildGatePayload(
        gateStatus,
        trainInfo,
        distanceToGate,
        corridor
      ),

    coordinates
  };
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const startTime =
    Date.now();

  try {
    const now =
      new Date();

    console.log(
      "\n=========================================="
    );

    console.log(
      `Gudur Gate Monitor - ${now.toLocaleString()}`
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Querying RailRadar GDR live station board..."
    );

    // ========================================================
    // STATION LIVE BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours: 4
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
      boardRes.data;

    // ========================================================
    // SUPPORT MULTIPLE RESPONSE SHAPES
    // ========================================================

    let trainsArray = [];

    if (
      Array.isArray(
        responseBody?.data?.trains
      )
    ) {
      trainsArray =
        responseBody.data.trains;
    } else if (
      Array.isArray(
        responseBody?.data
      )
    ) {
      trainsArray =
        responseBody.data;
    } else if (
      Array.isArray(
        responseBody?.trains
      )
    ) {
      trainsArray =
        responseBody.trains;
    }

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
      `RailRadar returned ${trainsArray.length} board entries.`
    );

    // ========================================================
    // BUILD UPCOMING DISPLAY LIST
    // ========================================================

    const topUpcoming =
      buildUpcomingFromBoard(
        trainsArray
      );

    console.log(
      `Upcoming trains selected for Firebase: ${topUpcoming.length}`
    );

    if (
      topUpcoming.length
    ) {
      console.log(
        "\n[UPCOMING GDR TRAINS]"
      );

      topUpcoming.forEach(
        (t, index) => {
          console.log(
            ` ${index + 1}. ` +
            `${t.trainNo} ${t.name} | ` +
            `${t.corridor} | ` +
            `ETA ${t.etaMinutes === null ? "N/A" : `${t.etaMinutes}m`}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING GDR TRAINS] None"
      );
    }

    // ========================================================
    // FIND LIVE CANDIDATES
    // ========================================================

    const candidates =
      findLiveCandidates(
        trainsArray
      );

    console.log(
      `\nLive GPS candidates: ${candidates.length}`
    );

    // ========================================================
    // DEFAULT GATE STATES
    // ========================================================

    let masGate = {
      status: "OPEN",

      waitMinutes: 0,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "MAS"
    };

    let tptyGate = {
      status: "OPEN",

      waitMinutes: 0,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "TPTY"
    };

    // ========================================================
    // LIVE REQUESTS
    // ========================================================

    let liveRequestCount = 0;

    for (
      const candidate of candidates
    ) {
      if (
        liveRequestCount >=
        MAX_LIVE_REQUESTS
      ) {
        break;
      }

      // Only known MAS/TPTY trains can control a gate.
      if (
        !candidate.corridor
      ) {
        console.log(
          `[DISPLAY ONLY] ${candidate.trainNo} - corridor unknown`
        );

        continue;
      }

      liveRequestCount++;

      const result =
        await processLiveCandidate(
          candidate
        );

      if (!result) {
        continue;
      }

      // ======================================================
      // UPDATE GATE WITH PRIORITY
      // ======================================================

      if (
        result.corridor === "MAS"
      ) {
        const currentPriority =
          gateStatePriority(
            masGate.status
          );

        const newPriority =
          gateStatePriority(
            result.status
          );

        if (
          newPriority >
            currentPriority ||
          (
            newPriority ===
              currentPriority &&
            result.distanceToGate <
              (
                masGate.distanceKm ??
                Infinity
              )
          )
        ) {
          masGate =
            result.payload;
        }
      }

      if (
        result.corridor === "TPTY"
      ) {
        const currentPriority =
          gateStatePriority(
            tptyGate.status
          );

        const newPriority =
          gateStatePriority(
            result.status
          );

        if (
          newPriority >
            currentPriority ||
          (
            newPriority ===
              currentPriority &&
            result.distanceToGate <
              (
                tptyGate.distanceKm ??
                Infinity
              )
          )
        ) {
          tptyGate =
            result.payload;
        }
      }
    }

    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    const elapsedSeconds =
      (
        Date.now() -
        startTime
      ) / 1000;

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedISO:
        now.toISOString(),

      liveRequestCount,

      boardTrainCount:
        trainsArray.length,

      processingSeconds:
        Number(
          elapsedSeconds.toFixed(2)
        ),

      meta: {
        warningDistanceKm:
          WARNING_DISTANCE_KM,

        closeDistanceKm:
          CLOSE_DISTANCE_KM,

        clearDistanceKm:
          CLEAR_DISTANCE_KM,

        upcomingWindowMinutes:
          UPCOMING_WINDOW_MINUTES,

        maxUpcoming:
          MAX_UPCOMING_TRAINS,

        liveRequests:
          liveRequestCount,

        source:
          "RailRadar GDR live station board + live GPS",

        gateLogic:
          "LIVE GPS DISTANCE"
      }
    });

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Chennai Gate : ${masGate.status}`
    );

    console.log(
      `  ${masGate.activeTrain}`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status}`
    );

    console.log(
      `  ${tptyGate.activeTrain}`
    );

    console.log(
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live GPS requests: ${liveRequestCount}`
    );

    console.log(
      `Processing time: ${elapsedSeconds.toFixed(2)} seconds`
    );

    console.log(
      "==========================================\n"
    );

  } catch (error) {
    // ========================================================
    // ERROR HANDLING
    // ========================================================

    console.error(
      "\n=========================================="
    );

    console.error(
      "[MONITOR ERROR]"
    );

    console.error(
      "=========================================="
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

    console.error(
      "==========================================\n"
    );

    // Important for GitHub Actions:
    // fail the job so the workflow clearly shows
    // that this particular run failed.
    process.exitCode = 1;
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
  "=========================================="
);

console.log(
  `Gudur Junction: ${GUDUR.lat}, ${GUDUR.lng}`
);

console.log(
  `Chennai Gate:   ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
);

console.log(
  `Tirupati Gate:  ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
);

console.log(
  "------------------------------------------"
);

console.log(
  `Warning distance: ${WARNING_DISTANCE_KM} km`
);

console.log(
  `Close distance:   ${CLOSE_DISTANCE_KM} km`
);

console.log(
  `Clear reference:  ${CLEAR_DISTANCE_KM} km`
);

console.log(
  `Upcoming trains:  ${MAX_UPCOMING_TRAINS}`
);

console.log(
  `Live GPS checks:  ${MAX_LIVE_REQUESTS}`
);

console.log(
  "------------------------------------------"
);

console.log(
  "Upcoming display: ALL RailRadar GDR trains"
);

console.log(
  "Gate control:     LIVE GPS + MAS/TPTY corridor"
);

console.log(
  "Direction:        TOWARD GUDUR ONLY"
);

console.log(
  "------------------------------------------"
);

console.log(
  "RailRadar API Key: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================
//
// DO NOT USE setInterval() HERE.
//
// GitHub Actions starts this script, performs one sync,
// then exits.
//

updateGateSystem()
  .then(() => {
    console.log(
      "Monitor run completed."
    );
  })
  .catch((error) => {
    console.error(
      "Fatal error:",
      error
    );

    process.exitCode = 1;
  });
