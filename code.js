const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// GUDUR CROSSING RADAR V8.1
// ============================================================
//
// PURPOSE
// -------
// Monitor trains approaching Gudur (GDR) and publish gate
// information to Firebase.
//
// IMPORTANT ARCHITECTURE
// ----------------------
// This script runs ONE monitoring cycle and then exits.
//
// GitHub Actions should run this file every 5 minutes.
//
// DO NOT use setInterval() here.
// A permanent setInterval() causes GitHub Actions to keep
// running until the job timeout is reached.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {
  // Preferred method for GitHub Actions:
  //
  // Store the complete service account JSON inside:
  //
  // FIREBASE_SERVICE_ACCOUNT
  //
  // GitHub Secret:
  // FIREBASE_SERVICE_ACCOUNT
  //
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else {
    // Local fallback:
    //
    // serviceAccountKey.json must be beside code.js
    //
    serviceAccount =
      require("./serviceAccountKey.json");
  }
} catch (error) {
  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    "For GitHub Actions, make sure FIREBASE_SERVICE_ACCOUNT is configured."
  );

  console.error(
    "For local execution, make sure serviceAccountKey.json exists beside code.js."
  );

  console.error(
    error.message
  );

  process.exit(1);
}


// Prevent accidental double initialization.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: cert(serviceAccount),
    databaseURL: FIREBASE_DATABASE_URL
  });
}

const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");


// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY;

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  process.exit(1);
}


// ============================================================
// GUDUR STATION
// ============================================================

const GUDUR_STATION_CODE =
  "GDR";


// ============================================================
// GATE COORDINATES
// ============================================================

const GUDUR_COORDINATES = {
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
// WARNING:
// Train is within 1.00 km of gate.
//
// CLOSED:
// Train is within 0.60 km of gate.
//
// CLEAR:
// Gate can remain open when train is beyond 0.80 km.
//
// ============================================================

const WARNING_DISTANCE_KM =
  1.00;

const CLOSE_DISTANCE_KM =
  0.60;

const CLEAR_DISTANCE_KM =
  0.80;


// ============================================================
// UPCOMING TRAIN WINDOW
// ============================================================

const UPCOMING_WINDOW_MINUTES =
  240;


// ============================================================
// LIVE API LIMIT
// ============================================================
//
// One station-board request is made first.
//
// Then up to MAX_LIVE_REQUESTS train-live requests.
//
// They run in parallel.
//
// ============================================================

const MAX_LIVE_REQUESTS =
  7;


// ============================================================
// IST TIMEZONE
// ============================================================

const INDIA_TIMEZONE =
  "Asia/Kolkata";


// ============================================================
// APPROVED TRAIN NUMBERS
// ============================================================
//
// TPTY = Tirupati side -> Gudur
//
// MAS = Chennai side -> Gudur
//
// OTHER = Other known Gudur inbound trains.
//
// These lists prevent unrelated trains from controlling
// the crossing.
//
// ============================================================

const APPROVED_TPTY_TRAINS =
  new Set([
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


const APPROVED_MAS_TRAINS =
  new Set([
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


const APPROVED_OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "20498",
    "67226"
  ]);


// ============================================================
// ALL APPROVED TRAINS
// ============================================================

const ALL_APPROVED_TRAINS =
  new Set([
    ...APPROVED_TPTY_TRAINS,
    ...APPROVED_MAS_TRAINS,
    ...APPROVED_OTHER_TRAINS
  ]);


// ============================================================
// NORMALIZE TEXT
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}


// ============================================================
// TRAIN NUMBER NORMALIZER
// ============================================================

function normalizeTrainNumber(value) {
  const text =
    String(value || "")
      .trim()
      .replace(/\s+/g, "");

  if (!text) {
    return "";
  }

  // Keep leading zeros because RailRadar may use them.
  return text;
}


// ============================================================
// CONTAINS ANY
// ============================================================

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
// GET ORIGIN
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
// GET DESTINATION
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
    ""
  );
}


// ============================================================
// CHENNAI SIDE DETECTION
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const origin =
    getOrigin(train, item);

  return containsAny(
    origin,
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
  const origin =
    getOrigin(train, item);

  return containsAny(
    origin,
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
//
// Returns:
//
// true  = toward Gudur
// false = away from Gudur
// null  = unknown
//
// ============================================================

function getExplicitDirection(
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
  // INBOUND
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // OUTBOUND
  // ----------------------------------------------------------

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
// DETERMINE CORRIDOR
// ============================================================
//
// Returns:
//
// TPTY = Tirupati -> Gudur
// MAS  = Chennai -> Gudur
// OTHER = other approved inbound train
// null = ignore
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo =
    normalizeTrainNumber(
      train.number ||
      train.trainNumber ||
      item.trainNumber ||
      item.number
    );

  if (!trainNo) {
    return null;
  }


  // ----------------------------------------------------------
  // Approved train list is the primary filter.
  // ----------------------------------------------------------

  if (
    !ALL_APPROVED_TRAINS.has(
      trainNo
    )
  ) {
    return null;
  }


  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );


  // ----------------------------------------------------------
  // Explicit outbound = ALWAYS reject.
  // ----------------------------------------------------------

  if (
    explicitDirection === false
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // TIRUPATI
  // ----------------------------------------------------------

  if (
    APPROVED_TPTY_TRAINS.has(
      trainNo
    )
  ) {
    // If RailRadar explicitly says inbound,
    // accept it.
    if (
      explicitDirection === true
    ) {
      return "TPTY";
    }

    // If origin confirms Tirupati,
    // accept it.
    if (
      isFromTirupatiSide(
        train,
        item
      )
    ) {
      return "TPTY";
    }

    // If there is no contradictory direction,
    // the approved TPTY train is allowed.
    //
    // This is necessary because some RailRadar
    // responses do not expose direction/origin.
    return "TPTY";
  }


  // ----------------------------------------------------------
  // CHENNAI
  // ----------------------------------------------------------

  if (
    APPROVED_MAS_TRAINS.has(
      trainNo
    )
  ) {
    if (
      explicitDirection === true
    ) {
      return "MAS";
    }

    if (
      isFromChennaiSide(
        train,
        item
      )
    ) {
      return "MAS";
    }

    // For MAS trains, do not assume direction when
    // RailRadar gives absolutely no directional clue.
    //
    // This prevents an outbound MAS train from accidentally
    // controlling the crossing.
    return null;
  }


  // ----------------------------------------------------------
  // OTHER APPROVED TRAINS
  // ----------------------------------------------------------

  if (
    APPROVED_OTHER_TRAINS.has(
      trainNo
    )
  ) {
    if (
      explicitDirection === false
    ) {
      return null;
    }

    if (
      explicitDirection === true
    ) {
      return "OTHER";
    }

    return null;
  }


  return null;
}


// ============================================================
// GET NUMERIC VALUE
// ============================================================

function toNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
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
  const R =
    6371;

  const dLat =
    (
      (lat2 - lat1) *
      Math.PI
    ) / 180;

  const dLon =
    (
      (lon2 - lon1) *
      Math.PI
    ) / 180;

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos(
      lat1 *
        Math.PI /
        180
    ) *
      Math.cos(
        lat2 *
          Math.PI /
          180
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
// EXTRACT GPS COORDINATES
// ============================================================
//
// RailRadar may expose coordinates in different places.
//
// ============================================================

function extractCoordinates(
  live
) {
  const candidates = [
    live.currentLocation,
    live.location,
    live.position,
    live.coordinates,
    live.gps,
    live
  ];

  for (
    const candidate
    of candidates
  ) {
    if (
      !candidate ||
      typeof candidate !==
        "object"
    ) {
      continue;
    }

    const lat =
      toNumber(
        candidate.lat ??
        candidate.latitude ??
        candidate.currentLat
      );

    const lng =
      toNumber(
        candidate.lng ??
        candidate.lon ??
        candidate.longitude ??
        candidate.currentLng
      );

    if (
      lat !== null &&
      lng !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return {
        lat,
        lng
      };
    }
  }

  return null;
}


// ============================================================
// GET TRAIN STATUS
// ============================================================

function getLiveStatus(
  live
) {
  return (
    live.status ||
    live.runningStatus ||
    live.trainStatus ||
    ""
  );
}


// ============================================================
// DETERMINE TRAIN MOVING TOWARD GUDUR
// ============================================================

function isTrainTowardGudur(
  train,
  live,
  stop,
  item
) {
  const explicit =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  // Explicit answer always wins.
  if (
    explicit === true
  ) {
    return true;
  }

  if (
    explicit === false
  ) {
    return false;
  }


  // ----------------------------------------------------------
  // Check common textual status fields.
  // ----------------------------------------------------------

  const text =
    normalizeText(
      [
        getLiveStatus(live),
        live.statusText,
        live.message,
        live.remarks,
        live.description,
        train.status,
        train.direction,
        live.direction
      ]
        .filter(Boolean)
        .join(" ")
    );


  if (
    text.includes(
      "TOWARD GUDUR"
    ) ||
    text.includes(
      "TOWARDS GUDUR"
    ) ||
    text.includes(
      "APPROACHING GUDUR"
    ) ||
    text.includes(
      "GUDUR INBOUND"
    )
  ) {
    return true;
  }


  if (
    text.includes(
      "FROM GUDUR"
    ) ||
    text.includes(
      "GUDUR OUTBOUND"
    ) ||
    text.includes(
      "TO CHENNAI"
    ) ||
    text.includes(
      "TO TIRUPATI"
    )
  ) {
    return false;
  }


  // ----------------------------------------------------------
  // Unknown direction.
  // ----------------------------------------------------------

  return null;
}


// ============================================================
// GATE DISTANCE
// ============================================================

function getGateDistance(
  corridor,
  coordinates
) {
  if (!coordinates) {
    return null;
  }

  const gate =
    corridor === "TPTY"
      ? TIRUPATI_GATE
      : CHENNAI_GATE;

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    gate.lat,
    gate.lng
  );
}


// ============================================================
// TIME HELPERS
// ============================================================
//
// RailRadar can return:
//
// 23:55
// 23:55:00
// 2026-06-22T23:55:00+05:30
//
// Bare times are interpreted explicitly as IST.
//
// ============================================================

function getIndiaParts(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          INDIA_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(date);

  const result = {};

  for (
    const part of parts
  ) {
    result[part.type] =
      part.value;
  }

  return {
    year:
      Number(result.year),
    month:
      Number(result.month),
    day:
      Number(result.day),
    hour:
      Number(result.hour),
    minute:
      Number(result.minute),
    second:
      Number(result.second)
  };
}


// ============================================================
// CONVERT IST DATE/TIME TO UTC DATE
// ============================================================
//
// Creates a Date for an IST wall-clock time.
//
// ============================================================

function indiaWallTimeToDate(
  year,
  month,
  day,
  hour,
  minute,
  second = 0
) {
  // India is UTC+05:30.
  //
  // Convert IST wall-clock values to UTC.
  const utcMillis =
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second
    ) -
    (5 * 60 + 30) *
      60 *
      1000;

  return new Date(
    utcMillis
  );
}


// ============================================================
// PARSE RAILRADAR DATE
// ============================================================

function parseRailRadarDate(
  value
) {
  if (!value) {
    return null;
  }

  const text =
    String(value)
      .trim();

  if (!text) {
    return null;
  }


  // ----------------------------------------------------------
  // Full ISO date/time
  // ----------------------------------------------------------

  if (
    /^\d{4}-\d{2}-\d{2}T/.test(
      text
    )
  ) {
    const date =
      new Date(text);

    if (
      !isNaN(
        date.getTime()
      )
    ) {
      return date;
    }
  }


  // ----------------------------------------------------------
  // HH:mm or HH:mm:ss
  // ----------------------------------------------------------

  const match =
    text.match(
      /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );

  if (match) {
    const now =
      getIndiaParts();

    const hour =
      Number(match[1]);

    const minute =
      Number(match[2]);

    const second =
      Number(
        match[3] || 0
      );

    if (
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59 &&
      second >= 0 &&
      second <= 59
    ) {
      return indiaWallTimeToDate(
        now.year,
        now.month,
        now.day,
        hour,
        minute,
        second
      );
    }
  }


  // ----------------------------------------------------------
  // Try normal Date parsing as final fallback.
  // ----------------------------------------------------------

  const fallback =
    new Date(text);

  if (
    !isNaN(
      fallback.getTime()
    )
  ) {
    return fallback;
  }

  return null;
}


// ============================================================
// ADD DELAY TO DATE
// ============================================================

function addMinutes(
  date,
  minutes
) {
  return new Date(
    date.getTime() +
      Number(minutes || 0) *
        60 *
        1000
  );
}


// ============================================================
// GET BOARD ARRIVAL TIME
// ============================================================
//
// IMPORTANT:
// For incoming trains, expectedArrivalTime is preferred.
//
// ============================================================

function getBoardArrivalTime(
  item
) {
  const live =
    item.live || {};

  const stop =
    item.stop || {};

  const candidates = [
    live.expectedArrivalTime,
    live.expectedArrival,
    stop.expectedArrival,
    stop.arrival,
    item.expectedArrivalTime,
    item.expectedArrival,
    item.arrival
  ];

  for (
    const value
    of candidates
  ) {
    if (!value) {
      continue;
    }

    const date =
      parseRailRadarDate(
        value
      );

    if (date) {
      return date;
    }
  }

  return null;
}


// ============================================================
// GET BOARD DEPARTURE TIME
// ============================================================

function getBoardDepartureTime(
  item
) {
  const live =
    item.live || {};

  const stop =
    item.stop || {};

  const candidates = [
    live.expectedDepartureTime,
    live.expectedDeparture,
    stop.expectedDeparture,
    stop.departure,
    item.expectedDepartureTime,
    item.expectedDeparture,
    item.departure
  ];

  for (
    const value
    of candidates
  ) {
    if (!value) {
      continue;
    }

    const date =
      parseRailRadarDate(
        value
      );

    if (date) {
      return date;
    }
  }

  return null;
}


// ============================================================
// CURRENT IST DATE
// ============================================================

function getCurrentIndiaDate() {
  const parts =
    getIndiaParts();

  return indiaWallTimeToDate(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}


// ============================================================
// FORMAT IST DATE/TIME
// ============================================================

function formatIndiaDateTime(
  date
) {
  if (!date) {
    return "";
  }

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
      hour12: true
    }
  ).format(date);
}


// ============================================================
// FORMAT IST TIME
// ============================================================

function formatIndiaTime(
  date
) {
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone:
        INDIA_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }
  ).format(date);
}


// ============================================================
// ETA MINUTES
// ============================================================

function minutesUntil(
  target,
  now
) {
  if (
    !target ||
    !now
  ) {
    return null;
  }

  return Math.round(
    (
      target.getTime() -
      now.getTime()
    ) /
      60000
  );
}


// ============================================================
// GET TRAIN NUMBER
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return normalizeTrainNumber(
    train.number ||
    train.trainNumber ||
    item.trainNumber ||
    item.number
  );
}


// ============================================================
// GET TRAIN NAME
// ============================================================

function getTrainName(
  train,
  trainNo
) {
  return (
    train.name ||
    train.trainName ||
    train.displayName ||
    `Train ${trainNo}`
  );
}


// ============================================================
// GET DELAY
// ============================================================

function getDelayMinutes(
  live
) {
  const candidates = [
    live.delayMinutes,
    live.delay,
    live.delayMins
  ];

  for (
    const value
    of candidates
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      const number =
        Number(value);

      if (
        Number.isFinite(number)
      ) {
        return number;
      }
    }
  }

  return 0;
}


// ============================================================
// BUILD UPCOMING TRAINS
// ============================================================
//
// IMPORTANT:
// Upcoming trains DO NOT require live GPS.
//
// They come from the station board.
//
// ============================================================

function buildUpcomingFromBoard(
  trainsArray,
  now
) {
  const upcoming = [];

  for (
    const item
    of trainsArray
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
      !ALL_APPROVED_TRAINS.has(
        trainNo
      )
    ) {
      continue;
    }


    const arrival =
      getBoardArrivalTime(
        item
      );

    if (!arrival) {
      continue;
    }


    const delayMin =
      getDelayMinutes(
        live
      );


    // If RailRadar gave a scheduled arrival
    // but not an already delayed expected arrival,
    // apply the reported delay.
    //
    // Avoid applying delay twice when the field is
    // already expectedArrivalTime.

    let effectiveArrival =
      arrival;

    const arrivalSource =
      [
        live.expectedArrivalTime,
        live.expectedArrival
      ].find(Boolean);

    if (
      !arrivalSource &&
      delayMin !== 0
    ) {
      effectiveArrival =
        addMinutes(
          arrival,
          delayMin
        );
    }


    const eta =
      minutesUntil(
        effectiveArrival,
        now
      );

    if (
      eta === null
    ) {
      continue;
    }


    // Only show:
    //
    // 15 minutes after ETA
    // through
    // 240 minutes ahead.
    //
    if (
      eta < -15 ||
      eta > UPCOMING_WINDOW_MINUTES
    ) {
      continue;
    }


    let corridor =
      null;

    if (
      APPROVED_TPTY_TRAINS.has(
        trainNo
      )
    ) {
      corridor =
        "TPTY";
    } else if (
      APPROVED_MAS_TRAINS.has(
        trainNo
      )
    ) {
      corridor =
        "MAS";
    } else if (
      APPROVED_OTHER_TRAINS.has(
        trainNo
      )
    ) {
      corridor =
        "OTHER";
    }


    if (!corridor) {
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


    const platform =
      String(
        live.platform ||
        stop.platform ||
        item.platform ||
        "1"
      );


    upcoming.push({
      trainNo,

      name:
        getTrainName(
          train,
          trainNo
        ),

      origin:
        origin ||
        (
          corridor === "TPTY"
            ? "Tirupati side"
            : corridor === "MAS"
              ? "Chennai side"
              : "Southern side"
        ),

      destination:
        destination ||
        "Gudur",

      etaMinutes:
        Math.max(
          0,
          eta
        ),

      delayMinutes:
        delayMin,

      corridor,

      direction:
        "TOWARD GUDUR",

      platform
    });
  }


  // Sort nearest first.
  upcoming.sort(
    (a, b) =>
      a.etaMinutes -
      b.etaMinutes
  );


  // Remove duplicate train numbers.
  const unique =
    [];

  const seen =
    new Set();

  for (
    const train
    of upcoming
  ) {
    if (
      seen.has(
        train.trainNo
      )
    ) {
      continue;
    }

    seen.add(
      train.trainNo
    );

    unique.push(
      train
    );

    if (
      unique.length >= 5
    ) {
      break;
    }
  }

  return unique;
}


// ============================================================
// FIND LIVE CANDIDATES
// ============================================================
//
// We only need live GPS for trains that may control a gate.
//
// Select the nearest approved trains first.
//
// ============================================================

function findLiveCandidates(
  trainsArray,
  now
) {
  const candidates = [];

  for (
    const item
    of trainsArray
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


    const arrival =
      getBoardArrivalTime(
        item
      );

    if (!arrival) {
      continue;
    }


    const eta =
      minutesUntil(
        arrival,
        now
      );

    if (
      eta === null
    ) {
      continue;
    }


    // Only query live GPS for trains that
    // are near enough in the station board
    // to potentially matter.
    //
    // Give a little extra room for delays.
    //
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
      a.eta -
      b.eta
  );


  // Limit live API usage.
  return candidates.slice(
    0,
    MAX_LIVE_REQUESTS
  );
}


// ============================================================
// RAILRADAR REQUEST
// ============================================================

let requestsThisCycle =
  0;


async function railRadarGet(
  path,
  params = {}
) {
  requestsThisCycle += 1;

  const response =
    await axios.get(
      `${RAILRADAR_BASE_URL}${path}`,
      {
        params,

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

  return response.data;
}


// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    const data =
      await railRadarGet(
        `/trains/${encodeURIComponent(
          trainNo
        )}/live`,
        {
          authoritative:
            true,

          includeCoordinates:
            true
        }
      );

    return {
      trainNo,
      data
    };
  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo}: ${error.message}`
    );

    return {
      trainNo,
      data: null,
      error
    };
  }
}


// ============================================================
// CREATE OPEN GATE
// ============================================================

function createOpenGate() {
  return {
    status:
      "OPEN",

    waitMinutes:
      0,

    activeTrain:
      "Tracks clear",

    direction:
      "NONE",

    corridor:
      null
  };
}


// ============================================================
// CREATE WARNING GATE
// ============================================================

function createWarningGate(
  candidate
) {
  const waitMinutes =
    Math.max(
      1,
      Math.ceil(
        candidate.distanceKm *
        2
      )
    );

  return {
    status:
      "WARNING",

    waitMinutes,

    activeTrain:
      `${candidate.trainNo} ${candidate.name}`,

    direction:
      "TOWARD GUDUR",

    corridor:
      candidate.corridor,

    distanceKm:
      Number(
        candidate.distanceKm.toFixed(
          3
        )
      ),

    source:
      "LIVE_GPS"
  };
}


// ============================================================
// CREATE CLOSED GATE
// ============================================================

function createClosedGate(
  candidate
) {
  const waitMinutes =
    Math.max(
      1,
      Math.ceil(
        candidate.distanceKm *
        4
      )
    );

  return {
    status:
      "CLOSED",

    waitMinutes,

    activeTrain:
      `${candidate.trainNo} ${candidate.name}`,

    direction:
      "TOWARD GUDUR",

    corridor:
      candidate.corridor,

    distanceKm:
      Number(
        candidate.distanceKm.toFixed(
          3
        )
      ),

    source:
      "LIVE_GPS"
  };
}


// ============================================================
// CHOOSE BEST GATE STATE
// ============================================================
//
// CLOSED beats WARNING.
// WARNING beats OPEN.
//
// If multiple trains exist,
// nearest train wins.
//
// ============================================================

function chooseGateState(
  candidates
) {
  if (
    !candidates ||
    candidates.length === 0
  ) {
    return createOpenGate();
  }


  const closed =
    candidates
      .filter(
        (candidate) =>
          candidate.distanceKm <=
          CLOSE_DISTANCE_KM
      )
      .sort(
        (a, b) =>
          a.distanceKm -
          b.distanceKm
      );


  if (
    closed.length > 0
  ) {
    return createClosedGate(
      closed[0]
    );
  }


  const warning =
    candidates
      .filter(
        (candidate) =>
          candidate.distanceKm <=
          WARNING_DISTANCE_KM
      )
      .sort(
        (a, b) =>
          a.distanceKm -
          b.distanceKm
      );


  if (
    warning.length > 0
  ) {
    return createWarningGate(
      warning[0]
    );
  }


  return createOpenGate();
}


// ============================================================
// PROCESS LIVE TRAIN
// ============================================================

function processLiveTrain(
  candidate,
  liveResponse
) {
  if (
    !liveResponse ||
    !liveResponse.data
  ) {
    return null;
  }


  const liveData =
    liveResponse.data;


  // RailRadar may wrap the actual response
  // inside data.
  const live =
    liveData?.data ||
    liveData?.train ||
    liveData;


  if (
    !live ||
    typeof live !==
      "object"
  ) {
    return null;
  }


  const coordinates =
    extractCoordinates(
      live
    );


  if (!coordinates) {
    console.log(
      `[NO GPS] ${candidate.trainNo} - no usable live coordinates`
    );

    return null;
  }


  const direction =
    isTrainTowardGudur(
      candidate.train,
      live,
      candidate.stop,
      candidate.item
    );


  // ----------------------------------------------------------
  // NEVER close a gate when direction is explicitly outbound.
  // ----------------------------------------------------------

  if (
    direction === false
  ) {
    console.log(
      `[OUTBOUND IGNORED] ${candidate.trainNo}`
    );

    return null;
  }


  // Unknown direction:
  //
  // For TPTY approved trains we allow the train because
  // the approved list represents the intended inbound
  // southern corridor.
  //
  // For MAS and OTHER, unknown direction is rejected.
  //
  if (
    direction === null &&
    candidate.corridor !==
      "TPTY"
  ) {
    console.log(
      `[UNKNOWN DIRECTION] ${candidate.trainNo} - ignored`
    );

    return null;
  }


  const distance =
    getGateDistance(
      candidate.corridor,
      coordinates
    );


  if (
    distance === null
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // Ignore trains outside warning radius.
  // ----------------------------------------------------------

  if (
    distance >
    WARNING_DISTANCE_KM
  ) {
    console.log(
      `[CLEAR] ${candidate.trainNo} ${candidate.corridor} | gate distance ${distance.toFixed(3)} km`
    );

    return null;
  }


  const name =
    getTrainName(
      candidate.train,
      candidate.trainNo
    );


  console.log(
    `[LIVE ${candidate.corridor}] ${candidate.trainNo} ${name} | ${distance.toFixed(3)} km from gate | direction=${direction === true ? "TOWARD GUDUR" : "ASSUMED TOWARD GUDUR"}`
  );


  return {
    trainNo:
      candidate.trainNo,

    name,

    corridor:
      candidate.corridor,

    distanceKm:
      distance,

    direction:
      "TOWARD GUDUR",

    coordinates
  };
}


// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  const now =
    getCurrentIndiaDate();


  console.log(
    "\n=========================================="
  );

  console.log(
    " GUDUR CROSSING RADAR - MONITOR CYCLE "
  );

  console.log(
    "=========================================="
  );

  console.log(
    `Time (IST): ${formatIndiaDateTime(now)}`
  );

  console.log(
    `Station: ${GUDUR_STATION_CODE}`
  );

  console.log(
    `RailRadar API: ${RAILRADAR_BASE_URL}`
  );


  // ----------------------------------------------------------
  // DEFAULT GATE STATES
  // ----------------------------------------------------------

  let masGate =
    createOpenGate();

  let tptyGate =
    createOpenGate();


  // ----------------------------------------------------------
  // GET STATION BOARD
  // ----------------------------------------------------------

  console.log(
    "\n[1/4] Querying RailRadar GDR live station board..."
  );


  let responseBody;

  try {
    responseBody =
      await railRadarGet(
        `/stations/${GUDUR_STATION_CODE}/live`,
        {
          hours: 4
        }
      );
  } catch (error) {
    console.error(
      "\n❌ RailRadar station board request failed."
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

    throw error;
  }


  const trainsArray =
    responseBody?.data?.trains ||
    responseBody?.trains ||
    [];


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
    `✅ RailRadar returned ${trainsArray.length} station-board entries.`
  );


  // ----------------------------------------------------------
  // UPCOMING TRAINS
  // ----------------------------------------------------------

  console.log(
    "\n[2/4] Building upcoming train queue..."
  );


  const upcomingTrains =
    buildUpcomingFromBoard(
      trainsArray,
      now
    );


  console.log(
    `✅ Upcoming relevant trains: ${upcomingTrains.length}`
  );


  if (
    upcomingTrains.length > 0
  ) {
    upcomingTrains.forEach(
      (train) => {
        console.log(
          `   ${train.corridor} | ${train.trainNo} ${train.name} | ETA ${train.etaMinutes}m`
        );
      }
    );
  } else {
    console.log(
      "   No approved upcoming trains."
    );
  }


  // ----------------------------------------------------------
  // LIVE CANDIDATES
  // ----------------------------------------------------------

  console.log(
    "\n[3/4] Selecting live GPS candidates..."
  );


  const candidates =
    findLiveCandidates(
      trainsArray,
      now
    );


  console.log(
    `✅ Live candidates selected: ${candidates.length}`
  );


  if (
    candidates.length > 0
  ) {
    candidates.forEach(
      (candidate) => {
        console.log(
          `   ${candidate.corridor} | ${candidate.trainNo} | board ETA ${Math.max(0, candidate.eta)}m`
        );
      }
    );
  }


  // ----------------------------------------------------------
  // LIVE GPS REQUESTS
  // ----------------------------------------------------------
  //
  // Run in parallel.
  //
  // This is much faster than waiting 12 seconds for every
  // train sequentially.
  //
  // ----------------------------------------------------------

  const liveResults =
    await Promise.all(
      candidates.map(
        (candidate) =>
          fetchLiveTrain(
            candidate.trainNo
          )
      )
    );


  // ----------------------------------------------------------
  // PROCESS LIVE GPS
  // ----------------------------------------------------------

  const masCandidates =
    [];

  const tptyCandidates =
    [];


  for (
    let i = 0;
    i <
      candidates.length;
    i++
  ) {
    const candidate =
      candidates[i];

    const liveResponse =
      liveResults[i];


    const processed =
      processLiveTrain(
        candidate,
        liveResponse
      );


    if (!processed) {
      continue;
    }


    if (
      candidate.corridor ===
      "MAS"
    ) {
      masCandidates.push(
        processed
      );
    }


    if (
      candidate.corridor ===
      "TPTY"
    ) {
      tptyCandidates.push(
        processed
      );
    }
  }


  // ----------------------------------------------------------
  // CHOOSE GATE STATES
  // ----------------------------------------------------------

  masGate =
    chooseGateState(
      masCandidates
    );

  tptyGate =
    chooseGateState(
      tptyCandidates
    );


  // ----------------------------------------------------------
  // FIREBASE DATA
  // ----------------------------------------------------------

  const upcomingObject =
    {};

  upcomingTrains.forEach(
    (train, index) => {
      upcomingObject[
        String(index)
      ] = train;
    }
  );


  const durationMs =
    Date.now() -
    startedAt;


  const payload = {
    tirupatiGate:
      tptyGate,

    chennaiGate:
      masGate,

    upcomingTrains:
      upcomingObject,

    lastUpdated:
      formatIndiaTime(now),

    lastUpdatedAt:
      new Date().toISOString(),

    lastUpdatedLocal:
      formatIndiaDateTime(now),

    timezone:
      INDIA_TIMEZONE,

    apiRequestsThisCycle:
      requestsThisCycle,

    cycleDurationMs:
      durationMs,

    meta: {
      station:
        GUDUR_STATION_CODE,

      directionRule:
        "SOUTHERN SIDE -> GUDUR ONLY",

      gateControl:
        "LIVE GPS DISTANCE",

      upcomingSource:
        "STATION BOARD ETA",

      closeDistanceKm:
        CLOSE_DISTANCE_KM,

      warningDistanceKm:
        WARNING_DISTANCE_KM,

      clearDistanceKm:
        CLEAR_DISTANCE_KM,

      maxLiveRequests:
        MAX_LIVE_REQUESTS
    }
  };


  // ----------------------------------------------------------
  // WRITE FIREBASE
  // ----------------------------------------------------------

  console.log(
    "\n[4/4] Updating Firebase..."
  );


  await gateRef.set(
    payload
  );


  // ----------------------------------------------------------
  // VERIFY FIREBASE
  // ----------------------------------------------------------

  console.log(
    "✅ Firebase write completed."
  );


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
    "✅ Firebase verification successful."
  );


  // ----------------------------------------------------------
  // FINAL LOGS
  // ----------------------------------------------------------

  console.log(
    "\n=========================================="
  );

  console.log(
    " SYNC SUCCESS "
  );

  console.log(
    "=========================================="
  );

  console.log(
    `Chennai Gate : ${masGate.status}`
  );

  console.log(
    `   Train     : ${masGate.activeTrain}`
  );

  console.log(
    `   Distance  : ${
      masGate.distanceKm !== undefined
        ? `${masGate.distanceKm} km`
        : "N/A"
    }`
  );

  console.log(
    `Tirupati Gate: ${tptyGate.status}`
  );

  console.log(
    `   Train     : ${tptyGate.activeTrain}`
  );

  console.log(
    `   Distance  : ${
      tptyGate.distanceKm !== undefined
        ? `${tptyGate.distanceKm} km`
        : "N/A"
    }`
  );

  console.log(
    `Upcoming trains: ${upcomingTrains.length}`
  );

  console.log(
    `API requests: ${requestsThisCycle}`
  );

  console.log(
    `Cycle duration: ${durationMs} ms`
  );

  console.log(
    "==========================================\n"
  );


  return payload;
}


// ============================================================
// APPLICATION START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " GUDUR CROSSING RADAR V8.1 "
);

console.log(
  "=========================================="
);

console.log(
  "Station: GDR"
);

console.log(
  "Chennai Gate: 14.1396639, 79.8441306"
);

console.log(
  "Tirupati Gate: 14.1402056, 79.8436000"
);

console.log(
  "Gudur Station: 14.14842, 79.84524"
);

console.log(
  "Direction: Southern side -> Gudur only"
);

console.log(
  "Gate control: Live GPS distance"
);

console.log(
  "Upcoming trains: Station board ETA"
);

console.log(
  "Timezone: Asia/Kolkata"
);

console.log(
  "=========================================="
);


// ============================================================
// RUN ONE CYCLE AND EXIT
// ============================================================
//
// IMPORTANT:
// DO NOT ADD setInterval().
//
// GitHub Actions itself runs this script every 5 minutes.
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

    console.error(
      error.message
    );

    process.exit(1);
  }
})();
