const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR CROSSING RADAR
// ============================================================
// STRICT ETA RULE:
//
// Numeric ETA is allowed ONLY when:
//
// 1. RailRadar provides CURRENT live position
// 2. Train is NOT already past Gudur
// 3. Train is within 1 km of Gudur Junction
// 4. Train belongs to MAS or TPTY corridor
//
// Otherwise:
//
//     etaMinutes = null
//
// Frontend will display:
//
//     --m
//
// 0m is allowed ONLY when the train is actually at Gudur.
//
// OTHER LINE trains can NEVER receive numeric ETA.
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
  console.error(error.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential:
      admin.credential.cert(serviceAccount),

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
// GUDUR LOCATION
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

// Numeric ETA allowed only inside this radius.
const APPROACHING_GUDUR_DISTANCE_KM =
  1.00;

// Physical gate is approximately 0.52 km
// from Gudur Junction.
const GATE_DISTANCE_KM =
  0.52;

// Gate closure radius.
const GATE_CLOSE_DISTANCE_KM =
  0.60;

// Gate clear radius.
const GATE_CLEAR_DISTANCE_KM =
  0.80;


// ============================================================
// DISPLAY
// ============================================================

const UPCOMING_LIMIT =
  10;


// ============================================================
// LIVE API THROTTLE
// ============================================================
//
// GitHub runs every 5 minutes.
//
// Live train requests are persisted in Firebase,
// so the 20-minute throttle survives separate GitHub
// Actions executions.
// ============================================================

const LIVE_REFRESH_MINUTES =
  20;


// ============================================================
// KNOWN CORRIDORS
// ============================================================
//
// These numbers identify the branch only.
//
// They NEVER create an ETA.
//

const TPTY_TRAINS =
  new Set([
    "03251",
    "05074",
    "04717",
    "12296",
    "12762",
    "12764",
    "12733",
    "12734",
    "17487",
    "17488",
    "12763",
    "17261",
    "17262",
    "17479",
    "17480",
    "07669",
    "07670"
  ]);


const MAS_TRAINS =
  new Set([
    "12622",
    "12625",
    "12626",
    "12759",
    "12760",
    "16031",
    "16032",
    "12851",
    "17237"
  ]);


// ============================================================
// KNOWN OTHER TRAINS
// ============================================================

const OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "67226"
  ]);


// ============================================================
// TEXT
// ============================================================

function normalizeText(
  value
) {
  return String(value || "")
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


function containsAny(
  text,
  values
) {
  const normalized =
    normalizeText(text);

  return values.some(
    (value) =>
      normalized.includes(
        normalizeText(value)
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
// DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const aLat =
    numberOrNull(lat1);

  const aLng =
    numberOrNull(lng1);

  const bLat =
    numberOrNull(lat2);

  const bLng =
    numberOrNull(lng2);

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
    (bLat - aLat) *
    Math.PI /
    180;

  const dLng =
    (bLng - aLng) *
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
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(dLng / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
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
    item.trainNumber ||
    item.number ||
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
    item.trainName ||
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
    item.origin ||
    item.source?.name ||
    item.source?.code ||
    item.from ||
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
    item.destination ||
    item.to ||
    ""
  );
}


// ============================================================
// CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// This function returns the railway branch.
//
// It DOES NOT determine ETA.
//
// ============================================================

function determineCorridor(
  item,
  liveData = null
) {
  const trainNo =
    getTrainNumber(item);

  // ----------------------------------------------------------
  // Explicit OTHER mappings
  // ----------------------------------------------------------

  if (
    OTHER_TRAINS.has(
      trainNo
    )
  ) {
    return "OTHER";
  }


  // ----------------------------------------------------------
  // Explicit TPTY
  // ----------------------------------------------------------

  if (
    TPTY_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // Explicit MAS
  // ----------------------------------------------------------

  if (
    MAS_TRAINS.has(
      trainNo
    )
  ) {
    return "MAS";
  }


  const name =
    getTrainName(item);

  const origin =
    getOrigin(item);

  const destination =
    getDestination(item);

  const liveDestination =
    liveData?.train?.destination?.name ||
    liveData?.destination?.name ||
    "";

  const liveOrigin =
    liveData?.train?.source?.name ||
    liveData?.origin?.name ||
    "";

  const text =
    normalizeText(
      [
        name,
        origin,
        destination,
        liveOrigin,
        liveDestination
      ].join(" ")
    );


  // ----------------------------------------------------------
  // TPTY
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
        "SMVT BENGALURU",
        "KSR BENGALURU",
        "YESVANTPUR",
        "YPR",
        "BENGALURU",
        "BANGALORE",
        "SANGHAMITRA",
        "PADMAVATHI"
      ]
    )
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // MAS
  // ----------------------------------------------------------

  if (
    containsAny(
      text,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI",
        "TAMBARAM",
        "TBM",
        "SULLURUPETA",
        "ARAKKONAM",
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
  const candidates = [
    liveData?.currentLocation?.coordinates,

    liveData?.currentLocation,

    liveData?.coordinates,

    liveData?.position,

    liveData?.live?.currentLocation?.coordinates
  ];


  for (
    const point of candidates
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
    liveData?.currentLocation?.stationCode ||
    ""
  )
    .trim()
    .toUpperCase();
}


function getCurrentStationName(
  liveData
) {
  return normalizeText(
    liveData?.currentLocation?.stationName ||
    ""
  );
}


// ============================================================
// AT GUDUR
// ============================================================
//
// 0m is possible ONLY here.
//
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


  // Strong confirmation
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


  // Coordinate confirmation
  const coordinates =
    getCoordinates(
      liveData
    );


  if (!coordinates) {
    return false;
  }


  const d =
    distanceKm(
      coordinates.lat,
      coordinates.lng,
      GUDUR.lat,
      GUDUR.lng
    );


  return (
    d !== null &&
    d <= 0.20
  );
}


// ============================================================
// PASSED GUDUR
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
      liveData?.currentLocation?.sequence
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
// NEXT HALT = GUDUR
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
// VERIFIED APPROACHING GUDUR
// ============================================================
//
// HARD RULE:
//
// A train is considered approaching Gudur ONLY if:
//
// - current live coordinates exist
// - it has NOT departed Gudur
// - it is <= 1 km from Gudur
// - corridor is MAS or TPTY
//
// Merely having GDR as next halt is NOT enough.
//
// This is important because a train can have GDR as its
// next halt while still being many kilometres away.
//
// ============================================================

function isVerifiedApproachingGudur(
  liveData,
  corridor
) {
  if (!liveData) {
    return false;
  }


  // OTHER LINE can NEVER have numeric ETA.
  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return false;
  }


  // Already at Gudur
  if (
    isAtGudur(
      liveData
    )
  ) {
    return true;
  }


  // Already passed Gudur
  if (
    hasDepartedGudur(
      liveData
    )
  ) {
    return false;
  }


  // Must have current physical position.
  const distance =
    getDistanceToGudur(
      liveData
    );


  if (
    distance === null
  ) {
    return false;
  }


  // HARD 1 KM RULE
  if (
    distance >
    APPROACHING_GUDUR_DISTANCE_KM
  ) {
    return false;
  }


  return true;
}


// ============================================================
// PARSE DATE
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
    new Date(value);


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
//
// Only used when:
//
// - verified approaching
// - actual coordinates
// - actual speed > 5 km/h
//
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
      liveData?.currentLocation?.speedKmh ??
      liveData?.speedKmh
    );


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
    Math.round(minutes)
  );
}


// ============================================================
// VERIFIED ETA
// ============================================================
//
// THIS FUNCTION IS THE ONLY SOURCE OF NUMERIC ETA.
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
  // NO LIVE DATA = NO ETA
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
  // MUST BE PHYSICALLY WITHIN 1 KM
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
  // NO TRUSTWORTHY ETA
  // ----------------------------------------------------------

  return null;
}


// ============================================================
// GET BOARD ARRIVAL TIME
// ============================================================
//
// This is informational only.
//
// It is NEVER converted to etaMinutes.
//

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
    item.expectedArrivalTime ||
    item.expectedArrival ||
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
    Number(value);

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
    getTrainNumber(item);

  if (!trainNo) {
    return null;
  }


  const name =
    getTrainName(item);

  const corridor =
    determineCorridor(
      item
    );


  return {
    trainNo,

    name,

    origin:
      getOrigin(item) ||
      "Unknown",

    destination:
      getDestination(item) ||
      "Gudur",

    corridor,

    platform:
      getPlatform(item),

    delayMinutes:
      getDelay(item),

    arrivalTime:
      getBoardArrivalTime(
        item
      ),

    // --------------------------------------------------------
    // CRITICAL DEFAULT
    // --------------------------------------------------------

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
      false
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
  // If no live data:
  //
  // NEVER create ETA.
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
  // Recalculate corridor with live data.
  // ----------------------------------------------------------

  const fakeItem = {
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
      fakeItem,
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
  // Distance
  // ----------------------------------------------------------

  const distance =
    getDistanceToGudur(
      liveData
    );


  train.distanceToGudurKm =
    distance !== null
      ? Number(
          distance.toFixed(3)
        )
      : null;


  // ----------------------------------------------------------
  // VERIFIED APPROACH
  // ----------------------------------------------------------

  train.approachingGudur =
    isVerifiedApproachingGudur(
      liveData,
      corridor
    );


  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  const eta =
    getVerifiedEta(
      liveData,
      corridor,
      now
    );


  train.etaMinutes =
    eta;


  train.etaVerified =
    eta !== null;


  train.etaSource =
    eta === null
      ? "UNVERIFIED"
      : train.atGudur
        ? "LIVE_AT_GUDUR"
        : "LIVE_APPROACHING_GUDUR";


  // ----------------------------------------------------------
  // Direction
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
            gateDistance.toFixed(3)
          )
        : null;


    // --------------------------------------------------------
    // GATE CLOSURE
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
// FIND LIVE CANDIDATES
// ============================================================
//
// We prioritize trains that already have a board indication
// that GDR is the next halt, but we do NOT trust that alone
// for ETA.
//
// ============================================================

function findLiveCandidates(
  board
) {
  const candidates = [];

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


    const nextCode =
      String(
        live?.nextHalt?.stationCode ||
        ""
      )
        .trim()
        .toUpperCase();


    const nextName =
      normalizeText(
        live?.nextHalt?.stationName
      );


    if (
      nextCode === "GDR" ||
      nextName === "GUDUR" ||
      nextName === "GUDUR JN" ||
      nextName === "GUDUR JUNCTION"
    ) {
      candidates.push(
        train.trainNo
      );
    }
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
    new Date(value);


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
// FETCH LIVE
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
// MAIN
// ============================================================

async function updateGateSystem() {
  const now =
    new Date();


  console.log(
    "\n=================================================="
  );

  console.log(
    `[${now.toLocaleTimeString()}] GUDUR GATE MONITOR`
  );

  console.log(
    "=================================================="
  );


  try {

    // ========================================================
    // BOARD
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
      response.data?.data?.trains ||
      [];


    if (
      !Array.isArray(board)
    ) {
      throw new Error(
        "Invalid RailRadar station board response."
      );
    }


    console.log(
      `✅ Board returned ${board.length} trains.`
    );


    // ========================================================
    // LIVE REFRESH
    // ========================================================

    const liveAllowed =
      await canRunLiveRefresh();


    const liveMap =
      new Map();


    if (
      liveAllowed
    ) {

      console.log(
        "🔴 Live verification allowed."
      );


      const candidates =
        findLiveCandidates(
          board
        );


      console.log(
        `📍 Live candidates: ${candidates.length}`
      );


      // Maximum 8 live requests per refresh.
      const limitedCandidates =
        candidates.slice(
          0,
          8
        );


      for (
        const trainNo
        of limitedCandidates
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


      // Persist throttle across GitHub Actions runs.
      await gateRef
        .child(
          "meta/lastLiveCheckAt"
        )
        .set(
          now.toISOString()
        );

    } else {

      console.log(
        "🟢 Live verification throttled."
      );
    }


    // ========================================================
    // PROCESS BOARD
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


      const live =
        liveMap.get(
          train.trainNo
        ) || null;


      train =
        applyLiveData(
          train,
          live,
          now
        );


      // ------------------------------------------------------
      // HARD SAFETY:
      //
      // OTHER LINE can NEVER have numeric ETA.
      // ------------------------------------------------------

      if (
        train.corridor !== "MAS" &&
        train.corridor !== "TPTY"
      ) {

        train.etaMinutes =
          null;

        train.etaVerified =
          false;

        train.etaSource =
          "OTHER_LINE_BLOCKED";

        train.approachingGudur =
          false;
      }


      // ------------------------------------------------------
      // HARD SAFETY:
      //
      // If not physically approaching Gudur,
      // ETA MUST be null.
      // ------------------------------------------------------

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


      // ------------------------------------------------------
      // HARD SAFETY:
      //
      // Departed Gudur = no incoming ETA.
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
      }


      processed.push(
        train
      );


      // ------------------------------------------------------
      // LOG ETA DECISION
      // ------------------------------------------------------

      if (
        train.etaMinutes !== null
      ) {

        console.log(
          `[ETA OK] ${train.trainNo} ${train.name} | ${train.corridor} | ${train.etaMinutes}m | ${train.distanceToGudurKm} km`
        );

      } else {

        console.log(
          `[ETA BLOCKED] ${train.trainNo} ${train.name} | ${train.corridor} | distance ${
            train.distanceToGudurKm ??
            "unknown"
          } km`
        );
      }
    }


    // ========================================================
    // UPCOMING
    // ========================================================

    //
    // IMPORTANT:
    //
    // We do NOT sort unknown trains using fake ETA.
    //
    // Numeric verified ETA first.
    // Unknown ETA afterwards.
    //

    processed.sort(
      (a, b) => {

        const aEta =
          a.etaMinutes === null
            ? Number.MAX_SAFE_INTEGER
            : a.etaMinutes;

        const bEta =
          b.etaMinutes === null
            ? Number.MAX_SAFE_INTEGER
            : b.etaMinutes;

        return (
          aEta - bEta
        );
      }
    );


    const upcoming =
      processed
        .filter(
          (train) =>
            !train.departedGudur
        )
        .slice(
          0,
          UPCOMING_LIMIT
        );


    // ========================================================
    // GATES
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
        (train) => {

          // -----------------------------------------------
          // FINAL ETA SECURITY
          // -----------------------------------------------

          let eta =
            train.etaMinutes;


          let etaSource =
            train.etaSource;


          // OTHER = NEVER numeric
          if (
            train.corridor !== "MAS" &&
            train.corridor !== "TPTY"
          ) {
            eta =
              null;

            etaSource =
              "OTHER_LINE_BLOCKED";
          }


          // Not approaching = NEVER numeric
          if (
            !train.approachingGudur &&
            !train.atGudur
          ) {
            eta =
              null;

            etaSource =
              "NOT_APPROACHING_GUDUR";
          }


          // Departed = NEVER numeric
          if (
            train.departedGudur
          ) {
            eta =
              null;

            etaSource =
              "DEPARTED_GUDUR";
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

            // -------------------------------------------
            // ONLY VERIFIED ETA
            // -------------------------------------------

            etaMinutes:
              eta,

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

            // Informational only
            arrivalTime:
              train.arrivalTime ||
              null
          };
        }
      );


    // ========================================================
    // FIREBASE
    // ========================================================

    await gateRef.set({
      tirupatiGate,

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
        etaRule:
          "NUMERIC ETA ONLY FOR CURRENT LIVE TRAIN WITHIN 1 KM OF GUDUR",

        zeroEtaRule:
          "0m ONLY WHEN TRAIN IS ACTUALLY AT GUDUR",

        otherLineEtaRule:
          "OTHER LINE NEVER GETS NUMERIC ETA",

        staleEtaRule:
          "OLD FIREBASE ETA IS NEVER REUSED",

        timetableEtaRule:
          "TIMETABLE ARRIVAL IS NEVER USED AS LIVE ETA",

        approachingRadiusKm:
          APPROACHING_GUDUR_DISTANCE_KM,

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        lastLiveCheckAt:
          (
            await gateRef
              .child(
                "meta/lastLiveCheckAt"
              )
              .once("value")
          ).val()
      }
    });


    // ========================================================
    // FINAL LOG
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
      "================================================"
    );


    console.log(
      "\n[FINAL ETA CHECK]"
    );


    firebaseUpcoming.forEach(
      (train) => {

        console.log(
          `${train.trainNo} | ${train.name} | ${train.corridor} | ETA ${
            train.etaMinutes === null
              ? "--"
              : train.etaMinutes + "m"
          } | distance ${
            train.distanceToGudurKm === null
              ? "--"
              : train.distanceToGudurKm + " km"
          }`
        );
      }
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
  "       GUDUR CROSSING RADAR ACTIVE"
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
  "ETA Radius     : 1.00 km"
);

console.log(
  "Gate Close     : 0.60 km"
);

console.log(
  "Gate Clear     : 0.80 km"
);

console.log(
  "Numeric ETA    : VERIFIED APPROACH ONLY"
);

console.log(
  "OTHER LINE ETA : ALWAYS BLOCKED"
);

console.log(
  "0m ETA         : AT GUDUR ONLY"
);

console.log(
  "=================================================="
);


// ============================================================
// RUN
// ============================================================

updateGateSystem();


// ============================================================
// RUN EVERY 5 MINUTES
// ============================================================
//
// GitHub Actions can also invoke this script every 5 minutes.
// Persistent Firebase throttling prevents excessive live API
// calls.
//

setInterval(
  updateGateSystem,
  300000
);
