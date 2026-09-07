const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// GUDUR CROSSING RADAR V9
// ============================================================
//
// V9 changes:
// - Live GPS candidates are refreshed every workflow run.
// - No 20-minute live-GPS throttle.
// - Tirupati gate logic preserved.
// - Chennai/MAS gate uses the same physical GPS logic.
// - Gate closure is based ONLY on verified physical position.
// - WARNING: 1.00 km
// - CLOSED: 0.60 km
//
// IMPORTANT:
// GitHub Action should run approximately every 5 minutes.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

try {
  serviceAccount = require("./serviceAccountKey.json");
} catch (error) {
  console.error("❌ Could not load serviceAccountKey.json");
  console.error(
    "Make sure serviceAccountKey.json is in the same folder as code.js"
  );
  console.error(error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: cert(serviceAccount),
    databaseURL:
      "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
  });
}

const db = getDatabase();
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
// GUDUR LOCATION
// ============================================================

const GUDUR = {
  lat: 14.1451694,
  lng: 79.8443472
};


// ============================================================
// CROSSING GATE LOCATIONS
// ============================================================

const CHENNAI_GATE = {
  lat: 14.1396667,
  lng: 79.8441278
};

const TIRUPATI_GATE = {
  lat: 14.1402028,
  lng: 79.8435972
};


// ============================================================
// DISTANCE SETTINGS
// ============================================================

const APPROACHING_GUDUR_DISTANCE_KM = 1.00;

const GATE_WARNING_DISTANCE_KM = 1.00;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;


// ============================================================
// REQUEST SETTINGS
// ============================================================

// Maximum number of LIVE GPS requests per workflow run.

const MAX_LIVE_REQUESTS = 8;


// ============================================================
// APPROVED TIRUPATI CORRIDOR TRAINS
// ============================================================

const TIRUPATI_TRAINS = new Set([
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


// ============================================================
// APPROVED CHENNAI / MAS CORRIDOR TRAINS
// ============================================================

const CHENNAI_TRAINS = new Set([
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


// ============================================================
// OTHER APPROVED TRAINS
// ============================================================

const OTHER_TRAINS = new Set([
  "12743",
  "12744",
  "20498",
  "67226"
]);


// ============================================================
// ALL APPROVED TRAINS
// ============================================================

const APPROVED_TRAINS = new Set([
  ...TIRUPATI_TRAINS,
  ...CHENNAI_TRAINS,
  ...OTHER_TRAINS
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
// NUMBER NORMALIZER
// ============================================================

function normalizeTrainNumber(value) {
  return String(value || "")
    .trim()
    .replace(/\D/g, "");
}


// ============================================================
// DISTANCE CALCULATION
// ============================================================

function calculateDistanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) / 180;

  const dLon =
    ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
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
// SAFE NUMBER
// ============================================================

function safeNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// EXTRACT COORDINATES
// ============================================================

function getCoordinates(
  train,
  live,
  stop,
  item
) {
  const possibleCoordinates = [
    live?.currentLocation?.coordinates,
    live?.currentLocation,
    live?.coordinates,
    live?.position,

    train?.currentLocation?.coordinates,
    train?.currentLocation,
    train?.coordinates,
    train?.position,

    item?.currentLocation?.coordinates,
    item?.currentLocation,
    item?.coordinates,
    item?.position
  ];

  for (const value of possibleCoordinates) {
    if (!value) {
      continue;
    }

    // ----------------------------------------------------------
    // Object form
    // ----------------------------------------------------------

    if (
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const lat =
        safeNumber(
          value.lat ??
          value.latitude
        );

      const lng =
        safeNumber(
          value.lng ??
          value.lon ??
          value.longitude
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

      // GeoJSON
      if (
        Array.isArray(value.coordinates) &&
        value.coordinates.length >= 2
      ) {
        const lng =
          safeNumber(
            value.coordinates[0]
          );

        const lat =
          safeNumber(
            value.coordinates[1]
          );

        if (
          lat !== null &&
          lng !== null
        ) {
          return {
            lat,
            lng
          };
        }
      }
    }


    // ----------------------------------------------------------
    // Array form
    // ----------------------------------------------------------

    if (
      Array.isArray(value) &&
      value.length >= 2
    ) {
      const first =
        safeNumber(value[0]);

      const second =
        safeNumber(value[1]);

      if (
        first !== null &&
        second !== null
      ) {
        // RailRadar/GeoJSON usually uses [lng, lat]
        if (
          Math.abs(first) <= 180 &&
          Math.abs(second) <= 90
        ) {
          return {
            lat: second,
            lng: first
          };
        }
      }
    }
  }

  return null;
}


// ============================================================
// STATION CODE / NAME
// ============================================================

function getStationText(
  train,
  live,
  stop,
  item
) {
  const values = [
    live?.station,
    live?.stationCode,
    live?.currentStation,
    live?.currentStationCode,

    train?.station,
    train?.stationCode,
    train?.currentStation,
    train?.currentStationCode,

    stop?.station,
    stop?.stationCode,

    item?.station,
    item?.stationCode
  ];

  return values
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}


// ============================================================
// CHECK IF TRAIN IS AT GUDUR
// ============================================================

function isAtGudur(
  train,
  live,
  stop,
  item,
  coordinates
) {
  const stationText =
    getStationText(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // Explicit GDR station
  // ----------------------------------------------------------

  if (
    stationText.includes("GDR") ||
    stationText.includes("GUDUR")
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Physical distance fallback
  // ----------------------------------------------------------

  if (coordinates) {
    const distance =
      calculateDistanceKm(
        coordinates.lat,
        coordinates.lng,
        GUDUR.lat,
        GUDUR.lng
      );

    if (
      distance <=
      0.20
    ) {
      return true;
    }
  }

  return false;
}


// ============================================================
// GET DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  return (
    train?.destination ||
    train?.to ||
    train?.destinationStation ||
    train?.endStation ||

    item?.destination ||
    item?.to ||
    item?.destinationStation ||

    ""
  );
}


// ============================================================
// GET ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    train?.origin ||
    train?.source ||
    train?.from ||
    train?.fromStation ||
    train?.startStation ||
    train?.start ||

    item?.origin ||
    item?.source ||
    item?.from ||
    item?.fromStation ||
    item?.startStation ||

    ""
  );
}


// ============================================================
// CORRIDOR DETERMINATION
// ============================================================
//
// TPTY = Tirupati side
// MAS  = Chennai side
// OTHER = approved but no automatic gate assignment
//
// IMPORTANT:
// Train number remains the primary corridor identifier.
// This preserves the previously working 12733 behavior.
//
// ============================================================

function determineCorridor(
  trainNo
) {
  if (
    TIRUPATI_TRAINS.has(trainNo)
  ) {
    return "TPTY";
  }

  if (
    CHENNAI_TRAINS.has(trainNo)
  ) {
    return "MAS";
  }

  if (
    OTHER_TRAINS.has(trainNo)
  ) {
    return "OTHER";
  }

  return null;
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

  const date =
    new Date(timeStr);

  if (
    !isNaN(date.getTime())
  ) {
    totalMinutes =
      date.getHours() * 60 +
      date.getMinutes();
  } else {
    const match =
      String(timeStr)
        .trim()
        .match(
          /(\d{1,2}):(\d{2})/
        );

    if (match) {
      totalMinutes =
        parseInt(
          match[1],
          10
        ) *
          60 +
        parseInt(
          match[2],
          10
        );
    }
  }

  if (
    totalMinutes === -1
  ) {
    return -1;
  }

  return (
    totalMinutes +
    Number(
      delayMinutes || 0
    )
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

  // Midnight crossing
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
// LIVE API RESPONSE EXTRACTION
// ============================================================

function extractLiveData(
  response
) {
  if (!response) {
    return null;
  }

  return (
    response?.data?.train ||
    response?.data ||
    response?.train ||
    response ||
    null
  );
}


// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  try {
    console.log(
      `[LIVE REQUEST] ${trainNo}`
    );

    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${trainNo}/live`,
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

    const liveData =
      extractLiveData(
        response.data
      );

    return liveData;

  } catch (error) {
    if (
      error.response
    ) {
      console.error(
        `[LIVE ERROR] ${trainNo} | HTTP ${error.response.status}`
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
        `[LIVE ERROR] ${trainNo} | ${error.message}`
      );
    }

    return null;
  }
}


// ============================================================
// GET GATE FOR CORRIDOR
// ============================================================

function getGateForCorridor(
  corridor
) {
  if (
    corridor === "MAS"
  ) {
    return CHENNAI_GATE;
  }

  if (
    corridor === "TPTY"
  ) {
    return TIRUPATI_GATE;
  }

  return null;
}


// ============================================================
// CALCULATE GATE DISTANCE
// ============================================================

function getDistanceToGate(
  coordinates,
  corridor
) {
  if (
    !coordinates
  ) {
    return null;
  }

  const gate =
    getGateForCorridor(
      corridor
    );

  if (!gate) {
    return null;
  }

  return calculateDistanceKm(
    coordinates.lat,
    coordinates.lng,
    gate.lat,
    gate.lng
  );
}


// ============================================================
// GET LIVE ARRIVAL TIME
// ============================================================

function getLiveArrivalTime(
  live
) {
  return (
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
    live?.eta ||
    live?.estimatedArrival ||
    ""
  );
}


// ============================================================
// GET BOARD ARRIVAL TIME
// ============================================================

function getBoardArrivalTime(
  stop,
  live
) {
  return (
    stop?.arrival ||
    live?.expectedArrivalTime ||
    ""
  );
}


// ============================================================
// GET LIVE SPEED
// ============================================================

function getSpeedKmph(
  live
) {
  const possible =
    [
      live?.speed,
      live?.speedKmph,
      live?.currentSpeed,
      live?.speedKmH
    ];

  for (
    const value of possible
  ) {
    const n =
      safeNumber(value);

    if (
      n !== null &&
      n > 0
    ) {
      return n;
    }
  }

  return null;
}


// ============================================================
// ETA FROM GPS
// ============================================================
//
// This is only a fallback display ETA.
// Gate closure NEVER depends on ETA.
//
// ============================================================

function calculatePhysicalEtaMinutes(
  distanceKm,
  speedKmph
) {
  if (
    distanceKm === null ||
    speedKmph === null ||
    speedKmph <= 0
  ) {
    return null;
  }

  const hours =
    distanceKm /
    speedKmph;

  return Math.max(
    0,
    Math.round(
      hours * 60
    )
  );
}


// ============================================================
// GET VERIFIED ETA
// ============================================================

function getVerifiedEta(
  train,
  live,
  stop,
  item,
  coordinates,
  atGudur,
  departedGudur,
  currentMin
) {
  // At Gudur = 0
  if (
    atGudur
  ) {
    return 0;
  }

  // Already departed Gudur
  if (
    departedGudur
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // Live expected arrival
  // ----------------------------------------------------------

  const liveArrival =
    getLiveArrivalTime(
      live
    );

  if (
    liveArrival
  ) {
    const minutes =
      parseTimeToMinutes(
        liveArrival,
        Number(
          live?.delayMinutes || 0
        )
      );

    if (
      minutes !== -1
    ) {
      return Math.max(
        0,
        calculateTimeDifference(
          minutes,
          currentMin
        )
      );
    }
  }

  // ----------------------------------------------------------
  // Board expected arrival
  // ----------------------------------------------------------

  const boardArrival =
    getBoardArrivalTime(
      stop,
      live
    );

  if (
    boardArrival
  ) {
    const minutes =
      parseTimeToMinutes(
        boardArrival,
        Number(
          live?.delayMinutes || 0
        )
      );

    if (
      minutes !== -1
    ) {
      return Math.max(
        0,
        calculateTimeDifference(
          minutes,
          currentMin
        )
      );
    }
  }

  // ----------------------------------------------------------
  // Physical GPS ETA fallback
  // ----------------------------------------------------------

  const speed =
    getSpeedKmph(
      live
    );

  if (
    coordinates &&
    speed
  ) {
    const distance =
      calculateDistanceKm(
        coordinates.lat,
        coordinates.lng,
        GUDUR.lat,
        GUDUR.lng
      );

    return calculatePhysicalEtaMinutes(
      distance,
      speed
    );
  }

  return null;
}


// ============================================================
// GATE STATE
// ============================================================

function calculateGateState(
  gateDistanceKm,
  atGudur
) {
  // ----------------------------------------------------------
  // No physical position
  // ----------------------------------------------------------

  if (
    gateDistanceKm === null
  ) {
    return {
      warning: false,
      closed: false
    };
  }

  // ----------------------------------------------------------
  // At Gudur
  // ----------------------------------------------------------

  if (
    atGudur
  ) {
    return {
      warning: false,
      closed: false
    };
  }

  // ----------------------------------------------------------
  // WARNING
  // ----------------------------------------------------------

  const warning =
    gateDistanceKm <=
      GATE_WARNING_DISTANCE_KM &&
    gateDistanceKm >
      GATE_CLOSE_DISTANCE_KM;

  // ----------------------------------------------------------
  // CLOSED
  // ----------------------------------------------------------

  const closed =
    gateDistanceKm <=
    GATE_CLOSE_DISTANCE_KM;

  return {
    warning,
    closed
  };
}


// ============================================================
// GATE PAYLOAD
// ============================================================

function createOpenGate() {
  return {
    status: "OPEN",

    waitMinutes: 0,

    activeTrain:
      "Tracks clear",

    direction:
      "CLEAR",

    corridor:
      "",

    gateDistanceKm:
      null,

    warningDistanceKm:
      GATE_WARNING_DISTANCE_KM,

    closeDistanceKm:
      GATE_CLOSE_DISTANCE_KM
  };
}


// ============================================================
// UPDATE GATE FROM TRAIN
// ============================================================

function applyTrainToGate(
  gateState,
  train
) {
  if (
    train.corridor !== "MAS" &&
    train.corridor !== "TPTY"
  ) {
    return;
  }

  // ----------------------------------------------------------
  // CLOSED
  // ----------------------------------------------------------

  if (
    train.gateClosed
  ) {
    const waitMinutes =
      Math.max(
        1,
        Number(
          train.etaMinutes ?? 2
        ) + 2
      );

    const payload = {
      status:
        "CLOSED",

      waitMinutes,

      activeTrain:
        `${train.trainNo} ${train.name}`,

      direction:
        "TOWARD GUDUR",

      corridor:
        train.corridor,

      trainNo:
        train.trainNo,

      gateDistanceKm:
        Number(
          train.gateDistanceKm.toFixed(
            3
          )
        ),

      warningDistanceKm:
        GATE_WARNING_DISTANCE_KM,

      closeDistanceKm:
        GATE_CLOSE_DISTANCE_KM
    };

    gateState.payload =
      payload;

    return;
  }

  // ----------------------------------------------------------
  // WARNING
  // ----------------------------------------------------------

  if (
    train.gateWarning &&
    !gateState.payload
  ) {
    const payload = {
      status:
        "WARNING",

      waitMinutes:
        Math.max(
          1,
          Number(
            train.etaMinutes ?? 1
          ) + 1
        ),

      activeTrain:
        `${train.trainNo} ${train.name}`,

      direction:
        "TOWARD GUDUR",

      corridor:
        train.corridor,

      trainNo:
        train.trainNo,

      gateDistanceKm:
        Number(
          train.gateDistanceKm.toFixed(
            3
          )
        ),

      warningDistanceKm:
        GATE_WARNING_DISTANCE_KM,

      closeDistanceKm:
        GATE_CLOSE_DISTANCE_KM
    };

    gateState.payload =
      payload;
  }
}


// ============================================================
// DEDUPLICATE BOARD
// ============================================================

function deduplicateBoard(
  candidates
) {
  const map =
    new Map();

  function priority(
    item
  ) {
    const status =
      String(
        item.status || ""
      ).toUpperCase();

    if (
      status.includes(
        "AT STATION"
      )
    ) {
      return 5;
    }

    if (
      status.includes(
        "UPCOMING"
      )
    ) {
      return 4;
    }

    if (
      status.includes(
        "SCHEDULED"
      )
    ) {
      return 3;
    }

    if (
      status.includes(
        "DEPARTED"
      )
    ) {
      return 1;
    }

    return 2;
  }

  for (
    const item of candidates
  ) {
    const trainNo =
      normalizeTrainNumber(
        item?.train?.number
      );

    if (!trainNo) {
      continue;
    }

    const existing =
      map.get(trainNo);

    if (
      !existing ||
      priority(item) >
        priority(existing)
    ) {
      map.set(
        trainNo,
        item
      );
    }
  }

  return Array.from(
    map.values()
  );
}


// ============================================================
// MAIN UPDATE FUNCTION
// ============================================================

async function updateGateSystem() {
  try {
    const now =
      new Date();

    const currentMin =
      now.getHours() *
        60 +
      now.getMinutes();

    console.log(
      "\n=================================================="
    );

    console.log(
      "          GUDUR CROSSING RADAR V9"
    );

    console.log(
      "=================================================="
    );

    console.log(
      "STRICT TRAIN NUMBERS: ENABLED"
    );

    console.log(
      "Unknown trains: IGNORED"
    );

    console.log(
      "Duplicate train numbers: REMOVED"
    );

    console.log(
      "Far-away ETA: ALLOWED"
    );

    console.log(
      "1.00 km WARNING: ENABLED"
    );

    console.log(
      "0.60 km GATE CLOSE: ENABLED"
    );

    console.log(
      "Gate closure: LIVE PHYSICAL POSITION"
    );

    console.log(
      "departedGudur is NOT required for gate closure"
    );

    console.log(
      "LIVE GPS: REFRESH EVERY WORKFLOW RUN"
    );

    console.log(
      "=================================================="
    );

    console.log(
      `\n[${now.toLocaleString()}]`
    );

    // ----------------------------------------------------------
    // FETCH STATION BOARD
    // ----------------------------------------------------------

    console.log(
      "\n📡 Fetching RailRadar GDR station board..."
    );

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4`,
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
        "❌ RailRadar returned invalid train data."
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
      `✅ Raw board trains: ${trainsArray.length}`
    );


    // ==========================================================
    // FILTER APPROVED TRAINS
    // ==========================================================

    const approvedCandidates =
      [];

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const trainNo =
        normalizeTrainNumber(
          train.number
        );

      if (!trainNo) {
        continue;
      }

      const corridor =
        determineCorridor(
          trainNo
        );

      if (!corridor) {
        console.log(
          `[IGNORED UNKNOWN TRAIN] ${trainNo} ${train.name || ""}`
        );

        continue;
      }

      approvedCandidates.push(
        item
      );
    }


    // ==========================================================
    // DEDUPLICATE
    // ==========================================================

    const uniqueCandidates =
      deduplicateBoard(
        approvedCandidates
      );

    console.log(
      `\n✅ Approved unique trains: ${uniqueCandidates.length}`
    );


    // ==========================================================
    // INITIAL GATES
    // ==========================================================

    const masGateState = {
      payload:
        null
    };

    const tptyGateState = {
      payload:
        null
    };


    // ==========================================================
    // UPCOMING TRAIN LIST
    // ==========================================================

    const upcomingList =
      [];


    // ==========================================================
    // LIVE GPS REQUEST COUNTER
    // ==========================================================

    let liveRequests =
      0;


    console.log(
      "\n🔴 LIVE GPS VERIFICATION: ENABLED"
    );

    console.log(
      "📍 Live candidates without embedded GPS will be refreshed now."
    );


    // ==========================================================
    // PROCESS EACH APPROVED TRAIN
    // ==========================================================

    for (
      const item of uniqueCandidates
    ) {
      const train =
        item?.train || {};

      const boardLive =
        item?.live || {};

      const stop =
        item?.stop || {};

      const trainNo =
        normalizeTrainNumber(
          train.number
        );

      const name =
        train.name ||
        `Express ${trainNo}`;

      const corridor =
        determineCorridor(
          trainNo
        );

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

      const delayMinutes =
        Number(
          boardLive?.delayMinutes ||
          0
        );


      // --------------------------------------------------------
      // GET EMBEDDED GPS FIRST
      // --------------------------------------------------------

      let liveData =
        boardLive;

      let coordinates =
        getCoordinates(
          train,
          liveData,
          stop,
          item
        );


      // --------------------------------------------------------
      // REFRESH LIVE GPS EVERY WORKFLOW RUN
      // --------------------------------------------------------

      //
      // IMPORTANT:
      // Previously live GPS could be skipped for 20 minutes.
      //
      // V9 refreshes the live candidate now.
      //
      // This is the main MAS fix.
      //

      if (
        !coordinates &&
        liveRequests <
          MAX_LIVE_REQUESTS
      ) {
        liveRequests++;

        const freshLive =
          await fetchLiveTrain(
            trainNo
          );

        if (
          freshLive
        ) {
          liveData =
            freshLive;

          coordinates =
            getCoordinates(
              train,
              liveData,
              stop,
              item
            );
        }

        if (
          coordinates
        ) {
          const station =
            getStationText(
              train,
              liveData,
              stop,
              item
            ) ||
            "UNKNOWN";

          const stationDistance =
            calculateDistanceKm(
              coordinates.lat,
              coordinates.lng,
              GUDUR.lat,
              GUDUR.lng
            );

          const atGDR =
            isAtGudur(
              train,
              liveData,
              stop,
              item,
              coordinates
            );

          console.log(
            `[LIVE RESULT] ${trainNo} | station=${station} | distance=${stationDistance.toFixed(3)} km | atGDR=${atGDR}`
          );
        } else {
          console.log(
            `[LIVE RESULT] ${trainNo} | GPS unavailable`
          );
        }
      }


      // --------------------------------------------------------
      // CHECK GUDUR
      // --------------------------------------------------------

      const trainIsAtGudur =
        isAtGudur(
          train,
          liveData,
          stop,
          item,
          coordinates
        );


      // --------------------------------------------------------
      // DISTANCE TO GATE
      // --------------------------------------------------------

      const gateDistanceKm =
        getDistanceToGate(
          coordinates,
          corridor
        );


      // --------------------------------------------------------
      // PHYSICAL GPS AVAILABLE?
      // --------------------------------------------------------

      const hasPhysicalPosition =
        coordinates !== null;


      // --------------------------------------------------------
      // DEPARTED GUDUR
      // --------------------------------------------------------
      //
      // This is informational only.
      // It is NOT required for gate closure.
      //
      // --------------------------------------------------------

      let departedGudur =
        false;

      const stationText =
        getStationText(
          train,
          liveData,
          stop,
          item
        );

      if (
        stationText.includes(
          "DEPARTED"
        ) &&
        stationText.includes(
          "GUDUR"
        )
      ) {
        departedGudur =
          true;
      }


      // --------------------------------------------------------
      // GATE STATE
      // --------------------------------------------------------

      const gateState =
        calculateGateState(
          gateDistanceKm,
          trainIsAtGudur
        );


      // --------------------------------------------------------
      // ETA
      // --------------------------------------------------------

      const etaMinutes =
        getVerifiedEta(
          train,
          liveData,
          stop,
          item,
          coordinates,
          trainIsAtGudur,
          departedGudur,
          currentMin
        );


      // --------------------------------------------------------
      // ADD TRAIN TO QUEUE
      // --------------------------------------------------------

      const trainRecord = {
        trainNo,

        name,

        origin:
          origin ||
          "Southern side",

        destination:
          destination ||
          "Gudur",

        etaMinutes:
          etaMinutes === null
            ? null
            : Math.max(
                0,
                etaMinutes
              ),

        delayMinutes,

        corridor,

        direction:
          "TOWARD GUDUR",

        platform:
          String(
            liveData?.platform ||
            "1"
          ),

        gateDistanceKm:
          gateDistanceKm === null
            ? null
            : Number(
                gateDistanceKm.toFixed(
                  3
                )
              ),

        gateWarning:
          gateState.warning,

        gateClosed:
          gateState.closed,

        atGDR:
          trainIsAtGudur,

        departedGudur,

        hasPhysicalPosition
      };


      // --------------------------------------------------------
      // LOG TRAIN
      // --------------------------------------------------------

      console.log(
        `\n[TRAIN] ${trainNo} | ${name} | ${corridor} | ETA=${
          etaMinutes === null
            ? "--"
            : `${etaMinutes}m`
        } | gateDistance=${
          gateDistanceKm === null
            ? "--"
            : `${gateDistanceKm.toFixed(3)}km`
        } | warning=${
          gateState.warning
        } | closed=${
          gateState.closed
        } | atGDR=${
          trainIsAtGudur
        } | departed=${
          departedGudur
        }`
      );


      // --------------------------------------------------------
      // ADD TO QUEUE
      // --------------------------------------------------------

      upcomingList.push(
        trainRecord
      );


      // --------------------------------------------------------
      // APPLY TO GATE
      // --------------------------------------------------------

      if (
        corridor === "MAS"
      ) {
        applyTrainToGate(
          masGateState,
          trainRecord
        );
      }

      if (
        corridor === "TPTY"
      ) {
        applyTrainToGate(
          tptyGateState,
          trainRecord
        );
      }
    }


    // ==========================================================
    // SORT QUEUE
    // ==========================================================

    upcomingList.sort(
      (a, b) => {
        const aEta =
          a.etaMinutes === null
            ? 999999
            : a.etaMinutes;

        const bEta =
          b.etaMinutes === null
            ? 999999
            : b.etaMinutes;

        return (
          aEta -
          bEta
        );
      }
    );


    // ==========================================================
    // MAX 5 TRAINS
    // ==========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );


    // ==========================================================
    // FINAL GATE OBJECTS
    // ==========================================================

    const masGate =
      masGateState.payload ||
      createOpenGate();

    const tptyGate =
      tptyGateState.payload ||
      createOpenGate();


    // ==========================================================
    // FIREBASE UPDATE
    // ==========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      meta: {
        version:
          "V9",

        liveGps:
          true,

        liveGpsEveryRun:
          true,

        strictTrainNumbers:
          true,

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClosure:
          "LIVE_PHYSICAL_POSITION"
      }
    });


    // ==========================================================
    // SUCCESS
    // ==========================================================

    console.log(
      "\n================ SYNC SUCCESS ================"
    );

    console.log(
      `Chennai Gate : ${masGate.status} | ${masGate.activeTrain}`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status} | ${tptyGate.activeTrain}`
    );

    console.log(
      `Raw trains   : ${trainsArray.length}`
    );

    console.log(
      `Approved     : ${uniqueCandidates.length}`
    );

    console.log(
      `Live requests: ${liveRequests}`
    );

    console.log(
      `Final queue  : ${topUpcoming.length}`
    );


    // ==========================================================
    // FINAL TRAIN LIST
    // ==========================================================

    console.log(
      "\n[FINAL FIREBASE TRAINS]"
    );

    if (
      topUpcoming.length === 0
    ) {
      console.log(
        "None"
      );
    } else {
      topUpcoming.forEach(
        (train) => {
          console.log(
            `${train.trainNo} | ${train.name} | ${train.corridor} | ETA=${
              train.etaMinutes === null
                ? "--"
                : `${train.etaMinutes}m`
            } | gate=${
              train.gateDistanceKm === null
                ? "--"
                : `${train.gateDistanceKm}km`
            } | warning=${
              train.gateWarning
            } | closed=${
              train.gateClosed
            }`
          );
        }
      );
    }


    console.log(
      "\n================================================"
    );

    console.log(
      "✅ Monitor finished successfully."
    );

    console.log(
      "================================================"
    );

  } catch (error) {
    console.error(
      "\n❌ MONITOR ERROR"
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
  }
}


// ============================================================
// START
// ============================================================

console.log(
  "=================================================="
);

console.log(
  "       GUDUR CROSSING RADAR V9 ACTIVE"
);

console.log(
  "=================================================="
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
  `Warning distance: ${GATE_WARNING_DISTANCE_KM} km`
);

console.log(
  `Close distance: ${GATE_CLOSE_DISTANCE_KM} km`
);

console.log(
  `Maximum live GPS requests/run: ${MAX_LIVE_REQUESTS}`
);

console.log(
  "LIVE GPS: REFRESH EVERY WORKFLOW RUN"
);

console.log(
  "Direction: SOUTHERN SIDE -> GUDUR ONLY"
);

console.log(
  "=================================================="
);


// ============================================================
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();
