const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR CROSSING RADAR - COMPLETE BACKEND
// ============================================================
//
// IMPORTANT RULES:
//
// 1. OTHER LINE trains NEVER receive numeric ETA.
// 2. 0m is allowed ONLY when train is actually at Gudur.
// 3. Numeric ETA requires CURRENT live position.
// 4. Numeric ETA is allowed only within 1 km of Gudur.
// 5. Old/stale Firebase ETA is NEVER reused.
// 6. After Gudur, train continues being tracked toward gate.
// 7. Gate closes only when train reaches the physical gate area.
// 8. This script runs ONCE and exits.
//    GitHub Actions handles the 5-minute schedule.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
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
// RAILRADAR CONFIGURATION
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
// LOCATIONS
// ============================================================

const GUDUR = {
  lat: 14.1451694,
  lng: 79.8443472
};

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

// Train must be physically within this distance
// of Gudur before numeric ETA is allowed.
const APPROACHING_GUDUR_DISTANCE_KM =
  1.00;

// Approximate physical distance from Gudur Junction
// to the railway crossing gates.
const GATE_DISTANCE_KM =
  0.52;

// Gate closes when train is inside this radius
// of the corresponding physical gate.
const GATE_CLOSE_DISTANCE_KM =
  0.60;

// Gate is considered safely clear after this radius.
const GATE_CLEAR_DISTANCE_KM =
  0.80;


// ============================================================
// DISPLAY SETTINGS
// ============================================================

const UPCOMING_LIMIT =
  10;


// ============================================================
// LIVE API THROTTLE
// ============================================================
//
// GitHub Actions runs every 5 minutes.
//
// Live train API is checked approximately every 20 minutes.
// The timestamp is stored in Firebase so the throttle survives
// separate GitHub Action executions.
// ============================================================

const LIVE_REFRESH_MINUTES =
  20;


// ============================================================
// KNOWN TIRUPATI / SOUTHERN CORRIDOR TRAINS
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

    "17261",
    "17262",

    "17479",
    "17480",
    "17487",
    "17488",

    "22871",
    "14723"
  ]);


// ============================================================
// KNOWN CHENNAI / MAS CORRIDOR TRAINS
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
// KNOWN OTHER LINE TRAINS
// ============================================================
//
// These must NEVER receive a numeric ETA.
//
// ============================================================

const OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "67226",
    "20498"
  ]);


// ============================================================
// TEXT NORMALIZER
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
    (value) =>
      normalized.includes(
        normalizeText(
          value
        )
      )
  );
}


// ============================================================
// SAFE NUMBER
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
// DISTANCE CALCULATION
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

  const source =
    train.source;

  return (
    source?.name ||
    source?.code ||
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

  const destination =
    train.destination;

  return (
    destination?.name ||
    destination?.code ||
    train.to ||
    train.destinationStation ||
    item?.destination ||
    item?.to ||
    ""
  );
}


// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// MAS  = Chennai-side railway corridor
// TPTY = Tirupati-side railway corridor
// OTHER = not used for either gate
//
// IMPORTANT:
// Corridor does NOT mean train is currently approaching Gudur.
// It only identifies the branch.
//
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
  // Text fallback
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


  // ----------------------------------------------------------
  // TPTY fallback
  // ----------------------------------------------------------

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
        "HISAR TIRUPATI",
        "PADMAVATHI"
      ]
    )
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // MAS fallback
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
// GET CURRENT COORDINATES
// ============================================================

function getCoordinates(
  liveData
) {
  const candidates = [

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
    of candidates
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
// CURRENT STATION CODE
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


// ============================================================
// CURRENT STATION NAME
// ============================================================

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
//
// ============================================================

function isAtGudur(
  liveData
) {
  if (!liveData) {
    return false;
  }


  const stationCode =
    getCurrentStationCode(
      liveData
    );


  const stationName =
    getCurrentStationName(
      liveData
    );


  // Strong station-code confirmation.
  if (
    stationCode === "GDR"
  ) {
    return true;
  }


  // Station-name confirmation.
  if (
    stationName === "GUDUR" ||
    stationName === "GUDUR JN" ||
    stationName === "GUDUR JUNCTION"
  ) {
    return true;
  }


  // Coordinate confirmation.
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


  // RailRadar sequence proof:
  //
  // previous halt = GDR
  // current sequence > GDR sequence
  //
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
// NEXT HALT GUDUR
// ============================================================

function nextHaltIsGudur(
  liveData
) {
  const next =
    liveData?.nextHalt;


  if (!next) {
    return false;
  }


  const code =
    String(
      next.stationCode ||
      ""
    )
      .trim()
      .toUpperCase();


  const name =
    normalizeText(
      next.stationName
    );


  return (
    code === "GDR" ||
    name === "GUDUR" ||
    name === "GUDUR JN" ||
    name === "GUDUR JUNCTION"
  );
}


// ============================================================
// VERIFIED APPROACH TO GUDUR
// ============================================================
//
// IMPORTANT:
//
// nextHalt = GDR alone is NOT enough.
//
// Physical current coordinates must also place the train
// within 1 km of Gudur.
//
// ============================================================

function isVerifiedApproachingGudur(
  liveData,
  corridor
) {
  if (!liveData) {
    return false;
  }


  // OTHER line is NEVER approaching for gate purposes.
  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return false;
  }


  // Train physically at Gudur.
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


  // Need current coordinates.
  const distance =
    getDistanceToGudur(
      liveData
    );


  if (
    distance === null
  ) {
    return false;
  }


  // HARD 1 KM RULE.
  if (
    distance >
    APPROACHING_GUDUR_DISTANCE_KM
  ) {
    return false;
  }


  return true;
}


// ============================================================
// DATE PARSER
// ============================================================

function parseDate(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
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


  // A stationary train cannot provide a reliable
  // distance-based arrival prediction.
  if (
    speed === null ||
    speed <= 5
  ) {
    return null;
  }


  const minutes =
    (
      distance /
      speed
    ) *
    60;


  if (
    !Number.isFinite(
      minutes
    )
  ) {
    return null;
  }


  return Math.max(
    0,
    Math.round(
      minutes
    )
  );
}


// ============================================================
// VERIFIED ETA
// ============================================================
//
// THIS IS THE ONLY FUNCTION ALLOWED TO PRODUCE NUMERIC ETA.
//
// ============================================================

function getVerifiedEta(
  liveData,
  corridor,
  now
) {
  // ----------------------------------------------------------
  // OTHER = NEVER NUMERIC
  // ----------------------------------------------------------

  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // NO LIVE = NO ETA
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
  // DEPARTED GUDUR = NO ETA
  // ----------------------------------------------------------

  if (
    hasDepartedGudur(
      liveData
    )
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // PHYSICAL 1 KM CHECK
  // ----------------------------------------------------------

  const distance =
    getDistanceToGudur(
      liveData
    );


  if (
    distance === null ||
    distance >
      APPROACHING_GUDUR_DISTANCE_KM
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // LIVE EXPECTED ARRIVAL
  // ----------------------------------------------------------

  const expectedArrival =
    getLiveExpectedArrival(
      liveData
    );


  if (expectedArrival) {

    const eta =
      Math.round(
        (
          expectedArrival.getTime() -
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


  // ----------------------------------------------------------
  // NOT TRUSTWORTHY
  // ----------------------------------------------------------

  return null;
}


// ============================================================
// BOARD ARRIVAL
// ============================================================
//
// Informational only.
// NEVER used as live ETA.
//
// ============================================================

function getBoardArrivalTime(
  item
) {
  const live =
    item?.live || {};

  const stop =
    item?.stop || {};


  return (
    live.expectedArrivalTime ||
    live.expectedArrival ||
    item?.expectedArrivalTime ||
    item?.expectedArrival ||
    stop.arrival ||
    ""
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
// BUILD BASIC TRAIN
// ============================================================

function buildBasicTrain(
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
      item
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

    // CRITICAL:
    // Always null until CURRENT LIVE verification.
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
// APPLY LIVE DATA
// ============================================================

function applyLiveData(
  train,
  liveData,
  now
) {
  if (!train) {
    return null;
  }


  // ----------------------------------------------------------
  // No live data
  // ----------------------------------------------------------

  if (!liveData) {

    train.etaMinutes =
      null;

    train.etaSource =
      "UNVERIFIED";

    train.etaVerified =
      false;

    train.approachingGudur =
      false;

    train.atGudur =
      false;

    train.departedGudur =
      false;

    train.direction =
      "UNKNOWN";

    return train;
  }


  // ----------------------------------------------------------
  // Determine corridor again using live data.
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
  // State
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
  // Distance Gudur
  // ----------------------------------------------------------

  const distance =
    getDistanceToGudur(
      liveData
    );


  train.distanceToGudurKm =
    distance !== null
      ? Number(
          distance.toFixed(
            3
          )
        )
      : null;


  // ----------------------------------------------------------
  // Approaching
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
  // Direction/state
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
  // Gate distance
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
      gateDistance !== null
        ? Number(
            gateDistance.toFixed(
              3
            )
          )
        : null;


    // --------------------------------------------------------
    // Gate closure
    //
    // Train must have departed Gudur and physically be
    // close to the corresponding gate.
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
// LIVE CANDIDATES
// ============================================================
//
// We use board information to decide which trains deserve
// live API verification.
//
// A board indication alone NEVER creates ETA.
//
// ============================================================

function findLiveCandidates(
  board
) {
  const candidates =
    new Set();


  for (
    const item
    of board
  ) {

    const train =
      buildBasicTrain(
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


    const live =
      item?.live || {};


    const currentCode =
      String(
        live?.currentLocation
          ?.stationCode ||
        ""
      )
        .trim()
        .toUpperCase();


    const nextCode =
      String(
        live?.nextHalt
          ?.stationCode ||
        ""
      )
        .trim()
        .toUpperCase();


    const nextName =
      normalizeText(
        live?.nextHalt
          ?.stationName
      );


    // Already at Gudur.
    if (
      currentCode === "GDR"
    ) {

      candidates.add(
        train.trainNo
      );

      continue;
    }


    // Next halt Gudur.
    if (
      nextCode === "GDR" ||
      nextName === "GUDUR" ||
      nextName === "GUDUR JN" ||
      nextName === "GUDUR JUNCTION"
    ) {

      candidates.add(
        train.trainNo
      );
    }
  }


  return [
    ...candidates
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


  const elapsedMinutes =
    (
      Date.now() -
      previous.getTime()
    ) /
    60000;


  return (
    elapsedMinutes >=
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
      `[LIVE] Requesting ${trainNo}`
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


    return (
      response.data?.data ||
      response.data ||
      null
    );


  } catch (error) {

    console.error(
      `[LIVE ERROR] ${trainNo}: ${
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
    "        GUDUR CROSSING RADAR"
  );

  console.log(
    `[${now.toLocaleTimeString("en-IN")}]`
  );

  console.log(
    "=================================================="
  );


  try {

    // ========================================================
    // FETCH STATION BOARD
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


    const board =
      boardResponse
        .data
        ?.data
        ?.trains ||
      [];


    if (
      !Array.isArray(
        board
      )
    ) {

      throw new Error(
        "RailRadar returned invalid GDR board data."
      );
    }


    console.log(
      `✅ ${board.length} trains returned by RailRadar.`
    );


    // ========================================================
    // LIVE VERIFICATION
    // ========================================================

    const liveMap =
      new Map();


    const liveAllowed =
      await canRunLiveRefresh();


    if (
      liveAllowed
    ) {

      const candidates =
        findLiveCandidates(
          board
        );


      console.log(
        `📍 Live candidates: ${candidates.length}`
      );


      // Maximum 8 live requests per refresh.
      const limited =
        candidates.slice(
          0,
          8
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
      // IMPORTANT:
      //
      // Write throttle timestamp AFTER successful attempt
      // sequence has completed.
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
        "🟢 Live API refresh currently throttled."
      );
    }


    // ========================================================
    // PROCESS ALL BOARD TRAINS
    // ========================================================

    const processed =
      [];


    for (
      const item
      of board
    ) {

      let train =
        buildBasicTrain(
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
        applyLiveData(
          train,
          liveData,
          now
        );


      // ======================================================
      // FINAL SAFETY #1
      // OTHER = NEVER NUMERIC
      // ======================================================

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


      // ======================================================
      // FINAL SAFETY #2
      // NOT APPROACHING = NO NUMERIC ETA
      // ======================================================

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


      // ======================================================
      // FINAL SAFETY #3
      // DEPARTED GUDUR = NO INBOUND ETA
      // ======================================================

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


      // ======================================================
      // FINAL SAFETY #4
      // 0m ONLY AT GUDUR
      // ======================================================

      if (
        train.etaMinutes === 0 &&
        !train.atGudur
      ) {

        console.log(
          `[SAFETY] Blocking invalid 0m for ${train.trainNo}`
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
      // DEBUG LOG
      // ======================================================

      console.log(
        `[ETA DECISION] ${train.trainNo} | ${train.name} | corridor=${train.corridor} | live=${Boolean(liveData)} | distance=${train.distanceToGudurKm ?? "--"}km | atGDR=${train.atGudur} | departed=${train.departedGudur} | approaching=${train.approachingGudur} | eta=${train.etaMinutes ?? "--"}`
      );
    }


    // ========================================================
    // UPCOMING
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


    const upcoming =
      processed
        .filter(
          (
            train
          ) =>
            !train.departedGudur
        )
        .slice(
          0,
          UPCOMING_LIMIT
        );


    // ========================================================
    // DEFAULT GATE STATES
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
    // APPLY GATE CLOSURES
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
    // BUILD FIREBASE UPCOMING DATA
    // ========================================================

    const firebaseUpcoming =
      upcoming.map(
        (
          train
        ) => {

          let eta =
            train.etaMinutes;


          let etaSource =
            train.etaSource;


          // --------------------------------------------------
          // FINAL FIREWALL
          // --------------------------------------------------

          // OTHER never numeric.
          if (
            train.corridor !== "MAS" &&
            train.corridor !== "TPTY"
          ) {

            eta =
              null;

            etaSource =
              "OTHER_LINE_BLOCKED";
          }


          // Not approaching = no ETA.
          if (
            !train.approachingGudur &&
            !train.atGudur
          ) {

            eta =
              null;

            etaSource =
              "NOT_APPROACHING_GUDUR";
          }


          // Departed Gudur = no ETA.
          if (
            train.departedGudur
          ) {

            eta =
              null;

            etaSource =
              "DEPARTED_GUDUR";
          }


          // 0 only at Gudur.
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
              train.direction ||
              "UNKNOWN",

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
              train.arrivalTime ||
              null
          };
        }
      );


    // ========================================================
    // FIREBASE WRITE
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
          "GUDUR-RADAR-STRICT-ETA-V3",

        etaRule:
          "CURRENT LIVE POSITION REQUIRED",

        approachingRadiusKm:
          APPROACHING_GUDUR_DISTANCE_KM,

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        zeroEtaRule:
          "0m ONLY AT GUDUR",

        otherEtaRule:
          "OTHER LINE NEVER NUMERIC",

        staleEtaRule:
          "OLD ETA NEVER REUSED",

        timetableEtaRule:
          "TIMETABLE ETA NEVER USED AS LIVE ETA"
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
      `Upcoming     : ${firebaseUpcoming.length}`
    );


    console.log(
      "\n[FINAL FIREBASE ETA CHECK]"
    );


    firebaseUpcoming.forEach(
      (
        train
      ) => {

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
// START
// ============================================================

console.log(
  "=================================================="
);

console.log(
  "      GUDUR CROSSING RADAR BACKEND"
);

console.log(
  "=================================================="
);

console.log(
  "Gudur Junction : 14.1451694, 79.8443472"
);

console.log(
  "Chennai Gate   : 14.1396667, 79.8441278"
);

console.log(
  "Tirupati Gate  : 14.1402028, 79.8435972"
);

console.log(
  "ETA radius     : 1.00 km"
);

console.log(
  "Gate close     : 0.60 km"
);

console.log(
  "Gate clear     : 0.80 km"
);

console.log(
  "0m ETA         : AT GUDUR ONLY"
);

console.log(
  "OTHER ETA      : ALWAYS BLOCKED"
);

console.log(
  "=================================================="
);


// ============================================================
// RUN ONCE
// ============================================================
//
// DO NOT use setInterval here.
//
// GitHub Actions runs this file every 5 minutes.
//
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
    (error) => {

      console.error(
        "❌ Fatal error:",
        error
      );

      process.exit(1);
    }
  );
