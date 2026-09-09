// ============================================================
// GUDUR GATE TRACKER
// RailRadar + Firebase
// ============================================================
//
// Direction / gate logic:
//
// CHENNAI SIDE -> GDR -> CHENNAI GATE
//
//   > 5.00 km              OPEN
//   > 4.00 km and <= 5 km  WARNING
//   <= 4.00 km             CLOSED
//
// NORTH -> GDR -> TIRUPATI
//
//   Before GDR             OPEN
//   At GDR                 OPEN
//   After GDR > 0.50 km    OPEN
//   After GDR <= 0.50 km   CLOSED
//
// GDR TERMINAL TRAIN
//
//   GDR is final stop       OPEN
//   Removed from upcoming list
//
// CLOSED HOLD
//
//   Keep CLOSED for 5 minutes.
//
// ============================================================

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
  serviceAccount = JSON.parse(
    FIREBASE_SERVICE_ACCOUNT
  );
} catch (error) {
  throw new Error(
    `FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${error.message}`
  );
}

admin.initializeApp({
  credential: admin.credential.cert(
    serviceAccount
  ),

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

const API_TIMEOUT_MS = 10000;

// ============================================================
// LOCATIONS
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

const CHENNAI_GATE_WARNING_DISTANCE_KM =
  5.00;

const CHENNAI_GATE_CLOSE_DISTANCE_KM =
  4.00;

const TIRUPATI_GATE_CLOSE_DISTANCE_KM =
  0.50;

// Informational reference.
const CLEAR_DISTANCE_KM =
  0.80;

// CLOSED hold.
const GATE_HOLD_MINUTES =
  5;

const GATE_HOLD_MS =
  GATE_HOLD_MINUTES *
  60 *
  1000;

// ============================================================
// BOARD SETTINGS
// ============================================================

const STATION_BOARD_HOURS =
  4;

const MAX_UPCOMING_TRAINS =
  10;

const MAX_LIVE_REQUESTS =
  10;

const MAX_ROUTE_REQUESTS =
  10;

// ============================================================
// HTTP CONFIG
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

  for (
    const part of parts
  ) {
    if (
      part.type !==
      "literal"
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

  return `${p.year}-${p.month}-${p.day}`;
}

function getCurrentISTTimeString() {
  const p =
    getISTDateParts();

  return `${p.hour}:${p.minute}:${p.second}`;
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
// TEXT HELPERS
// ============================================================

function normalizeText(value) {
  return String(
    value || ""
  )
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
// TRAIN HELPERS
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
    train?.name ||
    item?.trainName ||
    item?.name ||
    `Train ${trainNo}`
  );
}

function getOrigin(
  train,
  item
) {
  return (
    getNameOrCode(
      train?.origin
    ) ||

    getNameOrCode(
      train?.source
    ) ||

    getNameOrCode(
      train?.from
    ) ||

    getNameOrCode(
      train?.fromStation
    ) ||

    getNameOrCode(
      item?.origin
    ) ||

    getNameOrCode(
      item?.source
    ) ||

    getNameOrCode(
      item?.from
    ) ||

    getNameOrCode(
      item?.fromStation
    ) ||

    ""
  );
}

function getDestination(
  train,
  item
) {
  return (
    getNameOrCode(
      train?.destination
    ) ||

    getNameOrCode(
      train?.to
    ) ||

    getNameOrCode(
      train?.destinationStation
    ) ||

    getNameOrCode(
      item?.destination
    ) ||

    getNameOrCode(
      item?.to
    ) ||

    getNameOrCode(
      item?.destinationStation
    ) ||

    ""
  );
}

function getPlatform(
  train,
  live,
  stop,
  item
) {
  return String(
    live?.platform ||
      stop?.platform ||
      item?.platform ||
      train?.platform ||
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
    String(timeValue).trim();

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
    live?.type ||
      live?.status ||
      stop?.status ||
      item?.status ||
      train?.status ||
      ""
  );
}

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
    status.includes(
      "AT STATION"
    ) ||
    status.includes(
      "AT-STATION"
    ) ||
    live?.isHalt === true ||
    live?.currentLocation?.isHalt === true
  );
}

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
    status.includes(
      "DEPARTED"
    ) ||
    status.includes(
      "CANCELLED"
    ) ||
    status.includes(
      "CANCELED"
    )
  );
}

// ============================================================
// ARRIVAL
// ============================================================

function getArrivalTime(
  train,
  live,
  stop,
  item
) {
  return (
    stop?.arrival ||
    stop?.expectedArrival ||
    stop?.scheduledArrival ||

    item?.arrival ||
    item?.expectedArrival ||
    item?.scheduledArrival ||

    live?.expectedArrivalTime ||
    live?.arrivalTime ||

    train?.arrival ||
    train?.arrivalTime ||

    ""
  );
}

// ============================================================
// DEPARTURE
// ============================================================

function getDepartureTime(
  train,
  live,
  stop,
  item,
  arrivalTime
) {
  return (
    live?.expectedDepartureTime ||
    live?.departureTime ||

    stop?.departure ||
    stop?.expectedDeparture ||
    stop?.scheduledDeparture ||

    item?.departure ||
    item?.expectedDeparture ||
    item?.scheduledDeparture ||

    train?.departure ||
    train?.departureTime ||

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
      live?.delayMinutes ??
        item?.delayMinutes ??
        train?.delayMinutes ??
        0
    );

  // ----------------------------------------------------------
  // Scheduled GDR arrival
  // ----------------------------------------------------------

  const scheduledArrival =
    stop?.arrival ||
    stop?.scheduledArrival ||
    item?.arrival ||
    item?.scheduledArrival ||
    train?.arrival;

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
  // Live expected arrival
  // ----------------------------------------------------------

  const expectedArrival =
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
    stop?.expectedArrival ||
    item?.expectedArrival ||
    train?.arrivalTime;

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
  // Direct ETA
  // ----------------------------------------------------------

  const directEta =
    live?.etaMinutes ??
    live?.eta ??
    item?.etaMinutes ??
    item?.eta ??
    train?.etaMinutes ??
    train?.eta;

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
  const R =
    6371;

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
// STATIC ROUTE
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
// GDR LIVE BOARD
// ============================================================

async function fetchGudurBoard() {
  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours:
              STATION_BOARD_HOURS
          },

          ...railRadarConfig()
        }
      );

    return (
      response.data?.data ||
      response.data ||
      {}
    );
  } catch (error) {
    if (
      error.response
    ) {
      console.error(
        `[BOARD ERROR] HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[BOARD ERROR] ${error.message}`
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

  if (
    Array.isArray(
      liveData?.data?.route
    )
  ) {
    return liveData.data.route;
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
      station?.station?.code ||
      station?.station?.stationCode ||
      ""
  );
}

function getStationCoordinates(
  station
) {
  const lat =
    Number(
      station?.lat ??
        station?.latitude ??
        station?.station?.lat ??
        station?.station?.latitude
    );

  const lng =
    Number(
      station?.lng ??
        station?.lon ??
        station?.longitude ??
        station?.station?.lng ??
        station?.station?.lon ??
        station?.station?.longitude
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
// FIND GUDUR
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
  if (
    !Array.isArray(route)
  ) {
    return -1;
  }

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
            station?.sequence
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
// INTERPOLATE POSITION
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

  const p =
    Math.max(
      0,
      Math.min(
        1,
        Number(progress) || 0
      )
    );

  return {
    lat:
      a.lat +
      (b.lat - a.lat) *
        p,

    lng:
      a.lng +
      (b.lng - a.lng) *
        p
  };
}

// ============================================================
// LIVE POSITION EXTRACTION
// ============================================================

function getLiveCoordinates(
  liveData
) {
  if (!liveData) {
    return null;
  }

  const currentLocation =
    liveData.currentLocation ||
    liveData.location ||
    liveData.position ||
    liveData.currentPosition ||
    null;

  // ----------------------------------------------------------
  // Direct coordinates
  // ----------------------------------------------------------

  const direct =
    getStationCoordinates(
      currentLocation
    );

  if (direct) {
    return direct;
  }

  // ----------------------------------------------------------
  // Direct live object coordinates
  // ----------------------------------------------------------

  const directLive =
    getStationCoordinates(
      liveData
    );

  if (directLive) {
    return directLive;
  }

  // ----------------------------------------------------------
  // Coordinate array
  // ----------------------------------------------------------

  const coordinateCandidates = [
    currentLocation?.coordinates,
    liveData?.coordinates,
    currentLocation?.location?.coordinates
  ];

  for (
    const value of
    coordinateCandidates
  ) {
    if (
      Array.isArray(value) &&
      value.length >= 2
    ) {
      const lng =
        Number(value[0]);

      const lat =
        Number(value[1]);

      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng)
      ) {
        return {
          lat,
          lng
        };
      }
    }
  }

  // ----------------------------------------------------------
  // Segment interpolation
  // ----------------------------------------------------------

  const route =
    getRoute(
      liveData
    );

  const progress =
    Number(
      currentLocation?.segmentProgress ??
        liveData?.segmentProgress
    );

  const sequence =
    Number(
      currentLocation?.sequence
    );

  if (
    route.length > 1 &&
    Number.isFinite(progress) &&
    Number.isFinite(sequence)
  ) {
    const currentIndex =
      findCurrentRouteIndex(
        route,
        {
          sequence
        }
      );

    if (
      currentIndex >= 0 &&
      currentIndex <
        route.length - 1
    ) {
      const interpolated =
        interpolatePosition(
          route[currentIndex],
          route[currentIndex + 1],
          progress
        );

      if (interpolated) {
        return interpolated;
      }
    }
  }

  return null;
}

// ============================================================
// GDR CURRENT LOCATION
// ============================================================

function getCurrentLocation(
  liveData
) {
  return (
    liveData?.currentLocation ||
    liveData?.location ||
    liveData?.currentStation ||
    liveData?.station ||
    null
  );
}

// ============================================================
// GDR TERMINAL
// ============================================================

function isGudurLastStop(
  route
) {
  if (
    !Array.isArray(route) ||
    route.length === 0
  ) {
    return false;
  }

  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  if (
    gudurIndex === -1
  ) {
    return false;
  }

  return (
    gudurIndex ===
    route.length - 1
  );
}

// ============================================================
// PASSED GUDUR
// ============================================================

function hasPassedGudur(
  route,
  currentLocation
) {
  if (
    !Array.isArray(route) ||
    route.length === 0
  ) {
    return false;
  }

  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  if (
    gudurIndex === -1
  ) {
    return false;
  }

  const currentIndex =
    findCurrentRouteIndex(
      route,
      currentLocation
    );

  if (
    currentIndex === -1
  ) {
    return false;
  }

  return (
    currentIndex >
    gudurIndex
  );
}

// ============================================================
// AT GUDUR
// ============================================================

function isCurrentlyAtGudur(
  route,
  currentLocation,
  liveData
) {
  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  if (
    gudurIndex === -1
  ) {
    return false;
  }

  const currentIndex =
    findCurrentRouteIndex(
      route,
      currentLocation
    );

  if (
    currentIndex !==
    gudurIndex
  ) {
    return false;
  }

  const status =
    normalizeText(
      liveData?.type ||
        liveData?.status ||
        currentLocation?.status ||
        ""
    );

  return (
    status.includes(
      "AT STATION"
    ) ||
    status.includes(
      "AT-STATION"
    ) ||
    currentLocation?.isHalt === true ||
    liveData?.isHalt === true
  );
}

// ============================================================
// NORTH CONTINUATION
// ============================================================

function isNorthToGudurContinuation(
  route
) {
  if (
    !Array.isArray(route) ||
    route.length === 0
  ) {
    return false;
  }

  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  if (
    gudurIndex === -1
  ) {
    return false;
  }

  // GDR terminal.
  if (
    gudurIndex ===
    route.length - 1
  ) {
    return false;
  }

  return (
    gudurIndex > 0
  );
}

// ============================================================
// TRAIN DIRECTION
// ============================================================

function determineTrainDirection(
  route,
  currentLocation
) {
  if (
    !Array.isArray(route) ||
    route.length === 0
  ) {
    return "UNKNOWN";
  }

  const gudurIndex =
    findGudurRouteIndex(
      route
    );

  if (
    gudurIndex === -1
  ) {
    return "UNKNOWN";
  }

  const currentIndex =
    findCurrentRouteIndex(
      route,
      currentLocation
    );

  if (
    currentIndex === -1
  ) {
    return "UNKNOWN";
  }

  if (
    currentIndex <
    gudurIndex
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    currentIndex ===
    gudurIndex
  ) {
    return "AT_GUDUR";
  }

  return "AFTER_GUDUR";
}

// ============================================================
// DISTANCE TO CHENNAI GATE
// ============================================================

function getDistanceToChennaiGate(
  position
) {
  if (!position) {
    return null;
  }

  return calculateDistanceKm(
    position.lat,
    position.lng,
    CHENNAI_GATE.lat,
    CHENNAI_GATE.lng
  );
}

// ============================================================
// DISTANCE TO TIRUPATI GATE
// ============================================================

function getDistanceToTirupatiGate(
  position
) {
  if (!position) {
    return null;
  }

  return calculateDistanceKm(
    position.lat,
    position.lng,
    TIRUPATI_GATE.lat,
    TIRUPATI_GATE.lng
  );
}

// ============================================================
// CHENNAI GATE DECISION
// ============================================================

function calculateChennaiGateStatus(
  distanceKm
) {
  if (
    !Number.isFinite(
      Number(distanceKm)
    )
  ) {
    return {
      status:
        "OPEN",

      reason:
        "Train position unavailable"
    };
  }

  const distance =
    Number(distanceKm);

  // Exact requirement:
  // > 5 km = OPEN
  // 4-5 km = WARNING
  // <= 4 km = CLOSED

  if (
    distance >
    CHENNAI_GATE_WARNING_DISTANCE_KM
  ) {
    return {
      status:
        "OPEN",

      distanceKm:
        Number(
          distance.toFixed(3)
        ),

      reason:
        "More than 5.00 km from Chennai Gate"
    };
  }

  if (
    distance >
    CHENNAI_GATE_CLOSE_DISTANCE_KM
  ) {
    return {
      status:
        "WARNING",

      distanceKm:
        Number(
          distance.toFixed(3)
        ),

      reason:
        "Within 5.00 km of Chennai Gate"
    };
  }

  return {
    status:
      "CLOSED",

    distanceKm:
      Number(
        distance.toFixed(3)
      ),

    reason:
      "Within 4.00 km of Chennai Gate"
  };
}

// ============================================================
// TIRUPATI GATE DECISION
// ============================================================

function calculateTirupatiGateStatus(
  route,
  currentLocation,
  livePosition
) {
  // ----------------------------------------------------------
  // GDR terminal protection
  // ----------------------------------------------------------

  if (
    isGudurLastStop(route)
  ) {
    return {
      status:
        "OPEN",

      direction:
        "NORTH_TO_GUDUR_TERMINAL",

      reason:
        "GDR is the final stop"
    };
  }

  // ----------------------------------------------------------
  // Before GDR
  // ----------------------------------------------------------

  const direction =
    determineTrainDirection(
      route,
      currentLocation
    );

  if (
    direction ===
      "TOWARD_GUDUR" ||
    direction ===
      "AT_GUDUR"
  ) {
    return {
      status:
        "OPEN",

      direction:
        direction,

      reason:
        "Train has not passed GDR"
    };
  }

  // ----------------------------------------------------------
  // After GDR
  // ----------------------------------------------------------

  const passed =
    hasPassedGudur(
      route,
      currentLocation
    );

  if (!passed) {
    return {
      status:
        "OPEN",

      direction:
        "UNKNOWN",

      reason:
        "GDR passage not confirmed"
    };
  }

  const distance =
    getDistanceToTirupatiGate(
      livePosition
    );

  if (
    !Number.isFinite(
      Number(distance)
    )
  ) {
    return {
      status:
        "OPEN",

      direction:
        "GUDUR_TO_TIRUPATI",

      reason:
        "Train position unavailable after GDR"
    };
  }

  if (
    Number(distance) <=
    TIRUPATI_GATE_CLOSE_DISTANCE_KM
  ) {
    return {
      status:
        "CLOSED",

      direction:
        "GUDUR_TO_TIRUPATI",

      distanceKm:
        Number(
          Number(distance).toFixed(3)
        ),

      reason:
        "Train passed GDR and is within 0.50 km of Tirupati Gate"
    };
  }

  return {
    status:
      "OPEN",

    direction:
      "GUDUR_TO_TIRUPATI",

    distanceKm:
      Number(
        Number(distance).toFixed(3)
      ),

    reason:
      "Train passed GDR but is more than 0.50 km from Tirupati Gate"
  };
}

// ============================================================
// GET UPCOMING ARRAY
// ============================================================

function getUpcomingArray(
  boardData
) {
  const candidates = [
    boardData?.upcoming,
    boardData?.trains,
    boardData?.data?.upcoming,
    boardData?.data?.trains
  ];

  for (
    const candidate of
    candidates
  ) {
    if (
      Array.isArray(candidate)
    ) {
      return candidate;
    }
  }

  return [];
}

// ============================================================
// BUILD UPCOMING LIST
// ============================================================

async function buildUpcomingTrains(
  boardData
) {
  const source =
    getUpcomingArray(
      boardData
    );

  const result = [];

  let routeRequests = 0;

  for (
    const item of source
  ) {
    if (
      result.length >=
      MAX_UPCOMING_TRAINS
    ) {
      break;
    }

    const train =
      item?.train ||
      item ||
      {};

    const trainNo =
      getTrainNumber(
        train,
        item
      );

    if (!trainNo) {
      continue;
    }

    let route = [];

    if (
      routeRequests <
      MAX_ROUTE_REQUESTS
    ) {
      routeRequests++;

      const routeData =
        await fetchTrainRoute(
          trainNo
        );

      route =
        getRouteStops(
          routeData
        );
    }

    // --------------------------------------------------------
    // GDR terminal train
    // --------------------------------------------------------

    if (
      route.length > 0 &&
      isGudurLastStop(
        route
      )
    ) {
      console.log(
        `[UPCOMING FILTER] ${trainNo} -> GDR TERMINAL -> REMOVED`
      );

      continue;
    }

    const stop =
      item?.stop ||
      {};

    const eta =
      calculateBoardEta(
        train,
        {},
        stop,
        item
      );

    const arrival =
      getArrivalTime(
        train,
        {},
        stop,
        item
      );

    const departure =
      getDepartureTime(
        train,
        {},
        stop,
        item,
        arrival
      );

    result.push({
      trainNumber:
        trainNo,

      trainName:
        getTrainName(
          train,
          item
        ),

      origin:
        getOrigin(
          train,
          item
        ) ||
        "Unknown",

      destination:
        getDestination(
          train,
          item
        ) ||
        "Gudur",

      platform:
        getPlatform(
          train,
          {},
          stop,
          item
        ),

      arrival:
        arrival ||
        null,

      departure:
        departure ||
        null,

      etaMinutes:
        eta,

      status:
        getBoardStatus(
          train,
          {},
          stop,
          item
        ) ||
        "UPCOMING"
    });
  }

  result.sort(
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
          : 9999;

      const bEta =
        Number.isFinite(
          Number(
            b.etaMinutes
          )
        )
          ? Number(
              b.etaMinutes
            )
          : 9999;

      return (
        aEta - bEta
      );
    }
  );

  return result.slice(
    0,
    MAX_UPCOMING_TRAINS
  );
}

// ============================================================
// LIVE CANDIDATES
// ============================================================

function getLiveCandidates(
  boardData
) {
  const arrays = [
    boardData?.upcoming,
    boardData?.atStation,
    boardData?.["at-station"],
    boardData?.trains,

    boardData?.data?.upcoming,
    boardData?.data?.atStation,
    boardData?.data?.["at-station"],
    boardData?.data?.trains
  ];

  const result = [];

  const seen =
    new Set();

  for (
    const array of arrays
  ) {
    if (
      !Array.isArray(array)
    ) {
      continue;
    }

    for (
      const item of array
    ) {
      const train =
        item?.train ||
        item ||
        {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (
        !trainNo ||
        seen.has(trainNo)
      ) {
        continue;
      }

      seen.add(trainNo);

      result.push({
        train,
        item
      });
    }
  }

  return result;
}

// ============================================================
// PROCESS LIVE TRAIN
// ============================================================

async function processTrain(
  train,
  item
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  if (!trainNo) {
    return null;
  }

  const live =
    await fetchLiveTrain(
      trainNo
    );

  if (!live) {
    return null;
  }

  let route =
    getRoute(
      live
    );

  // ----------------------------------------------------------
  // Static route fallback
  // ----------------------------------------------------------

  if (
    route.length === 0
  ) {
    const routeData =
      await fetchTrainRoute(
        trainNo
      );

    route =
      getRouteStops(
        routeData
      );
  }

  if (
    route.length === 0
  ) {
    console.log(
      `[IGNORED] ${trainNo} -> no route data`
    );

    return null;
  }

  const currentLocation =
    getCurrentLocation(
      live
    );

  const livePosition =
    getLiveCoordinates(
      live
    );

  // ----------------------------------------------------------
  // GDR terminal
  // ----------------------------------------------------------

  const terminalAtGDR =
    isGudurLastStop(
      route
    );

  if (
    terminalAtGDR
  ) {
    console.log(
      `[TERMINAL] ${trainNo} -> GDR is final stop -> gate remains OPEN`
    );

    return {
      trainNumber:
        trainNo,

      trainName:
        getTrainName(
          train,
          item
        ),

      origin:
        getOrigin(
          train,
          item
        ),

      destination:
        getDestination(
          train,
          item
        ),

      terminalAtGDR:
        true,

      chennaiGate:
        {
          status:
            "OPEN",

          reason:
            "GDR terminal train"
        },

      tirupatiGate:
        {
          status:
            "OPEN",

          reason:
            "GDR terminal train"
        },

      livePosition:
        livePosition ||
        null,

      route:
        route
    };
  }

  // ----------------------------------------------------------
  // Chennai gate
  // ----------------------------------------------------------

  const chennaiDistance =
    getDistanceToChennaiGate(
      livePosition
    );

  const chennaiDecision =
    calculateChennaiGateStatus(
      chennaiDistance
    );

  // ----------------------------------------------------------
  // Tirupati gate
  // ----------------------------------------------------------

  const tirupatiDecision =
    calculateTirupatiGateStatus(
      route,
      currentLocation,
      livePosition
    );

  const direction =
    determineTrainDirection(
      route,
      currentLocation
    );

  return {
    trainNumber:
      trainNo,

    trainName:
      getTrainName(
        train,
        item
      ),

    origin:
      getOrigin(
        train,
        item
      ),

    destination:
      getDestination(
        train,
        item
      ),

    platform:
      getPlatform(
        train,
        live,
        {},
        item
      ),

    terminalAtGDR:
      false,

    direction:
      direction,

    livePosition:
      livePosition ||
      null,

    chennaiGate:
      chennaiDecision,

    tirupatiGate:
      tirupatiDecision,

    route:
      route,

    currentLocation:
      currentLocation ||
      null,

    updatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// FIND BEST GATE TRAIN
// ============================================================

function selectBestTrain(
  processed,
  gateName
) {
  const priority = {
    CLOSED: 3,
    WARNING: 2,
    OPEN: 1
  };

  let selected =
    null;

  for (
    const train of processed
  ) {
    if (
      train.terminalAtGDR
    ) {
      continue;
    }

    const gate =
      train[gateName];

    if (!gate) {
      continue;
    }

    const status =
      gate.status;

    if (
      !priority[status]
    ) {
      continue;
    }

    if (!selected) {
      selected =
        train;

      continue;
    }

    const selectedStatus =
      selected[
        gateName
      ]?.status;

    if (
      priority[status] >
      priority[selectedStatus]
    ) {
      selected =
        train;

      continue;
    }

    if (
      priority[status] ===
      priority[selectedStatus]
    ) {
      const currentDistance =
        Number(
          gate.distanceKm
        );

      const selectedDistance =
        Number(
          selected[
            gateName
          ]?.distanceKm
        );

      if (
        Number.isFinite(
          currentDistance
        ) &&
        Number.isFinite(
          selectedDistance
        ) &&
        currentDistance <
          selectedDistance
      ) {
        selected =
          train;
      }
    }
  }

  return selected;
}

// ============================================================
// GATE PAYLOAD
// ============================================================

function makeGatePayload(
  train,
  gateDecision,
  previousGate
) {
  const status =
    gateDecision?.status ||
    "OPEN";

  let closedAt =
    previousGate?.closedAt ||
    null;

  let holdUntil =
    previousGate?.holdUntil ||
    null;

  const now =
    Date.now();

  // ----------------------------------------------------------
  // Start hold when a gate newly closes
  // ----------------------------------------------------------

  if (
    status ===
      "CLOSED" &&
    previousGate?.status !==
      "CLOSED"
  ) {
    closedAt =
      now;

    holdUntil =
      now +
      GATE_HOLD_MS;
  }

  // ----------------------------------------------------------
  // Existing hold
  // ----------------------------------------------------------

  if (
    previousGate?.status ===
      "CLOSED" &&
    previousGate?.closedAt
  ) {
    const previousClosedAt =
      Number(
        previousGate.closedAt
      );

    if (
      now -
        previousClosedAt <
      GATE_HOLD_MS
    ) {
      closedAt =
        previousClosedAt;

      holdUntil =
        previousClosedAt +
        GATE_HOLD_MS;
    }
  }

  // ----------------------------------------------------------
  // Hold has expired
  // ----------------------------------------------------------

  if (
    status ===
      "OPEN" &&
    holdUntil &&
    now >=
      Number(holdUntil)
  ) {
    closedAt =
      null;

    holdUntil =
      null;
  }

  // ----------------------------------------------------------
  // If currently under hold, force CLOSED.
  // ----------------------------------------------------------

  let finalStatus =
    status;

  if (
    holdUntil &&
    now <
      Number(holdUntil) &&
    previousGate?.status ===
      "CLOSED"
  ) {
    finalStatus =
      "CLOSED";
  }

  const waitMinutes =
    finalStatus ===
      "CLOSED" &&
    holdUntil
      ? Math.max(
          1,
          Math.ceil(
            (
              Number(
                holdUntil
              ) -
              now
            ) /
              60000
          )
        )
      : 0;

  return {
    status:
      finalStatus,

    waitMinutes:
      waitMinutes,

    activeTrain:
      train
        ? `${train.trainNumber} ${train.trainName}`
        : "Tracks clear",

    trainNumber:
      train?.trainNumber ||
      null,

    trainName:
      train?.trainName ||
      null,

    origin:
      train?.origin ||
      null,

    destination:
      train?.destination ||
      null,

    direction:
      gateDecision?.direction ||
      train?.direction ||
      null,

    distanceKm:
      gateDecision?.distanceKm ??
      null,

    reason:
      gateDecision?.reason ||
      "No active train",

    closedAt:
      finalStatus ===
        "CLOSED"
        ? closedAt
        : null,

    holdUntil:
      finalStatus ===
        "CLOSED"
        ? holdUntil
        : null
  };
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  console.log(
    "\n============================================================"
  );

  console.log(
    `🚆 GUDUR GATE TRACKER | ${getCurrentISTDisplayTime()}`
  );

  console.log(
    "============================================================"
  );

  try {
    // --------------------------------------------------------
    // GET BOARD
    // --------------------------------------------------------

    const board =
      await fetchGudurBoard();

    if (!board) {
      console.error(
        "❌ GDR board unavailable."
      );

      return;
    }

    const rawUpcoming =
      getUpcomingArray(
        board
      );

    console.log(
      `✅ RailRadar returned ${rawUpcoming.length} board entries.`
    );

    // --------------------------------------------------------
    // UPCOMING
    // --------------------------------------------------------

    const upcoming =
      await buildUpcomingTrains(
        board
      );

    // --------------------------------------------------------
    // LIVE PROCESSING
    // --------------------------------------------------------

    const candidates =
      getLiveCandidates(
        board
      );

    const processed =
      [];

    let liveRequests =
      0;

    for (
      const candidate of
      candidates
    ) {
      if (
        liveRequests >=
        MAX_LIVE_REQUESTS
      ) {
        break;
      }

      liveRequests++;

      try {
        const result =
          await processTrain(
            candidate.train,
            candidate.item
          );

        if (result) {
          processed.push(
            result
          );
        }
      } catch (error) {
        console.error(
          `[PROCESS ERROR] ${candidate.train?.number || "UNKNOWN"}: ${error.message}`
        );
      }
    }

    // --------------------------------------------------------
    // SELECT BEST TRAINS
    // --------------------------------------------------------

    const bestChennaiTrain =
      selectBestTrain(
        processed,
        "chennaiGate"
      );

    const bestTirupatiTrain =
      selectBestTrain(
        processed,
        "tirupatiGate"
      );

    // --------------------------------------------------------
    // PREVIOUS FIREBASE STATE
    // --------------------------------------------------------

    const snapshot =
      await gateRef.once(
        "value"
      );

    const previous =
      snapshot.val() ||
      {};

    // --------------------------------------------------------
    // BUILD GATE PAYLOADS
    // --------------------------------------------------------

    const chennaiDecision =
      bestChennaiTrain
        ? bestChennaiTrain.chennaiGate
        : {
            status:
              "OPEN",

            reason:
              "No train requiring Chennai Gate action"
          };

    const tirupatiDecision =
      bestTirupatiTrain
        ? bestTirupatiTrain.tirupatiGate
        : {
            status:
              "OPEN",

            reason:
              "No train requiring Tirupati Gate action"
          };

    const chennaiGate =
      makeGatePayload(
        bestChennaiTrain,
        chennaiDecision,
        previous.chennaiGate
      );

    const tirupatiGate =
      makeGatePayload(
        bestTirupatiTrain,
        tirupatiDecision,
        previous.tirupatiGate
      );

    // --------------------------------------------------------
    // DATABASE UPDATE
    // --------------------------------------------------------

    const firebaseData = {
      chennaiGate:
        chennaiGate,

      tirupatiGate:
        tirupatiGate,

      // Compatibility / overall status.
      gateStatus:
        (
          chennaiGate.status ===
            "CLOSED" ||
          tirupatiGate.status ===
            "CLOSED"
        )
          ? "CLOSED"

          : (
              chennaiGate.status ===
                "WARNING" ||
              tirupatiGate.status ===
                "WARNING"
            )
            ? "WARNING"
            : "OPEN",

      upcomingTrains:
        upcoming,

      monitoredTrains:
        processed.map(
          (train) => ({
            trainNumber:
              train.trainNumber,

            trainName:
              train.trainName,

            origin:
              train.origin,

            destination:
              train.destination,

            direction:
              train.direction,

            terminalAtGDR:
              train.terminalAtGDR,

            chennaiGate:
              train.chennaiGate,

            tirupatiGate:
              train.tirupatiGate,

            livePosition:
              train.livePosition,

            updatedAt:
              train.updatedAt
          })
        ),

      locations: {
        gudur:
          GUDUR,

        chennaiGate:
          CHENNAI_GATE,

        tirupatiGate:
          TIRUPATI_GATE
      },

      rules: {
        chennaiWarningDistanceKm:
          CHENNAI_GATE_WARNING_DISTANCE_KM,

        chennaiCloseDistanceKm:
          CHENNAI_GATE_CLOSE_DISTANCE_KM,

        tirupatiCloseDistanceKm:
          TIRUPATI_GATE_CLOSE_DISTANCE_KM,

        clearDistanceKm:
          CLEAR_DISTANCE_KM,

        gateHoldMinutes:
          GATE_HOLD_MINUTES
      },

      lastUpdated:
        new Date().toISOString(),

      updatedDate:
        getCurrentISTDateString(),

      updatedTime:
        getCurrentISTTimeString(),

      serverTime:
        getCurrentISTDisplayTime()
    };

    await gateRef.set(
      firebaseData
    );

    // --------------------------------------------------------
    // LOGS
    // --------------------------------------------------------

    console.log(
      "\n[SYNC SUCCESS]"
    );

    console.log(
      `🚦 Chennai Gate : ${chennaiGate.status}`
    );

    console.log(
      `   Train       : ${chennaiGate.activeTrain}`
    );

    console.log(
      `   Distance    : ${chennaiGate.distanceKm ?? "N/A"} km`
    );

    console.log(
      `   Wait        : ${chennaiGate.waitMinutes} min`
    );

    console.log(
      `   Reason      : ${chennaiGate.reason}`
    );

    console.log(
      `\n🚦 Tirupati Gate: ${tirupatiGate.status}`
    );

    console.log(
      `   Train       : ${tirupatiGate.activeTrain}`
    );

    console.log(
      `   Distance    : ${tirupatiGate.distanceKm ?? "N/A"} km`
    );

    console.log(
      `   Wait        : ${tirupatiGate.waitMinutes} min`
    );

    console.log(
      `   Reason      : ${tirupatiGate.reason}`
    );

    console.log(
      `\n🚆 Upcoming trains: ${upcoming.length}`
    );

    if (
      upcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS]"
      );

      upcoming.forEach(
        (train, index) => {
          console.log(
            ` ${index + 1}. ${train.trainNumber} ${train.trainName} | ETA ${train.etaMinutes ?? "N/A"}m`
          );
        }
      );
    } else {
      console.log(
        "No upcoming trains."
      );
    }

    console.log(
      "\n============================================================"
    );
  } catch (error) {
    console.error(
      "\n❌ UPDATE FAILED"
    );

    console.error(
      error.message
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
    }

    console.error(
      "============================================================"
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
  "🚆 GUDUR CROSSING RADAR"
);

console.log(
  "RailRadar + Firebase"
);

console.log(
  "============================================================"
);

console.log(
  `📍 GDR            : ${GUDUR.lat}, ${GUDUR.lng}`
);

console.log(
  `📍 Chennai Gate   : ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
);

console.log(
  `📍 Tirupati Gate  : ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
);

console.log(
  `🚦 Chennai Warning: ${CHENNAI_GATE_WARNING_DISTANCE_KM} km`
);

console.log(
  `🚦 Chennai Close  : ${CHENNAI_GATE_CLOSE_DISTANCE_KM} km`
);

console.log(
  `🚦 Tirupati Close : ${TIRUPATI_GATE_CLOSE_DISTANCE_KM} km`
);

console.log(
  `🔒 Gate Hold      : ${GATE_HOLD_MINUTES} minutes`
);

console.log(
  "============================================================"
);

console.log(
  "Direction protection: ENABLED"
);

console.log(
  "GDR terminal protection: ENABLED"
);

console.log(
  "============================================================"
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
