const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR CROSSING RADAR - V6
// ============================================================
//
// IMPORTANT DESIGN:
//
// ETA DISPLAY and PHYSICAL GATE CONTROL are SEPARATE.
//
// ETA DISPLAY:
//   MAS / TPTY
//      -> RailRadar live expected arrival
//      -> station-board expected arrival fallback
//      -> speed/distance fallback
//
// PHYSICAL APPROACH:
//   -> requires actual live position
//   -> must be within 1 km of Gudur
//
// GATE:
//   -> requires actual physical position
//   -> never closes just because ETA says 1m/2m
//
// SAFETY:
//   OTHER       -> never numeric ETA
//   0m          -> only at Gudur
//   departed    -> no upcoming ETA
//   duplicate   -> removed
//   far away    -> ETA may display, but no gate warning
//
// GitHub Actions runs this script every 5 minutes.
// This script runs once and exits.
// ============================================================


// ============================================================
// FIREBASE
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
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
// RAILRADAR
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
  lat: 14.1451694,
  lng: 79.8443472
};


// ============================================================
// CROSSING LOCATIONS
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

// Physical approach radius.
const APPROACHING_GUDUR_DISTANCE_KM =
  1.00;


// Approximate Gudur -> crossing distance.
const GATE_DISTANCE_KM =
  0.52;


// Close gate inside this physical distance.
const GATE_CLOSE_DISTANCE_KM =
  0.60;


// Clear gate after this distance.
const GATE_CLEAR_DISTANCE_KM =
  0.80;


// ============================================================
// LIVE API SETTINGS
// ============================================================

const MAX_LIVE_REQUESTS =
  8;


// Refresh expensive live-position calls only every 20 min.
const LIVE_REFRESH_MINUTES =
  20;


// ============================================================
// UPCOMING LIST
// ============================================================

const UPCOMING_LIMIT =
  10;


// ============================================================
// TPTY TRAIN NUMBERS
// ============================================================
//
// These are known Tirupati-side corridor trains.
//
// IMPORTANT:
// This list determines the application's crossing corridor,
// not whether the train is physically approaching Gudur.
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

    "22871",

    "22365",
    "18509"
  ]);


// ============================================================
// MAS TRAIN NUMBERS
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
// KNOWN OTHER TRAINS
// ============================================================

const OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "20498",
    "67226",

    "17405"
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
// TEXT MATCH
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
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// HAVERSINE
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
        liveData?.train?.source?.code,

        liveData?.train?.destination?.name,
        liveData?.train?.destination?.code
      ]
        .filter(Boolean)
        .join(" ")
    );


  // ----------------------------------------------------------
  // TIRUPATI / SOUTHERN SIDE
  // ----------------------------------------------------------

  if (
    containsAny(
      text,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "KATPADI",
        "KPD",
        "BENGALURU",
        "BANGALORE",
        "SMVT",
        "KSR BENGALURU",
        "YESVANTPUR",
        "YPR"
      ]
    )
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // CHENNAI SIDE
  // ----------------------------------------------------------

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
// COORDINATES
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
// DATE PARSER
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


  // ----------------------------------------------------------
  // ISO / normal date
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // HH:mm or HH:mm:ss
  // ----------------------------------------------------------

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
// BOARD ARRIVAL
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
// ETA FROM ARRIVAL
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
// DISPLAY ETA
// ============================================================
//
// IMPORTANT:
//
// The train can be far away and still have a valid ETA.
//
// Example:
//
//   Train 20 km away
//   RailRadar ETA = 19m
//
// Display:
//   19m
//
// But:
//
//   approachingGudur = false
//   gateClosed = false
//
// ============================================================

function getVerifiedEta(
  liveData,
  corridor,
  now,
  boardItem
) {
  // ----------------------------------------------------------
  // OTHER = NEVER
  // ----------------------------------------------------------

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
  // DEPARTED = NULL
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
  // LIVE EXPECTED ARRIVAL
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
  // BOARD EXPECTED ARRIVAL
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
// DEDUPLICATE BOARD
// ============================================================
//
// RailRadar may return the same train more than once.
//
// We keep ONE record per train number.
//
// Preference:
//   1. at-station
//   2. upcoming
//   3. departed
//   4. first available
//
// This prevents repeated cards.
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


    const existingStatus =
      existingTrain
        ?.boardStatus ||
      "";


    const newStatus =
      train.boardStatus ||
      "";


    const priority = {
      "AT STATION": 4,
      "UPCOMING": 3,
      "SCHEDULED": 2,
      "DEPARTED": 1
    };


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
// APPLY LIVE
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
  // NO LIVE GPS
  //
  // ETA can STILL be calculated from the board.
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
  // LIVE CORRIDOR
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
      corridor
    );


  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  train.etaMinutes =
    getVerifiedEta(
      liveData,
      corridor,
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
      "UNKNOWN";
  }


  // ----------------------------------------------------------
  // GATE DISTANCE
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


    // --------------------------------------------------------
    // PHYSICAL GATE CLOSURE
    // --------------------------------------------------------
    //
    // IMPORTANT:
    //
    // ETA alone NEVER closes gate.
    //
    // Train must have passed Gudur and be physically
    // close to the actual crossing.
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
// PHYSICAL APPROACHING
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


  // At Gudur is still part of the approaching state.
  if (
    isAtGudur(
      liveData
    )
  ) {
    return true;
  }


  // Already passed Gudur.
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
      `[LIVE RESULT] ${trainNo} | station=${
        getCurrentStationCode(
          data
        ) || "--"
      } | distance=${
        distance === null
          ? "--"
          : distance.toFixed(
              3
            ) + " km"
      } | atGDR=${
        isAtGudur(
          data
        )
      } | departed=${
        hasDepartedGudur(
          data
        )
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
// UPDATE SYSTEM
// ============================================================

async function updateGateSystem() {

  const now =
    new Date();


  console.log(
    "\n=================================================="
  );

  console.log(
    "          GUDUR CROSSING RADAR V6"
  );

  console.log(
    `[${now.toLocaleString("en-IN")}]`
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
    // DEDUPLICATE
    // ========================================================

    const board =
      deduplicateBoard(
        rawBoard
      );


    console.log(
      `✅ After duplicate removal: ${board.length}`
    );


    // ========================================================
    // LIVE MAP
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
        `📍 MAS/TPTY live candidates: ${candidates.length}`
      );


      const limited =
        candidates.slice(
          0,
          MAX_LIVE_REQUESTS
        );


      console.log(
        `📡 Live API requests: ${limited.length}`
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
      // Save live refresh time.
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
        "🟢 LIVE GPS VERIFICATION: THROTTLED"
      );
    }


    // ========================================================
    // PROCESS TRAINS
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
          now,
          item
        );


      // ======================================================
      // FINAL SAFETY
      // ======================================================

      // ------------------------------------------------------
      // OTHER = NEVER ETA
      // ------------------------------------------------------

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

        train.etaSource =
          "OTHER_LINE_BLOCKED";

        train.gateClosed =
          false;

        train.approachingGudur =
          false;
      }


      // ------------------------------------------------------
      // DEPARTED GUDUR
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
      // 0m ONLY AT GUDUR
      // ------------------------------------------------------

      if (
        train.etaMinutes === 0 &&
        !train.atGudur
      ) {

        console.log(
          `[SAFETY BLOCK] Invalid 0m blocked: ${train.trainNo}`
        );


        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "INVALID_ZERO_BLOCKED";
      }


      // ------------------------------------------------------
      // GATE FIREWALL
      // ------------------------------------------------------

      // No live physical position = no gate closure.
      if (
        !liveData
      ) {

        train.gateClosed =
          false;
      }


      // No physical approach = no gate closure.
      if (
        !train.approachingGudur &&
        !train.atGudur &&
        !train.departedGudur
      ) {

        train.gateClosed =
          false;
      }


      processed.push(
        train
      );


      // ======================================================
      // DEBUG
      // ======================================================

      console.log(
        `[ETA DECISION] ${train.trainNo} | ${train.name} | corridor=${train.corridor} | live=${Boolean(liveData)} | Gudur=${train.distanceToGudurKm ?? "--"}km | approaching=${train.approachingGudur} | atGDR=${train.atGudur} | departed=${train.departedGudur} | ETA=${train.etaMinutes ?? "--"} | source=${train.etaSource} | gateClosed=${train.gateClosed}`
      );
    }


    // ========================================================
    // UPCOMING
    // ========================================================
    //
    // IMPORTANT:
    //
    // We DO NOT require approachingGudur here.
    //
    // This preserves valid:
    //
    //   14m
    //   19m
    //
    // even when the train is physically far away.
    //
    // But approachingGudur remains FALSE until live GPS
    // confirms the train is actually near Gudur.
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
          // OTHER
          // --------------------------------------------------

          if (
            train.corridor !== "MAS" &&
            train.corridor !== "TPTY"
          ) {

            eta =
              null;

            etaSource =
              "OTHER_LINE_BLOCKED";
          }


          // --------------------------------------------------
          // DEPARTED
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
          // INVALID ZERO
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
    // FIREBASE UPDATE
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
          "GUDUR-RADAR-V6",

        architecture:
          "ETA_DISPLAY_SEPARATE_FROM_PHYSICAL_GATE_CONTROL",

        etaRule:
          "MAS/TPTY RAILRADAR EXPECTED ARRIVAL",

        physicalApproachRule:
          "LIVE POSITION WITHIN 1 KM",

        gateRule:
          "PHYSICAL LIVE POSITION ONLY",

        zeroEtaRule:
          "0m ONLY AT GUDUR",

        otherEtaRule:
          "OTHER LINE NEVER NUMERIC",

        duplicateRule:
          "ONE RECORD PER TRAIN NUMBER",

        departedRule:
          "DEPARTED GUDUR HAS NO UPCOMING ETA",

        staleEtaRule:
          "OLD ETA NEVER REUSED",

        approachingRadiusKm:
          APPROACHING_GUDUR_DISTANCE_KM,

        gateDistanceKm:
          GATE_DISTANCE_KM,

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        liveRefreshMinutes:
          LIVE_REFRESH_MINUTES
      }
    });


    // ========================================================
    // SUCCESS
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
      `Unique trains: ${board.length}`
    );


    console.log(
      `Upcoming     : ${firebaseUpcoming.length}`
    );


    console.log(
      "\n[FINAL UPCOMING ETA]"
    );


    firebaseUpcoming.forEach(
      train => {

        console.log(

          `${train.trainNo} | ` +

          `${train.name} | ` +

          `${train.corridor} | ` +

          `ETA=${
            train.etaMinutes === null
              ? "--"
              : train.etaMinutes + "m"
          } | ` +

          `approaching=${
            train.approachingGudur
          } | ` +

          `Gudur=${
            train.distanceToGudurKm === null
              ? "--"
              : train.distanceToGudurKm + "km"
          } | ` +

          `gate=${
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
  "          GUDUR CROSSING RADAR V6"
);

console.log(
  "=================================================="
);

console.log(
  "ETA display    : RailRadar expected arrival"
);

console.log(
  "Physical warn  : Live position <= 1 km"
);

console.log(
  "Gate control   : Physical live position"
);

console.log(
  "0m             : Gudur station ONLY"
);

console.log(
  "OTHER ETA      : BLOCKED"
);

console.log(
  "Duplicates     : REMOVED"
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

      process.exit(0);
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

      process.exit(1);
    }
  );
