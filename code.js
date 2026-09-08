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
// GATE DISTANCE RULES
// ============================================================
//
// > 4.00 km  = OPEN
// > 3.00 km
// <= 4.00 km = WARNING
// <= 3.00 km = CLOSED
//
// ============================================================

const WARNING_DISTANCE_KM = 4.00;
const CLOSE_DISTANCE_KM = 3.00;

// Informational value only.
const CLEAR_DISTANCE_KM = 0.80;

// ============================================================
// 15-MINUTE CLOSED HOLD
// ============================================================
//
// IMPORTANT:
//
// GitHub Actions starts a NEW Node process every run.
//
// Therefore a normal JavaScript timer would disappear.
//
// We store closedAtISO in Firebase.
//
// ============================================================

const GATE_HOLD_MINUTES = 15;

const GATE_HOLD_MS =
  GATE_HOLD_MINUTES * 60 * 1000;

// ============================================================
// API SETTINGS
// ============================================================

const STATION_BOARD_HOURS = 4;

const MAX_UPCOMING_TRAINS = 10;

// Only trains whose GDR ETA is within this window
// receive a live train API request.
const LIVE_LOOKAHEAD_MINUTES = 90;

// Maximum live train requests per run.
const MAX_LIVE_REQUESTS = 10;

// Short timeout prevents one bad API request from
// holding the entire GitHub Action for a long time.
const API_TIMEOUT_MS = 8000;

// ============================================================
// IST TIME HELPERS
// ============================================================

function getISTParts() {
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
  const p = getISTParts();

  return (
    Number(p.hour) * 60 +
    Number(p.minute)
  );
}

function getCurrentISTDateString() {
  const p = getISTParts();

  return (
    `${p.year}-${p.month}-${p.day}`
  );
}

function getCurrentISTTimeString() {
  const p = getISTParts();

  return (
    `${p.hour}:${p.minute}:${p.second}`
  );
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
// TEXT HELPERS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

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
// TRAIN HELPERS
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

function getTrainName(train, item) {
  const trainNo =
    getTrainNumber(train, item);

  return (
    train.name ||
    item.trainName ||
    item.name ||
    `Train ${trainNo}`
  );
}

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

function getDestination(train, item) {
  return (
    getNameOrCode(train.destination) ||
    getNameOrCode(train.to) ||
    getNameOrCode(item.destination) ||
    getNameOrCode(item.to) ||
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
    live.platform ||
    stop.platform ||
    item.platform ||
    train.platform ||
    "1"
  );
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
// ARRIVAL / DEPARTURE
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

  // Plain HH:MM
  const match =
    value.match(
      /^(\d{1,2}):(\d{2})$/
    );

  if (match) {
    return (
      Number(match[1]) * 60 +
      Number(match[2]) +
      Number(delayMinutes || 0)
    );
  }

  // ISO / normal date
  const date =
    new Date(value);

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
        hour =
          Number(part.value);
      }

      if (part.type === "minute") {
        minute =
          Number(part.value);
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

  // Midnight handling.
  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
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
  // ALREADY AT GUDUR
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
  // SCHEDULED GDR ARRIVAL
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

    if (
      scheduledMinutes !== -1
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

    if (
      expectedMinutes !== -1
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
// RAILRADAR LIVE TRAIN REQUEST
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

          timeout:
            API_TIMEOUT_MS
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
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo}: ${error.message}`
      );
    }

    return null;
  }
}

// ============================================================
// RAILRADAR ROUTE HELPERS
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
// FIND GUDUR IN LIVE ROUTE
// ============================================================

function findGudurRouteIndex(
  route
) {
  return route.findIndex(
    (station) =>
      getStationCode(station) ===
      "GDR"
  );
}

// ============================================================
// FIND CURRENT ROUTE POSITION
// ============================================================

function findCurrentRouteIndex(
  route,
  currentLocation
) {
  const sequence =
    Number(
      currentLocation?.sequence
    );

  if (
    Number.isFinite(sequence)
  ) {
    const index =
      route.findIndex(
        (station) =>
          Number(
            station.sequence
          ) === sequence
      );

    if (index !== -1) {
      return index;
    }
  }

  const currentCode =
    getStationCode(
      currentLocation
    );

  if (currentCode) {
    const index =
      route.findIndex(
        (station) =>
          getStationCode(station) ===
          currentCode
      );

    if (index !== -1) {
      return index;
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
    getRoute(liveData);

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
  // DIRECT GPS COORDINATES
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
  // TRAIN IS AT GUDUR
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

    const status =
      normalizeText(
        currentLocation.status
      );

    const atGudur =
      status.includes(
        "AT STATION"
      ) ||
      status.includes(
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
  // ROUTE INFORMATION UNAVAILABLE
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
// DETERMINE MAS / TPTY FROM LIVE ROUTE
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

  // Train must be inbound.
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
  // TIRUPATI-SIDE STATIONS
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
  // CHENNAI-SIDE STATIONS
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
// DISPLAY-ONLY CORRIDOR
// ============================================================
//
// This is ONLY for the upcoming list.
//
// Gate control uses live route data instead.
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
    origin.includes(
      "CHENNAI"
    ) ||
    origin.includes("MAS")
  ) {
    return "MAS";
  }

  if (
    origin.includes(
      "TIRUPATI"
    ) ||
    origin.includes(
      "TPTY"
    ) ||
    origin.includes(
      "RENIGUNTA"
    ) ||
    origin === "RU"
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// BUILD UPCOMING TRAINS
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

    const arrival =
      getArrivalTime(
        train,
        live,
        stop,
        item
      );

    const departure =
      getDepartureTime(
        train,
        live,
        stop,
        item,
        arrival
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
        arrival || "",

      departure:
        departure || "",

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
  // <= 3 km
  if (
    distanceKm <=
    CLOSE_DISTANCE_KM
  ) {
    return "CLOSED";
  }

  // > 3 km and <= 4 km
  if (
    distanceKm <=
    WARNING_DISTANCE_KM
  ) {
    return "WARNING";
  }

  // > 4 km
  return "OPEN";
}

function gatePriority(
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
// PROCESS LIVE TRAIN
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
    `\n[LIVE CHECK] ${trainNo} ${getTrainName(
      train,
      item
    )} | ETA ${candidate.etaMinutes}m`
  );

  const liveData =
    await fetchLiveTrain(
      trainNo
    );

  if (!liveData) {
    return null;
  }

  const positionInfo =
    getLiveTrainPosition(
      liveData
    );

  if (!positionInfo) {
    console.log(
      `[NO POSITION] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // REJECT OUTBOUND
  // ----------------------------------------------------------

  if (
    positionInfo.inbound === false
  ) {
    console.log(
      `[OUTBOUND IGNORED] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // UNKNOWN DIRECTION
  // ----------------------------------------------------------

  if (
    positionInfo.inbound === null
  ) {
    console.log(
      `[UNKNOWN DIRECTION] ${trainNo}`
    );

    return null;
  }

  const coordinates =
    positionInfo.coordinates;

  if (!coordinates) {
    console.log(
      `[NO COORDINATES] ${trainNo}`
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
      `[NO CORRIDOR] ${trainNo}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // SELECT GATE
  // ----------------------------------------------------------

  const gate =
    corridor === "MAS"
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
  // STATUS
  // ----------------------------------------------------------

  const status =
    getGateState(
      distanceToGate
    );

  // ----------------------------------------------------------
  // TRAIN INFO
  // ----------------------------------------------------------

  const trainName =
    liveData.train?.name ||
    getTrainName(
      train,
      item
    );

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

  // ----------------------------------------------------------
  // ONLY WITHIN 4 KM CONTROLS GATE
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

  // ----------------------------------------------------------
  // TRAIN STATUS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // PAYLOAD
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
    `Gate ${distanceToGate.toFixed(2)} km | ` +
    `GDR ${distanceToGudur.toFixed(2)} km | ` +
    `${gateRelevant ? status : "OPEN"}`
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
// PERSISTENT GATE HOLD
// ============================================================

function getGateHoldState(
  previousGate
) {
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

  if (
    !Number.isFinite(closedAt)
  ) {
    return {
      active: false,
      expired: false,
      closedAtISO: null,
      remainingMinutes: 0
    };
  }

  const elapsed =
    Date.now() -
    closedAt;

  const remaining =
    GATE_HOLD_MS -
    elapsed;

  if (remaining > 0) {
    return {
      active: true,
      expired: false,

      closedAtISO:
        previousGate.closedAtISO,

      remainingMinutes:
        Math.max(
          1,
          Math.ceil(
            remaining /
            60000
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

// ============================================================
// APPLY 15-MINUTE HOLD
// ============================================================

function applyGateHold(
  currentGate,
  previousGate,
  gateName
) {
  const hold =
    getGateHoldState(
      previousGate
    );

  // ----------------------------------------------------------
  // EXISTING HOLD STILL ACTIVE
  // ----------------------------------------------------------

  if (hold.active) {
    currentGate.status =
      "CLOSED";

    currentGate.closedAtISO =
      hold.closedAtISO;

    currentGate.holdActive =
      true;

    currentGate.holdMinutesRemaining =
      hold.remainingMinutes;

    currentGate.waitMinutes =
      hold.remainingMinutes;

    console.log(
      `[${gateName}] 15-MIN HOLD ACTIVE | ${hold.remainingMinutes}m remaining`
    );

    return currentGate;
  }

  // ----------------------------------------------------------
  // CURRENT TRAIN REQUIRES CLOSURE
  // ----------------------------------------------------------

  if (
    currentGate.status ===
    "CLOSED"
  ) {
    const nowISO =
      new Date().toISOString();

    currentGate.status =
      "CLOSED";

    currentGate.closedAtISO =
      nowISO;

    currentGate.holdActive =
      true;

    currentGate.holdMinutesRemaining =
      GATE_HOLD_MINUTES;

    currentGate.waitMinutes =
      GATE_HOLD_MINUTES;

    console.log(
      `[${gateName}] NEW 15-MIN HOLD STARTED`
    );

    return currentGate;
  }

  // ----------------------------------------------------------
  // HOLD FINISHED
  // ----------------------------------------------------------

  currentGate.closedAtISO =
    null;

  currentGate.holdActive =
    false;

  currentGate.holdMinutesRemaining =
    0;

  console.log(
    `[${gateName}] HOLD COMPLETE - OPEN`
  );

  return currentGate;
}

// ============================================================
// UPDATE UPCOMING CORRIDOR
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

  if (!item) {
    return;
  }

  item.corridor =
    corridor;

  item.direction =
    "TOWARD GUDUR";
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  // ----------------------------------------------------------
  // READ PREVIOUS FIREBASE STATE
  // ----------------------------------------------------------

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

  try {
    console.log(
      "\n=========================================="
    );

    console.log(
      " GUDUR GATE MONITOR"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `IST: ${getCurrentISTDisplayTime()}`
    );

    console.log(
      `Warning: ${WARNING_DISTANCE_KM} km`
    );

    console.log(
      `Closed:  ${CLOSE_DISTANCE_KM} km`
    );

    console.log(
      `Hold:    ${GATE_HOLD_MINUTES} minutes`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // FETCH GDR BOARD
    // ========================================================

    console.log(
      "\nFetching RailRadar GDR station board..."
    );

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours:
              STATION_BOARD_HOURS
          },

          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          timeout:
            API_TIMEOUT_MS
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
      `Board trains: ${trainsArray.length}`
    );

    // ========================================================
    // UPCOMING TRAINS
    // ========================================================

    const upcomingList =
      buildUpcomingFromBoard(
        trainsArray
      );

    console.log(
      `Upcoming displayed: ${upcomingList.length}`
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
          }`
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
      `\nLive candidates: ${liveCandidates.length}`
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
        "MAS",

      distanceKm:
        null,

      distanceToGudurKm:
        null,

      trainNo:
        null,

      trainName:
        null,

      closedAtISO:
        null,

      holdActive:
        false,

      holdMinutesRemaining:
        0
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
        "TPTY",

      distanceKm:
        null,

      distanceToGudurKm:
        null,

      trainNo:
        null,

      trainName:
        null,

      closedAtISO:
        null,

      holdActive:
        false,

      holdMinutesRemaining:
        0
    };

    // ========================================================
    // PROCESS LIVE REQUESTS IN PARALLEL
    // ========================================================
    //
    // THIS IS THE IMPORTANT SPEED FIX.
    //
    // Old:
    //
    // await train1
    // await train2
    // await train3
    //
    // New:
    //
    // train1 ─┐
    // train2 ─┤
    // train3 ─┤ -> all together
    // train4 ─┤
    // train5 ─┘
    //
    // ========================================================

    const candidatesToProcess =
      liveCandidates.slice(
        0,
        MAX_LIVE_REQUESTS
      );

    const liveRequestCount =
      candidatesToProcess.length;

    console.log(
      `\nStarting ${liveRequestCount} live requests in parallel...`
    );

    const liveResults =
      await Promise.all(
        candidatesToProcess.map(
          async (candidate) => {
            try {
              const result =
                await processLiveCandidate(
                  candidate
                );

              return {
                candidate,
                result
              };
            } catch (error) {
              console.error(
                `[PROCESS ERROR] ${candidate.trainNo}: ${error.message}`
              );

              return {
                candidate,
                result: null
              };
            }
          }
        )
      );

    // ========================================================
    // PROCESS RESULTS
    // ========================================================

    for (
      const {
        candidate,
        result
      } of liveResults
    ) {
      if (!result) {
        continue;
      }

      updateUpcomingCorridor(
        upcomingList,
        candidate.trainNo,
        result.corridor
      );

      // Too far away to control gate.
      if (
        !result.gateRelevant
      ) {
        continue;
      }

      // ------------------------------------------------------
      // CHENNAI
      // ------------------------------------------------------

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

      // ------------------------------------------------------
      // TIRUPATI
      // ------------------------------------------------------

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

    chennaiGate =
      applyGateHold(
        chennaiGate,
        previousChennaiGate,
        "CHENNAI GATE"
      );

    tirupatiGate =
      applyGateHold(
        tirupatiGate,
        previousTirupatiGate,
        "TIRUPATI GATE"
      );

    // ========================================================
    // FIREBASE UPDATE
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

        apiTimeoutMs:
          API_TIMEOUT_MS,

        source:
          "RailRadar GDR live station board + live train route telemetry",

        gateLogic:
          "LIVE ROUTE POSITION + DISTANCE",

        directionLogic:
          "TRAIN MUST BE BEFORE GDR ON LIVE ROUTE",

        gateRelevance:
          "TRAIN MUST BE WITHIN 4 KM OF ITS GATE",

        holdLogic:
          "GATE REMAINS CLOSED FOR 15 MINUTES AFTER CLOSED DETECTION",

        executionMode:
          "SINGLE GITHUB ACTION RUN"
      }
    });

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      " FIREBASE UPDATE SUCCESS"
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
      `  ETA: ${
        chennaiGate.etaMinutes ??
        "N/A"
      }m`
    );

    console.log(
      `Tirupati Gate: ${tirupatiGate.status}`
    );

    console.log(
      `  ${tirupatiGate.activeTrain}`
    );

    console.log(
      `  ETA: ${
        tirupatiGate.etaMinutes ??
        "N/A"
      }m`
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
      "=========================================="
    );

  } catch (error) {
    console.error(
      "\n=========================================="
    );

    console.error(
      " MONITOR ERROR"
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
      "=========================================="
    );

    throw error;
  }
}

// ============================================================
// START
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

// ============================================================
// RUN ONCE
// ============================================================
//
// IMPORTANT:
//
// We DO NOT use setInterval().
//
// GitHub Actions starts this script once,
// updates Firebase, closes Firebase,
// and exits.
//
// ============================================================

updateGateSystem()
  .then(async () => {
    console.log(
      "\nMonitor run completed."
    );

    // --------------------------------------------------------
    // CRITICAL:
    // CLOSE FIREBASE CONNECTION
    //
    // Without this, Node can remain alive and GitHub Actions
    // can continue running for many minutes.
    // --------------------------------------------------------

    try {
      await admin
        .app()
        .delete();

      console.log(
        "Firebase connection closed."
      );
    } catch (error) {
      console.error(
        `Firebase cleanup error: ${error.message}`
      );
    }

    console.log(
      "Exiting successfully."
    );

    process.exit(0);
  })
  .catch(async (error) => {
    console.error(
      "\nFatal monitor error:"
    );

    console.error(error);

    // --------------------------------------------------------
    // ALWAYS CLOSE FIREBASE ON ERROR
    // --------------------------------------------------------

    try {
      await admin
        .app()
        .delete();

      console.log(
        "Firebase connection closed after error."
      );
    } catch (cleanupError) {
      console.error(
        `Firebase cleanup error: ${cleanupError.message}`
      );
    }

    process.exit(1);
  });
