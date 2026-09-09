// ============================================================
// GUDUR GATE TRACKER
// RailRadar + Firebase
// ============================================================

// GitHub Actions normally runs in UTC.
// Force Node.js date/time calculations to IST.
process.env.TZ = "Asia/Kolkata";

const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

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
    JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  throw new Error(
    `FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${error.message}`
  );
}

admin.initializeApp({
  credential:
    admin.credential.cert(serviceAccount),

  databaseURL:
    "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db =
  admin.database();

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

const API_TIMEOUT_MS = 8000;

// ============================================================
// LOCATION
// ============================================================

const GUDUR = {
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
// GATE RULES
// ============================================================
//
// > 4.00 km
//     OPEN
//
// 3.01 km - 4.00 km
//     WARNING
//
// <= 3.00 km
//     CLOSED
//
// After CLOSED:
//     Keep CLOSED for 15 minutes.
//
// ============================================================

const WARNING_DISTANCE_KM = 4.00;

const CLOSE_DISTANCE_KM = 3.00;

// Informational reference only.
const CLEAR_DISTANCE_KM = 0.80;

// Persistent gate hold.
const GATE_HOLD_MINUTES = 5;

const GATE_HOLD_MS =
  GATE_HOLD_MINUTES *
  60 *
  1000;

// ============================================================
// UPCOMING / LIVE SETTINGS
// ============================================================

const STATION_BOARD_HOURS = 4;

const MAX_UPCOMING_TRAINS = 10;

// Only trains within this ETA receive live API checks.
const LIVE_LOOKAHEAD_MINUTES = 90;

// Maximum live train API requests.
const MAX_LIVE_REQUESTS = 10;

// Maximum static route API requests per run.
const MAX_ROUTE_REQUESTS = 10;

// ============================================================
// RAILRADAR HTTP CONFIG
// ============================================================

function railRadarConfig() {
  return {
    headers: {
      Authorization:
        `Bearer ${RAILRADAR_API_KEY}`,

      Accept:
        "application/json"
    },

    timeout:
      API_TIMEOUT_MS
  };
}

// ============================================================
// IST HELPERS
// ============================================================

function getISTDateParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Asia/Kolkata",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hourCycle:
          "h23"
      }
    ).formatToParts(
      new Date()
    );

  const result = {};

  for (const part of parts) {
    if (
      part.type !== "literal"
    ) {
      result[part.type] =
        part.value;
    }
  }

  return result;
}

function getCurrentISTMinutes() {
  const p =
    getISTDateParts();

  return (
    Number(p.hour) *
      60 +
    Number(p.minute)
  );
}

function getCurrentISTDateString() {
  const p =
    getISTDateParts();

  return (
    `${p.year}-${p.month}-${p.day}`
  );
}

function getCurrentISTTimeString() {
  const p =
    getISTDateParts();

  return (
    `${p.hour}:${p.minute}:${p.second}`
  );
}

function getCurrentISTDisplayTime() {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone:
        "Asia/Kolkata",

      hour:
        "2-digit",

      minute:
        "2-digit",

      second:
        "2-digit",

      hour12:
        true
    }
  ).format(
    new Date()
  );
}

// ============================================================
// TEXT NORMALIZER
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(
      /[^A-Z0-9]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    );
}

function containsAny(
  text,
  values
) {
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
// VALUE HELPER
// ============================================================

function getNameOrCode(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value ===
    "string"
  ) {
    return value;
  }

  if (
    typeof value ===
    "object"
  ) {
    return (
      value.name ||
      value.code ||
      value.stationName ||
      value.stationCode ||
      ""
    );
  }

  return String(value);
}

// ============================================================
// TRAIN NUMBER
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
// TRAIN NAME
// ============================================================

function getTrainName(
  train,
  item
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  return (
    train.name ||
    item.trainName ||
    item.name ||
    `Train ${trainNo}`
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    getNameOrCode(
      train.origin
    ) ||

    getNameOrCode(
      train.source
    ) ||

    getNameOrCode(
      train.from
    ) ||

    getNameOrCode(
      item.origin
    ) ||

    getNameOrCode(
      item.source
    ) ||

    getNameOrCode(
      item.from
    ) ||

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
  return (
    getNameOrCode(
      train.destination
    ) ||

    getNameOrCode(
      train.to
    ) ||

    getNameOrCode(
      item.destination
    ) ||

    getNameOrCode(
      item.to
    ) ||

    ""
  );
}

// ============================================================
// PLATFORM
// ============================================================

function getPlatform(
  train,
  live,
  stop,
  item
) {
  return String(
    live.platform ||
      stop.platform ||
      item.platform ||
      train.platform ||
      "1"
  );
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeValue,
  delayMinutes = 0
) {
  if (!timeValue) {
    return -1;
  }

  const value =
    String(timeValue)
      .trim();

  // HH:MM
  const simpleMatch =
    value.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (simpleMatch) {
    return (
      Number(
        simpleMatch[1]
      ) *
        60 +

      Number(
        simpleMatch[2]
      ) +

      Number(
        delayMinutes || 0
      )
    );
  }

  // ISO / date
  const date =
    new Date(value);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    const parts =
      new Intl.DateTimeFormat(
        "en-GB",
        {
          timeZone:
            "Asia/Kolkata",

          hour:
            "2-digit",

          minute:
            "2-digit",

          hourCycle:
            "h23"
        }
      ).formatToParts(
        date
      );

    let hour = 0;
    let minute = 0;

    for (
      const part of parts
    ) {
      if (
        part.type ===
        "hour"
      ) {
        hour =
          Number(
            part.value
          );
      }

      if (
        part.type ===
        "minute"
      ) {
        minute =
          Number(
            part.value
          );
      }
    }

    return (
      hour * 60 +
      minute +
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

  // Midnight handling.
  if (
    diff < -720
  ) {
    diff += 1440;
  }

  if (
    diff > 720
  ) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// BOARD STATUS
// ============================================================

function getBoardStatus(
  train,
  live,
  stop,
  item
) {
  return normalizeText(
    live.type ||
      live.status ||
      stop.status ||
      item.status ||
      train.status ||
      ""
  );
}

// ============================================================
// AT STATION
// ============================================================

function isAtStation(
  train,
  live,
  stop,
  item
) {
  const status =
    getBoardStatus(
      train,
      live,
      stop,
      item
    );

  return (
    status ===
      "AT STATION" ||

    status ===
      "AT-STATION" ||

    status.includes(
      "AT STATION"
    )
  );
}

// ============================================================
// DEPARTED
// ============================================================

function isDeparted(
  train,
  live,
  stop,
  item
) {
  const status =
    getBoardStatus(
      train,
      live,
      stop,
      item
    );

  return (
    status ===
      "DEPARTED" ||

    status.includes(
      "CANCELLED"
    ) ||

    status.includes(
      "CANCELED"
    )
  );
}

// ============================================================
// ARRIVAL TIME
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

    item.arrival ||
    item.expectedArrival ||
    item.scheduledArrival ||

    live.expectedArrivalTime ||
    live.arrivalTime ||

    train.arrival ||
    train.arrivalTime ||

    ""
  );
}

// ============================================================
// DEPARTURE TIME
// ============================================================

function getDepartureTime(
  train,
  live,
  stop,
  item,
  arrivalTime
) {
  return (
    live.expectedDepartureTime ||
    live.departureTime ||

    stop.departure ||
    stop.expectedDeparture ||
    stop.scheduledDeparture ||

    item.departure ||
    item.expectedDeparture ||
    item.scheduledDeparture ||

    train.departure ||
    train.departureTime ||

    arrivalTime
  );
}

// ============================================================
// BOARD ETA
// ============================================================

function calculateBoardEta(
  train,
  live,
  stop,
  item
) {
  // If the board says the train is already at GDR.
  if (
    isAtStation(
      train,
      live,
      stop,
      item
    )
  ) {
    return 0;
  }

  const currentMinutes =
    getCurrentISTMinutes();

  const delayMin =
    Number(
      live.delayMinutes ??
        item.delayMinutes ??
        train.delayMinutes ??
        0
    );

  // ----------------------------------------------------------
  // 1. SCHEDULED GDR ARRIVAL
  // ----------------------------------------------------------

  const scheduledArrival =
    stop.arrival ||
    stop.scheduledArrival ||
    item.arrival ||
    item.scheduledArrival ||
    train.arrival;

  if (
    scheduledArrival
  ) {
    const scheduledMinutes =
      parseTimeToMinutes(
        scheduledArrival,
        0
      );

    if (
      scheduledMinutes !==
      -1
    ) {
      let diff =
        calculateTimeDifference(
          scheduledMinutes +
            delayMin,
          currentMinutes
        );

      if (
        diff < 0 &&
        diff > -60
      ) {
        diff = 0;
      }

      return Math.max(
        0,
        Math.round(diff)
      );
    }
  }

  // ----------------------------------------------------------
  // 2. LIVE EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const expectedArrival =
    live.expectedArrivalTime ||
    live.arrivalTime ||
    stop.expectedArrival ||
    item.expectedArrival ||
    train.arrivalTime;

  if (
    expectedArrival
  ) {
    const expectedMinutes =
      parseTimeToMinutes(
        expectedArrival,
        0
      );

    if (
      expectedMinutes !==
      -1
    ) {
      let diff =
        calculateTimeDifference(
          expectedMinutes,
          currentMinutes
        );

      if (
        diff < 0 &&
        diff > -60
      ) {
        diff = 0;
      }

      return Math.max(
        0,
        Math.round(diff)
      );
    }
  }

  // ----------------------------------------------------------
  // 3. DIRECT ETA
  // ----------------------------------------------------------

  const directEta =
    live.etaMinutes ??
    live.eta ??
    item.etaMinutes ??
    item.eta ??
    train.etaMinutes ??
    train.eta;

  if (
    directEta !==
      undefined &&
    directEta !==
      null &&
    Number.isFinite(
      Number(directEta)
    )
  ) {
    return Math.max(
      0,
      Math.round(
        Number(directEta)
      )
    );
  }

  return null;
}

// ============================================================
// DISTANCE
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
      degreesToRadians(
        lat1
      )
    ) *

      Math.cos(
        degreesToRadians(
          lat2
        )
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
// RAILRADAR LIVE TRAIN
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
            authoritative:
              true,

            includeCoordinates:
              true
          },

          ...railRadarConfig()
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
        `[LIVE ERROR] ${trainNo} HTTP ${error.response.status}`
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
// RAILRADAR STATIC TRAIN ROUTE
// ============================================================
//
// Used for upcoming-list corridor classification.
//
// Official RailRadar route API:
// /v1/trains/{number}/route?format=geojson&stops=true
//
// ============================================================

async function fetchTrainRoute(
  trainNo
) {
  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
          trainNo
        )}/route`,
        {
          params: {
            format:
              "geojson",

            stops:
              true
          },

          ...railRadarConfig()
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
        `[ROUTE ERROR] ${trainNo} HTTP ${error.response.status}`
      );
    } else {
      console.error(
        `[ROUTE ERROR] ${trainNo}: ${error.message}`
      );
    }

    return null;
  }
}

// ============================================================
// ROUTE HELPERS
// ============================================================

function getRoute(
  liveData
) {
  if (
    Array.isArray(
      liveData?.route
    )
  ) {
    return liveData.route;
  }

  return [];
}

function getRouteStops(
  routeData
) {
  if (
    Array.isArray(
      routeData?.stops
    )
  ) {
    return routeData.stops;
  }

  if (
    Array.isArray(
      routeData?.data?.stops
    )
  ) {
    return routeData.data.stops;
  }

  return [];
}

function getStationCode(
  station
) {
  return normalizeText(
    station?.stationCode ||
      station?.code ||
      ""
  );
}

function getStationCoordinates(
  station
) {
  const lat =
    Number(
      station?.lat ??
        station?.latitude
    );

  const lng =
    Number(
      station?.lng ??
        station?.lon ??
        station?.longitude
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
// FIND GUDUR IN ROUTE
// ============================================================

function findGudurRouteIndex(
  route
) {
  return route.findIndex(
    (station) =>
      getStationCode(
        station
      ) === "GDR"
  );
}

// ============================================================
// FIND CURRENT ROUTE INDEX
// ============================================================

function findCurrentRouteIndex(
  route,
  currentLocation
) {
  const currentSequence =
    Number(
      currentLocation?.sequence
    );

  if (
    Number.isFinite(
      currentSequence
    )
  ) {
    const bySequence =
      route.findIndex(
        (station) =>
          Number(
            station.sequence
          ) ===
          currentSequence
      );

    if (
      bySequence !==
      -1
    ) {
      return bySequence;
    }
  }

  const currentCode =
    getStationCode(
      currentLocation
    );

  if (currentCode) {
    const byCode =
      route.findIndex(
        (station) =>
          getStationCode(
            station
          ) ===
          currentCode
      );

    if (
      byCode !==
      -1
    ) {
      return byCode;
    }
  }

  return -1;
}

// ============================================================
// INTERPOLATE LIVE POSITION
// ============================================================

function interpolatePosition(
  from,
  to,
  progress
) {
  const a =
    getStationCoordinates(
      from
    );

  const b =
    getStationCoordinates(
      to
    );

  if (!a || !b) {
    return null;
  }

  let p =
    Number(progress);

  if (
    !Number.isFinite(p)
  ) {
    p = 0;
  }

  p =
    Math.max(
      0,
      Math.min(
        1,
        p
      )
    );

  return {
    lat:
      a.lat +
      (
        b.lat -
        a.lat
      ) *
        p,

    lng:
      a.lng +
      (
        b.lng -
        a.lng
      ) *
        p
  };
}

// ============================================================
// GET LIVE TRAIN POSITION
// ============================================================

function getLiveTrainPosition(
  liveData
) {
  const currentLocation =
    liveData?.currentLocation ||
    liveData?.liveData?.currentLocation ||
    null;

  const route =
    getRoute(
      liveData
    );

  if (!currentLocation) {
    return null;
  }

  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  const currentIndex =
    findCurrentRouteIndex(
      route,
      currentLocation
    );

  // ----------------------------------------------------------
  // DIRECT GPS
  // ----------------------------------------------------------

  const directLat =
    Number(
      currentLocation.lat ??
        currentLocation.latitude
    );

  const directLng =
    Number(
      currentLocation.lng ??
        currentLocation.lon ??
        currentLocation.longitude
    );

  let coordinates =
    null;

  if (
    Number.isFinite(
      directLat
    ) &&
    Number.isFinite(
      directLng
    )
  ) {
    coordinates = {
      lat:
        directLat,

      lng:
        directLng
    };
  }

  // ----------------------------------------------------------
  // CURRENT STATION = GUDUR
  // ----------------------------------------------------------

  if (
    currentIndex ===
      gudurIndex &&
    gudurIndex !==
      -1
  ) {
    const gudurCoords =
      getStationCoordinates(
        route[gudurIndex]
      );

    if (gudurCoords) {
      coordinates =
        gudurCoords;
    }

    const currentStatus =
      normalizeText(
        currentLocation.status
      );

    const atGudur =
      currentStatus.includes(
        "AT STATION"
      ) ||
      currentStatus.includes(
        "AT-STATION"
      ) ||
      currentLocation.isHalt ===
        true;

    return {
      coordinates,

      currentRouteIndex:
        currentIndex,

      gudurRouteIndex:
        gudurIndex,

      inbound:
        atGudur,

      atGudur,

      currentLocation
    };
  }

  // ----------------------------------------------------------
  // ROUTE UNKNOWN
  // ----------------------------------------------------------

  if (
    currentIndex ===
      -1 ||
    gudurIndex ===
      -1
  ) {
    return {
      coordinates,

      currentRouteIndex:
        currentIndex,

      gudurRouteIndex:
        gudurIndex,

      inbound:
        null,

      atGudur:
        false,

      currentLocation
    };
  }

  // ----------------------------------------------------------
  // BEFORE GUDUR
  // ----------------------------------------------------------

  if (
    currentIndex <
    gudurIndex
  ) {
    if (!coordinates) {
      coordinates =
        interpolatePosition(
          route[
            currentIndex
          ],

          route[
            currentIndex +
              1
          ],

          currentLocation.segmentProgress
        );
    }

    return {
      coordinates,

      currentRouteIndex:
        currentIndex,

      gudurRouteIndex:
        gudurIndex,

      inbound:
        true,

      atGudur:
        false,

      currentLocation
    };
  }

  // ----------------------------------------------------------
  // AFTER GUDUR
  // ----------------------------------------------------------

  if (
    currentIndex >
    gudurIndex
  ) {
    if (!coordinates) {
      const nextIndex =
        Math.min(
          currentIndex +
            1,

          route.length -
            1
        );

      coordinates =
        interpolatePosition(
          route[
            currentIndex
          ],

          route[
            nextIndex
          ],

          currentLocation.segmentProgress
        );
    }

    return {
      coordinates,

      currentRouteIndex:
        currentIndex,

      gudurRouteIndex:
        gudurIndex,

      inbound:
        false,

      atGudur:
        false,

      currentLocation
    };
  }

  return {
    coordinates,

    currentRouteIndex:
      currentIndex,

    gudurRouteIndex:
      gudurIndex,

    inbound:
      null,

    atGudur:
      false,

    currentLocation
  };
}

// ============================================================
// CORRIDOR STATIONS
// ============================================================

const TPTY_STATIONS =
  new Set([
    "KQA",
    "VDD",
    "NDZ",
    "VKI",
    "YAL",
    "YLK",
    "AKY",
    "KHT",
    "RCG",
    "YPD",
    "SUPM",
    "RU",
    "TCNR",
    "TPTY"
  ]);

const MAS_STATIONS =
  new Set([
    "NYP",
    "NYPD",
    "NYD",
    "NDD",
    "SPE",
    "AKM",
    "TADA",
    "TRL",
    "MAS",
    "PER",
    "AJJ"
  ]);

// ============================================================
// DETERMINE CORRIDOR FROM ROUTE
// ============================================================
//
// The train's origin is NOT used as the primary classification.
//
// Example:
//
// 13433 SMVT Bengaluru
// Bengaluru -> ... -> Renigunta -> GDR
//
// This must be TPTY side.
//
// Therefore we look at the station immediately before GDR.
// ============================================================

function determineCorridorFromRouteStops(
  stops
) {
  if (
    !Array.isArray(stops) ||
    stops.length === 0
  ) {
    return null;
  }

  const ordered =
    [...stops].sort(
      (a, b) =>
        Number(
          a.sequence ?? 0
        ) -
        Number(
          b.sequence ?? 0
        )
    );

  const gudurIndex =
    ordered.findIndex(
      (station) =>
        getStationCode(
          station
        ) === "GDR"
    );

  if (
    gudurIndex <= 0
  ) {
    return null;
  }

  const previousStation =
    ordered[
      gudurIndex - 1
    ];

  const previousCode =
    getStationCode(
      previousStation
    );

  const previousCoords =
    getStationCoordinates(
      previousStation
    );

  // ----------------------------------------------------------
  // LONGITUDE
  // ----------------------------------------------------------

  if (
    previousCoords &&
    previousCoords.lng <
      GUDUR.lng -
        0.01
  ) {
    return "TPTY";
  }

  if (
    previousCoords &&
    previousCoords.lng >
      GUDUR.lng +
        0.01
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // KNOWN STATION CODES
  // ----------------------------------------------------------

  if (
    TPTY_STATIONS.has(
      previousCode
    )
  ) {
    return "TPTY";
  }

  if (
    MAS_STATIONS.has(
      previousCode
    )
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// LIVE ROUTE CORRIDOR
// ============================================================

function determineCorridorFromLiveRoute(
  liveData,
  positionInfo
) {
  const route =
    getRoute(
      liveData
    );

  const gudurIndex =
    positionInfo?.gudurRouteIndex;

  if (
    !Array.isArray(
      route
    ) ||
    gudurIndex ===
      -1 ||
    gudurIndex ===
      null ||
    gudurIndex ===
      undefined
  ) {
    return null;
  }

  // Must actually be inbound.
  if (
    positionInfo.inbound !==
    true
  ) {
    return null;
  }

  return determineCorridorFromRouteStops(
    route
  );
}

// ============================================================
// ORIGIN FALLBACK
// ============================================================
//
// ONLY for temporary display before route classification.
// Gate control NEVER uses this.
// ============================================================

function determineBoardDisplayCorridorFallback(
  train,
  item
) {
  const origin =
    normalizeText(
      getOrigin(
        train,
        item
      )
    );

  if (
    containsAny(
      origin,
      [
        "CHENNAI",
        "MAS",
        "CHENNAI CENTRAL",
        "MGR CHENNAI CENTRAL"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU"
      ]
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// BUILD UPCOMING LIST
// ============================================================

function buildUpcomingFromBoard(
  trainsArray,
  corridorCache
) {
  const upcoming =
    [];

  for (
    const item of
      trainsArray
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
      isDeparted(
        train,
        live,
        stop,
        item
      )
    ) {
      continue;
    }

    const trainName =
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

    const delayMin =
      Number(
        live.delayMinutes ??
          item.delayMinutes ??
          train.delayMinutes ??
          0
      );

    const etaMinutes =
      calculateBoardEta(
        train,
        live,
        stop,
        item
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

    const corridor =
      corridorCache[
        trainNo
      ] ||
      determineBoardDisplayCorridorFallback(
        train,
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
        "TOWARD GUDUR",

      platform:
        getPlatform(
          train,
          live,
          stop,
          item
        ),

      arrival:
        arrivalTime ||
        "",

      departure:
        departureTime ||
        "",

      boardStatus:
        getBoardStatus(
          train,
          live,
          stop,
          item
        )
    });
  }

  upcoming.sort(
    (a, b) => {
      if (
        a.etaMinutes ===
        null
      ) {
        return 1;
      }

      if (
        b.etaMinutes ===
        null
      ) {
        return -1;
      }

      return (
        a.etaMinutes -
        b.etaMinutes
      );
    }
  );

  return upcoming.slice(
    0,
    MAX_UPCOMING_TRAINS
  );
}

// ============================================================
// ENRICH UPCOMING CORRIDORS
// ============================================================
//
// Fetch static routes only for train numbers that are not already
// cached as MAS/TPTY.
//
// The route result is saved in Firebase.
// ============================================================

async function enrichUpcomingCorridors(
  upcomingList,
  existingCache
) {
  const cache = {
    ...(existingCache || {})
  };

  const unknownNumbers =
    upcomingList
      .filter(
        (train) =>
          !(
            cache[
              train.trainNo
            ] === "MAS" ||
            cache[
              train.trainNo
            ] === "TPTY"
          )
      )
      .map(
        (train) =>
          train.trainNo
      )
      .filter(
        (
          value,
          index,
          array
        ) =>
          array.indexOf(
            value
          ) === index
      );

  const routeNumbers =
    unknownNumbers.slice(
      0,
      MAX_ROUTE_REQUESTS
    );

  if (
    routeNumbers.length >
    0
  ) {
    console.log(
      `\n[ROUTE CLASSIFICATION] Fetching ${routeNumbers.length} uncached route(s)...`
    );
  }

  const results =
    await Promise.all(
      routeNumbers.map(
        async (
          trainNo
        ) => {
          const routeData =
            await fetchTrainRoute(
              trainNo
            );

          const stops =
            getRouteStops(
              routeData
            );

          const corridor =
            determineCorridorFromRouteStops(
              stops
            );

          return {
            trainNo,
            corridor
          };
        }
      )
    );

  for (
    const result of
      results
  ) {
    if (
      result.corridor ===
        "MAS" ||
      result.corridor ===
        "TPTY"
    ) {
      cache[
        result.trainNo
      ] =
        result.corridor;

      console.log(
        `[ROUTE CLASSIFIED] ${result.trainNo} -> ${result.corridor}`
      );
    } else {
      console.log(
        `[ROUTE UNKNOWN] ${result.trainNo} -> OTHER`
      );
    }
  }

  for (
    const train of
      upcomingList
  ) {
    const cached =
      cache[
        train.trainNo
      ];

    if (
      cached === "MAS" ||
      cached === "TPTY"
    ) {
      train.corridor =
        cached;

      train.direction =
        "TOWARD GUDUR";
    }
  }

  return cache;
}

// ============================================================
// FIND LIVE CANDIDATES
// ============================================================

function findLiveCandidates(
  trainsArray
) {
  const candidates =
    [];

  for (
    const item of
      trainsArray
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
      isDeparted(
        train,
        live,
        stop,
        item
      )
    ) {
      continue;
    }

    const eta =
      calculateBoardEta(
        train,
        live,
        stop,
        item
      );

    if (
      eta === null
    ) {
      continue;
    }

    if (
      eta >
      LIVE_LOOKAHEAD_MINUTES
    ) {
      continue;
    }

    candidates.push({
      item,

      train,

      live,

      stop,

      trainNo,

      etaMinutes:
        eta
    });
  }

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
// GATE STATE
// ============================================================

function getGateState(
  distanceKm
) {
  // <= 3.00 km
  if (
    distanceKm <=
    CLOSE_DISTANCE_KM
  ) {
    return "CLOSED";
  }

  // > 3.00 and <= 4.00
  if (
    distanceKm <=
    WARNING_DISTANCE_KM
  ) {
    return "WARNING";
  }

  // > 4.00
  return "OPEN";
}

function gatePriority(
  status
) {
  if (
    status ===
    "CLOSED"
  ) {
    return 3;
  }

  if (
    status ===
    "WARNING"
  ) {
    return 2;
  }

  return 1;
}

// ============================================================
// FIREBASE TIME PARSER
// ============================================================

function parseFirebaseTime(
  value
) {
  if (!value) {
    return null;
  }

  const time =
    new Date(
      value
    ).getTime();

  return Number.isFinite(
    time
  )
    ? time
    : null;
}

// ============================================================
// PREVIOUS GATE HOLD
// ============================================================

function getPreviousGateHoldState(
  previousGate,
  nowMs
) {
  if (
    !previousGate ||
    previousGate.status !==
      "CLOSED"
  ) {
    return {
      active:
        false,

      closedAtMs:
        null,

      remainingMinutes:
        0,

      trainNo:
        previousGate?.trainNo ||
        null
    };
  }

  const closedAtMs =
    parseFirebaseTime(
      previousGate.closedAtISO
    );

  if (
    closedAtMs ===
    null
  ) {
    return {
      active:
        false,

      closedAtMs:
        null,

      remainingMinutes:
        0,

      trainNo:
        previousGate.trainNo ||
        null
    };
  }

  const elapsed =
    nowMs -
    closedAtMs;

  const remainingMs =
    GATE_HOLD_MS -
    elapsed;

  if (
    remainingMs <=
    0
  ) {
    return {
      active:
        false,

      closedAtMs,

      remainingMinutes:
        0,

      trainNo:
        previousGate.trainNo ||
        null
    };
  }

  return {
    active:
      true,

    closedAtMs,

    remainingMinutes:
      Math.ceil(
        remainingMs /
          60000
      ),

    trainNo:
      previousGate.trainNo ||
      null
  };
}

// ============================================================
// APPLY PERSISTENT 15-MINUTE HOLD
// ============================================================

function applyPersistentGateHold(
  gate,
  previousGate,
  nowMs
) {
  const hold =
    getPreviousGateHoldState(
      previousGate,
      nowMs
    );

  // ----------------------------------------------------------
  // PREVIOUS CLOSED HOLD STILL ACTIVE
  // ----------------------------------------------------------

  if (
    hold.active
  ) {
    return {
      ...gate,

      status:
        "CLOSED",

      waitMinutes:
        hold.remainingMinutes,

      etaMinutes:
        gate.etaMinutes ??
        null,

      activeTrain:
        previousGate.activeTrain ||
        gate.activeTrain ||
        "Active rail vehicle",

      direction:
        previousGate.direction ||
        gate.direction ||
        "TOWARD GUDUR",

      corridor:
        previousGate.corridor ||
        gate.corridor,

      trainNo:
        previousGate.trainNo ||
        gate.trainNo ||
        null,

      closedAtISO:
        previousGate.closedAtISO,

      holdMinutes:
        GATE_HOLD_MINUTES,

      holdActive:
        true,

      holdRemainingMinutes:
        hold.remainingMinutes
    };
  }

  // ----------------------------------------------------------
  // NEW CLOSED STATE
  // ----------------------------------------------------------

  if (
    gate.status ===
    "CLOSED"
  ) {
    const closedAtISO =
      new Date().toISOString();

    return {
      ...gate,

      closedAtISO,

      holdMinutes:
        GATE_HOLD_MINUTES,

      holdActive:
        true,

      holdRemainingMinutes:
        GATE_HOLD_MINUTES
    };
  }

  // ----------------------------------------------------------
  // HOLD EXPIRED / OPEN
  // ----------------------------------------------------------

  return {
    ...gate,

    holdActive:
      false,

    holdRemainingMinutes:
      0,

    holdMinutes:
      GATE_HOLD_MINUTES,

    closedAtISO:
      previousGate?.closedAtISO ||
      null
  };
}

// ============================================================
// PROCESS ONE LIVE TRAIN
// ============================================================

async function processLiveCandidate(
  candidate
) {
  const {
    item,
    train,
    live: boardLive,
    stop,
    trainNo
  } = candidate;

  console.log(
    `\n[LIVE CHECK] ${trainNo} ${train.name || ""} | board ETA ${candidate.etaMinutes}m`
  );

  const liveData =
    await fetchLiveTrain(
      trainNo
    );

  if (!liveData) {
    console.log(
      `[NO LIVE DATA] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // LIVE POSITION
  // ----------------------------------------------------------

  const positionInfo =
    getLiveTrainPosition(
      liveData
    );

  if (!positionInfo) {
    console.log(
      `[NO POSITION] ${trainNo} - no currentLocation`
    );

    return null;
  }

  // ----------------------------------------------------------
  // OUTBOUND MUST NEVER CONTROL GATE
  // ----------------------------------------------------------

  if (
    positionInfo.inbound ===
    false
  ) {
    console.log(
      `[OUTBOUND IGNORED] ${trainNo} - already beyond GDR`
    );

    return null;
  }

  if (
    positionInfo.inbound ===
    null
  ) {
    console.log(
      `[UNKNOWN DIRECTION] ${trainNo} - cannot prove inbound`
    );

    return null;
  }

  const coordinates =
    positionInfo.coordinates;

  if (!coordinates) {
    console.log(
      `[NO POSITION COORDINATES] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // CORRIDOR
  // ----------------------------------------------------------

  const corridor =
    determineCorridorFromLiveRoute(
      liveData,
      positionInfo
    );

  if (!corridor) {
    console.log(
      `[NO CORRIDOR] ${trainNo} - approach side unknown`
    );

    return null;
  }

  // ----------------------------------------------------------
  // SELECT GATE
  // ----------------------------------------------------------

  const gate =
    corridor ===
    "MAS"
      ? CHENNAI_GATE
      : TIRUPATI_GATE;

  // ----------------------------------------------------------
  // DISTANCE TO GATE
  // ----------------------------------------------------------

  const distanceToGate =
    calculateDistanceKm(
      coordinates.lat,
      coordinates.lng,
      gate.lat,
      gate.lng
    );

  // ----------------------------------------------------------
  // DISTANCE TO GUDUR
  // ----------------------------------------------------------

  const distanceToGudur =
    calculateDistanceKm(
      coordinates.lat,
      coordinates.lng,
      GUDUR.lat,
      GUDUR.lng
    );

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------

  const status =
    getGateState(
      distanceToGate
    );

  const trainName =
    liveData.train?.name ||
    train.name ||
    item.trainName ||
    `Train ${trainNo}`;

  const delayMin =
    Number(
      liveData.delayMinutes ??
        boardLive.delayMinutes ??
        train.delayMinutes ??
        0
    );

  const liveStatus =
    normalizeText(
      liveData.status ||
        positionInfo
          .currentLocation
          ?.status ||
        ""
    );

  const atStation =
    liveStatus.includes(
      "AT STATION"
    ) ||
    liveStatus.includes(
      "AT-STATION"
    ) ||
    positionInfo.atGudur;

  // ----------------------------------------------------------
  // ONLY <= 4 KM CONTROLS GATE
  // ----------------------------------------------------------

  const gateRelevant =
    distanceToGate <=
    WARNING_DISTANCE_KM;

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  const boardEtaMinutes =
    candidate.etaMinutes;

  let waitMinutes = 0;

  if (
    status ===
      "OPEN" ||
    status ===
      "WARNING"
  ) {
    if (
      Number.isFinite(
        Number(
          boardEtaMinutes
        )
      )
    ) {
      waitMinutes =
        Math.max(
          0,
          Math.round(
            Number(
              boardEtaMinutes
            )
          )
        );
    }
  }

  if (
    status ===
    "CLOSED"
  ) {
    waitMinutes =
      Math.max(
        1,
        Math.ceil(
          Math.min(
            10,
            distanceToGate *
              2
          )
        )
      );
  }

  // ----------------------------------------------------------
  // TRAIN STATUS
  // ----------------------------------------------------------

  let trainStatus =
    "Approaching";

  if (
    atStation
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

  // ----------------------------------------------------------
  // FIREBASE PAYLOAD
  // ----------------------------------------------------------

  const payload = {
    status:
      gateRelevant
        ? status
        : "OPEN",

    waitMinutes:
      gateRelevant
        ? waitMinutes
        : (
            Number.isFinite(
              Number(
                boardEtaMinutes
              )
            )
              ? Math.max(
                  0,
                  Math.round(
                    Number(
                      boardEtaMinutes
                    )
                  )
                )
              : 0
          ),

    etaMinutes:
      Number.isFinite(
        Number(
          boardEtaMinutes
        )
      )
        ? Math.max(
            0,
            Math.round(
              Number(
                boardEtaMinutes
              )
            )
          )
        : null,

    activeTrain:
      gateRelevant
        ? `${trainNo} ${trainName} (${trainStatus})`
        : "Tracks clear",

    direction:
      "TOWARD GUDUR",

    corridor,

    distanceKm:
      Number(
        distanceToGate.toFixed(
          3
        )
      ),

    distanceToGudurKm:
      Number(
        distanceToGudur.toFixed(
          3
        )
      ),

    trainNo,

    trainName,

    delayMinutes:
      delayMin,

    platform:
      getPlatform(
        train,
        boardLive,
        stop,
        item
      )
  };

  console.log(
    `[INBOUND ${corridor}] ${trainNo} ${trainName} | ` +
    `GPS ${coordinates.lat.toFixed(5)},${coordinates.lng.toFixed(5)} | ` +
    `Gate ${distanceToGate.toFixed(2)} km | ` +
    `GDR ${distanceToGudur.toFixed(2)} km | ` +
    `${gateRelevant ? status : "OPEN / TOO FAR"}`
  );

  return {
    corridor,

    status:
      gateRelevant
        ? status
        : "OPEN",

    distanceToGate,

    distanceToGudur,

    gateRelevant,

    payload
  };
}

// ============================================================
// UPDATE UPCOMING CORRIDOR FROM LIVE DATA
// ============================================================

function updateUpcomingCorridor(
  upcomingList,
  trainNo,
  corridor
) {
  if (!corridor) {
    return;
  }

  const item =
    upcomingList.find(
      (train) =>
        train.trainNo ===
        trainNo
    );

  if (item) {
    item.corridor =
      corridor;

    item.direction =
      "TOWARD GUDUR";
  }
}

// ============================================================
// MAIN MONITOR
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  try {
    console.log(
      "\n=========================================="
    );

    console.log(
      " Gudur Gate Monitor Starting "
    );

    console.log(
      "=========================================="
    );

    console.log(
      `IST Date: ${getCurrentISTDateString()}`
    );

    console.log(
      `IST Time: ${getCurrentISTDisplayTime()}`
    );

    console.log(
      `Warning distance: ${WARNING_DISTANCE_KM} km`
    );

    console.log(
      `Close distance:   ${CLOSE_DISTANCE_KM} km`
    );

    console.log(
      `Gate hold:        ${GATE_HOLD_MINUTES} minutes`
    );

    // ========================================================
    // PREVIOUS FIREBASE STATE
    // ========================================================

    const previousSnapshot =
      await gateRef.once(
        "value"
      );

    const previousData =
      previousSnapshot.val() ||
      {};

    const previousChennaiGate =
      previousData.chennaiGate ||
      {};

    const previousTirupatiGate =
      previousData.tirupatiGate ||
      {};

    const previousCorridorCache =
      previousData.routeCorridorCache ||
      {};

    // ========================================================
    // GDR LIVE BOARD
    // ========================================================

    console.log(
      "\nQuerying RailRadar GDR live station board..."
    );

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours:
              STATION_BOARD_HOURS,

            includeIntermediate:
              true
          },

          ...railRadarConfig()
        }
      );

    const responseBody =
      boardResponse.data;

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
        responseBody?.trains
      )
    ) {
      trainsArray =
        responseBody.trains;
    } else if (
      Array.isArray(
        responseBody?.data
      )
    ) {
      trainsArray =
        responseBody.data;
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
    // UPCOMING LIST
    // ========================================================

    let upcomingList =
      buildUpcomingFromBoard(
        trainsArray,
        previousCorridorCache
      );

    // ========================================================
    // FIX UPCOMING LINE CLASSIFICATION
    // ========================================================

    const corridorCache =
      await enrichUpcomingCorridors(
        upcomingList,
        previousCorridorCache
      );

    // Rebuild using newly classified routes.
    upcomingList =
      buildUpcomingFromBoard(
        trainsArray,
        corridorCache
      );

    console.log(
      `Upcoming trains selected: ${upcomingList.length}`
    );

    console.log(
      "\n[UPCOMING GDR TRAINS]"
    );

    upcomingList.forEach(
      (
        train,
        index
      ) => {
        console.log(
          `${index + 1}. ` +
          `${train.trainNo} ${train.name} | ` +
          `${train.corridor} | ` +
          `ETA ${
            train.etaMinutes ===
            null
              ? "N/A"
              : `${train.etaMinutes}m`
          } | ` +
          `${train.boardStatus}`
        );
      }
    );

    // ========================================================
    // LIVE CANDIDATES
    // ========================================================

    const liveCandidates =
      findLiveCandidates(
        trainsArray
      );

    console.log(
      `\nLive candidates within ${LIVE_LOOKAHEAD_MINUTES} minutes: ${liveCandidates.length}`
    );

    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let chennaiGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      etaMinutes:
        null,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "MAS"
    };

    let tirupatiGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      etaMinutes:
        null,

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "TPTY"
    };

    // ========================================================
    // LIVE TRAIN PROCESSING
    // ========================================================

    const candidatesToCheck =
      liveCandidates.slice(
        0,
        MAX_LIVE_REQUESTS
      );

    let liveRequestCount =
      candidatesToCheck.length;

    console.log(
      `\nStarting ${liveRequestCount} live train request(s) in parallel...`
    );

    const liveResults =
      await Promise.all(
        candidatesToCheck.map(
          (
            candidate
          ) =>
            processLiveCandidate(
              candidate
            )
        )
      );

    // ========================================================
    // APPLY LIVE RESULTS
    // ========================================================

    for (
      let i = 0;
      i <
        liveResults.length;
      i++
    ) {
      const result =
        liveResults[i];

      const candidate =
        candidatesToCheck[i];

      if (!result) {
        continue;
      }

      // Upgrade upcoming display classification.
      updateUpcomingCorridor(
        upcomingList,
        candidate.trainNo,
        result.corridor
      );

      // Too far to control gate.
      if (
        !result.gateRelevant
      ) {
        continue;
      }

      // ======================================================
      // CHENNAI GATE
      // ======================================================

      if (
        result.corridor ===
        "MAS"
      ) {
        const oldPriority =
          gatePriority(
            chennaiGate.status
          );

        const newPriority =
          gatePriority(
            result.status
          );

        if (
          newPriority >
            oldPriority ||
          (
            newPriority ===
              oldPriority &&
            result.distanceToGate <
              (
                chennaiGate.distanceKm ??
                Infinity
              )
          )
        ) {
          chennaiGate =
            result.payload;
        }
      }

      // ======================================================
      // TIRUPATI GATE
      // ======================================================

      if (
        result.corridor ===
        "TPTY"
      ) {
        const oldPriority =
          gatePriority(
            tirupatiGate.status
          );

        const newPriority =
          gatePriority(
            result.status
          );

        if (
          newPriority >
            oldPriority ||
          (
            newPriority ===
              oldPriority &&
            result.distanceToGate <
              (
                tirupatiGate.distanceKm ??
                Infinity
              )
          )
        ) {
          tirupatiGate =
            result.payload;
        }
      }
    }

    // ========================================================
    // APPLY PERSISTENT 15-MINUTE HOLD
    // ========================================================

    const nowMs =
      Date.now();

    chennaiGate =
      applyPersistentGateHold(
        chennaiGate,
        previousChennaiGate,
        nowMs
      );

    tirupatiGate =
      applyPersistentGateHold(
        tirupatiGate,
        previousTirupatiGate,
        nowMs
      );

    // ========================================================
    // FINAL FIREBASE UPDATE
    // ========================================================

    const processingSeconds =
      (
        Date.now() -
        startedAt
      ) / 1000;

    await gateRef.set({
      tirupatiGate,

      chennaiGate,

      upcomingTrains:
        upcomingList,

      // Cached train-number -> corridor.
      routeCorridorCache:
        corridorCache,

      lastUpdated:
        getCurrentISTDisplayTime(),

      lastUpdatedISO:
        new Date().toISOString(),

      lastUpdatedIST:
        `${getCurrentISTDateString()} ${getCurrentISTTimeString()}`,

      boardTrainCount:
        trainsArray.length,

      liveRequestCount,

      routeRequestLimit:
        MAX_ROUTE_REQUESTS,

      processingSeconds:
        Number(
          processingSeconds.toFixed(
            2
          )
        ),

      meta: {
        timezone:
          "Asia/Kolkata",

        timezoneLabel:
          "IST",

        warningDistanceKm:
          WARNING_DISTANCE_KM,

        closeDistanceKm:
          CLOSE_DISTANCE_KM,

        clearDistanceKm:
          CLEAR_DISTANCE_KM,

        gateHoldMinutes:
          GATE_HOLD_MINUTES,

        upcomingWindowHours:
          STATION_BOARD_HOURS,

        maxUpcoming:
          MAX_UPCOMING_TRAINS,

        liveLookaheadMinutes:
          LIVE_LOOKAHEAD_MINUTES,

        maxLiveRequests:
          MAX_LIVE_REQUESTS,

        source:
          "RailRadar GDR live station board + train route geometry + live train telemetry",

        upcomingCorridorLogic:
          "Actual RailRadar route; station immediately before GDR",

        gateLogic:
          "LIVE ROUTE POSITION + DISTANCE",

        directionLogic:
          "TRAIN MUST BE BEFORE GDR ON LIVE ROUTE",

        gateRelevance:
          "TRAIN MUST BE WITHIN 4 KM OF ITS GATE TO CONTROL THE GATE"
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
      `Chennai Gate : ${chennaiGate.status}`
    );

    console.log(
      `  ${chennaiGate.activeTrain}`
    );

    console.log(
      `Tirupati Gate: ${tirupatiGate.status}`
    );

    console.log(
      `  ${tirupatiGate.activeTrain}`
    );

    console.log(
      `Upcoming trains: ${upcomingList.length}`
    );

    console.log(
      `Live requests: ${liveRequestCount}`
    );

    console.log(
      `Processing time: ${processingSeconds.toFixed(2)} seconds`
    );

    console.log(
      "==========================================\n"
    );
  } catch (error) {
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

    process.exitCode =
      1;
  }
}

// ============================================================
// START ONE RUN
// ============================================================
//
// IMPORTANT:
// No setInterval().
// GitHub Actions runs this script according to the workflow.
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " Gudur Gate Monitor Starting "
);

console.log(
  "=========================================="
);

console.log(
  `Gudur: ${GUDUR.lat}, ${GUDUR.lng}`
);

console.log(
  `Chennai Gate: ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
);

console.log(
  `Tirupati Gate: ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
);

console.log(
  "=========================================="
);

updateGateSystem()
  .then(
    async () => {
      console.log(
        "Monitor run completed."
      );

      try {
        await admin
          .app()
          .delete();
      } catch (error) {
        console.error(
          "Firebase cleanup error:",
          error.message
        );
      }

      process.exit(
        process.exitCode || 0
      );
    }
  )
  .catch(
    async (error) => {
      console.error(
        "Fatal monitor error:",
        error
      );

      try {
        await admin
          .app()
          .delete();
      } catch (
        cleanupError
      ) {
        console.error(
          "Firebase cleanup error:",
          cleanupError.message
        );
      }

      process.exit(1);
    }
  );
