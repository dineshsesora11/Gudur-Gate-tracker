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
//
// IMPORTANT:
// API key is NOT stored in this code.
// GitHub Actions must provide:
//
// RAILRADAR_API_KEY: ${{ secrets.RAILRADAR_API_KEY }}
//
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

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
//
// > 4.00 km       = OPEN
// <= 4.00 km      = WARNING
// <= 3.00 km      = CLOSED
//
// ============================================================

const WARNING_DISTANCE_KM = 4.00;
const CLOSE_DISTANCE_KM = 3.00;

// Used only when the train is extremely close to GDR.
// It is NOT used as the warning/close distance.

const CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// UPCOMING TRAIN SETTINGS
// ============================================================
//
// RailRadar GDR station board is used directly.
//
// ============================================================

const UPCOMING_WINDOW_MINUTES = 480;

const MAX_UPCOMING_TRAINS = 10;

// Maximum number of live train API calls in one cycle.
//
// Increase this only if your RailRadar API quota allows it.

const MAX_LIVE_REQUESTS = 10;

// ============================================================
// TIMEZONE
// ============================================================

const INDIA_TIMEZONE = "Asia/Kolkata";

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
    normalized.includes(normalizeText(value))
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
// CHENNAI / MAS SIDE DETECTION
// ============================================================
//
// This is used ONLY to determine which website gate the
// upcoming train belongs to.
//
// We do NOT use a hardcoded train-number list.
//
// ============================================================

function isFromChennaiSide(train, item) {
  const origin = getOrigin(train, item);

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
  const origin = getOrigin(train, item);

  const text = normalizeText(origin);

  if (!text) {
    return false;
  }

  return containsAny(text, [
    "TIRUPATI",
    "TIRUPATI MAIN",
    "TPTY",
    "RENIGUNTA",
    "RU"
  ]);
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================
//
// Returns:
//
// true  = explicitly toward Gudur
// false = explicitly away from Gudur
// null  = no usable direction information
//
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
    direction.includes("ARRIVING GUDUR") ||
    direction.includes("INBOUND")
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
// DETERMINE DISPLAY CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// There is NO hardcoded train-number approval here.
//
// We determine the respective gate from the actual train
// information returned by the GDR upcoming board.
//
// ============================================================

function determineDisplayCorridor(
  train,
  live,
  stop,
  item
) {
  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  // Explicitly outbound = don't display/control.
  if (explicitDirection === false) {
    return null;
  }

  // ----------------------------------------------------------
  // FIRST: origin information
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
  // SOME RAILRADAR RESPONSES MAY PROVIDE CORRIDOR/LINE
  // INFORMATION DIRECTLY.
  // ----------------------------------------------------------

  const possibleCorridorText = normalizeText(
    [
      train.corridor,
      train.line,
      train.route,
      train.routeName,
      train.section,

      live.corridor,
      live.line,
      live.route,
      live.routeName,

      stop.corridor,
      stop.line,
      stop.route,

      item.corridor,
      item.line,
      item.route,
      item.routeName,
      item.section
    ]
      .filter(Boolean)
      .join(" ")
  );

  if (
    containsAny(
      possibleCorridorText,
      [
        "MAS",
        "CHENNAI",
        "SULLURUPETA",
        "NAYUDUPETA"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      possibleCorridorText,
      [
        "TPTY",
        "TIRUPATI",
        "RENIGUNTA"
      ]
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // UNKNOWN CORRIDOR
  // ----------------------------------------------------------
  //
  // We don't guess.
  //
  // The train can still appear in RailRadar data, but it will
  // not be assigned to a physical gate unless its corridor
  // can be determined.
  //
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
//
// IMPORTANT CHANGE:
//
// The train has already been selected from the GDR upcoming
// station board.
//
// Therefore:
//
// - Explicit outbound direction => REJECT
// - Explicit toward Gudur => ACCEPT
// - No direction supplied => ACCEPT
//
// We do NOT require the train to be within 0.8 km anymore.
//
// This is important because your warning zone starts at 4 km
// and your closed zone starts at 3 km.
//
// ============================================================

function isTowardGudur(
  liveData
) {
  if (!liveData) {
    return false;
  }

  const directionText =
    normalizeText(
      [
        liveData.direction,
        liveData.travelDirection,
        liveData.runningDirection,
        liveData.routeDirection
      ]
        .filter(Boolean)
        .join(" ")
    );

  // ----------------------------------------------------------
  // EXPLICITLY TOWARD GUDUR
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
    ) ||
    directionText.includes(
      "APPROACHING GUDUR"
    ) ||
    directionText.includes(
      "ARRIVING GUDUR"
    )
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // EXPLICITLY AWAY FROM GUDUR
  // ----------------------------------------------------------

  if (
    directionText.includes(
      "FROM GUDUR"
    ) ||
    directionText.includes(
      "OUTBOUND"
    ) ||
    directionText.includes(
      "AWAY FROM GUDUR"
    ) ||
    directionText.includes(
      "TO CHENNAI"
    ) ||
    directionText.includes(
      "TOWARD CHENNAI"
    ) ||
    directionText.includes(
      "TOWARDS CHENNAI"
    ) ||
    directionText.includes(
      "TO TIRUPATI"
    ) ||
    directionText.includes(
      "TOWARD TIRUPATI"
    ) ||
    directionText.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // NO DIRECTION PROVIDED
  // ----------------------------------------------------------
  //
  // Because this train came from the upcoming GDR board,
  // we allow the GPS distance check to decide the gate state.
  //
  // ----------------------------------------------------------

  return true;
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

// ============================================================
// INDIA TIME
// ============================================================

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

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const value =
    String(timeStr).trim();

  // HH:MM
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

  // ISO/date time
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
// DIRECTLY FROM RAILRADAR GDR BOARD
//
// ============================================================

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

    // ----------------------------------------------------------
    // DETERMINE ACTUAL CORRIDOR
    // ----------------------------------------------------------

    const corridor =
      determineDisplayCorridor(
        train,
        live,
        stop,
        item
      );

    if (!corridor) {
      console.log(
        `[UPCOMING IGNORED] ${trainNo} - corridor could not be determined`
      );

      continue;
    }

    // ----------------------------------------------------------
    // ARRIVAL
    // ----------------------------------------------------------

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

    const eta =
      calculateTimeDifference(
        arrivalMinutes,
        currentMinutes
      );

    // ----------------------------------------------------------
    // UPCOMING WINDOW
    // ----------------------------------------------------------

    if (
      eta < -30 ||
      eta >
        UPCOMING_WINDOW_MINUTES
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // DEPARTURE
    // ----------------------------------------------------------

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

    const explicitDirection =
      getExplicitDirection(
        train,
        live,
        stop,
        item
      );

    // ----------------------------------------------------------
    // AVOID DUPLICATES
    // ----------------------------------------------------------

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

    // ----------------------------------------------------------
    // ADD TRAIN
    // ----------------------------------------------------------

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
        false
          ? "OUTBOUND"
          : "TOWARD GUDUR",

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

  upcoming.sort(
    (a, b) =>
      a.etaMinutes -
      b.etaMinutes
  );

  return upcoming.slice(
    0,
    MAX_UPCOMING_TRAINS
  );
}

// ============================================================
// FIND LIVE CANDIDATES
// ============================================================
//
// IMPORTANT CHANGE:
//
// NO ALL_APPROVED_TRAINS CHECK.
//
// Every relevant train from the actual RailRadar GDR
// upcoming board can be sent to the live API.
//
// ============================================================

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

    // ----------------------------------------------------------
    // DETERMINE CORRIDOR FROM ACTUAL BOARD DATA
    // ----------------------------------------------------------

    const corridor =
      determineDisplayCorridor(
        train,
        live,
        stop,
        item
      );

    if (!corridor) {
      console.log(
        `[LIVE CANDIDATE IGNORED] ${trainNo} - corridor unknown`
      );

      continue;
    }

    // OTHER is display-only.
    //
    // It cannot operate either physical gate.

    if (
      corridor !== "MAS" &&
      corridor !== "TPTY"
    ) {
      continue;
    }

    // ----------------------------------------------------------
    // EXPLICIT OUTBOUND CHECK
    // ----------------------------------------------------------

    const explicitDirection =
      getExplicitDirection(
        train,
        live,
        stop,
        item
      );

    if (
      explicitDirection === false
    ) {
      console.log(
        `[LIVE CANDIDATE IGNORED] ${trainNo} ${corridor} - explicitly outbound`
      );

      continue;
    }

    // ----------------------------------------------------------
    // ARRIVAL / ETA
    // ----------------------------------------------------------

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

    // ----------------------------------------------------------
    // IMPORTANT:
    //
    // If RailRadar doesn't provide a usable arrival time,
    // we can still use the upcoming board train.
    //
    // This prevents a missing timetable field from blocking
    // live GPS monitoring.
    //
    // ----------------------------------------------------------

    let eta = null;

    if (
      arrivalMinutes !== -1
    ) {
      eta =
        calculateTimeDifference(
          arrivalMinutes,
          currentMinutes
        );

      // We don't need trains many hours away for live GPS.

      if (
        eta < -30 ||
        eta > 120
      ) {
        continue;
      }
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

  // ----------------------------------------------------------
  // SORT
  // ----------------------------------------------------------

  candidates.sort(
    (a, b) => {
      const aEta =
        a.eta === null
          ? 999999
          : Math.abs(a.eta);

      const bEta =
        b.eta === null
          ? 999999
          : Math.abs(b.eta);

      return aEta - bEta;
    }
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

    if (error.response) {
      console.error(
        `[LIVE ERROR] HTTP ${error.response.status}`
      );
    }

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

  // ----------------------------------------------------------
  // LIVE GPS
  // ----------------------------------------------------------

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
  // DISTANCE TO GUDUR
  // ----------------------------------------------------------

  const distanceToGDR =
    distanceKm(
      coordinates.lat,
      coordinates.lng,
      GDR.lat,
      GDR.lng
    );

  // ----------------------------------------------------------
  // CORRESPONDING PHYSICAL GATE
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

  // ----------------------------------------------------------
  // DISTANCE TO ACTUAL GATE
  // ----------------------------------------------------------

  const distanceToGate =
    distanceKm(
      coordinates.lat,
      coordinates.lng,
      gate.lat,
      gate.lng
    );

  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  const towardGudur =
    isTowardGudur(
      liveData
    );

  // ----------------------------------------------------------
  // BEARING
  // ----------------------------------------------------------

  let bearing = null;

  const possibleBearing =
    liveData.bearingDegrees ??
    liveData.bearing;

  if (
    possibleBearing !==
      undefined &&
    possibleBearing !==
      null
  ) {
    const value =
      Number(
        possibleBearing
      );

    if (
      Number.isFinite(value)
    ) {
      bearing = value;
    }
  }

  // ----------------------------------------------------------
  // SPEED
  // ----------------------------------------------------------

  let speedKmh = null;

  const possibleSpeed =
    liveData.speedKmh ??
    liveData.speed ??
    liveData.speedKmH;

  if (
    possibleSpeed !==
      undefined &&
    possibleSpeed !==
      null
  ) {
    const value =
      Number(
        possibleSpeed
      );

    if (
      Number.isFinite(value)
    ) {
      speedKmh = value;
    }
  }

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  let etaMinutes = 0;

  if (
    candidate.eta !== null &&
    Number.isFinite(
      Number(candidate.eta)
    )
  ) {
    etaMinutes =
      Math.max(
        0,
        Math.round(
          Number(candidate.eta)
        )
      );
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

    atGDR:
      distanceToGDR <=
      CLEAR_DISTANCE_KM,

    towardGudur,

    bearing,

    speedKmh,

    etaMinutes
  };

  console.log(
    `[GPS] ${candidate.trainNo} ${candidate.corridor} | ` +
    `distance GDR=${result.distanceToGDRKm}km | ` +
    `gate=${result.distanceToGateKm}km | ` +
    `speed=${speedKmh ?? "N/A"}km/h | ` +
    `bearing=${bearing ?? "N/A"} | ` +
    `towardGudur=${towardGudur} | ` +
    `atGDR=${result.atGDR}`
  );

  return result;
}

// ============================================================
// CREATE OPEN GATE
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
  // ONLY PHYSICAL MAS / TPTY GATES
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
  // DIRECTION
  // ----------------------------------------------------------

  if (
    !liveResult.towardGudur
  ) {
    console.log(
      `[GATE IGNORED] ${candidate.trainNo} ${candidate.corridor} - explicit direction is away from Gudur`
    );

    return currentGate;
  }

  // ----------------------------------------------------------
  // DISTANCE TO ACTUAL GATE
  // ----------------------------------------------------------

  const distance =
    liveResult.distanceToGateKm;

  // ----------------------------------------------------------
  // MORE THAN 4 KM = OPEN
  // ----------------------------------------------------------

  if (
    distance >
    WARNING_DISTANCE_KM
  ) {
    return currentGate;
  }

  const trainLabel =
    `${candidate.trainNo} ${candidate.train.name || "Train"}`;

  // ==========================================================
  // CLOSED AT 3 KM OR LESS
  // ==========================================================

  if (
    distance <=
    CLOSE_DISTANCE_KM
  ) {
    const waitMinutes =
      Math.max(
        1,
        Math.min(
          15,
          Math.ceil(
            Math.max(
              1,
              liveResult.etaMinutes + 2
            )
          )
        )
      );

    console.log(
      `[GATE CLOSED] ${candidate.trainNo} ${candidate.corridor} | ${distance} km`
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

  // ==========================================================
  // WARNING AT 4 KM OR LESS
  // ==========================================================

  console.log(
    `[GATE WARNING] ${candidate.trainNo} ${candidate.corridor} | ${distance} km`
  );

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

  // ==========================================================
  // VALIDATE RAILRADAR SECRET
  // ==========================================================

  if (!RAILRADAR_API_KEY) {
    throw new Error(
      "RAILRADAR_API_KEY GitHub Secret is missing."
    );
  }

  // ==========================================================
  // GET STATION BOARD
  // ==========================================================
  //
  // 4 hours is intentional.
  //
  // The previous 8-hour request caused the RailRadar
  // server-side HTTP 500 error.
  //
  // ==========================================================

  console.log(
    "\n[1/5] Querying RailRadar GDR 4-hour station board..."
  );

  const boardResponse =
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

  // ==========================================================
  // BUILD UPCOMING DISPLAY
  // ==========================================================

  console.log(
    "\n[2/5] Building upcoming train list directly from GDR board..."
  );

  const upcomingList =
    buildUpcomingFromBoard(
      trainsArray,
      now
    );

  console.log(
    `✅ Upcoming display trains: ${upcomingList.length}`
  );

  // ==========================================================
  // DEFAULT GATES
  // ==========================================================

  let chennaiGate =
    createOpenGate(
      "Tracks clear"
    );

  let tirupatiGate =
    createOpenGate(
      "Tracks clear"
    );

  // ==========================================================
  // FIND LIVE CANDIDATES
  // ==========================================================

  console.log(
    "\n[3/5] Finding live GPS candidates from upcoming GDR trains..."
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
      "No GDR upcoming trains currently need live GPS checking."
    );
  }

  // ==========================================================
  // FETCH LIVE GPS
  // ==========================================================

  console.log(
    "\n[4/5] Fetching live GPS..."
  );

  const liveResults =
    await Promise.all(
      candidates.map(
        async (
          candidate
        ) => {
          console.log(
            `[LIVE CHECK] ${candidate.trainNo} ${candidate.corridor}`
          );

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

  // ==========================================================
  // EVALUATE GATES
  // ==========================================================

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

  // ==========================================================
  // FIREBASE UPCOMING OBJECT
  // ==========================================================

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

  // ==========================================================
  // FIREBASE OBJECT
  // ==========================================================

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
        "GUDUR-CROSSING-RADAR-V9",

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
        "UPCOMING GDR BOARD + EXPLICIT OUTBOUND REJECTION",

      gateControl:
        "LIVE GPS DISTANCE",

      stationBoardHours:
        4,

      hardcodedTrainApproval:
        false
    }
  };

  // ==========================================================
  // FIREBASE WRITE
  // ==========================================================

  console.log(
    "\n[5/5] Updating Firebase..."
  );

  await gateRef.set(
    firebasePayload
  );

  // ==========================================================
  // VERIFY FIREBASE
  // ==========================================================

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

  // ==========================================================
  // LOG CHENNAI GATE
  // ==========================================================

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

  // ==========================================================
  // LOG TIRUPATI GATE
  // ==========================================================

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

  // ==========================================================
  // UPCOMING LIST
  // ==========================================================

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

  // ==========================================================
  // LIVE GPS SUMMARY
  // ==========================================================

  console.log(
    "\n[LIVE GPS SUMMARY]"
  );

  if (
    liveResults.length === 0
  ) {
    console.log(
      "No live GPS results."
    );
  } else {
    for (
      const result of liveResults
    ) {
      const {
        candidate,
        liveResult
      } = result;

      if (!liveResult) {
        console.log(
          `${candidate.trainNo} | NO GPS`
        );

        continue;
      }

      console.log(
        `${candidate.trainNo} | ` +
        `${candidate.corridor} | ` +
        `GDR ${liveResult.distanceToGDRKm} km | ` +
        `Gate ${liveResult.distanceToGateKm} km | ` +
        `Speed ${liveResult.speedKmh ?? "N/A"} km/h | ` +
        `Toward Gudur ${liveResult.towardGudur}`
      );
    }
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
// GitHub Actions runs this workflow approximately every 5 min.
//
// DO NOT use setInterval().
//
// ============================================================

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
