const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR CROSSING RADAR
// ============================================================
//
// RULES:
//
// OTHER LINE
//   -> NEVER numeric ETA
//
// MAS / TPTY
//   -> numeric ETA ONLY from CURRENT live position
//   -> train must be within 1 km of Gudur
//
// AT GUDUR
//   -> ETA = 0m
//
// DEPARTED GUDUR
//   -> ETA = --
//
// OLD ETA
//   -> NEVER reused
//
// GitHub Actions runs this script every 5 minutes.
// This script runs ONCE and exits.
// ============================================================


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
  } else if (
    fs.existsSync("./serviceAccountKey.json")
  ) {
    serviceAccount =
      require("./serviceAccountKey.json");
  } else {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing."
    );
  }
} catch (error) {
  console.error(
    "❌ Firebase service account error:"
  );

  console.error(
    error.message
  );

  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential:
      admin.credential.cert(
        serviceAccount
      ),

    databaseURL:
      FIREBASE_DATABASE_URL
  });
}

const db =
  admin.database();

const gateRef =
  db.ref("gudur_gates");


// ============================================================
// RAILRADAR
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

if (!RAILRADAR_API_KEY) {
  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  process.exit(1);
}


// ============================================================
// GUDUR
// ============================================================

const GUDUR = {
  lat: 14.1451694,
  lng: 79.8443472
};


// ============================================================
// GATES
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
// DISTANCE RULES
// ============================================================

// Numeric ETA allowed inside 1 km of Gudur.
const APPROACHING_GUDUR_DISTANCE_KM =
  1.00;

// Physical crossing is approximately 0.52 km
// from Gudur Junction.
const GATE_DISTANCE_KM =
  0.52;

// Close gate when train is within this distance
// of the corresponding crossing.
const GATE_CLOSE_DISTANCE_KM =
  0.60;

// Clear gate after train moves beyond this distance.
const GATE_CLEAR_DISTANCE_KM =
  0.80;


// ============================================================
// LIVE API
// ============================================================
//
// Maximum candidates requested in one live refresh.
// ============================================================

const MAX_LIVE_REQUESTS =
  8;


// ============================================================
// LIVE REFRESH THROTTLE
// ============================================================

const LIVE_REFRESH_MINUTES =
  20;


// ============================================================
// UPCOMING
// ============================================================

const UPCOMING_LIMIT =
  10;


// ============================================================
// TPTY TRAINS
// ============================================================

const TPTY_TRAINS =
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


// ============================================================
// MAS TRAINS
// ============================================================

const MAS_TRAINS =
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


// ============================================================
// OTHER TRAINS
// ============================================================
//
// These NEVER receive numeric ETA.
// ============================================================

const OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "20498",
    "67226"
  ]);


// ============================================================
// NORMALIZE
// ============================================================

function normalizeText(
  value
) {
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


// ============================================================
// CONTAINS
// ============================================================

function containsAny(
  text,
  values
) {
  const normalized =
    normalizeText(
      text
    );

  return values.some(
    value =>
      normalized.includes(
        normalizeText(
          value
        )
      )
  );
}


// ============================================================
// NUMBER
// ============================================================

function numberOrNull(
  value
) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// HAVERSINE DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const aLat =
    numberOrNull(
      lat1
    );

  const aLng =
    numberOrNull(
      lng1
    );

  const bLat =
    numberOrNull(
      lat2
    );

  const bLng =
    numberOrNull(
      lng2
    );

  if (
    aLat === null ||
    aLng === null ||
    bLat === null ||
    bLng === null
  ) {
    return null;
  }

  const R =
    6371;

  const dLat =
    (
      bLat -
      aLat
    ) *
    Math.PI /
    180;

  const dLng =
    (
      bLng -
      aLng
    ) *
    Math.PI /
    180;

  const lat1Rad =
    aLat *
    Math.PI /
    180;

  const lat2Rad =
    bLat *
    Math.PI /
    180;

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +
    Math.cos(
      lat1Rad
    ) *
    Math.cos(
      lat2Rad
    ) *
    Math.sin(
      dLng / 2
    ) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(
        1 - a
      )
    );

  return R * c;
}


// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  item
) {
  const train =
    item?.train || {};

  return String(
    train.number ||
    train.trainNumber ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}


// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  item
) {
  const train =
    item?.train || {};

  return (
    train.name ||
    train.trainName ||
    item?.trainName ||
    `Train ${getTrainNumber(item)}`
  );
}


// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  item
) {
  const train =
    item?.train || {};

  return (
    train.source?.name ||
    train.source?.code ||
    train.origin ||
    train.from ||
    train.fromStation ||
    item?.origin ||
    item?.source?.name ||
    item?.source?.code ||
    item?.from ||
    ""
  );
}


// ============================================================
// DESTINATION
// ============================================================

function getDestination(
  item
) {
  const train =
    item?.train || {};

  return (
    train.destination?.name ||
    train.destination?.code ||
    train.to ||
    train.destinationStation ||
    item?.destination ||
    item?.to ||
    ""
  );
}


// ============================================================
// CORRIDOR
// ============================================================

function determineCorridor(
  item,
  liveData = null
) {
  const trainNo =
    getTrainNumber(
      item
    );


  // ----------------------------------------------------------
  // HARD OTHER
  // ----------------------------------------------------------

  if (
    OTHER_TRAINS.has(
      trainNo
    )
  ) {
    return "OTHER";
  }


  // ----------------------------------------------------------
  // HARD TPTY
  // ----------------------------------------------------------

  if (
    TPTY_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // HARD MAS
  // ----------------------------------------------------------

  if (
    MAS_TRAINS.has(
      trainNo
    )
  ) {
    return "MAS";
  }


  // ----------------------------------------------------------
  // TEXT FALLBACK
  // ----------------------------------------------------------

  const text =
    normalizeText(
      [
        getTrainName(item),
        getOrigin(item),
        getDestination(item),

        liveData?.train?.source?.name,
        liveData?.train?.destination?.name,

        liveData?.origin?.name,
        liveData?.destination?.name
      ]
        .filter(Boolean)
        .join(" ")
    );


  if (
    containsAny(
      text,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU",
        "KATPADI",
        "KPD",
        "BENGALURU",
        "BANGALORE",
        "SMVT",
        "KSR BENGALURU",
        "YESVANTPUR",
        "YPR",
        "SANGHAMITRA",
        "PADMAVATHI",
        "HISAR TIRUPATI"
      ]
    )
  ) {
    return "TPTY";
  }


  if (
    containsAny(
      text,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "CHENNAI CENTRAL",
        "TAMBARAM",
        "TBM",
        "SULLURUPETA",
        "CHARMINAR",
        "TAMIL NADU EXPRESS",
        "KERALA EXPRESS",
        "ANDAMAN EXPRESS"
      ]
    )
  ) {
    return "MAS";
  }


  return "OTHER";
}


// ============================================================
// CURRENT COORDINATES
// ============================================================

function getCoordinates(
  liveData
) {
  const points = [

    liveData?.currentLocation
      ?.coordinates,

    liveData?.currentLocation,

    liveData?.coordinates,

    liveData?.position,

    liveData?.live
      ?.currentLocation
      ?.coordinates
  ];


  for (
    const point
    of points
  ) {

    if (!point) {
      continue;
    }


    const lat =
      numberOrNull(
        point.lat ??
        point.latitude
      );


    const lng =
      numberOrNull(
        point.lng ??
        point.lon ??
        point.longitude
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


  return null;
}


// ============================================================
// CURRENT STATION
// ============================================================

function getCurrentStationCode(
  liveData
) {
  return String(
    liveData?.currentLocation
      ?.stationCode ||
    ""
  )
    .trim()
    .toUpperCase();
}


function getCurrentStationName(
  liveData
) {
  return normalizeText(
    liveData?.currentLocation
      ?.stationName ||
    ""
  );
}


// ============================================================
// AT GUDUR
// ============================================================
//
// 0m ONLY here.
// ============================================================

function isAtGudur(
  liveData
) {
  if (!liveData) {
    return false;
  }


  const code =
    getCurrentStationCode(
      liveData
    );


  const name =
    getCurrentStationName(
      liveData
    );


  if (
    code === "GDR"
  ) {
    return true;
  }


  if (
    name === "GUDUR" ||
    name === "GUDUR JN" ||
    name === "GUDUR JUNCTION"
  ) {
    return true;
  }


  const coordinates =
    getCoordinates(
      liveData
    );


  if (!coordinates) {
    return false;
  }


  const distance =
    distanceKm(
      coordinates.lat,
      coordinates.lng,
      GUDUR.lat,
      GUDUR.lng
    );


  return (
    distance !== null &&
    distance <= 0.20
  );
}


// ============================================================
// DEPARTED GUDUR
// ============================================================

function hasDepartedGudur(
  liveData
) {
  if (!liveData) {
    return false;
  }


  if (
    isAtGudur(
      liveData
    )
  ) {
    return false;
  }


  const currentSequence =
    numberOrNull(
      liveData?.currentLocation
        ?.sequence
    );


  const previousHalt =
    liveData?.previousHalt;


  const previousCode =
    String(
      previousHalt?.stationCode ||
      ""
    )
      .trim()
      .toUpperCase();


  const previousSequence =
    numberOrNull(
      previousHalt?.sequence
    );


  if (
    previousCode === "GDR" &&
    currentSequence !== null &&
    previousSequence !== null &&
    currentSequence >
      previousSequence
  ) {
    return true;
  }


  return false;
}


// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  liveData
) {
  const coordinates =
    getCoordinates(
      liveData
    );


  if (!coordinates) {
    return null;
  }


  return distanceKm(
    coordinates.lat,
    coordinates.lng,
    GUDUR.lat,
    GUDUR.lng
  );
}


// ============================================================
// DISTANCE TO GATE
// ============================================================

function getDistanceToGate(
  liveData,
  corridor
) {
  const coordinates =
    getCoordinates(
      liveData
    );


  if (!coordinates) {
    return null;
  }


  let gate = null;


  if (
    corridor === "MAS"
  ) {
    gate =
      CHENNAI_GATE;
  }


  if (
    corridor === "TPTY"
  ) {
    gate =
      TIRUPATI_GATE;
  }


  if (!gate) {
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
// DATE
// ============================================================

function parseDate(
  value
) {
  if (
    !value
  ) {
    return null;
  }


  const date =
    new Date(
      value
    );


  if (
    isNaN(
      date.getTime()
    )
  ) {
    return null;
  }


  return date;
}


// ============================================================
// LIVE EXPECTED ARRIVAL
// ============================================================

function getLiveExpectedArrival(
  liveData
) {
  if (!liveData) {
    return null;
  }


  const values = [

    liveData.expectedArrivalTime,

    liveData.expectedArrival,

    liveData.currentLocation
      ?.expectedArrivalTime,

    liveData.currentLocation
      ?.expectedArrival,

    liveData.nextHalt
      ?.expectedArrivalTime,

    liveData.nextHalt
      ?.expectedArrival
  ];


  for (
    const value
    of values
  ) {

    const date =
      parseDate(
        value
      );


    if (date) {
      return date;
    }
  }


  return null;
}


// ============================================================
// SPEED ETA
// ============================================================

function calculateSpeedEta(
  liveData,
  distance
) {
  if (
    distance === null ||
    distance < 0
  ) {
    return null;
  }


  const speed =
    numberOrNull(
      liveData?.currentLocation
        ?.speedKmh ??
      liveData?.speedKmh
    );


  if (
    speed === null ||
    speed <= 5
  ) {
    return null;
  }


  const eta =
    (
      distance /
      speed
    ) *
    60;


  if (
    !Number.isFinite(
      eta
    )
  ) {
    return null;
  }


  return Math.max(
    0,
    Math.round(
      eta
    )
  );
}


// ============================================================
// VERIFIED ETA
// ============================================================
//
// THIS IS THE ONLY PLACE THAT CREATES A NUMERIC ETA.
//
// ============================================================

function getVerifiedEta(
  liveData,
  corridor,
  now
) {
  // ----------------------------------------------------------
  // OTHER = ALWAYS NULL
  // ----------------------------------------------------------

  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // NO LIVE DATA = NULL
  // ----------------------------------------------------------

  if (!liveData) {
    return null;
  }


  // ----------------------------------------------------------
  // AT GUDUR = 0
  // ----------------------------------------------------------

  if (
    isAtGudur(
      liveData
    )
  ) {
    return 0;
  }


  // ----------------------------------------------------------
  // DEPARTED GUDUR = NULL
  // ----------------------------------------------------------

  if (
    hasDepartedGudur(
      liveData
    )
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // PHYSICAL DISTANCE
  // ----------------------------------------------------------

  const distance =
    getDistanceToGudur(
      liveData
    );


  if (
    distance === null
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // MUST BE INSIDE 1 KM
  // ----------------------------------------------------------

  if (
    distance >
    APPROACHING_GUDUR_DISTANCE_KM
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // LIVE EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const expected =
    getLiveExpectedArrival(
      liveData
    );


  if (expected) {

    const eta =
      Math.round(
        (
          expected.getTime() -
          now.getTime()
        ) /
        60000
      );


    if (
      eta >= 0 &&
      eta <= 60
    ) {
      return eta;
    }
  }


  // ----------------------------------------------------------
  // SPEED FALLBACK
  // ----------------------------------------------------------

  const speedEta =
    calculateSpeedEta(
      liveData,
      distance
    );


  if (
    speedEta !== null &&
    speedEta <= 60
  ) {
    return speedEta;
  }


  return null;
}


// ============================================================
// BOARD ARRIVAL
// ============================================================
//
// Informational only.
// NEVER used as etaMinutes.
// ============================================================

function getBoardArrivalTime(
  item
) {
  return (
    item?.live?.expectedArrivalTime ||
    item?.live?.expectedArrival ||
    item?.stop?.arrival ||
    item?.expectedArrivalTime ||
    item?.expectedArrival ||
    null
  );
}


// ============================================================
// DELAY
// ============================================================

function getDelay(
  item
) {
  const value =
    item?.live?.delayMinutes ??
    item?.delayMinutes ??
    0;


  const n =
    Number(
      value
    );


  return Number.isFinite(n)
    ? Math.max(
        0,
        Math.round(n)
      )
    : 0;
}


// ============================================================
// PLATFORM
// ============================================================

function getPlatform(
  item
) {
  return String(
    item?.live?.platform ||
    item?.stop?.platform ||
    item?.platform ||
    "--"
  );
}


// ============================================================
// BASIC TRAIN
// ============================================================

function buildTrain(
  item
) {
  const trainNo =
    getTrainNumber(
      item
    );


  if (!trainNo) {
    return null;
  }


  return {

    trainNo,

    name:
      getTrainName(
        item
      ),

    origin:
      getOrigin(
        item
      ) ||
      "Unknown",

    destination:
      getDestination(
        item
      ) ||
      "Gudur",

    corridor:
      determineCorridor(
        item
      ),

    platform:
      getPlatform(
        item
      ),

    delayMinutes:
      getDelay(
        item
      ),

    arrivalTime:
      getBoardArrivalTime(
        item
      ),

    etaMinutes:
      null,

    etaSource:
      "UNVERIFIED",

    etaVerified:
      false,

    approachingGudur:
      false,

    atGudur:
      false,

    departedGudur:
      false,

    gateClosed:
      false,

    distanceToGudurKm:
      null,

    distanceToGateKm:
      null,

    direction:
      "UNKNOWN"
  };
}


// ============================================================
// APPLY LIVE
// ============================================================

function applyLive(
  train,
  liveData,
  now
) {
  if (!train) {
    return null;
  }


  // ----------------------------------------------------------
  // NO LIVE
  // ----------------------------------------------------------

  if (!liveData) {

    train.etaMinutes =
      null;

    train.etaSource =
      "UNVERIFIED";

    train.etaVerified =
      false;

    return train;
  }


  // ----------------------------------------------------------
  // Corridor remains based on known train number first.
  // ----------------------------------------------------------

  const liveItem = {

    train: {

      number:
        train.trainNo,

      name:
        train.name,

      source: {
        name:
          train.origin
      },

      destination: {
        name:
          train.destination
      }
    }
  };


  const corridor =
    determineCorridor(
      liveItem,
      liveData
    );


  train.corridor =
    corridor;


  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------

  train.atGudur =
    isAtGudur(
      liveData
    );


  train.departedGudur =
    hasDepartedGudur(
      liveData
    );


  // ----------------------------------------------------------
  // DISTANCE
  // ----------------------------------------------------------

  const gudurDistance =
    getDistanceToGudur(
      liveData
    );


  train.distanceToGudurKm =
    gudurDistance === null
      ? null
      : Number(
          gudurDistance.toFixed(
            3
          )
        );


  // ----------------------------------------------------------
  // APPROACHING
  // ----------------------------------------------------------

  train.approachingGudur =
    isVerifiedApproachingGudur(
      liveData,
      corridor
    );


  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  train.etaMinutes =
    getVerifiedEta(
      liveData,
      corridor,
      now
    );


  train.etaVerified =
    train.etaMinutes !== null;


  if (
    train.etaMinutes === null
  ) {

    train.etaSource =
      "UNVERIFIED";

  } else if (
    train.atGudur
  ) {

    train.etaSource =
      "LIVE_AT_GUDUR";

  } else {

    train.etaSource =
      "LIVE_APPROACHING_GUDUR";
  }


  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  if (
    train.atGudur
  ) {

    train.direction =
      "AT GUDUR";

  } else if (
    train.departedGudur
  ) {

    train.direction =
      "AFTER GUDUR";

  } else if (
    train.approachingGudur
  ) {

    train.direction =
      "TOWARD GUDUR";

  } else {

    train.direction =
      "UNKNOWN";
  }


  // ----------------------------------------------------------
  // GATE
  // ----------------------------------------------------------

  if (
    corridor === "MAS" ||
    corridor === "TPTY"
  ) {

    const gateDistance =
      getDistanceToGate(
        liveData,
        corridor
      );


    train.distanceToGateKm =
      gateDistance === null
        ? null
        : Number(
            gateDistance.toFixed(
              3
            )
          );


    train.gateClosed =
      train.departedGudur &&
      gateDistance !== null &&
      gateDistance <=
        GATE_CLOSE_DISTANCE_KM;

  } else {

    train.distanceToGateKm =
      null;

    train.gateClosed =
      false;
  }


  return train;
}


// ============================================================
// VERIFIED APPROACHING
// ============================================================

function isVerifiedApproachingGudur(
  liveData,
  corridor
) {
  if (!liveData) {
    return false;
  }


  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return false;
  }


  if (
    isAtGudur(
      liveData
    )
  ) {
    return true;
  }


  if (
    hasDepartedGudur(
      liveData
    )
  ) {
    return false;
  }


  const distance =
    getDistanceToGudur(
      liveData
    );


  if (
    distance === null
  ) {
    return false;
  }


  return (
    distance <=
    APPROACHING_GUDUR_DISTANCE_KM
  );
}


// ============================================================
// FIND LIVE CANDIDATES
// ============================================================
//
// IMPORTANT CHANGE:
//
// We no longer require the station board to say
// "next halt = GDR".
//
// Every MAS/TPTY train appearing on the GDR board is
// eligible for live verification.
//
// This prevents legitimate trains from getting stuck
// at --m simply because the board structure does not contain
// nextHalt information.
//
// ============================================================

function findLiveCandidates(
  board
) {
  const candidates =
    [];


  for (
    const item
    of board
  ) {

    const train =
      buildTrain(
        item
      );


    if (!train) {
      continue;
    }


    if (
      train.corridor !== "MAS" &&
      train.corridor !== "TPTY"
    ) {
      continue;
    }


    candidates.push(
      train.trainNo
    );
  }


  return [
    ...new Set(
      candidates
    )
  ];
}


// ============================================================
// LIVE THROTTLE
// ============================================================

async function canRunLiveRefresh() {

  const ref =
    gateRef.child(
      "meta/lastLiveCheckAt"
    );


  const snapshot =
    await ref.once(
      "value"
    );


  const value =
    snapshot.val();


  if (!value) {
    return true;
  }


  const previous =
    new Date(
      value
    );


  if (
    isNaN(
      previous.getTime()
    )
  ) {
    return true;
  }


  const elapsed =
    (
      Date.now() -
      previous.getTime()
    ) /
    60000;


  return (
    elapsed >=
    LIVE_REFRESH_MINUTES
  );
}


// ============================================================
// FETCH LIVE
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

          params: {

            authoritative:
              "true",

            includeCoordinates:
              "true"
          },

          timeout:
            12000
        }
      );


    const data =
      response.data?.data ||
      response.data ||
      null;


    if (!data) {

      console.log(
        `[LIVE EMPTY] ${trainNo}`
      );

      return null;
    }


    const coords =
      getCoordinates(
        data
      );


    const distance =
      coords
        ? distanceKm(
            coords.lat,
            coords.lng,
            GUDUR.lat,
            GUDUR.lng
          )
        : null;


    console.log(
      `[LIVE RESULT] ${trainNo} | station=${
        getCurrentStationCode(
          data
        ) || "--"
      } | distance=${
        distance === null
          ? "--"
          : distance.toFixed(3) + " km"
      }`
    );


    return data;


  } catch (error) {

    console.error(
      `[LIVE ERROR] ${trainNo} | ${
        error.response?.status ||
        error.message
      }`
    );


    return null;
  }
}


// ============================================================
// MAIN
// ============================================================

async function updateGateSystem() {

  const now =
    new Date();


  console.log(
    "\n=================================================="
  );

  console.log(
    "       GUDUR CROSSING RADAR"
  );

  console.log(
    `[${now.toLocaleTimeString("en-IN")}]`
  );

  console.log(
    "=================================================="
  );


  try {

    // ========================================================
    // STATION BOARD
    // ========================================================

    console.log(
      "📡 Fetching GDR station board..."
    );


    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          headers: {

            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          params: {

            hours:
              4,

            includeIntermediate:
              true
          },

          timeout:
            12000
        }
      );


    const board =
      response.data
        ?.data
        ?.trains ||
      [];


    if (
      !Array.isArray(
        board
      )
    ) {

      throw new Error(
        "Invalid RailRadar station board."
      );
    }


    console.log(
      `✅ GDR board: ${board.length} trains`
    );


    // ========================================================
    // LIVE DATA
    // ========================================================

    const liveMap =
      new Map();


    const liveAllowed =
      await canRunLiveRefresh();


    if (
      liveAllowed
    ) {

      console.log(
        "🔴 Live verification: ENABLED"
      );


      const candidates =
        findLiveCandidates(
          board
        );


      console.log(
        `📍 MAS/TPTY live candidates: ${candidates.length}`
      );


      const limited =
        candidates.slice(
          0,
          MAX_LIVE_REQUESTS
        );


      console.log(
        `📡 Live requests this cycle: ${limited.length}`
      );


      for (
        const trainNo
        of limited
      ) {

        const live =
          await fetchLiveTrain(
            trainNo
          );


        if (live) {

          liveMap.set(
            trainNo,
            live
          );
        }
      }


      // ------------------------------------------------------
      // Persist throttle AFTER requests finish.
      // ------------------------------------------------------

      await gateRef
        .child(
          "meta/lastLiveCheckAt"
        )
        .set(
          now.toISOString()
        );


    } else {

      console.log(
        "🟢 Live verification: THROTTLED"
      );
    }


    // ========================================================
    // PROCESS
    // ========================================================

    const processed =
      [];


    for (
      const item
      of board
    ) {

      let train =
        buildTrain(
          item
        );


      if (!train) {
        continue;
      }


      const liveData =
        liveMap.get(
          train.trainNo
        ) ||
        null;


      train =
        applyLive(
          train,
          liveData,
          now
        );


      // ======================================================
      // FINAL ETA FIREWALL
      // ======================================================

      // OTHER = NEVER numeric.
      if (
        train.corridor !== "MAS" &&
        train.corridor !== "TPTY"
      ) {

        train.corridor =
          "OTHER";

        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.approachingGudur =
          false;

        train.gateClosed =
          false;

        train.etaSource =
          "OTHER_LINE_BLOCKED";
      }


      // Not approaching = null.
      if (
        !train.approachingGudur &&
        !train.atGudur
      ) {

        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "NOT_APPROACHING_GUDUR";
      }


      // Departed Gudur = null.
      if (
        train.departedGudur
      ) {

        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "DEPARTED_GUDUR";
      }


      // 0 only at Gudur.
      if (
        train.etaMinutes === 0 &&
        !train.atGudur
      ) {

        console.log(
          `[SAFETY BLOCK] Invalid 0m blocked for ${train.trainNo}`
        );


        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "INVALID_ZERO_BLOCKED";
      }


      processed.push(
        train
      );


      // ======================================================
      // DEBUG
      // ======================================================

      console.log(
        `[ETA DECISION] ${train.trainNo} | ${train.name} | corridor=${train.corridor} | live=${Boolean(liveData)} | Gudur=${train.distanceToGudurKm ?? "--"}km | atGDR=${train.atGudur} | departed=${train.departedGudur} | approaching=${train.approachingGudur} | ETA=${train.etaMinutes ?? "--"}`
      );
    }


    // ========================================================
    // SORT
    // ========================================================

    processed.sort(
      (
        a,
        b
      ) => {

        const aEta =
          a.etaMinutes === null
            ? Number.MAX_SAFE_INTEGER
            : a.etaMinutes;


        const bEta =
          b.etaMinutes === null
            ? Number.MAX_SAFE_INTEGER
            : b.etaMinutes;


        return (
          aEta -
          bEta
        );
      }
    );


    // ========================================================
    // UPCOMING
    // ========================================================

    const upcoming =
      processed
        .filter(
          train =>
            !train.departedGudur
        )
        .slice(
          0,
          UPCOMING_LIMIT
        );


    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let chennaiGate = {

      status:
        "OPEN",

      waitMinutes:
        0,

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

      activeTrain:
        "Tracks clear",

      direction:
        "CLEAR",

      corridor:
        "TPTY"
    };


    // ========================================================
    // GATE CLOSURE
    // ========================================================

    for (
      const train
      of processed
    ) {

      if (
        !train.gateClosed
      ) {
        continue;
      }


      const payload = {

        status:
          "CLOSED",

        waitMinutes:
          3,

        activeTrain:
          `${train.trainNo} ${train.name}`,

        direction:
          "TOWARD GATE",

        corridor:
          train.corridor,

        trainNo:
          train.trainNo,

        gateDistanceKm:
          train.distanceToGateKm
      };


      if (
        train.corridor ===
        "MAS"
      ) {

        chennaiGate =
          payload;

      } else if (
        train.corridor ===
        "TPTY"
      ) {

        tirupatiGate =
          payload;
      }
    }


    // ========================================================
    // FIREBASE OBJECT
    // ========================================================

    const firebaseUpcoming =
      upcoming.map(
        train => {

          let eta =
            train.etaMinutes;


          let etaSource =
            train.etaSource;


          // -----------------------------------------------
          // FINAL FIREWALL
          // -----------------------------------------------

          if (
            train.corridor !== "MAS" &&
            train.corridor !== "TPTY"
          ) {

            eta =
              null;

            etaSource =
              "OTHER_LINE_BLOCKED";
          }


          if (
            !train.approachingGudur &&
            !train.atGudur
          ) {

            eta =
              null;

            etaSource =
              "NOT_APPROACHING_GUDUR";
          }


          if (
            train.departedGudur
          ) {

            eta =
              null;

            etaSource =
              "DEPARTED_GUDUR";
          }


          if (
            eta === 0 &&
            !train.atGudur
          ) {

            eta =
              null;

            etaSource =
              "INVALID_ZERO_BLOCKED";
          }


          return {

            trainNo:
              train.trainNo,

            name:
              train.name,

            origin:
              train.origin,

            destination:
              train.destination,

            corridor:
              train.corridor,

            direction:
              train.direction,

            platform:
              train.platform,

            delayMinutes:
              train.delayMinutes,

            etaMinutes:
              eta,

            etaSource:
              etaSource,

            etaVerified:
              eta !== null,

            approachingGudur:
              train.approachingGudur,

            atGudur:
              train.atGudur,

            distanceToGudurKm:
              train.distanceToGudurKm,

            distanceToGateKm:
              train.distanceToGateKm,

            arrivalTime:
              train.arrivalTime
          };
        }
      );


    // ========================================================
    // WRITE FIREBASE
    // ========================================================

    await gateRef.set({

      tirupatiGate:
        tirupatiGate,

      chennaiGate:
        chennaiGate,

      upcomingTrains:
        firebaseUpcoming,

      lastUpdated:
        now.toLocaleTimeString(
          "en-IN"
        ),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleString(
          "en-IN"
        ),

      meta: {

        version:
          "GUDUR-RADAR-V4",

        etaRule:
          "CURRENT LIVE POSITION WITHIN 1 KM",

        zeroEtaRule:
          "0m ONLY AT GUDUR",

        otherEtaRule:
          "OTHER LINE NEVER NUMERIC",

        staleEtaRule:
          "OLD ETA NEVER REUSED",

        timetableEtaRule:
          "BOARD TIMETABLE IS NOT LIVE ETA",

        approachingRadiusKm:
          APPROACHING_GUDUR_DISTANCE_KM,

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        liveRefreshMinutes:
          LIVE_REFRESH_MINUTES
      }
    });


    // ========================================================
    // FINAL OUTPUT
    // ========================================================

    console.log(
      "\n================ SYNC SUCCESS ================"
    );


    console.log(
      `Chennai Gate : ${chennaiGate.status}`
    );


    console.log(
      `Tirupati Gate: ${tirupatiGate.status}`
    );


    console.log(
      `Upcoming     : ${firebaseUpcoming.length}`
    );


    console.log(
      "\n[FINAL ETA CHECK]"
    );


    firebaseUpcoming.forEach(
      train => {

        console.log(
          `${train.trainNo} | ${train.name} | ${train.corridor} | ETA ${
            train.etaMinutes === null
              ? "--"
              : train.etaMinutes + "m"
          } | Gudur ${
            train.distanceToGudurKm === null
              ? "--"
              : train.distanceToGudurKm + " km"
          }`
        );
      }
    );


    console.log(
      "================================================"
    );


  } catch (error) {

    console.error(
      "\n❌ GUDUR MONITOR ERROR"
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
  }
}


// ============================================================
// START ONCE
// ============================================================

console.log(
  "=================================================="
);

console.log(
  "       GUDUR CROSSING RADAR BACKEND"
);

console.log(
  "=================================================="
);

console.log(
  "ETA radius     : 1.00 km"
);

console.log(
  "Gate close     : 0.60 km"
);

console.log(
  "0m ETA         : AT GUDUR ONLY"
);

console.log(
  "OTHER ETA      : ALWAYS BLOCKED"
);

console.log(
  "Live candidates: ALL MAS/TPTY BOARD TRAINS"
);

console.log(
  "=================================================="
);


// ============================================================
// RUN ONCE AND EXIT
// ============================================================

updateGateSystem()
  .then(
    () => {

      console.log(
        "\n✅ Monitor finished."
      );

      process.exit(0);
    }
  )
  .catch(
    error => {

      console.error(
        "\n❌ Fatal error:",
        error
      );

      process.exit(1);
    }
  );
