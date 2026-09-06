const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT || ""
  );
} catch (error) {
  console.error(
    "❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing or invalid."
  );
  process.exit(1);
}

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();
const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR / GATE LOCATIONS
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_ETA_MINUTES = 360;

const GATE_TRIGGER_DISTANCE_KM = 0.60;

const LIVE_VERIFY_ETA_MINUTES = 60;

const MAX_LIVE_CALLS = 2;

// ============================================================
// NORMALIZER
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

// ============================================================
// STATION VALUE -> TEXT
// ============================================================

function stationToText(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object") {
    return [
      value.code,
      value.name,
      value.stationCode,
      value.stationName
    ]
      .filter(Boolean)
      .join(" ");
  }

  return String(value);
}

// ============================================================
// STATION CODE
// ============================================================

function getStationCode(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "object") {
    return String(
      value.code ||
      value.stationCode ||
      ""
    )
      .trim()
      .toUpperCase();
  }

  const text =
    String(value)
      .trim()
      .toUpperCase();

  if (
    /^[A-Z0-9]{2,6}$/.test(text)
  ) {
    return text;
  }

  const match =
    text.match(
      /\b[A-Z]{2,5}\b/
    );

  return match
    ? match[0]
    : "";
}

// ============================================================
// RAILRADAR SOURCE
// ============================================================

function getRailRadarSource(
  train,
  item
) {
  return (
    train?.source ||
    item?.train?.source ||
    item?.source ||
    ""
  );
}

// ============================================================
// RAILRADAR DESTINATION
// ============================================================

function getRailRadarDestination(
  train,
  item
) {
  return (
    train?.destination ||
    item?.train?.destination ||
    item?.destination ||
    ""
  );
}

// ============================================================
// SOURCE TEXT
// ============================================================

function getSourceText(
  train,
  item
) {
  return stationToText(
    getRailRadarSource(
      train,
      item
    )
  );
}

// ============================================================
// DESTINATION TEXT
// ============================================================

function getDestinationText(
  train,
  item
) {
  return stationToText(
    getRailRadarDestination(
      train,
      item
    )
  );
}

// ============================================================
// DESTINATION SIDE DEFINITIONS
// ============================================================
//
// IMPORTANT:
//
// We are no longer asking:
//
// "Did this train start in Chennai?"
//
// Instead we ask:
//
// "Where is the train going after passing Gudur?"
//
// If it is going toward Chennai/MAS,
// it approaches Gudur from the southern side.
//
// If it is going toward Tirupati/Renigunta/Bengaluru/Guntakal,
// it approaches Gudur from the northern side.
//
// ============================================================

const CHENNAI_SIDE_CODES = new Set([
  "MAS",
  "MS",
  "MSB",
  "TBM",
  "CGL",
  "AJJ",
  "PER",
  "AVD",
  "SPE",
  "NYP"
]);

const CHENNAI_SIDE_NAMES = [
  "CHENNAI",
  "MGR CHENNAI CENTRAL",
  "CHENNAI CENTRAL",
  "CHENNAI EGMORE",
  "TAMBARAM",
  "CHENGALPATTU",
  "PERAMBUR",
  "AVADI",
  "SULLURUPETA",
  "NAYUDUPETA"
];

const SOUTHERN_SIDE_CODES = new Set([
  "TPTY",
  "RU",
  "GTL",
  "DMM",
  "SMVB",
  "SBC",
  "BNC",
  "YPR",
  "KJM",
  "KPD",
  "CCT",
  "COA",
  "NS"
]);

const SOUTHERN_SIDE_NAMES = [
  "TIRUPATI",
  "TIRUPATI MAIN",
  "RENIGUNTA",
  "GUNTUR",
  "GUNTAKAL",
  "DHARMAVARAM",
  "SMVT BENGALURU",
  "SMVB",
  "SIR M VISVESVARAYA",
  "KSR BENGALURU",
  "BENGALURU",
  "BANGALORE",
  "KAKINADA",
  "KAKINADA TOWN",
  "SAMALKOT",
  "COA"
];

// ============================================================
// DESTINATION SIDE
// ============================================================

function getDestinationSide(
  destination
) {
  const text =
    normalizeText(
      destination
    );

  const code =
    getStationCode(
      destination
    );

  // ----------------------------------------------------------
  // CHENNAI / NORTH SIDE
  // ----------------------------------------------------------

  if (
    code &&
    CHENNAI_SIDE_CODES.has(code)
  ) {
    return "CHENNAI";
  }

  if (
    CHENNAI_SIDE_NAMES.some(
      (name) =>
        text.includes(
          normalizeText(name)
        )
    )
  ) {
    return "CHENNAI";
  }

  // ----------------------------------------------------------
  // TIRUPATI / SOUTH SIDE
  // ----------------------------------------------------------

  if (
    code &&
    SOUTHERN_SIDE_CODES.has(code)
  ) {
    return "SOUTH";
  }

  if (
    SOUTHERN_SIDE_NAMES.some(
      (name) =>
        text.includes(
          normalizeText(name)
        )
    )
  ) {
    return "SOUTH";
  }

  return null;
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  const fields = [
    train?.direction,
    train?.travelDirection,
    train?.routeDirection,
    train?.runningDirection,

    live?.direction,
    live?.travelDirection,
    live?.routeDirection,
    live?.runningDirection,

    stop?.direction,

    item?.direction,
    item?.travelDirection,
    item?.routeDirection,
    item?.runningDirection
  ];

  return fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION CHECK
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

  if (
    direction.includes(
      "TO GUDUR"
    ) ||
    direction.includes(
      "TOWARD GUDUR"
    ) ||
    direction.includes(
      "TOWARDS GUDUR"
    ) ||
    direction.includes(
      "APPROACHING GUDUR"
    )
  ) {
    return true;
  }

  if (
    direction.includes(
      "FROM GUDUR"
    ) ||
    direction.includes(
      "AWAY FROM GUDUR"
    ) ||
    direction.includes(
      "GUDUR OUTBOUND"
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
// IMPORTANT:
//
// The result is the GATE that corresponds to the side from
// which the train reaches Gudur.
//
// Destination toward Chennai:
//   train approaches from southern side
//   => TPTY gate
//
// Destination toward Tirupati/south:
//   train approaches from Chennai/northern side
//   => MAS gate
//
// ============================================================

function determineInboundCorridor(
  train,
  live,
  stop,
  item
) {
  const source =
    getRailRadarSource(
      train,
      item
    );

  const destination =
    getRailRadarDestination(
      train,
      item
    );

  const sourceText =
    stationToText(
      source
    );

  const destinationText =
    stationToText(
      destination
    );

  const explicit =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // Explicit outbound
  // ----------------------------------------------------------

  if (
    explicit === false
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // Destination-side method
  // ----------------------------------------------------------

  const destinationSide =
    getDestinationSide(
      destination
    );

  // ----------------------------------------------------------
  // Destination = Chennai
  //
  // Train is coming toward Gudur from the southern side.
  // Therefore Tirupati-side gate is the relevant gate.
  // ----------------------------------------------------------

  if (
    destinationSide ===
    "CHENNAI"
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Destination = southern side
  //
  // Train is coming toward Gudur from Chennai side.
  // Therefore Chennai-side gate is the relevant gate.
  // ----------------------------------------------------------

  if (
    destinationSide ===
    "SOUTH"
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Explicit "toward Gudur" but unknown destination
  //
  // Don't guess.
  // ----------------------------------------------------------

  if (
    explicit === true
  ) {
    console.log(
      `[DIRECTION UNKNOWN] ${train?.number || "?"} | ${sourceText || "UNKNOWN"} -> ${destinationText || "UNKNOWN"}`
    );

    return null;
  }

  // ----------------------------------------------------------
  // Unknown
  // ----------------------------------------------------------

  console.log(
    `[DIRECTION UNKNOWN] ${train?.number || "?"} | ${sourceText || "UNKNOWN"} -> ${destinationText || "UNKNOWN"}`
  );

  return null;
}

// ============================================================
// TIME PARSER
// ============================================================
//
// RailRadar timestamps are India time.
//
// Do NOT convert using new Date().getHours() because GitHub
// Actions normally runs in UTC.
//
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  const text =
    String(timeStr)
      .trim();

  const isoMatch =
    text.match(
      /T(\d{1,2}):(\d{2})(?::(\d{2}))?/
    );

  if (isoMatch) {
    return (
      parseInt(
        isoMatch[1],
        10
      ) *
        60 +
      parseInt(
        isoMatch[2],
        10
      ) +
      Number(
        delayMinutes || 0
      )
    );
  }

  const match =
    text.match(
      /(\d{1,2}):(\d{2})/
    );

  if (match) {
    return (
      parseInt(
        match[1],
        10
      ) *
        60 +
      parseInt(
        match[2],
        10
      ) +
      Number(
        delayMinutes || 0
      )
    );
  }

  return -1;
}

// ============================================================
// CURRENT INDIA TIME
// ============================================================

function getIndiaCurrentMinutes() {
  const parts =
    new Intl.DateTimeFormat(
      "en-IN",
      {
        timeZone:
          "Asia/Kolkata",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit"
      }
    )
      .formatToParts(
        new Date()
      );

  const hour =
    parseInt(
      parts.find(
        (p) =>
          p.type ===
          "hour"
      )?.value || "0",
      10
    );

  const minute =
    parseInt(
      parts.find(
        (p) =>
          p.type ===
          "minute"
      )?.value || "0",
      10
    );

  return (
    hour * 60 +
    minute
  );
}

// ============================================================
// INDIA DISPLAY TIME
// ============================================================

function getIndiaTimeString() {
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
// NUMBER
// ============================================================

function toNumber(value) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

// ============================================================
// DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

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
    Math.sin(
      dLat / 2
    ) ** 2 +
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
      Math.sin(
        dLon / 2
      ) ** 2;

  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(a)
    )
  );
}

// ============================================================
// LIVE COORDINATES
// ============================================================

function getLiveCoordinates(
  live
) {
  const latCandidates = [
    live?.latitude,
    live?.lat,
    live?.currentLatitude,
    live?.currentLocation?.latitude,
    live?.currentLocation?.lat,
    live?.currentLocation?.coordinates?.lat
  ];

  const lngCandidates = [
    live?.longitude,
    live?.lng,
    live?.lon,
    live?.currentLongitude,
    live?.currentLocation?.longitude,
    live?.currentLocation?.lng,
    live?.currentLocation?.lon,
    live?.currentLocation?.coordinates?.lng
  ];

  let lat = null;
  let lng = null;

  for (
    const value of latCandidates
  ) {
    const n =
      toNumber(value);

    if (
      n !== null &&
      Math.abs(n) <= 90
    ) {
      lat = n;
      break;
    }
  }

  for (
    const value of lngCandidates
  ) {
    const n =
      toNumber(value);

    if (
      n !== null &&
      Math.abs(n) <= 180
    ) {
      lng = n;
      break;
    }
  }

  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  return {
    lat,
    lng
  };
}

// ============================================================
// DISTANCE FROM GUDUR
// ============================================================

function getDistanceFromGudur(
  live
) {
  const coordinates =
    getLiveCoordinates(
      live
    );

  if (
    coordinates
  ) {
    return distanceKm(
      coordinates.lat,
      coordinates.lng,
      GDR_LAT,
      GDR_LNG
    );
  }

  const candidates = [
    live?.distanceFromGudurKm,
    live?.currentLocation
      ?.distanceFromGudurKm
  ];

  for (
    const value of candidates
  ) {
    const n =
      toNumber(value);

    if (
      n !== null &&
      n >= 0
    ) {
      return n;
    }
  }

  return null;
}

// ============================================================
// DEPARTED
// ============================================================

function isDepartedStatus(
  live
) {
  const status =
    normalizeText(
      live?.status ||
      live?.currentLocation
        ?.status ||
      ""
    );

  return (
    status.includes(
      "DEPARTED"
    ) ||
    status.includes(
      "PASSED"
    ) ||
    status.includes(
      "COMPLETED"
    ) ||
    status.includes(
      "CANCELLED"
    ) ||
    status.includes(
      "TERMINATED"
    )
  );
}

// ============================================================
// DELAY
// ============================================================

function getDelayMinutes(
  live,
  item
) {
  const values = [
    live?.delayMinutes,
    live?.delay,
    live?.currentLocation
      ?.delayMinutes,
    item?.live?.delayMinutes
  ];

  for (
    const value of values
  ) {
    const n =
      toNumber(value);

    if (
      n !== null
    ) {
      return n;
    }
  }

  return 0;
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
    stop?.scheduledArrival ||
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
    item?.arrival ||
    item?.arrivalTime ||
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
  item
) {
  return (
    stop?.departure ||
    stop?.scheduledDeparture ||
    live?.expectedDepartureTime ||
    live?.departureTime ||
    item?.departure ||
    item?.departureTime ||
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
    live?.platform ||
    stop?.platform ||
    item?.platform ||
    "1"
  );
}

// ============================================================
// LIVE TRAIN REQUEST
// ============================================================

async function getLiveTrainData(
  trainNo
) {
  try {
    const url =
      `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
        trainNo
      )}/live?authoritative=true&includeCoordinates=true`;

    console.log(
      `[LIVE] Checking train ${trainNo}...`
    );

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
          timeout:
            12000
        }
      );

    if (
      !response.data?.success
    ) {
      console.log(
        `[LIVE] ${trainNo} unsuccessful response`
      );

      return null;
    }

    return (
      response.data?.data ||
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
// APPLY LIVE DATA
// ============================================================

function applyLiveInformation(
  candidate,
  liveData
) {
  if (!liveData) {
    return candidate;
  }

  const currentLocation =
    liveData.currentLocation ||
    {};

  const coordinates =
    getLiveCoordinates(
      liveData
    );

  const distance =
    getDistanceFromGudur(
      liveData
    );

  const status =
    normalizeText(
      liveData.status ||
      currentLocation.status ||
      ""
    );

  const delay =
    toNumber(
      liveData.delayMinutes
    );

  if (
    delay !== null
  ) {
    candidate.delayMinutes =
      delay;
  }

  candidate.liveStatus =
    status;

  candidate.liveVerified =
    true;

  candidate.isActualPosition =
    Boolean(
      currentLocation
        .isActualPosition
    );

  candidate.positionSource =
    currentLocation
      .positionSource ||
    "";

  candidate.segmentProgress =
    currentLocation
      .segmentProgress ??
    null;

  candidate.speedKmh =
    currentLocation
      .speedKmh ??
    null;

  candidate.bearingDegrees =
    currentLocation
      .bearingDegrees ??
    null;

  if (
    coordinates
  ) {
    candidate.liveLatitude =
      coordinates.lat;

    candidate.liveLongitude =
      coordinates.lng;
  }

  if (
    distance !== null
  ) {
    candidate.distanceFromGudurKm =
      distance;
  }

  return candidate;
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  let apiRequests = 0;
  let liveVerifiedCount = 0;

  try {
    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY environment variable is missing."
      );
    }

    const currentIndiaTime =
      getIndiaTimeString();

    const currentMin =
      getIndiaCurrentMinutes();

    console.log(
      `\n[${currentIndiaTime}] Querying RailRadar Live Station Board for GDR...`
    );

    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardUrl =
      `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`;

    const boardRes =
      await axios.get(
        boardUrl,
        {
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

    apiRequests++;

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
        "❌ Invalid RailRadar train data."
      );

      console.error(
        JSON.stringify(
          responseBody,
          null,
          2
        )
      );

      return;
    }

    console.log(
      `✅ RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let masGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "NO INBOUND TRAIN",

      corridor:
        "MAS"
    };

    let tptyGate = {
      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        "NO INBOUND TRAIN",

      corridor:
        "TPTY"
    };

    const upcomingList = [];

    const liveCandidates = [];

    // ========================================================
    // PROCESS STATION BOARD
    // ========================================================

    for (
      const item of trainsArray
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
        String(
          train?.number ||
          item?.trainNumber ||
          ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train?.name ||
        item?.trainName ||
        `Express ${trainNo}`;

      const sourceText =
        getSourceText(
          train,
          item
        );

      const destinationText =
        getDestinationText(
          train,
          item
        );

      const delayMinutes =
        getDelayMinutes(
          live,
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
          item
        );

      const arrivalMin =
        parseTimeToMinutes(
          arrivalTime,
          delayMinutes
        );

      const departureMin =
        parseTimeToMinutes(
          departureTime,
          delayMinutes
        );

      if (
        arrivalMin === -1
      ) {
        continue;
      }

      const diff =
        calculateTimeDifference(
          arrivalMin,
          currentMin
        );

      // ------------------------------------------------------
      // TIME WINDOW
      // ------------------------------------------------------

      if (
        diff < -15 ||
        diff >
          UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      // ------------------------------------------------------
      // DEPARTED
      // ------------------------------------------------------

      if (
        isDepartedStatus(
          live
        )
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - RailRadar status: ${live.status || live.currentLocation?.status}`
        );

        continue;
      }

      // ------------------------------------------------------
      // CORRIDOR
      // ------------------------------------------------------

      const corridor =
        determineInboundCorridor(
          train,
          live,
          stop,
          item
        );

      if (!corridor) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} | ${sourceText || "UNKNOWN"} -> ${destinationText || "UNKNOWN"} | corridor not confirmed`
        );

        continue;
      }

      console.log(
        `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${sourceText || "UNKNOWN"} -> ${destinationText || "UNKNOWN"} | ETA ${Math.max(0, diff)}m`
      );

      // ------------------------------------------------------
      // UPCOMING ENTRY
      // ------------------------------------------------------

      const candidate = {
        trainNo,
        name:
          trainName,

        origin:
          sourceText ||
          "Unknown",

        destination:
          destinationText ||
          "Unknown",

        etaMinutes:
          Math.max(
            0,
            diff
          ),

        delayMinutes,

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

        liveVerified:
          false,

        distanceFromGudurKm:
          null,

        isActualPosition:
          false
      };

      upcomingList.push(
        candidate
      );

      // ------------------------------------------------------
      // LIVE CANDIDATE
      // ------------------------------------------------------

      if (
        diff >= 0 &&
        diff <=
          LIVE_VERIFY_ETA_MINUTES
      ) {
        liveCandidates.push(
          {
            trainNo,
            corridor,
            candidate
          }
        );
      }
    }

    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    liveCandidates.sort(
      (a, b) =>
        a.candidate
          .etaMinutes -
        b.candidate
          .etaMinutes
    );

    const selectedLiveCandidates =
      liveCandidates.slice(
        0,
        MAX_LIVE_CALLS
      );

    for (
      const selected of
        selectedLiveCandidates
    ) {
      const liveData =
        await getLiveTrainData(
          selected.trainNo
        );

      apiRequests++;

      if (!liveData) {
        continue;
      }

      liveVerifiedCount++;

      applyLiveInformation(
        selected.candidate,
        liveData
      );

      console.log(
        `[LIVE VERIFIED] ${selected.trainNo} | ${selected.corridor} | status=${selected.candidate.liveStatus || "unknown"} | distance=${selected.candidate.distanceFromGudurKm !== null ? selected.candidate.distanceFromGudurKm.toFixed(3) + " km" : "unknown"} | actual=${selected.candidate.isActualPosition}`
      );
    }

    // ========================================================
    // GATE CLOSURE
    // ========================================================
    //
    // DO NOT close simply because ETA <= 4 minutes.
    //
    // We use actual live position.
    //
    // ========================================================

    for (
      const entry of
        upcomingList
    ) {
      if (
        !entry.liveVerified
      ) {
        continue;
      }

      if (
        !entry.isActualPosition
      ) {
        continue;
      }

      const lat =
        toNumber(
          entry.liveLatitude
        );

      const lng =
        toNumber(
          entry.liveLongitude
        );

      if (
        lat === null ||
        lng === null
      ) {
        continue;
      }

      let distanceToGate =
        null;

      // ------------------------------------------------------
      // MAS GATE
      // ------------------------------------------------------

      if (
        entry.corridor ===
        "MAS"
      ) {
        distanceToGate =
          distanceKm(
            lat,
            lng,
            CHENNAI_GATE_LAT,
            CHENNAI_GATE_LNG
          );
      }

      // ------------------------------------------------------
      // TPTY GATE
      // ------------------------------------------------------

      if (
        entry.corridor ===
        "TPTY"
      ) {
        distanceToGate =
          distanceKm(
            lat,
            lng,
            TIRUPATI_GATE_LAT,
            TIRUPATI_GATE_LNG
          );
      }

      if (
        distanceToGate ===
          null ||
        distanceToGate >
          GATE_TRIGGER_DISTANCE_KM
      ) {
        continue;
      }

      // ------------------------------------------------------
      // CLOSE GATE
      // ------------------------------------------------------

      const waitMinutes =
        Math.max(
          1,
          Math.ceil(
            entry.etaMinutes
          ) + 2
        );

      const statusText =
        entry.delayMinutes > 0
          ? `${entry.delayMinutes}m late`
          : "On Time";

      const label =
        `${entry.trainNo} ${entry.name} (${statusText})`;

      const payload = {
        status:
          "CLOSED",

        waitMinutes,

        activeTrain:
          label,

        direction:
          "TOWARD GUDUR",

        corridor:
          entry.corridor,

        distanceFromGudurKm:
          Number(
            distanceToGate.toFixed(
              3
            )
          ),

        liveVerified:
          true,

        isActualPosition:
          true
      };

      if (
        entry.corridor ===
        "MAS"
      ) {
        masGate = {
          ...payload,
          etaMinutes:
            entry.etaMinutes
        };
      }

      if (
        entry.corridor ===
        "TPTY"
      ) {
        tptyGate = {
          ...payload,
          etaMinutes:
            entry.etaMinutes
        };
      }

      console.log(
        `[GATE CLOSE] ${entry.corridor} | ${entry.trainNo} ${entry.name} | ${distanceToGate.toFixed(3)} km from gate`
      );
    }

    // ========================================================
    // SORT UPCOMING
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ========================================================
    // MAX 5
    // ========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE
    // ========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        getIndiaTimeString(),

      apiRequests,

      liveVerified:
        liveVerifiedCount
    });

    // ========================================================
    // RESULT
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
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live verified: ${liveVerifiedCount}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    // ========================================================
    // UPCOMING
    // ========================================================

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform} | ${train.origin} -> ${train.destination}`
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
        "RailRadar response:",
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
  " Chennai Gate:  14.1396639 N, 79.8441306 E"
);

console.log(
  " Tirupati Gate: 14.1402056 N, 79.8436000 E"
);

console.log(
  "=========================================="
);

console.log(
  "Firebase: Configured"
);

console.log(
  "RailRadar: Configured"
);

console.log(
  "Direction: Both sides -> Gudur"
);

console.log(
  "Live verification window: 60 minutes"
);

console.log(
  "Maximum live calls per run: 2"
);

console.log(
  "Gate trigger distance: 0.60 km"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN
// ============================================================

updateGateSystem();

// ============================================================
// EVERY 3 MINUTES
// ============================================================

setInterval(
  updateGateSystem,
  180000
);
