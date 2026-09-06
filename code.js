const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR CROSSING RADAR - V7
// ============================================================
//
// IMPORTANT:
// This version uses STRICT TRAIN-NUMBER filtering.
//
// NEVER classify a train by its name.
// NEVER classify a train by destination text.
// NEVER invent a corridor from "Bengaluru", "Tirupati", etc.
//
// ONLY trains in the approved lists below are processed.
//
// ETA:
//   MAS / TPTY approved trains can show RailRadar ETA
//   even when physically far from Gudur.
//
// PHYSICAL APPROACH:
//   Requires actual live coordinates <= 1 km from Gudur.
//
// GATE:
//   Requires actual physical position near the crossing.
//
// 0m:
//   ONLY when train is actually at Gudur.
//
// DEPARTED:
//   No longer shown as upcoming.
//
// DUPLICATES:
//   One record per train number.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";


let serviceAccount;

try {

  if (
    process.env.FIREBASE_SERVICE_ACCOUNT
  ) {

    serviceAccount =
      JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      );

  } else if (
    fs.existsSync(
      "./serviceAccountKey.json"
    )
  ) {

    serviceAccount =
      require(
        "./serviceAccountKey.json"
      );

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
  db.ref(
    "gudur_gates"
  );


// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY ||
  "";


const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";


if (!RAILRADAR_API_KEY) {

  console.error(
    "❌ RAILRADAR_API_KEY environment variable is missing."
  );

  process.exit(1);
}


// ============================================================
// GUDUR JUNCTION
// ============================================================

const GUDUR = {

  lat:
    14.1451694,

  lng:
    79.8443472
};


// ============================================================
// CROSSING LOCATIONS
// ============================================================

const CHENNAI_GATE = {

  lat:
    14.1396667,

  lng:
    79.8441278
};


const TIRUPATI_GATE = {

  lat:
    14.1402028,

  lng:
    79.8435972
};


// ============================================================
// DISTANCE SETTINGS
// ============================================================

const APPROACHING_GUDUR_DISTANCE_KM =
  1.00;


const GATE_DISTANCE_KM =
  0.52;


const GATE_CLOSE_DISTANCE_KM =
  0.60;


const GATE_CLEAR_DISTANCE_KM =
  0.80;


// ============================================================
// LIVE API SETTINGS
// ============================================================

const MAX_LIVE_REQUESTS =
  8;


// Live API refresh every 20 minutes.
// Station board can still be refreshed every GitHub run.
const LIVE_REFRESH_MINUTES =
  20;


// ============================================================
// UPCOMING LIST
// ============================================================

const UPCOMING_LIMIT =
  10;


// ============================================================
// APPROVED TIRUPATI-SIDE TRAIN NUMBERS
// ============================================================
//
// STRICT LIST.
//
// DO NOT ADD TRAINS HERE JUST BECAUSE THEIR NAME SAYS
// BENGALURU / TIRUPATI.
//
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
// APPROVED CHENNAI-SIDE TRAIN NUMBERS
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
// OTHER / NOT USED FOR GATE CONTROL
// ============================================================

const OTHER_TRAINS =
  new Set([

    "12743",
    "12744",

    "20498",

    "67226"
  ]);


// ============================================================
// NORMALIZE TEXT
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
// NUMBER PARSER
// ============================================================

function numberOrNull(
  value
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }


  const n =
    Number(
      value
    );


  return Number.isFinite(
    n
  )
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
// GET TRAIN NUMBER
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
// GET TRAIN NAME
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
// GET ORIGIN
// ============================================================
//
// Origin is DISPLAY INFORMATION ONLY.
//
// It NEVER determines the corridor.
//
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
// GET DESTINATION
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
// STRICT CORRIDOR
// ============================================================
//
// THIS IS THE MOST IMPORTANT CHANGE IN V7.
//
// NO TEXT FALLBACK.
//
// NO:
//   Bengaluru -> TPTY
//   Tirupati -> TPTY
//   SMVT -> TPTY
//
// ONLY TRAIN NUMBER.
//
// ============================================================

function determineCorridor(
  trainNo
) {

  const number =
    String(
      trainNo || ""
    ).trim();


  if (
    TPTY_TRAINS.has(
      number
    )
  ) {

    return "TPTY";
  }


  if (
    MAS_TRAINS.has(
      number
    )
  ) {

    return "MAS";
  }


  if (
    OTHER_TRAINS.has(
      number
    )
  ) {

    return "OTHER";
  }


  // Unknown train.
  //
  // VERY IMPORTANT:
  // Never guess.

  return "UNKNOWN";
}


// ============================================================
// GET COORDINATES
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
// IS AT GUDUR
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
// HAS DEPARTED GUDUR
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


  let gate =
    null;


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
// PARSE RAILRADAR DATE
// ============================================================

function parseRailRadarDate(
  value,
  now
) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }


  if (
    value instanceof Date
  ) {

    return isNaN(
      value.getTime()
    )
      ? null
      : value;
  }


  const text =
    String(
      value
    ).trim();


  if (!text) {
    return null;
  }


  // ISO / full date

  const direct =
    new Date(
      text
    );


  if (
    !isNaN(
      direct.getTime()
    )
  ) {

    return direct;
  }


  // HH:mm / HH:mm:ss

  const match =
    text.match(
      /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );


  if (!match) {
    return null;
  }


  const hours =
    parseInt(
      match[1],
      10
    );


  const minutes =
    parseInt(
      match[2],
      10
    );


  const seconds =
    parseInt(
      match[3] || "0",
      10
    );


  if (
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {

    return null;
  }


  const result =
    new Date(
      now
    );


  result.setHours(

    hours,

    minutes,

    seconds,

    0
  );


  const difference =
    (
      result.getTime() -
      now.getTime()
    ) /
    60000;


  if (
    difference < -720
  ) {

    result.setDate(

      result.getDate() + 1
    );
  }


  return result;
}


// ============================================================
// LIVE EXPECTED ARRIVAL
// ============================================================

function getLiveExpectedArrival(
  liveData,
  now
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
      parseRailRadarDate(
        value,
        now
      );


    if (date) {
      return date;
    }
  }


  return null;
}


// ============================================================
// BOARD EXPECTED ARRIVAL
// ============================================================

function getBoardArrivalTime(
  item
) {

  return (

    item?.live
      ?.expectedArrivalTime ||

    item?.live
      ?.expectedArrival ||

    item?.stop
      ?.expectedArrivalTime ||

    item?.stop
      ?.expectedArrival ||

    item?.stop
      ?.arrival ||

    item?.expectedArrivalTime ||

    item?.expectedArrival ||

    item?.arrivalTime ||

    item?.arrival ||

    null
  );
}


// ============================================================
// CALCULATE ETA FROM ARRIVAL
// ============================================================

function calculateEtaFromArrival(
  arrivalValue,
  now
) {

  const arrival =
    parseRailRadarDate(
      arrivalValue,
      now
    );


  if (!arrival) {
    return null;
  }


  const eta =
    Math.round(

      (
        arrival.getTime() -
        now.getTime()
      ) /

      60000
    );


  if (
    eta >= 0 &&
    eta <= 240
  ) {

    return eta;
  }


  return null;
}


// ============================================================
// SPEED ETA FALLBACK
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
// IMPORTANT:
//
// Far away:
//
//   22365 = NOT APPROVED
//   18509 = NOT APPROVED
//
// They never reach this function.
//
// Approved train:
//
//   RailRadar says 14m
//
// We display 14m.
//
// Physical distance does NOT invalidate the ETA.
//
// ============================================================

function getVerifiedEta(
  liveData,
  corridor,
  now,
  boardItem
) {

  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {

    return null;
  }


  // ----------------------------------------------------------
  // AT GUDUR = 0
  // ----------------------------------------------------------

  if (
    liveData &&
    isAtGudur(
      liveData
    )
  ) {

    return 0;
  }


  // ----------------------------------------------------------
  // DEPARTED = NO UPCOMING ETA
  // ----------------------------------------------------------

  if (
    liveData &&
    hasDepartedGudur(
      liveData
    )
  ) {

    return null;
  }


  // ----------------------------------------------------------
  // LIVE ETA
  // ----------------------------------------------------------

  const liveArrival =
    getLiveExpectedArrival(
      liveData,
      now
    );


  if (liveArrival) {

    const eta =
      calculateEtaFromArrival(

        liveArrival,

        now
      );


    if (
      eta !== null
    ) {

      return eta;
    }
  }


  // ----------------------------------------------------------
  // BOARD ETA
  // ----------------------------------------------------------

  const boardArrival =
    getBoardArrivalTime(
      boardItem
    );


  if (boardArrival) {

    const eta =
      calculateEtaFromArrival(

        boardArrival,

        now
      );


    if (
      eta !== null
    ) {

      return eta;
    }
  }


  // ----------------------------------------------------------
  // SPEED FALLBACK
  // ----------------------------------------------------------

  if (liveData) {

    const distance =
      getDistanceToGudur(
        liveData
      );


    const speedEta =
      calculateSpeedEta(

        liveData,

        distance
      );


    if (
      speedEta !== null &&
      speedEta <= 240
    ) {

      return speedEta;
    }
  }


  return null;
}


// ============================================================
// DELAY
// ============================================================

function getDelay(
  item,
  liveData = null
) {

  const value =

    liveData?.delayMinutes ??

    liveData?.currentLocation
      ?.delayMinutes ??

    item?.live?.delayMinutes ??

    item?.delayMinutes ??

    0;


  const n =
    Number(
      value
    );


  return Number.isFinite(
    n
  )
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
// BOARD STATUS
// ============================================================

function getBoardStatus(
  item
) {

  return normalizeText(

    item?.live?.status ||

    item?.status ||

    item?.stop?.status ||

    ""
  );
}


// ============================================================
// BUILD TRAIN
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


  const corridor =
    determineCorridor(
      trainNo
    );


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

    corridor,

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

    boardStatus:
      getBoardStatus(
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
// DEDUPLICATE
// ============================================================
//
// One train number = one Firebase card.
//
// ============================================================

function deduplicateBoard(
  board
) {

  const map =
    new Map();


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


    // --------------------------------------------------------
    // UNKNOWN TRAIN NUMBERS ARE COMPLETELY IGNORED.
    // --------------------------------------------------------

    if (
      train.corridor ===
      "UNKNOWN"
    ) {

      console.log(

        `[IGNORED UNKNOWN TRAIN] ${train.trainNo} ${train.name}`
      );

      continue;
    }


    const trainNo =
      train.trainNo;


    if (
      !map.has(
        trainNo
      )
    ) {

      map.set(
        trainNo,
        item
      );

      continue;
    }


    const existing =
      map.get(
        trainNo
      );


    const existingTrain =
      buildTrain(
        existing
      );


    const priority = {

      "AT STATION":
        4,

      "UPCOMING":
        3,

      "SCHEDULED":
        2,

      "DEPARTED":
        1
    };


    const existingStatus =
      existingTrain
        ?.boardStatus ||
      "";


    const newStatus =
      train.boardStatus ||
      "";


    const existingPriority =
      priority[
        existingStatus
      ] || 0;


    const newPriority =
      priority[
        newStatus
      ] || 0;


    if (
      newPriority >
      existingPriority
    ) {

      map.set(
        trainNo,
        item
      );
    }
  }


  return [
    ...map.values()
  ];
}


// ============================================================
// APPLY LIVE DATA
// ============================================================

function applyLive(
  train,
  liveData,
  now,
  boardItem
) {

  if (!train) {
    return null;
  }


  // ----------------------------------------------------------
  // NO LIVE DATA
  // ----------------------------------------------------------
  //
  // We can STILL display board ETA.
  //
  // ----------------------------------------------------------

  if (!liveData) {

    if (

      train.corridor === "MAS" ||

      train.corridor === "TPTY"

    ) {

      train.etaMinutes =
        getVerifiedEta(

          null,

          train.corridor,

          now,

          boardItem
        );


      train.etaVerified =
        train.etaMinutes !== null;


      train.etaSource =

        train.etaMinutes === null

          ? "BOARD_ETA_UNAVAILABLE"

          : "BOARD_EXPECTED_ARRIVAL";
    }


    return train;
  }


  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  train.atGudur =
    isAtGudur(
      liveData
    );


  // ----------------------------------------------------------
  // DEPARTED
  // ----------------------------------------------------------

  train.departedGudur =
    hasDepartedGudur(
      liveData
    );


  // ----------------------------------------------------------
  // DISTANCE TO GUDUR
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
  // PHYSICAL APPROACH
  // ----------------------------------------------------------

  train.approachingGudur =
    isVerifiedApproachingGudur(

      liveData,

      train.corridor
    );


  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  train.etaMinutes =
    getVerifiedEta(

      liveData,

      train.corridor,

      now,

      boardItem
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
      "LIVE_OR_BOARD_EXPECTED_ARRIVAL";
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
      "APPROACHING GUDUR - NOT YET PHYSICAL";
  }


  // ----------------------------------------------------------
  // GATE DISTANCE
  // ----------------------------------------------------------

  if (

    train.corridor === "MAS" ||

    train.corridor === "TPTY"

  ) {

    const gateDistance =
      getDistanceToGate(

        liveData,

        train.corridor
      );


    train.distanceToGateKm =

      gateDistance === null

        ? null

        : Number(

            gateDistance.toFixed(
              3
            )
          );


    // --------------------------------------------------------
    // GATE CLOSURE
    // --------------------------------------------------------
    //
    // Train MUST:
    //
    // 1. have departed Gudur
    // 2. have live coordinates
    // 3. be physically <= 0.60 km from crossing
    //
    // ETA alone cannot close gate.
    // --------------------------------------------------------

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
// PHYSICAL APPROACH CHECK
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


  // At Gudur = yes.

  if (
    isAtGudur(
      liveData
    )
  ) {

    return true;
  }


  // Passed Gudur = no.

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
// LIVE CANDIDATES
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
// LIVE REFRESH THROTTLE
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


    const coordinates =
      getCoordinates(
        data
      );


    const distance =
      coordinates

        ? distanceKm(

            coordinates.lat,

            coordinates.lng,

            GUDUR.lat,

            GUDUR.lng

          )

        : null;


    console.log(

      `[LIVE RESULT] ${trainNo}` +

      ` | station=${
        getCurrentStationCode(
          data
        ) || "--"
      }` +

      ` | distance=${
        distance === null
          ? "--"
          : distance.toFixed(
              3
            ) + " km"
      }` +

      ` | atGDR=${
        isAtGudur(
          data
        )
      }` +

      ` | departed=${
        hasDepartedGudur(
          data
        )
      }`
    );


    return data;


  } catch (error) {

    console.error(

      `[LIVE ERROR] ${trainNo} | ` +

      `${
        error.response?.status ||
        error.message
      }`
    );


    return null;
  }
}


// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {

  const now =
    new Date();


  console.log(
    "\n=================================================="
  );

  console.log(
    "          GUDUR CROSSING RADAR V7"
  );

  console.log(
    `[${now.toLocaleString("en-IN")}]`
  );

  console.log(
    "=================================================="
  );


  try {

    // ========================================================
    // FETCH GDR BOARD
    // ========================================================

    console.log(
      "📡 Fetching RailRadar GDR station board..."
    );


    const boardResponse =
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


    const rawBoard =
      boardResponse.data
        ?.data
        ?.trains ||
      [];


    if (
      !Array.isArray(
        rawBoard
      )
    ) {

      throw new Error(
        "RailRadar returned invalid station board."
      );
    }


    console.log(
      `✅ Raw board trains: ${rawBoard.length}`
    );


    // ========================================================
    // STRICT FILTER + DEDUPLICATION
    // ========================================================

    const board =
      deduplicateBoard(
        rawBoard
      );


    console.log(
      `✅ Approved unique trains: ${board.length}`
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
        "🔴 LIVE GPS VERIFICATION: ENABLED"
      );


      const candidates =
        findLiveCandidates(
          board
        );


      console.log(
        `📍 Approved MAS/TPTY candidates: ${candidates.length}`
      );


      const limited =
        candidates.slice(
          0,
          MAX_LIVE_REQUESTS
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


      await gateRef
        .child(
          "meta/lastLiveCheckAt"
        )
        .set(
          now.toISOString()
        );

    } else {

      console.log(
        "🟢 LIVE GPS VERIFICATION: THROTTLED"
      );
    }


    // ========================================================
    // PROCESS APPROVED TRAINS
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


      // ------------------------------------------------------
      // ABSOLUTE SAFETY:
      // UNKNOWN CAN NEVER REACH FIREBASE.
      // ------------------------------------------------------

      if (
        train.corridor ===
        "UNKNOWN"
      ) {

        console.log(

          `[FINAL IGNORE] ${train.trainNo} ${train.name}`
        );

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

          now,

          item
        );


      // ------------------------------------------------------
      // OTHER = NO ETA
      // ------------------------------------------------------

      if (
        train.corridor ===
        "OTHER"
      ) {

        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "OTHER_LINE_BLOCKED";

        train.approachingGudur =
          false;

        train.gateClosed =
          false;
      }


      // ------------------------------------------------------
      // DEPARTED = NO UPCOMING
      // ------------------------------------------------------

      if (
        train.departedGudur
      ) {

        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "DEPARTED_GUDUR";

        train.approachingGudur =
          false;
      }


      // ------------------------------------------------------
      // 0m SAFETY
      // ------------------------------------------------------

      if (

        train.etaMinutes === 0 &&

        !train.atGudur

      ) {

        console.log(

          `[SAFETY] ${train.trainNo} had invalid 0m. Resetting.`
        );


        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "INVALID_ZERO_BLOCKED";
      }


      // ------------------------------------------------------
      // NO LIVE DATA = NO GATE
      // ------------------------------------------------------

      if (!liveData) {

        train.gateClosed =
          false;
      }


      // ------------------------------------------------------
      // FAR AWAY = NEVER GATE
      // ------------------------------------------------------

      if (

        train.distanceToGudurKm !== null &&

        train.distanceToGudurKm >
          APPROACHING_GUDUR_DISTANCE_KM

      ) {

        train.gateClosed =
          false;
      }


      processed.push(
        train
      );


      // ------------------------------------------------------
      // DEBUG
      // ------------------------------------------------------

      console.log(

        `[TRAIN] ${train.trainNo}` +

        ` | ${train.name}` +

        ` | ${train.corridor}` +

        ` | ETA=${
          train.etaMinutes === null
            ? "--"
            : train.etaMinutes + "m"
        }` +

        ` | distance=${
          train.distanceToGudurKm === null
            ? "--"
            : train.distanceToGudurKm + "km"
        }` +

        ` | approaching=${
          train.approachingGudur
        }` +

        ` | atGDR=${
          train.atGudur
        }` +

        ` | departed=${
          train.departedGudur
        }` +

        ` | gate=${
          train.gateClosed
        }`
      );
    }


    // ========================================================
    // UPCOMING LIST
    // ========================================================

    const upcoming =
      processed

        .filter(
          train =>
            !train.departedGudur
        )

        .sort(
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
    // GATE CONTROL
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
    // FIREBASE UPCOMING
    // ========================================================

    const firebaseUpcoming =
      upcoming.map(
        train => {

          let eta =
            train.etaMinutes;


          let etaSource =
            train.etaSource;


          // --------------------------------------------------
          // ABSOLUTE UNKNOWN BLOCK
          // --------------------------------------------------

          if (

            train.corridor !== "MAS" &&

            train.corridor !== "TPTY"

          ) {

            eta =
              null;

            etaSource =
              "UNAPPROVED_TRAIN_BLOCKED";
          }


          // --------------------------------------------------
          // DEPARTED BLOCK
          // --------------------------------------------------

          if (
            train.departedGudur
          ) {

            eta =
              null;

            etaSource =
              "DEPARTED_GUDUR";
          }


          // --------------------------------------------------
          // INVALID ZERO BLOCK
          // --------------------------------------------------

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

            departedGudur:
              train.departedGudur,

            gateClosed:
              train.gateClosed,

            distanceToGudurKm:
              train.distanceToGudurKm,

            distanceToGateKm:
              train.distanceToGateKm,

            arrivalTime:
              train.arrivalTime,

            boardStatus:
              train.boardStatus
          };
        }
      );


    // ========================================================
    // FINAL DUPLICATE FIREWALL
    // ========================================================
    //
    // Even if something strange happens upstream,
    // Firebase receives only one train number.
    //
    // ========================================================

    const finalMap =
      new Map();


    for (
      const train
      of firebaseUpcoming
    ) {

      if (
        !finalMap.has(
          train.trainNo
        )
      ) {

        finalMap.set(
          train.trainNo,
          train
        );
      }
    }


    const finalUpcoming =
      [
        ...finalMap.values()
      ].slice(
        0,
        UPCOMING_LIMIT
      );


    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    await gateRef.set({

      tirupatiGate:
        tirupatiGate,

      chennaiGate:
        chennaiGate,

      upcomingTrains:
        finalUpcoming,

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
          "GUDUR-RADAR-V7",

        trainFilter:
          "STRICT_APPROVED_TRAIN_NUMBERS_ONLY",

        nameBasedClassification:
          false,

        unknownTrainPolicy:
          "IGNORE",

        duplicatePolicy:
          "ONE_RECORD_PER_TRAIN_NUMBER",

        etaPolicy:
          "RAILRADAR_EXPECTED_ARRIVAL",

        etaCanDisplayWhenFarAway:
          true,

        physicalApproachPolicy:
          "LIVE_COORDINATES_ONLY",

        approachingRadiusKm:
          APPROACHING_GUDUR_DISTANCE_KM,

        gatePolicy:
          "PHYSICAL_POSITION_ONLY",

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        zeroEtaPolicy:
          "ONLY_AT_GUDUR",

        departedPolicy:
          "REMOVE_FROM_UPCOMING",

        liveRefreshMinutes:
          LIVE_REFRESH_MINUTES
      }
    });


    // ========================================================
    // SUCCESS LOG
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
      `Raw trains   : ${rawBoard.length}`
    );


    console.log(
      `Approved     : ${board.length}`
    );


    console.log(
      `Final queue  : ${finalUpcoming.length}`
    );


    console.log(
      "\n[FINAL FIREBASE TRAINS]"
    );


    finalUpcoming.forEach(
      train => {

        console.log(

          `${train.trainNo}` +

          ` | ${train.name}` +

          ` | ${train.corridor}` +

          ` | ETA=${
            train.etaMinutes === null
              ? "--"
              : train.etaMinutes + "m"
          }` +

          ` | distance=${
            train.distanceToGudurKm === null
              ? "--"
              : train.distanceToGudurKm + "km"
          }` +

          ` | approaching=${
            train.approachingGudur
          }` +

          ` | gate=${
            train.gateClosed
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


    throw error;
  }
}


// ============================================================
// START
// ============================================================

console.log(
  "=================================================="
);

console.log(
  "          GUDUR CROSSING RADAR V7"
);

console.log(
  "=================================================="
);

console.log(
  "STRICT TRAIN NUMBERS: ENABLED"
);

console.log(
  "Name-based classification: DISABLED"
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
  "Physical warning: LIVE GPS ONLY"
);

console.log(
  "Gate closure: PHYSICAL POSITION ONLY"
);

console.log(
  "0m: GUDUR ONLY"
);

console.log(
  "=================================================="
);


// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem()

  .then(
    () => {

      console.log(
        "\n✅ Monitor finished successfully."
      );

      process.exit(
        0
      );
    }
  )

  .catch(
    error => {

      console.error(
        "\n❌ Monitor failed:"
      );

      console.error(
        error.message
      );

      process.exit(
        1
      );
    }
  );
