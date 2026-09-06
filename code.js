const axios = require("axios");
const admin = require("firebase-admin");

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
    "❌ Firebase service account could not be loaded."
  );

  console.error(
    "GitHub Actions must contain FIREBASE_SERVICE_ACCOUNT."
  );

  console.error(error.message);

  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = admin.database();
const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR LOCATIONS
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436;

// ============================================================
// SETTINGS
// ============================================================

// Upcoming list can show trains up to 6 hours away.
const UPCOMING_MAX_ETA_MINUTES = 360;

// Maximum distance allowed for a known live train to remain
// relevant to the upcoming list.
const UPCOMING_MAX_DISTANCE_KM = 150;

// Actual gate trigger distance.
const GATE_TRIGGER_DISTANCE_KM = 0.60;

// Station board window.
const STATION_BOARD_HOURS = 4;

// ============================================================
// IMPORTANT CHANGE
// ============================================================
//
// LIVE VERIFICATION WINDOW:
//
// OLD: 30 minutes
// NEW: 60 minutes
//
// Any upcoming train within 60 minutes will be checked
// against RailRadar live data.
//
// ============================================================

const LIVE_VERIFY_ETA_MINUTES = 60;

// Maximum live calls per GitHub Actions run.
//
// We keep this limited because every live-train request
// consumes RailRadar API quota.
const MAX_LIVE_CALLS = 2;

// ============================================================
// KNOWN TIRUPATI TRAINS
// ============================================================
//
// These are used only as a fallback for the UPCOMING LIST.
//
// Actual gate closure still uses live route + actual position.
//
// ============================================================

const TPTY_TRAIN_NUMBERS = new Set([
  "12733",
  "12734",
  "12763",
  "12764",

  "17479",
  "17480",
  "17487",
  "17488",

  "17261",
  "17262",

  "07669",
  "07670",

  "20630",
  "17247"
]);

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

function containsAny(text, values) {
  const normalized =
    normalizeText(text);

  return values.some((value) =>
    normalized.includes(
      normalizeText(value)
    )
  );
}

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
    }
  }

  return "";
}

function normalizeTrainNumber(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .trim();
}

// ============================================================
// TRAIN DATA
// ============================================================

function getTrainNumber(train, item) {
  return normalizeTrainNumber(
    firstValue(
      train?.number,
      item?.trainNumber,
      item?.number
    )
  );
}

function getTrainName(
  train,
  item,
  trainNo
) {
  return firstValue(
    train?.name,
    item?.trainName,
    item?.name,
    `Express ${trainNo}`
  );
}

function getOrigin(train, item) {
  return firstValue(
    train?.source?.name,
    train?.source?.code,

    train?.origin?.name,
    train?.origin?.code,

    train?.from?.name,
    train?.from?.code,

    train?.fromStation?.name,
    train?.fromStation?.code,

    item?.source?.name,
    item?.source?.code,

    item?.origin?.name,
    item?.origin?.code,

    item?.from?.name,
    item?.from?.code
  );
}

function getDestination(train, item) {
  return firstValue(
    train?.destination?.name,
    train?.destination?.code,

    train?.to?.name,
    train?.to?.code,

    train?.destinationStation?.name,
    train?.destinationStation?.code,

    item?.destination?.name,
    item?.destination?.code,

    item?.to?.name,
    item?.to?.code
  );
}

function getPlatform(
  train,
  live,
  stop,
  item
) {
  return String(
    firstValue(
      live?.platform,
      stop?.platform,
      train?.platform,
      item?.platform,
      "1"
    )
  );
}

// ============================================================
// TIME
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const date =
    new Date(timeStr);

  if (!isNaN(date.getTime())) {
    return (
      date.getHours() * 60 +
      date.getMinutes() +
      Number(delayMinutes || 0)
    );
  }

  const match =
    String(timeStr)
      .trim()
      .match(
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

function timeDifference(
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
// BOARD ETA
// ============================================================

function getBoardEta(
  train,
  live,
  stop,
  item,
  currentMinutes
) {
  const directEta =
    firstValue(
      live?.etaMinutes,
      live?.eta,
      item?.etaMinutes,
      item?.eta
    );

  if (directEta !== "") {
    const number =
      Number(directEta);

    if (
      Number.isFinite(number)
    ) {
      return number;
    }
  }

  const delayMinutes =
    Number(
      firstValue(
        live?.delayMinutes,
        train?.delayMinutes,
        item?.delayMinutes,
        0
      )
    );

  const arrival =
    firstValue(
      stop?.arrival,
      stop?.arrivalTime,

      live?.expectedArrivalTime,
      live?.expectedArrival,

      live?.arrivalTime,

      item?.arrival,
      item?.arrivalTime
    );

  const arrivalMinutes =
    parseTimeToMinutes(
      arrival,
      delayMinutes
    );

  if (
    arrivalMinutes === -1
  ) {
    return null;
  }

  return timeDifference(
    arrivalMinutes,
    currentMinutes
  );
}

// ============================================================
// UPCOMING CORRIDOR
// ============================================================
//
// This is ONLY for displaying the upcoming list.
//
// ============================================================

function determineUpcomingCorridor(
  train,
  item
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  // Known TPTY train
  if (
    TPTY_TRAIN_NUMBERS.has(
      trainNo
    )
  ) {
    return "TPTY";
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

  const text =
    `${origin} ${destination}`;

  if (
    containsAny(
      text,
      [
        "TIRUPATI",
        "TPTY"
      ]
    )
  ) {
    return "TPTY";
  }

  // Main GDR board fallback.
  return "MAS";
}

// ============================================================
// ROUTE
// ============================================================

function getRouteArray(data) {
  if (
    Array.isArray(data?.route)
  ) {
    return data.route;
  }

  if (
    Array.isArray(
      data?.data?.route
    )
  ) {
    return data.data.route;
  }

  if (
    Array.isArray(
      data?.data?.stops
    )
  ) {
    return data.data.stops;
  }

  if (
    Array.isArray(
      data?.stops
    )
  ) {
    return data.stops;
  }

  return [];
}

function routeContainsStation(
  route,
  codes,
  names
) {
  return route.some(
    (station) => {
      const code =
        normalizeText(
          firstValue(
            station?.stationCode,
            station?.code
          )
        );

      const name =
        normalizeText(
          firstValue(
            station?.stationName,
            station?.name
          )
        );

      return (
        codes.includes(code) ||
        names.some(
          (n) =>
            name.includes(
              normalizeText(n)
            )
        )
      );
    }
  );
}

// ============================================================
// LIVE CORRIDOR
// ============================================================
//
// For gate closure we prefer the actual live route.
//
// ============================================================

function determineLiveCorridor(
  liveData
) {
  const route =
    getRouteArray(
      liveData
    );

  const hasGDR =
    routeContainsStation(
      route,
      ["GDR"],
      ["GUDUR"]
    );

  const hasTPTY =
    routeContainsStation(
      route,
      ["TPTY"],
      ["TIRUPATI"]
    );

  const hasMAS =
    routeContainsStation(
      route,
      ["MAS"],
      [
        "CHENNAI CENTRAL",
        "MGR CHENNAI CENTRAL"
      ]
    );

  // ----------------------------------------------------------
  // Route says Gudur + Tirupati
  // ----------------------------------------------------------

  if (
    hasGDR &&
    hasTPTY
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Route says Gudur + Chennai
  // ----------------------------------------------------------

  if (
    hasGDR &&
    hasMAS
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Fallback to source/destination
  // ----------------------------------------------------------

  const train =
    liveData?.train ||
    {};

  const origin =
    getOrigin(
      train,
      liveData
    );

  const destination =
    getDestination(
      train,
      liveData
    );

  const text =
    `${origin} ${destination}`;

  if (
    containsAny(
      text,
      [
        "TIRUPATI",
        "TPTY"
      ]
    )
  ) {
    return "TPTY";
  }

  return "MAS";
}

// ============================================================
// CURRENT LOCATION
// ============================================================

function getCurrentLocation(
  data
) {
  return (
    data?.currentLocation ||
    data?.data?.currentLocation ||
    null
  );
}

function getCurrentStationCode(
  data
) {
  const location =
    getCurrentLocation(
      data
    );

  return normalizeText(
    firstValue(
      location?.stationCode,
      location?.code
    )
  );
}

// ============================================================
// ACTUAL GPS
// ============================================================

function getActualGps(
  data
) {
  const location =
    getCurrentLocation(
      data
    );

  if (!location) {
    return null;
  }

  const lat =
    Number(
      firstValue(
        location.lat,
        location.latitude
      )
    );

  const lng =
    Number(
      firstValue(
        location.lng,
        location.lon,
        location.longitude
      )
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat === 0 ||
    lng === 0
  ) {
    return null;
  }

  // IMPORTANT:
  //
  // If RailRadar explicitly says this isn't an actual
  // position, don't use it for gate closure.
  //

  if (
    location.isActualPosition === false
  ) {
    return null;
  }

  return {
    lat,
    lng,

    speedKmh:
      Number(
        firstValue(
          location.speedKmh,
          location.speed,
          0
        )
      ),

    bearing:
      Number(
        firstValue(
          location.bearingDegrees,
          location.bearing,
          location.heading,
          0
        )
      ),

    isActualPosition:
      true
  };
}

// ============================================================
// HAVERSINE
// ============================================================

function haversineKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

  const dLat =
    (lat2 - lat1) *
    Math.PI /
    180;

  const dLon =
    (lon2 - lon1) *
    Math.PI /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 * Math.PI / 180
    ) *
      Math.cos(
        lat2 * Math.PI / 180
      ) *
      Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

// ============================================================
// DISTANCE
// ============================================================

function distanceToGate(
  actual,
  gateLat,
  gateLng
) {
  if (!actual) {
    return null;
  }

  return haversineKm(
    actual.lat,
    actual.lng,
    gateLat,
    gateLng
  );
}

function distanceToGudur(
  actual
) {
  if (!actual) {
    return null;
  }

  return haversineKm(
    actual.lat,
    actual.lng,
    GDR_LAT,
    GDR_LNG
  );
}

// ============================================================
// GATE WAIT TIME
// ============================================================

function calculateGateWaitMinutes(
  distanceKm,
  speedKmh
) {
  if (
    distanceKm === null
  ) {
    return 5;
  }

  if (
    distanceKm <= 0.05
  ) {
    return 5;
  }

  let speed =
    Number(speedKmh);

  if (
    !Number.isFinite(speed) ||
    speed < 5
  ) {
    speed = 55;
  }

  const etaMinutes =
    (
      distanceKm /
      speed
    ) * 60;

  return Math.max(
    1,
    Math.ceil(
      etaMinutes + 2
    )
  );
}

// ============================================================
// OPEN GATE
// ============================================================

function openGate() {
  return {
    status: "OPEN",

    waitMinutes: 0,

    activeTrain:
      "Tracks clear",

    direction:
      "CLEAR",

    corridor:
      "NONE",

    distanceKm:
      null
  };
}

// ============================================================
// LIVE TRAIN API
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${trainNo}/live` +
    `?authoritative=true` +
    `&includeCoordinates=true`;

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
    response.data ||
    {}
  );
}

// ============================================================
// INBOUND CHECK
// ============================================================

function isInboundTrain(
  liveData,
  candidate
) {
  const location =
    getCurrentLocation(
      liveData
    );

  const status =
    normalizeText(
      firstValue(
        location?.status,
        liveData?.status
      )
    );

  // Explicitly outbound/departed = reject.
  if (
    status.includes(
      "DEPARTED"
    ) ||
    status.includes(
      "OUTBOUND"
    )
  ) {
    return false;
  }

  // If candidate came from a future GDR station-board ETA,
  // it is considered inbound unless live data explicitly
  // says otherwise.
  return true;
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  const startTime =
    Date.now();

  let apiRequests = 0;

  try {
    const now =
      new Date();

    const currentMinutes =
      now.getHours() * 60 +
      now.getMinutes();

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
      `Gudur: ${GDR_LAT}, ${GDR_LNG}`
    );

    console.log(
      `Chennai Gate: ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
    );

    console.log(
      `Tirupati Gate: ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Firebase: Configured"
    );

    console.log(
      `RailRadar API Key: ${
        RAILRADAR_API_KEY
          ? "Configured"
          : "MISSING"
      }`
    );

    console.log(
      "MODE: TWO-STAGE"
    );

    console.log(
      "Stage 1: Upcoming MAS + TPTY"
    );

    console.log(
      "Stage 2: Actual position → gate closure"
    );

    console.log(
      `Upcoming max ETA: ${UPCOMING_MAX_ETA_MINUTES} minutes`
    );

    console.log(
      `Live verification window: ${LIVE_VERIFY_ETA_MINUTES} minutes`
    );

    console.log(
      `Gate trigger distance: ${GATE_TRIGGER_DISTANCE_KM} km`
    );

    console.log(
      `Maximum live calls: ${MAX_LIVE_CALLS}`
    );

    console.log(
      "GitHub Actions: RUN ONCE"
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // STAGE 1
    // ========================================================

    console.log(
      `\n[${now.toLocaleTimeString()}] Stage 1: Reading GDR live board...`
    );

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live` +
        `?hours=${STATION_BOARD_HOURS}` +
        `&includeIntermediate=true`,
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

    apiRequests++;

    const boardData =
      boardResponse.data?.data ||
      boardResponse.data ||
      {};

    const trains =
      Array.isArray(
        boardData.trains
      )
        ? boardData.trains
        : [];

    console.log(
      `\n✅ RailRadar returned ${trains.length} trains.`
    );

    // ========================================================
    // CREATE UPCOMING LIST
    // ========================================================

    const upcomingMap =
      new Map();

    for (
      const item of trains
    ) {
      const train =
        item?.train ||
        {};

      const live =
        item?.live ||
        {};

      const stop =
        item?.stop ||
        {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (!trainNo) {
        continue;
      }

      const name =
        getTrainName(
          train,
          item,
          trainNo
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

      const eta =
        getBoardEta(
          train,
          live,
          stop,
          item,
          currentMinutes
        );

      if (
        eta === null
      ) {
        continue;
      }

      if (
        eta < 0 ||
        eta >
          UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      if (
        !isUpcomingStatus(
          train,
          live,
          stop,
          eta
        )
      ) {
        continue;
      }

      const corridor =
        determineUpcomingCorridor(
          train,
          item
        );

      const upcomingTrain = {
        trainNo,

        name,

        origin:
          origin ||
          "Unknown",

        destination:
          destination ||
          "Gudur",

        etaMinutes:
          Math.max(
            0,
            Math.round(
              eta
            )
          ),

        delayMinutes:
          Number(
            firstValue(
              live?.delayMinutes,
              train?.delayMinutes,
              item?.delayMinutes,
              0
            )
          ),

        corridor,

        direction:
          "TOWARD GUDUR",

        platform:
          getPlatform(
            train,
            live,
            stop,
            item
          ),

        distanceKm:
          null,

        liveData:
          false
      };

      // Keep only one copy of each train.
      if (
        !upcomingMap.has(
          trainNo
        )
      ) {
        upcomingMap.set(
          trainNo,
          upcomingTrain
        );
      }
    }

    // ========================================================
    // SORT
    // ========================================================

    let upcomingList =
      Array.from(
        upcomingMap.values()
      );

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    console.log(
      "\n[BOARD UPCOMING]"
    );

    upcomingList
      .slice(
        0,
        10
      )
      .forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} | ETA ${train.etaMinutes}m`
          );
        }
      );

    // ========================================================
    // STAGE 2
    // ========================================================
    //
    // NEW:
    //
    // Check trains within 60 minutes.
    //
    // ========================================================

    const liveCandidates =
      upcomingList
        .filter(
          (train) =>
            train.etaMinutes >= 0 &&
            train.etaMinutes <=
              LIVE_VERIFY_ETA_MINUTES
        )
        .slice(
          0,
          MAX_LIVE_CALLS
        );

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    if (
      liveCandidates.length === 0
    ) {
      console.log(
        `[STAGE 2] No train is within ${LIVE_VERIFY_ETA_MINUTES} minutes.`
      );
    }

    let chennaiGate =
      openGate();

    let tirupatiGate =
      openGate();

    const liveResults =
      [];

    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    for (
      const candidate of
        liveCandidates
    ) {
      try {
        console.log(
          `\n[LIVE] Checking ${candidate.trainNo} ${candidate.name}...`
        );

        const liveData =
          await fetchLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        const train =
          liveData?.train ||
          {};

        const actual =
          getActualGps(
            liveData
          );

        const corridor =
          determineLiveCorridor(
            liveData
          );

        const currentStation =
          getCurrentStationCode(
            liveData
          );

        const distanceGdr =
          distanceToGudur(
            actual
          );

        const distanceChennai =
          distanceToGate(
            actual,
            CHENNAI_GATE_LAT,
            CHENNAI_GATE_LNG
          );

        const distanceTirupati =
          distanceToGate(
            actual,
            TIRUPATI_GATE_LAT,
            TIRUPATI_GATE_LNG
          );

        const speedKmh =
          Number(
            actual?.speedKmh || 0
          );

        const inbound =
          isInboundTrain(
            liveData,
            candidate
          );

        const liveResult = {
          trainNo:
            candidate.trainNo,

          name:
            getTrainName(
              train,
              liveData,
              candidate.trainNo
            ),

          corridor,

          direction:
            inbound
              ? "TOWARD GUDUR"
              : "UNKNOWN",

          currentStation:
            currentStation ||
            "UNKNOWN",

          actualPosition:
            Boolean(
              actual
            ),

          distanceToGdrKm:
            distanceGdr === null
              ? null
              : Number(
                  distanceGdr.toFixed(
                    3
                  )
                ),

          distanceToChennaiGateKm:
            distanceChennai === null
              ? null
              : Number(
                  distanceChennai.toFixed(
                    3
                  )
                ),

          distanceToTirupatiGateKm:
            distanceTirupati === null
              ? null
              : Number(
                  distanceTirupati.toFixed(
                    3
                  )
                ),

          speedKmh
        };

        liveResults.push(
          liveResult
        );

        console.log(
          `[LIVE RESULT] ${candidate.trainNo} | ${corridor} | ${inbound ? "TOWARD GUDUR" : "UNKNOWN"} | actual=${actual ? "YES" : "NO"} | GDR=${distanceGdr === null ? "UNKNOWN" : distanceGdr.toFixed(3) + "km"} | ChennaiGate=${distanceChennai === null ? "UNKNOWN" : distanceChennai.toFixed(3) + "km"} | TirupatiGate=${distanceTirupati === null ? "UNKNOWN" : distanceTirupati.toFixed(3) + "km"}`
        );

        // ====================================================
        // NO ACTUAL POSITION = NO CLOSURE
        // ====================================================

        if (
          !actual
        ) {
          console.log(
            `[GATE] ${candidate.trainNo}: actual position unavailable -> gates remain OPEN`
          );

          continue;
        }

        if (
          !inbound
        ) {
          console.log(
            `[GATE] ${candidate.trainNo}: not inbound -> gates remain OPEN`
          );

          continue;
        }

        // ====================================================
        // TIRUPATI GATE
        // ====================================================

        if (
          corridor === "TPTY" &&
          distanceTirupati !== null &&
          distanceTirupati <=
            GATE_TRIGGER_DISTANCE_KM
        ) {
          const wait =
            calculateGateWaitMinutes(
              distanceTirupati,
              speedKmh
            );

          tirupatiGate = {
            status:
              "CLOSED",

            waitMinutes:
              wait,

            activeTrain:
              `${candidate.trainNo} ${candidate.name}`,

            direction:
              "TOWARD GUDUR",

            corridor:
              "TPTY",

            distanceKm:
              Number(
                distanceTirupati.toFixed(
                  2
                )
              ),

            actualPositionSource:
              "RailRadar live"
          };

          console.log(
            `[GATE CLOSED] TIRUPATI GATE | ${candidate.trainNo} | distance ${distanceTirupati.toFixed(3)} km`
          );
        }

        // ====================================================
        // CHENNAI GATE
        // ====================================================

        if (
          corridor === "MAS" &&
          distanceChennai !== null &&
          distanceChennai <=
            GATE_TRIGGER_DISTANCE_KM
        ) {
          const wait =
            calculateGateWaitMinutes(
              distanceChennai,
              speedKmh
            );

          chennaiGate = {
            status:
              "CLOSED",

            waitMinutes:
              wait,

            activeTrain:
              `${candidate.trainNo} ${candidate.name}`,

            direction:
              "TOWARD GUDUR",

            corridor:
              "MAS",

            distanceKm:
              Number(
                distanceChennai.toFixed(
                  2
                )
              ),

            actualPositionSource:
              "RailRadar live"
          };

          console.log(
            `[GATE CLOSED] CHENNAI GATE | ${candidate.trainNo} | distance ${distanceChennai.toFixed(3)} km`
          );
        }

      } catch (error) {
        console.error(
          `[LIVE ERROR] ${candidate.trainNo}: ${error.message}`
        );
      }
    }

    // ========================================================
    // MERGE LIVE CORRIDOR INTO UPCOMING
    // ========================================================

    for (
      const liveTrain of
        liveResults
    ) {
      const existing =
        upcomingList.find(
          (train) =>
            train.trainNo ===
            liveTrain.trainNo
        );

      if (!existing) {
        continue;
      }

      existing.liveData =
        true;

      existing.corridor =
        liveTrain.corridor;

      existing.distanceKm =
        liveTrain.distanceToGdrKm;

      existing.direction =
        liveTrain.direction;
    }

    // ========================================================
    // FINAL TOP 5
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        startTime
      ) / 1000;

    await gateRef.set({
      chennaiGate,

      tirupatiGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedLocal:
        now.toLocaleString(),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedAtMs:
        Date.now(),

      monitorStatus:
        "OK",

      verifiedTrains:
        liveResults.length,

      apiRequests,

      monitorDurationSeconds:
        Number(
          durationSeconds.toFixed(
            1
          )
        )
    });

    // ========================================================
    // FINAL LOG
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
      `  Train    : ${chennaiGate.activeTrain}`
    );

    console.log(
      `  Distance : ${chennaiGate.distanceKm ?? "N/A"} km`
    );

    console.log(
      `Tirupati Gate: ${tirupatiGate.status}`
    );

    console.log(
      `  Train    : ${tirupatiGate.activeTrain}`
    );

    console.log(
      `  Distance : ${tirupatiGate.distanceKm ?? "N/A"} km`
    );

    console.log(
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live verified: ${liveResults.length}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    console.log(
      "\n[UPCOMING TRAINS TO GUDUR]"
    );

    if (
      topUpcoming.length === 0
    ) {
      console.log(
        "None"
      );
    } else {
      topUpcoming.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform}`
          );
        }
      );
    }

    console.log(
      "\n=========================================="
    );

    console.log(
      `Monitor completed in ${durationSeconds.toFixed(1)} seconds.`
    );

    console.log(
      "GitHub Actions process will now exit."
    );

    console.log(
      "=========================================="
    );

    return true;

  } catch (error) {
    console.error(
      "\n=========================================="
    );

    console.error(
      "[MONITOR ERROR]"
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
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    }

    console.error(
      "=========================================="
    );

    // ========================================================
    // FAIL-SAFE
    // ========================================================
    //
    // If the monitor itself fails, do NOT leave a stale CLOSED
    // status in Firebase.
    //
    // ========================================================

    try {
      await gateRef.set({
        chennaiGate:
          openGate(),

        tirupatiGate:
          openGate(),

        upcomingTrains:
          [],

        lastUpdated:
          new Date()
            .toLocaleTimeString(),

        lastUpdatedLocal:
          new Date()
            .toLocaleString(),

        lastUpdatedAt:
          new Date()
            .toISOString(),

        lastUpdatedAtMs:
          Date.now(),

        monitorStatus:
          "ERROR",

        apiRequests,

        monitorError:
          error.message
      });
    } catch (
      firebaseError
    ) {
      console.error(
        "[FIREBASE ERROR]",
        firebaseError.message
      );
    }

    return false;
  }
}

// ============================================================
// RUN ONCE
// ============================================================
//
// GitHub Actions calls this workflow every 5 minutes.
// DO NOT use setInterval().
//
// ============================================================

updateGateSystem()
  .then(
    (success) => {
      process.exitCode =
        success ? 0 : 1;
    }
  )
  .catch(
    (error) => {
      console.error(
        "[FATAL]",
        error.message
      );

      process.exitCode = 1;
    }
  );
