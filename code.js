```js
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
const gateRef = db.ref("gudur_gates");

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
// > 4 km       OPEN
// 3 - 4 km     WARNING
// <= 3 km      CLOSED
//
// ============================================================

const WARNING_DISTANCE_KM = 4.00;
const CLOSE_DISTANCE_KM = 3.00;

// Informational only.
const CLEAR_DISTANCE_KM = 0.80;

// Minimum time a gate remains CLOSED after the monitor first detects
// a train at or inside the 3 km closing distance. This is persisted
// in Firebase so it survives separate GitHub Actions runs.
const GATE_HOLD_MINUTES = 15;
const GATE_HOLD_MS = GATE_HOLD_MINUTES * 60 * 1000;

// ============================================================
// UPCOMING TRAIN SETTINGS
// ============================================================

const STATION_BOARD_HOURS = 4;

const MAX_UPCOMING_TRAINS = 10;

// Only trains whose board ETA is within this period
// receive a live train API request.
const LIVE_LOOKAHEAD_MINUTES = 90;

// Safety limit for RailRadar API usage.
const MAX_LIVE_REQUESTS = 10;

// ============================================================
// IST HELPERS
// ============================================================

function getISTDateParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(new Date());

  const result = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
  }

  return result;
}

function getCurrentISTMinutes() {
  const p = getISTDateParts();

  return (
    Number(p.hour) * 60 +
    Number(p.minute)
  );
}

function getCurrentISTDateString() {
  const p = getISTDateParts();

  return `${p.year}-${p.month}-${p.day}`;
}

function getCurrentISTTimeString() {
  const p = getISTDateParts();

  return `${p.hour}:${p.minute}:${p.second}`;
}

function getCurrentISTDisplayTime() {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }
  ).format(new Date());
}

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

function containsAny(text, values) {
  const normalized = normalizeText(text);

  return values.some((value) =>
    normalized.includes(normalizeText(value))
  );
}

// ============================================================
// OBJECT / STRING VALUE HELPER
// ============================================================

function getNameOrCode(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
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
// TRAIN ORIGIN
// ============================================================

function getOrigin(train, item) {
  return (
    getNameOrCode(train.origin) ||
    getNameOrCode(train.source) ||
    getNameOrCode(train.from) ||
    getNameOrCode(item.origin) ||
    getNameOrCode(item.source) ||
    getNameOrCode(item.from) ||
    ""
  );
}

// ============================================================
// TRAIN DESTINATION
// ============================================================

function getDestination(train, item) {
  return (
    getNameOrCode(train.destination) ||
    getNameOrCode(train.to) ||
    getNameOrCode(item.destination) ||
    getNameOrCode(item.to) ||
    ""
  );
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(train, item) {
  return String(
    train.number ||
    train.trainNumber ||
    item.trainNumber ||
    item.number ||
    ""
  ).trim();
}

// ============================================================
// TIME PARSER
// ============================================================
//
// Supports:
//
// 21:30
// 2026-09-08T21:30:00+05:30
//
// delayMinutes is applied only when explicitly requested.
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

  // Plain HH:MM
  const simpleMatch =
    value.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (simpleMatch) {
    return (
      Number(simpleMatch[1]) * 60 +
      Number(simpleMatch[2]) +
      Number(delayMinutes || 0)
    );
  }

  // Full ISO/date time
  const date = new Date(value);

  if (!isNaN(date.getTime())) {
    const parts =
      new Intl.DateTimeFormat(
        "en-GB",
        {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        }
      ).formatToParts(date);

    let hour = 0;
    let minute = 0;

    for (const part of parts) {
      if (part.type === "hour") {
        hour = Number(part.value);
      }

      if (part.type === "minute") {
        minute = Number(part.value);
      }
    }

    return (
      hour * 60 +
      minute +
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
    status === "AT STATION" ||
    status === "AT-STATION" ||
    status.includes("AT STATION")
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
    status === "DEPARTED" ||
    status.includes("CANCELLED") ||
    status.includes("CANCELED")
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
// BOARD ETA
// ============================================================

function calculateBoardEta(
  train,
  live,
  stop,
  item
) {
  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

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
  // SCHEDULED GDR STOP TIME
  // ----------------------------------------------------------

  const scheduledArrival =
    stop.arrival ||
    stop.scheduledArrival ||
    item.arrival ||
    item.scheduledArrival ||
    train.arrival;

  if (scheduledArrival) {
    const scheduledMinutes =
      parseTimeToMinutes(
        scheduledArrival,
        0
      );

    if (scheduledMinutes !== -1) {
      let diff =
        calculateTimeDifference(
          scheduledMinutes + delayMin,
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
  // LIVE EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const expectedArrival =
    live.expectedArrivalTime ||
    live.arrivalTime ||
    stop.expectedArrival ||
    item.expectedArrival ||
    train.arrivalTime;

  if (expectedArrival) {
    const expectedMinutes =
      parseTimeToMinutes(
        expectedArrival,
        0
      );

    if (expectedMinutes !== -1) {
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
  // DIRECT ETA
  // ----------------------------------------------------------

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
    return Math.max(
      0,
      Math.round(Number(directEta))
    );
  }

  return null;
}

// ============================================================
// DISTANCE
// ============================================================

function degreesToRadians(degrees) {
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
// RAILRADAR LIVE TRAIN
// ============================================================

async function fetchLiveTrain(trainNo) {
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
    if (error.response) {
      console.error(
        `[LIVE ERROR] ${trainNo} HTTP ${error.response.status}`
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
// ROUTE HELPERS
// ============================================================

function getRoute(liveData) {
  if (
    Array.isArray(
      liveData?.route
    )
  ) {
    return liveData.route;
  }

  return [];
}

function getStationCode(station) {
  return normalizeText(
    station?.stationCode ||
    station?.code ||
    ""
  );
}

function getStationCoordinates(station) {
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
// FIND GUDUR
// ============================================================

function findGudurRouteIndex(route) {
  return route.findIndex(
    (station) =>
      getStationCode(station) ===
      "GDR"
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
          ) === currentSequence
      );

    if (
      bySequence !== -1
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
          getStationCode(station) ===
          currentCode
      );

    if (
      byCode !== -1
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
    getStationCoordinates(from);

  const b =
    getStationCoordinates(to);

  if (!a || !b) {
    return null;
  }

  let p =
    Number(progress);

  if (!Number.isFinite(p)) {
    p = 0;
  }

  p =
    Math.max(
      0,
      Math.min(1, p)
    );

  return {
    lat:
      a.lat +
      (b.lat - a.lat) * p,

    lng:
      a.lng +
      (b.lng - a.lng) * p
  };
}

// ============================================================
// LIVE TRAIN POSITION
// ============================================================

function getLiveTrainPosition(
  liveData
) {
  const currentLocation =
    liveData?.currentLocation ||
    liveData?.liveData?.currentLocation ||
    null;

  const route =
    getRoute(liveData);

  if (!currentLocation) {
    return null;
  }

  const gudurIndex =
    findGudurRouteIndex(route);

  const currentIndex =
    findCurrentRouteIndex(
      route,
      currentLocation
    );

  // ----------------------------------------------------------
  // DIRECT COORDINATES
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

  let coordinates = null;

  if (
    Number.isFinite(directLat) &&
    Number.isFinite(directLng)
  ) {
    coordinates = {
      lat: directLat,
      lng: directLng
    };
  }

  // ----------------------------------------------------------
  // CURRENT STATION IS GUDUR
  // ----------------------------------------------------------

  if (
    currentIndex === gudurIndex &&
    gudurIndex !== -1
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
      currentLocation.isHalt === true;

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
  // NO ROUTE INFORMATION
  // ----------------------------------------------------------

  if (
    currentIndex === -1 ||
    gudurIndex === -1
  ) {
    return {
      coordinates,

      currentRouteIndex:
        currentIndex,

      gudurRouteIndex:
        gudurIndex,

      inbound: null,

      atGudur: false,

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
          route[currentIndex],
          route[
            currentIndex + 1
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

      inbound: true,

      atGudur: false,

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
          currentIndex + 1,
          route.length - 1
        );

      coordinates =
        interpolatePosition(
          route[currentIndex],
          route[nextIndex],
          currentLocation.segmentProgress
        );
    }

    return {
      coordinates,

      currentRouteIndex:
        currentIndex,

      gudurRouteIndex:
        gudurIndex,

      inbound: false,

      atGudur: false,

      currentLocation
    };
  }

  return {
    coordinates,

    currentRouteIndex:
      currentIndex,

    gudurRouteIndex:
      gudurIndex,

    inbound: null,

    atGudur: false,

    currentLocation
  };
}

// ============================================================
// DETERMINE GATE CORRIDOR FROM LIVE ROUTE
// ============================================================

function determineCorridorFromLiveRoute(
  liveData,
  positionInfo
) {
  const route =
    getRoute(liveData);

  const gudurIndex =
    positionInfo?.gudurRouteIndex;

  if (
    !Array.isArray(route) ||
    gudurIndex === -1 ||
    gudurIndex === null ||
    gudurIndex === undefined
  ) {
    return null;
  }

  if (
    positionInfo.inbound !== true
  ) {
    return null;
  }

  const previousIndex =
    gudurIndex - 1;

  if (
    previousIndex < 0
  ) {
    return null;
  }

  const previousStation =
    route[previousIndex];

  const previousCoords =
    getStationCoordinates(
      previousStation
    );

  const previousCode =
    getStationCode(
      previousStation
    );

  // ----------------------------------------------------------
  // TIRUPATI SIDE
  // ----------------------------------------------------------

  if (
    previousCoords &&
    previousCoords.lng <
      GUDUR.lng - 0.01
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

  if (
    previousCoords &&
    previousCoords.lng >
      GUDUR.lng + 0.01
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // KNOWN TIRUPATI-SIDE CODES
  // ----------------------------------------------------------

  const TPTY_STATIONS = [
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
  ];

  if (
    TPTY_STATIONS.includes(
      previousCode
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // KNOWN CHENNAI-SIDE CODES
  // ----------------------------------------------------------

  const MAS_STATIONS = [
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
  ];

  if (
    MAS_STATIONS.includes(
      previousCode
    )
  ) {
    return "MAS";
  }

  return null;
}

// ============================================================
// FALLBACK DISPLAY CORRIDOR
// ============================================================

function determineBoardDisplayCorridor(
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
  trainsArray
) {
  const upcoming = [];

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
      determineBoardDisplayCorridor(
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

  return upcoming.slice(
    0,
    MAX_UPCOMING_TRAINS
  );
}

// ============================================================
// FIND LIVE CANDIDATES
// ============================================================

function findLiveCandidates(
  trainsArray
) {
  const candidates = [];

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

    if (eta === null) {
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

function gatePriority(status) {
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

  if (
    positionInfo.inbound === false
  ) {
    console.log(
      `[OUTBOUND IGNORED] ${trainNo} - already beyond Gudur`
    );

    return null;
  }

  if (
    positionInfo.inbound === null
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

  const corridor =
    determineCorridorFromLiveRoute(
      liveData,
      positionInfo
    );

  if (!corridor) {
    console.log(
      `[NO CORRIDOR] ${trainNo} - inbound but approach side could not be determined`
    );

    return null;
  }

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
      positionInfo.currentLocation?.status ||
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

  const gateRelevant =
    distanceToGate <=
    WARNING_DISTANCE_KM;

  const boardEtaMinutes =
    candidate.etaMinutes;

  let waitMinutes = 0;

  if (
    status === "OPEN" ||
    status === "WARNING"
  ) {
    if (
      Number.isFinite(
        Number(boardEtaMinutes)
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
    status === "CLOSED"
  ) {
    waitMinutes =
      Math.max(
        1,
        Math.ceil(
          Math.min(
            10,
            distanceToGate * 2
          )
        )
      );
  }

  let trainStatus =
    "Approaching";

  if (atStation) {
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
              Number(boardEtaMinutes)
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
        Number(boardEtaMinutes)
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
        distanceToGate.toFixed(3)
      ),

    distanceToGudurKm:
      Number(
        distanceToGudur.toFixed(3)
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
// PERSISTENT 15-MINUTE GATE HOLD
// ============================================================
//
// GitHub Actions starts a fresh Node.js process on every run.
// Therefore an in-memory timer would be lost between runs.
//
// We persist closedAtISO in Firebase instead.
//
// Behaviour:
//
// 1. First detection at <= 3 km -> CLOSED + closedAtISO = now.
// 2. For the next 15 minutes -> remain CLOSED even if the next
//    Actions run temporarily has no live GPS result.
// 3. After 15 minutes -> OPEN if no current train is <= 3 km.
// 4. If a train is still <= 3 km after the hold expires, a new
//    15-minute hold starts from the fresh CLOSED detection.
//
// This is application display/control logic only, not railway-grade
// fail-safe hardware control.
// ============================================================

function getPreviousGateHoldState(previousGate) {
  if (
    !previousGate ||
    previousGate.status !== "CLOSED" ||
    !previousGate.closedAtISO
  ) {
    return {
      active: false,
      expired: false,
      closedAtISO: null,
      remainingMinutes: 0
    };
  }

  const closedAt =
    new Date(
      previousGate.closedAtISO
    ).getTime();

  if (!Number.isFinite(closedAt)) {
    return {
      active: false,
      expired: false,
      closedAtISO: null,
      remainingMinutes: 0
    };
  }

  const elapsedMs =
    Date.now() - closedAt;

  const remainingMs =
    GATE_HOLD_MS - elapsedMs;

  if (remainingMs > 0) {
    return {
      active: true,
      expired: false,
      closedAtISO:
        previousGate.closedAtISO,
      remainingMinutes:
        Math.max(
          1,
          Math.ceil(
            remainingMs / 60000
          )
        )
    };
  }

  return {
    active: false,
    expired: true,
    closedAtISO:
      previousGate.closedAtISO,
    remainingMinutes: 0
  };
}

function applyPersistentGateHold(
  gate,
  previousGate,
  gateName
) {
  const hold =
    getPreviousGateHoldState(
      previousGate
    );

  // ----------------------------------------------------------
  // EXISTING 15-MINUTE HOLD IS STILL ACTIVE
  // ----------------------------------------------------------

  if (hold.active) {
    gate.status = "CLOSED";

    gate.closedAtISO =
      hold.closedAtISO;

    gate.holdMinutesRemaining =
      hold.remainingMinutes;

    gate.holdActive = true;

    gate.waitMinutes =
      hold.remainingMinutes;

    console.log(
      `[${gateName} HOLD] CLOSED | ${hold.remainingMinutes}m remaining`
    );

    return gate;
  }

  // ----------------------------------------------------------
  // A NEW <= 3 KM DETECTION STARTS A NEW HOLD
  // ----------------------------------------------------------

  if (gate.status === "CLOSED") {
    const closedAtISO =
      hold.expired &&
      hold.closedAtISO
        ? new Date().toISOString()
        : new Date().toISOString();

    gate.closedAtISO =
      closedAtISO;

    gate.holdMinutesRemaining =
      GATE_HOLD_MINUTES;

    gate.holdActive = true;

    gate.waitMinutes =
      GATE_HOLD_MINUTES;

    console.log(
      `[${gateName} HOLD] NEW 15-MINUTE HOLD STARTED`
    );

    return gate;
  }

  // ----------------------------------------------------------
  // HOLD EXPIRED AND NO TRAIN REQUIRES CLOSURE
  // ----------------------------------------------------------

  gate.closedAtISO = null;
  gate.holdMinutesRemaining = 0;
  gate.holdActive = false;

  console.log(
    `[${gateName} HOLD] OPEN - 15-minute hold complete`
  );

  return gate;
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
    // Read the previous Firebase gate state before processing this run.
    // This is what makes the 15-minute CLOSED hold survive GitHub Actions runs.
    const previousSnapshot =
      await gateRef.once("value");

    const previousData =
      previousSnapshot.val() || {};

    const previousChennaiGate =
      previousData.chennaiGate || {};

    const previousTirupatiGate =
      previousData.tirupatiGate || {};

    console.log(
      "\n=========================================="
    );

    console.log(
      " RailRadar Real-time Gate Monitor Active "
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
      `Gate hold:        ${GATE_HOLD_MINUTES} minutes`
    );

    console.log(
      `Upcoming trains:  ${MAX_UPCOMING_TRAINS}`
    );

    console.log(
      `Live lookahead:   ${LIVE_LOOKAHEAD_MINUTES} min`
    );

    console.log(
      `Live GPS checks:  ${MAX_LIVE_REQUESTS}`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // STATION LIVE BOARD
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

    const upcomingList =
      buildUpcomingFromBoard(
        trainsArray
      );

    console.log(
      `Upcoming trains selected: ${upcomingList.length}`
    );

    console.log(
      "\n[UPCOMING GDR TRAINS]"
    );

    upcomingList.forEach(
      (train, index) => {
        console.log(
          `${index + 1}. ` +
          `${train.trainNo} ${train.name} | ` +
          `${train.corridor} | ` +
          `ETA ${
            train.etaMinutes === null
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
    // PROCESS LIVE TRAINS
    // ========================================================

    let liveRequestCount =
      0;

    for (
      const candidate of
      liveCandidates
    ) {
      if (
        liveRequestCount >=
        MAX_LIVE_REQUESTS
      ) {
        break;
      }

      liveRequestCount++;

      const result =
        await processLiveCandidate(
          candidate
        );

      if (!result) {
        continue;
      }

      updateUpcomingCorridor(
        upcomingList,
        candidate.trainNo,
        result.corridor
      );

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
    // APPLY PERSISTENT 15-MINUTE HOLDS
    // ========================================================

    chennaiGate =
      applyPersistentGateHold(
        chennaiGate,
        previousChennaiGate,
        "CHENNAI GATE"
      );

    tirupatiGate =
      applyPersistentGateHold(
        tirupatiGate,
        previousTirupatiGate,
        "TIRUPATI GATE"
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

      lastUpdated:
        getCurrentISTDisplayTime(),

      lastUpdatedISO:
        new Date().toISOString(),

      lastUpdatedIST:
        `${getCurrentISTDateString()} ${getCurrentISTTimeString()}`,

      boardTrainCount:
        trainsArray.length,

      liveRequestCount,

      processingSeconds:
        Number(
          processingSeconds.toFixed(2)
        ),

      gateHoldMinutes:
        GATE_HOLD_MINUTES,

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

        source:
          "RailRadar GDR live station board + live train route telemetry",

        gateLogic:
          "LIVE ROUTE POSITION + DISTANCE",

        directionLogic:
          "TRAIN MUST BE BEFORE GDR ON LIVE ROUTE",

        gateRelevance:
          "TRAIN MUST BE WITHIN 4 KM OF ITS GATE TO CONTROL THE GATE",

        holdLogic:
          "GATE REMAINS CLOSED FOR 15 MINUTES AFTER FIRST CLOSED DETECTION"
      }
    });

    // ========================================================
    // RESULT
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
      `Live GPS/route requests: ${liveRequestCount}`
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

    if (error.response) {
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

    process.exitCode = 1;
  }
}

// ============================================================
// START ONE RUN
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
  .then(() => {
    console.log(
      "Monitor run completed."
    );
  })
  .catch((error) => {
    console.error(
      "Fatal monitor error:",
      error
    );

    process.exitCode = 1;
  });
```
