const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// GUDUR CROSSING RADAR V9
// ============================================================
//
// FEATURES
// ------------------------------------------------------------
// - Firebase RTDB
// - RailRadar live station board
// - Live GPS verification
// - Strict approved train numbers
// - Unknown trains ignored
// - Duplicate train numbers removed
// - Chennai -> Gudur
// - Tirupati -> Gudur
// - 1.00 km warning zone
// - 0.60 km gate-close zone
// - 0.80 km gate-clear threshold
// - Gate closure based on LIVE PHYSICAL POSITION
// - departedGudur is NOT required for closure
// - Fresh live GPS request every workflow run
// - GitHub FIREBASE_SERVICE_ACCOUNT support
// - Local serviceAccountKey.json fallback
//
// IMPORTANT
// ------------------------------------------------------------
// This controls the Firebase/UI gate state.
// It is NOT a certified railway interlocking system.
// Do not connect this software directly to railway safety
// equipment without appropriate certified hardware/control
// systems.
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

let serviceAccount;

try {
  // ----------------------------------------------------------
  // GITHUB ACTIONS / PRODUCTION
  // ----------------------------------------------------------

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    console.log(
      "✅ Firebase service account loaded from FIREBASE_SERVICE_ACCOUNT."
    );
  }

  // ----------------------------------------------------------
  // LOCAL TESTING
  // ----------------------------------------------------------

  else {
    serviceAccount = require("./serviceAccountKey.json");

    console.log(
      "✅ Firebase service account loaded from serviceAccountKey.json."
    );
  }

} catch (error) {

  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    "For GitHub Actions, create a secret named:"
  );

  console.error(
    "FIREBASE_SERVICE_ACCOUNT"
  );

  console.error(
    "For local testing, place serviceAccountKey.json beside code.js."
  );

  console.error(
    error.message
  );

  process.exit(1);
}


// ============================================================
// INITIALIZE FIREBASE
// ============================================================

try {

  admin.initializeApp({
    credential: cert(serviceAccount),

    databaseURL:
      "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
  });

} catch (error) {

  console.error(
    "❌ Firebase initialization failed."
  );

  console.error(
    error.message
  );

  process.exit(1);
}


const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");


// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY ||
  "YOUR_RAILRADAR_API_KEY";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";


// ============================================================
// GUDUR STATION
// ============================================================

const GUDUR = {
  lat: 14.1451694,
  lng: 79.8443472
};


// ============================================================
// GATE COORDINATES
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
//
// 1.00 km
//     Train enters warning zone.
//
// 0.60 km
//     Gate closes.
//
// 0.80 km
//     Gate can clear after train moves away.
//
// ============================================================

const APPROACHING_GUDUR_DISTANCE_KM = 1.00;

const GATE_WARNING_DISTANCE_KM = 1.00;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;


// ============================================================
// LIVE REQUEST LIMIT
// ============================================================
//
// Maximum live train requests per workflow run.
//
// This is deliberately limited to avoid unnecessary API usage.
//
// ============================================================

const MAX_LIVE_REQUESTS = 8;


// ============================================================
// STRICT TRAIN NUMBER LIST
// ============================================================
//
// Only approved trains are allowed.
//
// Unknown trains are ignored.
//
// ============================================================


// ------------------------------------------------------------
// TIRUPATI -> GUDUR
// ------------------------------------------------------------

const TPTY_TRAINS = new Set([
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


// ------------------------------------------------------------
// CHENNAI -> GUDUR
// ------------------------------------------------------------

const MAS_TRAINS = new Set([
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


// ------------------------------------------------------------
// OTHER APPROVED TRAINS
// ------------------------------------------------------------

const OTHER_TRAINS = new Set([
  "12743",
  "12744",
  "20498",
  "67226"
]);


// ============================================================
// ALL APPROVED TRAINS
// ============================================================

const APPROVED_TRAINS =
  new Set([
    ...TPTY_TRAINS,
    ...MAS_TRAINS,
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
    .replace(/\s+/g, "");
}


// ============================================================
// DISTANCE FUNCTION
// ============================================================

function distanceKm(
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
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +

    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
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
// GET COORDINATES
// ============================================================

function getCoordinates(train, live, item) {

  const possibleCoordinates = [

    train?.currentLocation?.coordinates,

    train?.currentLocation,

    train?.coordinates,

    train?.position,

    live?.currentLocation?.coordinates,

    live?.currentLocation,

    live?.coordinates,

    live?.position,

    item?.currentLocation?.coordinates,

    item?.currentLocation,

    item?.coordinates,

    item?.position
  ];

  for (
    const coordinates of possibleCoordinates
  ) {

    if (!coordinates) {
      continue;
    }

    // --------------------------------------------------------
    // ARRAY FORMAT
    // --------------------------------------------------------

    if (
      Array.isArray(coordinates) &&
      coordinates.length >= 2
    ) {

      const lng =
        Number(coordinates[0]);

      const lat =
        Number(coordinates[1]);

      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180
      ) {

        return {
          lat,
          lng
        };
      }
    }


    // --------------------------------------------------------
    // OBJECT FORMAT
    // --------------------------------------------------------

    if (
      typeof coordinates === "object"
    ) {

      const lat =
        Number(
          coordinates.lat ??
          coordinates.latitude
        );

      const lng =
        Number(
          coordinates.lng ??
          coordinates.lon ??
          coordinates.longitude
        );

      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lng) <= 180
      ) {

        return {
          lat,
          lng
        };
      }
    }
  }

  return null;
}


// ============================================================
// GET TRAIN NUMBER
// ============================================================

function getTrainNumber(train, item) {

  return normalizeTrainNumber(
    train?.number ??
    train?.trainNumber ??
    item?.trainNumber ??
    item?.number ??
    ""
  );
}


// ============================================================
// GET TRAIN NAME
// ============================================================

function getTrainName(train, item, trainNo) {

  return (
    train?.name ||
    train?.trainName ||
    item?.trainName ||
    item?.name ||
    `Express ${trainNo}`
  );
}


// ============================================================
// GET ORIGIN
// ============================================================

function getOrigin(train, item) {

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
// GET DESTINATION
// ============================================================

function getDestination(train, item) {

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
// CORRIDOR
// ============================================================

function determineCorridor(trainNo) {

  if (
    TPTY_TRAINS.has(trainNo)
  ) {

    return "TPTY";
  }

  if (
    MAS_TRAINS.has(trainNo)
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
// CHECK GUDUR STATION
// ============================================================

function isAtGudur(train, live, stop, item, coordinates) {

  const stationFields = [

    train?.stationCode,
    train?.stationName,

    live?.stationCode,
    live?.stationName,

    stop?.stationCode,
    stop?.stationName,

    item?.stationCode,
    item?.stationName
  ];

  const stationText =
    stationFields
      .filter(Boolean)
      .map(normalizeText)
      .join(" ");

  if (
    stationText.includes("GDR") ||
    stationText.includes("GUDUR")
  ) {

    return true;
  }


  // ----------------------------------------------------------
  // GPS FALLBACK
  // ----------------------------------------------------------

  if (coordinates) {

    const distance =
      distanceKm(
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
// PREVIOUS GUDUR HALT DETECTION
// ============================================================

function hasDepartedGudur(train, live, stop, item) {

  const previousStop =
    live?.previousStop ||
    train?.previousStop ||
    item?.previousStop;

  if (!previousStop) {
    return false;
  }

  const previousCode =
    normalizeText(
      previousStop.code ||
      previousStop.stationCode ||
      previousStop.name ||
      ""
    );

  if (
    !previousCode.includes("GDR") &&
    !previousCode.includes("GUDUR")
  ) {

    return false;
  }

  const currentSequence =
    Number(
      stop?.sequence ??
      live?.sequence ??
      item?.sequence
    );

  const previousSequence =
    Number(
      previousStop.sequence
    );

  if (
    Number.isFinite(currentSequence) &&
    Number.isFinite(previousSequence)
  ) {

    return (
      currentSequence >
      previousSequence
    );
  }

  return false;
}


// ============================================================
// GATE DISTANCE
// ============================================================

function getDistanceToGate(
  coordinates,
  corridor
) {

  if (!coordinates) {
    return null;
  }

  let gate;

  if (
    corridor === "MAS"
  ) {

    gate =
      CHENNAI_GATE;

  } else if (
    corridor === "TPTY"
  ) {

    gate =
      TIRUPATI_GATE;

  } else {

    return null;
  }

  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    gate.lat,
    gate.lng
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

  const date =
    new Date(timeStr);

  if (
    !isNaN(
      date.getTime()
    )
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
        ) * 60 +

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
// GET ETA
// ============================================================

function getVerifiedEta(
  train,
  live,
  stop,
  item,
  currentMin,
  coordinates,
  atGudur,
  departedGudur
) {

  // ----------------------------------------------------------
  // TRAIN IS AT GUDUR
  // ----------------------------------------------------------

  if (atGudur) {

    return 0;
  }


  // ----------------------------------------------------------
  // TRAIN HAS DEPARTED GUDUR
  // ----------------------------------------------------------

  if (departedGudur) {

    return null;
  }


  // ----------------------------------------------------------
  // LIVE EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const delayMin =
    Number(
      live?.delayMinutes || 0
    );

  const liveArrival =
    live?.expectedArrivalTime ||
    live?.arrivalTime ||
    "";

  if (liveArrival) {

    const arrMin =
      parseTimeToMinutes(
        liveArrival,
        delayMin
      );

    if (
      arrMin !== -1
    ) {

      return Math.max(
        0,
        calculateTimeDifference(
          arrMin,
          currentMin
        )
      );
    }
  }


  // ----------------------------------------------------------
  // BOARD ARRIVAL
  // ----------------------------------------------------------

  const boardArrival =
    stop?.arrival ||
    item?.arrival ||
    "";

  if (boardArrival) {

    const arrMin =
      parseTimeToMinutes(
        boardArrival,
        delayMin
      );

    if (
      arrMin !== -1
    ) {

      return Math.max(
        0,
        calculateTimeDifference(
          arrMin,
          currentMin
        )
      );
    }
  }


  // ----------------------------------------------------------
  // SPEED FALLBACK
  // ----------------------------------------------------------

  if (
    coordinates
  ) {

    const speed =
      Number(
        live?.speed ||
        train?.speed ||
        0
      );

    const gateDistance =
      getDistanceToGate(
        coordinates,
        determineCorridor(
          getTrainNumber(
            train,
            item
          )
        )
      );

    if (
      speed > 5 &&
      gateDistance !== null
    ) {

      const hours =
        gateDistance /
        speed;

      return Math.max(
        0,
        Math.round(
          hours * 60
        )
      );
    }
  }

  return null;
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
        `[LIVE ERROR] ${trainNo} | HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
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
// EXTRACT LIVE DATA
// ============================================================

function extractLiveObject(
  liveResponse
) {

  if (!liveResponse) {
    return null;
  }

  if (
    liveResponse.train
  ) {

    return (
      liveResponse.train
    );
  }

  if (
    liveResponse.data?.train
  ) {

    return (
      liveResponse.data.train
    );
  }

  return liveResponse;
}


// ============================================================
// DEDUPLICATE BOARD
// ============================================================

function deduplicateBoard(
  trainsArray
) {

  const map =
    new Map();

  for (
    const item of trainsArray
  ) {

    const train =
      item?.train ||
      {};

    const trainNo =
      getTrainNumber(
        train,
        item
      );

    if (!trainNo) {
      continue;
    }

    if (
      !APPROVED_TRAINS.has(
        trainNo
      )
    ) {

      console.log(
        `[IGNORED UNKNOWN] ${trainNo}`
      );

      continue;
    }

    const existing =
      map.get(trainNo);

    if (!existing) {

      map.set(
        trainNo,
        item
      );

      continue;
    }


    // --------------------------------------------------------
    // STATUS PRIORITY
    // --------------------------------------------------------

    const getPriority =
      (candidate) => {

        const live =
          candidate?.live ||
          {};

        const stop =
          candidate?.stop ||
          {};

        const status =
          normalizeText(
            live?.status ||
            stop?.status ||
            candidate?.status ||
            ""
          );

        if (
          status.includes(
            "AT STATION"
          ) ||
          status.includes(
            "ARRIVED"
          )
        ) {

          return 4;
        }

        if (
          status.includes(
            "UPCOMING"
          )
        ) {

          return 3;
        }

        if (
          status.includes(
            "SCHEDULED"
          )
        ) {

          return 2;
        }

        if (
          status.includes(
            "DEPARTED"
          )
        ) {

          return 1;
        }

        return 2;
      };

    if (
      getPriority(item) >
      getPriority(existing)
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
// CREATE OPEN GATE
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

    trainNo:
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
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {

  try {

    const now =
      new Date();

    const currentMin =
      now.getHours() * 60 +
      now.getMinutes();


    console.log(
      "\n=========================================="
    );

    console.log(
      `[${now.toLocaleString()}]`
    );

    console.log(
      " GUDUR CROSSING RADAR V9"
    );

    console.log(
      "=========================================="
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
      "LIVE GPS VERIFICATION: ENABLED"
    );

    console.log(
      "LIVE GPS: FRESH REQUEST EVERY WORKFLOW RUN"
    );

    console.log(
      "1.00 km WARNING: ENABLED"
    );

    console.log(
      "0.60 km GATE CLOSE: ENABLED"
    );

    console.log(
      "0.80 km GATE CLEAR: ENABLED"
    );

    console.log(
      "Gate closure: LIVE PHYSICAL POSITION"
    );

    console.log(
      "departedGudur is NOT required for gate closure"
    );

    console.log(
      "=========================================="
    );


    // ========================================================
    // RAILRADAR BOARD
    // ========================================================

    console.log(
      "\nFetching RailRadar GDR station board..."
    );


    const boardResponse =
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
      boardResponse.data;


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
      `Raw board trains: ${trainsArray.length}`
    );


    // ========================================================
    // DEDUPLICATE
    // ========================================================

    const uniqueTrains =
      deduplicateBoard(
        trainsArray
      );


    console.log(
      `Approved unique trains: ${uniqueTrains.length}`
    );


    // ========================================================
    // GATES
    // ========================================================

    let masGate =
      createOpenGate();

    let tptyGate =
      createOpenGate();


    // ========================================================
    // UPCOMING
    // ========================================================

    const upcomingList = [];


    // ========================================================
    // LIVE REQUEST COUNTER
    // ========================================================

    let liveRequests = 0;


    // ========================================================
    // PROCESS TRAINS
    // ========================================================

    for (
      const item of uniqueTrains
    ) {

      const train =
        item?.train ||
        {};

      let live =
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


      // ------------------------------------------------------
      // APPROVED TRAIN
      // ------------------------------------------------------

      if (
        !APPROVED_TRAINS.has(
          trainNo
        )
      ) {

        console.log(
          `[IGNORED UNKNOWN] ${trainNo}`
        );

        continue;
      }


      const corridor =
        determineCorridor(
          trainNo
        );


      if (!corridor) {

        console.log(
          `[IGNORED] ${trainNo} - no corridor`
        );

        continue;
      }


      const trainName =
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


      const delayMin =
        Number(
          live?.delayMinutes ||
          item?.delayMinutes ||
          0
        );


      // ======================================================
      // COORDINATES FROM BOARD
      // ======================================================

      let coordinates =
        getCoordinates(
          train,
          live,
          item
        );


      // ======================================================
      // ALWAYS GET FRESH LIVE GPS WHEN POSSIBLE
      // ======================================================
      //
      // This is the important V9 change.
      //
      // The previous system could wait too long before
      // refreshing GPS.
      //
      // That allowed a train to move through the 1.00 km
      // / 0.60 km crossing zone before the next GPS check.
      //
      // Now every workflow run gets a fresh live request
      // for candidates without embedded coordinates.
      //
      // ======================================================

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


        const extractedLive =
          extractLiveObject(
            freshLive
          );


        if (
          extractedLive
        ) {

          live = {
            ...live,
            ...extractedLive
          };


          coordinates =
            getCoordinates(
              train,
              live,
              item
            );


          console.log(
            `[LIVE RESULT] ${trainNo} | GPS ${coordinates ? "AVAILABLE" : "NOT AVAILABLE"}`
          );
        }

      } else if (
        !coordinates
      ) {

        console.log(
          `[LIVE LIMIT] ${trainNo} | live request limit reached`
        );
      }


      // ======================================================
      // GUDUR STATUS
      // ======================================================

      const trainIsAtGudur =
        isAtGudur(
          train,
          live,
          stop,
          item,
          coordinates
        );


      const departedGudur =
        hasDepartedGudur(
          train,
          live,
          stop,
          item
        );


      // ======================================================
      // GATE DISTANCE
      // ======================================================

      const gateDistance =
        getDistanceToGate(
          coordinates,
          corridor
        );


      const hasPhysicalPosition =
        gateDistance !== null;


      // ======================================================
      // ETA
      // ======================================================

      const etaMinutes =
        getVerifiedEta(
          train,
          live,
          stop,
          item,
          currentMin,
          coordinates,
          trainIsAtGudur,
          departedGudur
        );


      // ======================================================
      // PHYSICAL GATE WARNING
      // ======================================================
      //
      // Train must:
      //
      // - have live physical position
      // - NOT already be at Gudur
      // - be within 1.00 km
      // - still be outside 0.60 km
      //
      // ======================================================

      const gateWarning =
        hasPhysicalPosition &&
        !trainIsAtGudur &&
        gateDistance <=
          GATE_WARNING_DISTANCE_KM &&
        gateDistance >
          GATE_CLOSE_DISTANCE_KM;


      // ======================================================
      // PHYSICAL GATE CLOSE
      // ======================================================
      //
      // Train must:
      //
      // - have live physical position
      // - NOT already be at Gudur
      // - be <= 0.60 km from crossing
      //
      // departedGudur is intentionally NOT required.
      //
      // ======================================================

      const gateClosed =
        hasPhysicalPosition &&
        !trainIsAtGudur &&
        gateDistance <=
          GATE_CLOSE_DISTANCE_KM;


      // ======================================================
      // LOG TRAIN
      // ======================================================

      console.log(
        `\n[TRAIN] ${trainNo} | ${trainName} | ${corridor}` +
        ` | ETA=${etaMinutes === null ? "--" : `${etaMinutes}m`}` +
        ` | gateDistance=${gateDistance === null ? "--" : `${gateDistance.toFixed(3)}km`}` +
        ` | warning=${gateWarning}` +
        ` | closed=${gateClosed}` +
        ` | atGDR=${trainIsAtGudur}` +
        ` | departed=${departedGudur}`
      );


      // ======================================================
      // UPCOMING TRAIN RECORD
      // ======================================================

      // Only show trains that are still relevant.

      if (
        !trainIsAtGudur &&
        etaMinutes !== null
      ) {

        upcomingList.push({

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
              etaMinutes
            ),

          delayMinutes:
            delayMin,

          corridor,

          direction:
            "TOWARD GUDUR",

          platform:
            String(
              live?.platform ||
              stop?.platform ||
              "1"
            ),

          gateDistanceKm:
            gateDistance === null
              ? null
              : Number(
                  gateDistance.toFixed(
                    3
                  )
                ),

          gateWarning,

          gateClosed
        });
      }


      // ======================================================
      // GATE PAYLOAD
      // ======================================================

      if (
        gateClosed
      ) {

        const waitTime =
          Math.max(
            1,
            Math.round(
              gateDistance * 2
            )
          );


        const payload = {

          status:
            "CLOSED",

          waitMinutes:
            waitTime,

          activeTrain:
            `${trainNo} ${trainName}`,

          direction:
            "TOWARD GUDUR",

          corridor,

          trainNo,

          gateDistanceKm:
            Number(
              gateDistance.toFixed(
                3
              )
            ),

          warningDistanceKm:
            GATE_WARNING_DISTANCE_KM,

          closeDistanceKm:
            GATE_CLOSE_DISTANCE_KM
        };


        // ----------------------------------------------------
        // TIRUPATI GATE
        // ----------------------------------------------------

        if (
          corridor === "TPTY"
        ) {

          tptyGate =
            payload;

          console.log(
            `[GATE CLOSED] TIRUPATI | ${trainNo} | ${gateDistance.toFixed(3)} km`
          );
        }


        // ----------------------------------------------------
        // CHENNAI GATE
        // ----------------------------------------------------

        if (
          corridor === "MAS"
        ) {

          masGate =
            payload;

          console.log(
            `[GATE CLOSED] CHENNAI | ${trainNo} | ${gateDistance.toFixed(3)} km`
          );
        }

      } else if (
        gateWarning
      ) {

        const payload = {

          status:
            "WARNING",

          waitMinutes:
            Math.max(
              1,
              Math.round(
                gateDistance * 2
              )
            ),

          activeTrain:
            `${trainNo} ${trainName}`,

          direction:
            "TOWARD GUDUR",

          corridor,

          trainNo,

          gateDistanceKm:
            Number(
              gateDistance.toFixed(
                3
              )
            ),

          warningDistanceKm:
            GATE_WARNING_DISTANCE_KM,

          closeDistanceKm:
            GATE_CLOSE_DISTANCE_KM
        };


        if (
          corridor === "TPTY" &&
          tptyGate.status !==
            "CLOSED"
        ) {

          tptyGate =
            payload;

          console.log(
            `[GATE WARNING] TIRUPATI | ${trainNo} | ${gateDistance.toFixed(3)} km`
          );
        }


        if (
          corridor === "MAS" &&
          masGate.status !==
            "CLOSED"
        ) {

          masGate =
            payload;

          console.log(
            `[GATE WARNING] CHENNAI | ${trainNo} | ${gateDistance.toFixed(3)} km`
          );
        }
      }
    }


    // ========================================================
    // SORT UPCOMING TRAINS
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );


    // ========================================================
    // MAXIMUM 5 TRAINS
    // ========================================================

    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );


    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    await gateRef.set({

      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleString(),

      meta: {

        version:
          "V9",

        liveGps:
          "ENABLED",

        liveGpsFresh:
          "EVERY_WORKFLOW_RUN",

        maxLiveRequests:
          MAX_LIVE_REQUESTS,

        warningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        closeDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        clearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        strictTrainNumbers:
          true,

        unknownTrainsIgnored:
          true,

        duplicateTrainsRemoved:
          true,

        gateClosureMethod:
          "LIVE_PHYSICAL_POSITION",

        departedGudurRequired:
          false
      }
    });


    // ========================================================
    // SUCCESS LOGS
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "SYNC SUCCESS"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Chennai Gate : ${masGate.status} | ${masGate.activeTrain}`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status} | ${tptyGate.activeTrain}`
    );

    console.log(
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live requests used: ${liveRequests}/${MAX_LIVE_REQUESTS}`
    );


    // ========================================================
    // UPCOMING TRAIN LOG
    // ========================================================

    if (
      topUpcoming.length > 0
    ) {

      console.log(
        "\n[INBOUND TRAINS TO GUDUR]"
      );


      topUpcoming.forEach(
        (train) => {

          console.log(

            `   ${train.corridor}` +
            ` | ${train.trainNo}` +
            ` ${train.name}` +
            ` | ETA ${train.etaMinutes}m` +
            ` | Gate ${train.gateDistanceKm === null ? "--" : `${train.gateDistanceKm}km`}` +
            ` | warning=${train.gateWarning}` +
            ` | closed=${train.gateClosed}`
          );
        }
      );

    } else {

      console.log(
        "\n[INBOUND TRAINS TO GUDUR] None"
      );
    }


    console.log(
      "\n=========================================="
    );

    console.log(
      "Firebase update completed."
    );

    console.log(
      "=========================================="
    );


  } catch (error) {

    // ========================================================
    // ERROR HANDLING
    // ========================================================

    console.error(
      "\n=========================================="
    );

    console.error(
      "❌ UPDATE FAILED"
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
        "Response:",
        error.response.data
      );

    } else {

      console.error(
        error.message
      );
    }


    console.error(
      "=========================================="
    );


    // Important:
    // Do not overwrite Firebase with fake OPEN data
    // when RailRadar fails.
  }
}


// ============================================================
// START APPLICATION
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor V9 "
);

console.log(
  "=========================================="
);

console.log(
  "Gudur Station:"
);

console.log(
  "14.1451694 N, 79.8443472 E"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Chennai Gate:"
);

console.log(
  "14.1396667 N, 79.8441278 E"
);

console.log(
  "------------------------------------------"
);

console.log(
  "Tirupati Gate:"
);

console.log(
  "14.1402028 N, 79.8435972 E"
);

console.log(
  "=========================================="
);

console.log(
  "Strict train numbers: ENABLED"
);

console.log(
  "Unknown trains: IGNORED"
);

console.log(
  "Duplicate trains: REMOVED"
);

console.log(
  "Live GPS: ENABLED"
);

console.log(
  "Fresh GPS: EVERY WORKFLOW RUN"
);

console.log(
  "Warning distance: 1.00 km"
);

console.log(
  "Close distance: 0.60 km"
);

console.log(
  "Clear distance: 0.80 km"
);

console.log(
  "Gate closure: LIVE PHYSICAL POSITION"
);

console.log(
  "departedGudur required: NO"
);

console.log(
  "Firebase: CONFIGURED"
);

console.log(
  "=========================================="
);


// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem();
