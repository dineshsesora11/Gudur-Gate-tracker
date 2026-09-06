const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// GUDUR GATE REAL-TIME RAIL MONITOR
// ============================================================
//
// IMPORTANT:
//
// Chennai Gate:
//   Chennai <-> Gudur
//
// Tirupati Gate:
//   Tirupati <-> Gudur
//
// Gate closure works in BOTH directions.
//
// The gate is closed ONLY when:
//   1. The train belongs to the correct physical corridor.
//   2. RailRadar gives an actual physical position.
//   3. The actual position is within the configured gate radius.
//
// Route interpolation is NEVER used to close a gate.
//
// Upcoming trains are shown only when travelling TOWARD GUDUR.
//
// ============================================================


// ============================================================
// DEPENDENCIES
// ============================================================

const fs = require("fs");


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

let serviceAccount;

try {

  // ----------------------------------------------------------
  // GitHub Actions / environment variable
  // ----------------------------------------------------------

  if (
    process.env.FIREBASE_SERVICE_ACCOUNT
  ) {

    serviceAccount =
      JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      );

    console.log(
      "Firebase service account: GitHub Secret"
    );

  }

  // ----------------------------------------------------------
  // Local development
  // ----------------------------------------------------------

  else {

    const SERVICE_ACCOUNT_FILE =
      "./serviceAccountKey.json";

    if (
      !fs.existsSync(
        SERVICE_ACCOUNT_FILE
      )
    ) {

      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
      );
    }

    serviceAccount =
      require(
        SERVICE_ACCOUNT_FILE
      );

    console.log(
      "Firebase service account: Local JSON"
    );
  }

}
catch (error) {

  console.error(
    "❌ Could not load Firebase service account."
  );

  console.error(
    error.message
  );

  process.exit(1);
}


// ============================================================
// INITIALIZE FIREBASE
// ============================================================

admin.initializeApp({

  credential:
    admin.credential.cert(
      serviceAccount
    ),

  databaseURL:
    FIREBASE_DATABASE_URL
});

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
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";


// ============================================================
// BASIC VALIDATION
// ============================================================

if (
  !RAILRADAR_API_KEY
) {

  console.error(
    "❌ RAILRADAR_API_KEY is missing."
  );

  process.exit(1);
}


// ============================================================
// LOCATION CONFIGURATION
// ============================================================

// Gudur Junction
const GDR_LAT =
  14.14842;

const GDR_LNG =
  79.84524;


// Chennai-side physical crossing
const CHENNAI_GATE_LAT =
  14.1396639;

const CHENNAI_GATE_LNG =
  79.8441306;


// Tirupati-side physical crossing
const TIRUPATI_GATE_LAT =
  14.1402056;

const TIRUPATI_GATE_LNG =
  79.8436000;


// ============================================================
// MONITOR SETTINGS
// ============================================================

// Physical gate detection radius.
//
// A train whose ACTUAL physical position is inside this
// radius can close the corresponding gate.
const GATE_STOP_DISTANCE_KM =
  0.60;


// Upcoming list can contain trains up to this distance
// from Gudur.
const UPCOMING_MAX_DISTANCE_KM =
  150;


// Number of live train requests after station-board request.
//
// IMPORTANT:
// GitHub Actions minimum schedule is 5 minutes.
// 7 live requests + 1 station-board request can consume
// approximately 2,880 API requests/month if every scheduled
// run executes.
//
// Reduce this if your RailRadar plan has a lower quota.
const MAX_LIVE_VERIFICATIONS =
  7;


// Number of trains retained from station board before
// live verification.
const MAX_BOARD_CANDIDATES =
  22;


// Station board look-ahead.
const STATION_BOARD_HOURS =
  4;


// Default speed when RailRadar does not provide speed.
const DEFAULT_SPEED_KMPH =
  55;


// Never use zero speed for ETA calculation.
const MIN_SPEED_KMPH =
  5;


// GitHub/local continuous mode refresh.
// GitHub Actions runs one cycle and exits.
const REFRESH_INTERVAL_MS =
  60 * 1000;


// ============================================================
// KNOWN TIRUPATI CORRIDOR TRAINS
// ============================================================
//
// These are only a fallback.
//
// Route information is preferred.
//
// ============================================================

const TIRUPATI_CORRIDOR_TRAINS =
  new Set([

    "12733",
    "12734",

    "17487",
    "17488",

    "12763",
    "12764",

    "17261",
    "17262",

    "17479",
    "17480",

    "07669",
    "07670",

    "22708",
    "20630"

  ]);


// ============================================================
// TEXT HELPERS
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


function normalizeCode(
  value
) {

  return String(
    value || ""
  )
    .trim()
    .toUpperCase();
}


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
// NUMBER HELPERS
// ============================================================

function toNumber(
  value
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function isValidCoordinate(
  lat,
  lng
) {

  const latitude =
    toNumber(lat);

  const longitude =
    toNumber(lng);

  return (
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
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

  const R =
    6371;

  const dLat =
    (
      (lat2 - lat1) *
      Math.PI
    ) / 180;

  const dLng =
    (
      (lng2 - lng1) *
      Math.PI
    ) / 180;

  const a =
    Math.sin(
      dLat / 2
    ) ** 2 +

    Math.cos(
      lat1 * Math.PI / 180
    ) *

    Math.cos(
      lat2 * Math.PI / 180
    ) *

    Math.sin(
      dLng / 2
    ) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}


// ============================================================
// ROUTE EXTRACTION
// ============================================================

function getRoute(
  train,
  live
) {

  if (
    Array.isArray(
      live?.route
    )
  ) {

    return live.route;
  }

  if (
    Array.isArray(
      train?.route
    )
  ) {

    return train.route;
  }

  return [];
}


// ============================================================
// ORIGIN / DESTINATION
// ============================================================

function getOrigin(
  train,
  item
) {

  const source =
    train?.source ||
    train?.origin ||
    train?.from ||
    train?.fromStation ||
    train?.startStation ||
    item?.source ||
    item?.origin ||
    item?.from ||
    item?.fromStation ||
    item?.startStation;

  if (
    source &&
    typeof source === "object"
  ) {

    return (
      source.code ||
      source.name ||
      ""
    );
  }

  return (
    source || ""
  );
}


function getDestination(
  train,
  item
) {

  const destination =
    train?.destination ||
    train?.to ||
    train?.destinationStation ||
    train?.endStation ||
    item?.destination ||
    item?.to ||
    item?.destinationStation;

  if (
    destination &&
    typeof destination === "object"
  ) {

    return (
      destination.code ||
      destination.name ||
      ""
    );
  }

  return (
    destination || ""
  );
}


// ============================================================
// ROUTE STATION LOOKUP
// ============================================================

function findRouteStop(
  route,
  stationCode
) {

  const code =
    normalizeCode(
      stationCode
    );

  if (
    !code ||
    !Array.isArray(route)
  ) {

    return null;
  }

  return (
    route.find(
      stop =>
        normalizeCode(
          stop?.stationCode ||
          stop?.code
        ) === code
    ) ||
    null
  );
}


function findRouteStopBySequence(
  route,
  sequence
) {

  const seq =
    Number(sequence);

  if (
    !Number.isFinite(seq) ||
    !Array.isArray(route)
  ) {

    return null;
  }

  return (
    route.find(
      stop =>
        Number(
          stop?.sequence
        ) === seq
    ) ||
    null
  );
}


// ============================================================
// ACTUAL GPS POSITION
// ============================================================
//
// This function ONLY accepts explicit actual coordinates.
//
// It does NOT calculate coordinates from route distance.
//
// ============================================================

function extractActualGpsPosition(
  train,
  live
) {

  const current =
    live?.currentLocation ||
    train?.currentLocation ||
    {};

  const candidates = [

    {
      lat:
        current.lat,

      lng:
        current.lng,

      source:
        "GPS"
    },

    {
      lat:
        current.latitude,

      lng:
        current.longitude,

      source:
        "GPS"
    },

    {
      lat:
        live?.lat,

      lng:
        live?.lng,

      source:
        "GPS"
    },

    {
      lat:
        live?.latitude,

      lng:
        live?.longitude,

      source:
        "GPS"
    },

    {
      lat:
        train?.lat,

      lng:
        train?.lng,

      source:
        "GPS"
    }

  ];


  for (
    const candidate of candidates
  ) {

    if (
      isValidCoordinate(
        candidate.lat,
        candidate.lng
      )
    ) {

      /*
       * If RailRadar explicitly says the position
       * is not actual, don't use it for gate closure.
       */

      if (
        current.isActualPosition === false
      ) {

        continue;
      }

      return {

        lat:
          Number(
            candidate.lat
          ),

        lng:
          Number(
            candidate.lng
          ),

        source:
          candidate.source,

        isActualPosition:
          true,

        speedKmh:
          toNumber(
            current.speedKmh ||
            current.speed
          ),

        bearingDegrees:
          toNumber(
            current.bearingDegrees ||
            current.bearing
          )

      };
    }
  }

  return null;
}


// ============================================================
// ACTUAL STATION-CODE POSITION
// ============================================================
//
// RailRadar can report:
//
// currentLocation.stationCode
// currentLocation.sequence
// currentLocation.isActualPosition
//
// With includeCoordinates=true, the matching route stop
// contains lat/lng.
//
// This is an ACTUAL station position.
//
// IMPORTANT:
// Being at GDR itself does NOT mean the train is at the
// crossing. The GDR station coordinate is roughly 1 km
// away from these gate coordinates, so distance is still
// calculated normally.
//
// ============================================================

function extractActualStationPosition(
  train,
  live
) {

  const current =
    live?.currentLocation ||
    train?.currentLocation ||
    {};

  if (
    current.isActualPosition !== true
  ) {

    return null;
  }

  const route =
    getRoute(
      train,
      live
    );

  if (
    route.length === 0
  ) {

    return null;
  }


  let stop =
    findRouteStopBySequence(
      route,
      current.sequence
    );


  if (
    !stop &&
    current.stationCode
  ) {

    stop =
      findRouteStop(
        route,
        current.stationCode
      );
  }


  if (!stop) {

    return null;
  }


  const lat =
    stop.lat ??
    stop.latitude;

  const lng =
    stop.lng ??
    stop.longitude;


  if (
    !isValidCoordinate(
      lat,
      lng
    )
  ) {

    return null;
  }


  return {

    lat:
      Number(lat),

    lng:
      Number(lng),

    source:
      "STATION_CODE",

    isActualPosition:
      true,

    speedKmh:
      toNumber(
        current.speedKmh ||
        current.speed
      ),

    bearingDegrees:
      toNumber(
        current.bearingDegrees ||
        current.bearing
      )

  };
}


// ============================================================
// BEST ACTUAL POSITION
// ============================================================

function getActualPosition(
  train,
  live
) {

  const gps =
    extractActualGpsPosition(
      train,
      live
    );

  if (gps) {

    return gps;
  }


  return (
    extractActualStationPosition(
      train,
      live
    )
  );
}


// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// Direction is determined using route sequence.
//
// If current sequence < GDR sequence:
//   TOWARD_GUDUR
//
// If current sequence > GDR sequence:
//   AWAY_FROM_GUDUR
//
// If exact sequence cannot be determined:
//   UNKNOWN
//
// ============================================================

function getRouteDirection(
  train,
  live
) {

  const route =
    getRoute(
      train,
      live
    );

  const current =
    live?.currentLocation ||
    train?.currentLocation ||
    {};

  const currentSequence =
    Number(
      current.sequence
    );


  if (
    !Number.isFinite(
      currentSequence
    ) ||
    route.length === 0
  ) {

    return "UNKNOWN";
  }


  const gdrStop =
    findRouteStop(
      route,
      "GDR"
    );


  if (!gdrStop) {

    return "UNKNOWN";
  }


  const gdrSequence =
    Number(
      gdrStop.sequence
    );


  if (
    !Number.isFinite(
      gdrSequence
    )
  ) {

    return "UNKNOWN";
  }


  if (
    currentSequence <
    gdrSequence
  ) {

    return "TOWARD_GUDUR";
  }


  if (
    currentSequence >
    gdrSequence
  ) {

    return "AWAY_FROM_GUDUR";
  }


  /*
   * At GDR.
   *
   * Use current status if available.
   */

  const status =
    normalizeText(
      current.status
    );


  if (
    status.includes(
      "DEPART"
    )
  ) {

    return "AWAY_FROM_GUDUR";
  }


  return "AT_GUDUR";
}


// ============================================================
// ROUTE CORRIDOR DETECTION
// ============================================================
//
// We identify the physical side of Gudur using route stations.
//
// Chennai-side anchors:
//   MAS / MMC / MS / PERAMBUR / AVADI / SPE / NYP
//
// Tirupati-side anchors:
//   TPTY / RU / KHT / VKI / YLK / KQA
//
// Route information is preferred over train origin text.
//
// ============================================================

function determinePhysicalCorridor(
  train,
  live,
  item
) {

  const route =
    getRoute(
      train,
      live
    );


  const routeCodes =
    route
      .map(
        stop =>
          normalizeCode(
            stop?.stationCode ||
            stop?.code
          )
      )
      .filter(Boolean);


  const masAnchors = [

    "MAS",
    "MMC",
    "MS",
    "PER",
    "AVD",
    "SPE",
    "NYP"

  ];


  const tptyAnchors = [

    "TPTY",
    "RU",
    "KHT",
    "VKI",
    "YLK",
    "KQA"

  ];


  const hasMasRoute =
    masAnchors.some(
      code =>
        routeCodes.includes(
          code
        )
    );


  const hasTptyRoute =
    tptyAnchors.some(
      code =>
        routeCodes.includes(
          code
        )
    );


  /*
   * We need the side BEFORE GDR.
   *
   * This prevents a train which shares stations elsewhere
   * in the route from being incorrectly assigned.
   */

  const gdrIndex =
    routeCodes.indexOf(
      "GDR"
    );


  if (
    gdrIndex >= 0
  ) {

    const beforeGdr =
      routeCodes.slice(
        0,
        gdrIndex
      );


    const masBefore =
      masAnchors.some(
        code =>
          beforeGdr.includes(
            code
          )
      );


    const tptyBefore =
      tptyAnchors.some(
        code =>
          beforeGdr.includes(
            code
          )
      );


    if (
      masBefore &&
      !tptyBefore
    ) {

      return "MAS";
    }


    if (
      tptyBefore &&
      !masBefore
    ) {

      return "TPTY";
    }


    if (
      masBefore &&
      tptyBefore
    ) {

      /*
       * Choose the anchor closest to GDR.
       */

      let lastMas =
        -1;

      let lastTpty =
        -1;


      for (
        const code of masAnchors
      ) {

        const index =
          beforeGdr.lastIndexOf(
            code
          );

        if (
          index >
          lastMas
        ) {

          lastMas =
            index;
        }
      }


      for (
        const code of tptyAnchors
      ) {

        const index =
          beforeGdr.lastIndexOf(
            code
          );

        if (
          index >
          lastTpty
        ) {

          lastTpty =
            index;
        }
      }


      if (
        lastMas >
        lastTpty
      ) {

        return "MAS";
      }


      if (
        lastTpty >
        lastMas
      ) {

        return "TPTY";
      }
    }
  }


  /*
   * Origin fallback.
   */

  const origin =
    getOrigin(
      train,
      item
    );


  if (
    containsAny(
      origin,
      [
        "CHENNAI",
        "MAS",
        "MGR CHENNAI CENTRAL",
        "AVADI",
        "PERAMBUR",
        "SULLURUPETA",
        "NAYUDUPETA"
      ]
    )
  ) {

    return "MAS";
  }


  if (
    containsAny(
      origin,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA",
        "RU"
      ]
    )
  ) {

    return "TPTY";
  }


  /*
   * Known fallback.
   */

  const trainNo =
    String(
      train?.number ||
      ""
    ).trim();


  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {

    return "TPTY";
  }


  return "UNKNOWN";
}


// ============================================================
// PHYSICAL GATE DISTANCES
// ============================================================

function calculateGateDistances(
  position
) {

  if (!position) {

    return {

      chennai:
        null,

      tirupati:
        null
    };
  }


  return {

    chennai:
      distanceKm(
        position.lat,
        position.lng,
        CHENNAI_GATE_LAT,
        CHENNAI_GATE_LNG
      ),

    tirupati:
      distanceKm(
        position.lat,
        position.lng,
        TIRUPATI_GATE_LAT,
        TIRUPATI_GATE_LNG
      )

  };
}


// ============================================================
// ACTUAL GATE CLOSURE
// ============================================================
//
// VERY IMPORTANT:
//
// We do NOT use:
//
//   route interpolation
//   ETA
//   scheduled arrival
//   estimated station distance
//
// to close the gate.
//
// We only close when:
//   - physical corridor is known
//   - actual position is known
//   - actual distance <= gate radius
//
// BOTH directions are allowed.
//
// ============================================================

function shouldCloseGate(
  corridor,
  actualPosition,
  gateDistances
) {

  if (
    !actualPosition ||
    actualPosition.isActualPosition !== true
  ) {

    return {

      close:
        false,

      reason:
        "NO_ACTUAL_POSITION"
    };
  }


  if (
    corridor === "MAS"
  ) {

    const distance =
      gateDistances.chennai;


    if (
      distance !== null &&
      distance <=
        GATE_STOP_DISTANCE_KM
    ) {

      return {

        close:
          true,

        gate:
          "MAS",

        distance
      };
    }


    return {

      close:
        false,

      gate:
        "MAS",

      distance
    };
  }


  if (
    corridor === "TPTY"
  ) {

    const distance =
      gateDistances.tirupati;


    if (
      distance !== null &&
      distance <=
        GATE_STOP_DISTANCE_KM
    ) {

      return {

        close:
          true,

        gate:
          "TPTY",

        distance
      };
    }


    return {

      close:
        false,

      gate:
        "TPTY",

      distance
    };
  }


  return {

    close:
      false,

    reason:
      "UNKNOWN_CORRIDOR"
  };
}


// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeValue,
  delayMinutes = 0
) {

  if (
    !timeValue
  ) {

    return -1;
  }


  let totalMinutes =
    -1;


  const date =
    new Date(
      timeValue
    );


  if (
    !isNaN(
      date.getTime()
    )
  ) {

    totalMinutes =
      date.getHours() *
        60 +

      date.getMinutes() +

      date.getSeconds() /
        60;
  }

  else {

    const match =
      String(
        timeValue
      )
        .trim()
        .match(
          /(\d{1,2}):(\d{2})(?::(\d{2}))?/
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
        ) +

        (
          parseInt(
            match[3] ||
              "0",
            10
          ) / 60
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
// CURRENT MINUTES
// ============================================================

function getCurrentMinutes() {

  const now =
    new Date();

  return (
    now.getHours() *
      60 +

    now.getMinutes() +

    now.getSeconds() /
      60
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

    diff +=
      1440;
  }


  if (
    diff > 720
  ) {

    diff -=
      1440;
  }


  return diff;
}


// ============================================================
// LIVE TRAIN REQUEST
// ============================================================

async function fetchLiveTrain(
  trainNo
) {

  const endpoints = [

    `/trains/${encodeURIComponent(trainNo)}/live`,

    `/trains/${encodeURIComponent(trainNo)}`,

    `/train/${encodeURIComponent(trainNo)}/live`

  ];


  for (
    const endpoint of endpoints
  ) {

    try {

      const response =
        await axios.get(
          `${RAILRADAR_BASE_URL}${endpoint}`,

          {

            headers: {

              Authorization:
                `Bearer ${RAILRADAR_API_KEY}`,

              Accept:
                "application/json"

            },

            params: {

              authoritative:
                true,

              includeCoordinates:
                true

            },

            timeout:
              15000
          }
        );


      return response.data;

    }

    catch (error) {

      const status =
        error?.response?.status;


      /*
       * Only try the next endpoint when the endpoint
       * itself doesn't exist.
       */

      if (
        status !== 404
      ) {

        throw error;
      }

    }
  }


  return null;
}


// ============================================================
// MERGE LIVE DATA
// ============================================================

function mergeVerifiedData(
  boardItem,
  liveResponse
) {

  const liveData =
    liveResponse?.data ||
    liveResponse ||
    {};


  const boardTrain =
    boardItem?.train ||
    {};


  const boardStop =
    boardItem?.stop ||
    {};


  const boardLive =
    boardItem?.live ||
    {};


  return {

    train: {

      ...boardTrain,

      ...(liveData.train || {})

    },

    stop: {

      ...boardStop,

      ...(liveData.stop || {})

    },

    live: {

      ...boardLive,

      ...(liveData.live || {})

    },

    currentLocation:
      liveData.currentLocation,

    previousHalt:
      liveData.previousHalt,

    nextHalt:
      liveData.nextHalt,

    route:
      liveData.route,

    delayMinutes:
      liveData.delayMinutes ??
      boardLive.delayMinutes ??
      0,

    isLive:
      liveData.isLive ??
      true,

    status:
      liveData.status,

    lastUpdatedAt:
      liveData.lastUpdatedAt

  };
}


// ============================================================
// UPCOMING TRAIN FILTER
// ============================================================
//
// Upcoming list:
//
// ONLY trains that are:
//
//   corridor MAS/TPTY
//   TOWARD_GUDUR
//   before GDR
//   within 150 km
//
// ============================================================

function shouldShowUpcoming(
  processed
) {

  if (!processed) {

    return false;
  }


  if (
    processed.corridor !== "MAS" &&
    processed.corridor !== "TPTY"
  ) {

    return false;
  }


  if (
    processed.direction !==
    "TOWARD_GUDUR"
  ) {

    return false;
  }


  if (
    processed.gdrDistanceKm === null ||
    processed.gdrDistanceKm >
      UPCOMING_MAX_DISTANCE_KM
  ) {

    return false;
  }


  return true;
}


// ============================================================
// ESTIMATE ETA FROM ACTUAL POSITION
// ============================================================

function estimateEtaMinutes(
  processed
) {

  /*
   * If actual GPS speed is available,
   * use physical distance to Gudur.
   */

  if (
    processed.actualPosition &&
    processed.gdrDistanceKm !== null
  ) {

    const speed =
      Number(
        processed.actualPosition.speedKmh
      );


    if (
      Number.isFinite(speed) &&
      speed >= MIN_SPEED_KMPH
    ) {

      return Math.max(
        0,
        Math.round(
          (
            processed.gdrDistanceKm /
            speed
          ) *
            60
        )
      );
    }
  }


  /*
   * Fall back to RailRadar station arrival/departure
   * timing when actual speed is unavailable.
   */

  const arrival =
    processed.arrivalTime;


  if (
    arrival
  ) {

    const currentMin =
      getCurrentMinutes();


    const arrivalMin =
      parseTimeToMinutes(
        arrival,
        processed.delayMinutes
      );


    if (
      arrivalMin !== -1
    ) {

      return Math.max(
        0,
        Math.round(
          calculateTimeDifference(
            arrivalMin,
            currentMin
          )
        )
      );
    }
  }


  /*
   * Last fallback:
   * approximate using default speed.
   */

  if (
    processed.gdrDistanceKm !== null
  ) {

    return Math.max(
      0,
      Math.round(
        (
          processed.gdrDistanceKm /
          DEFAULT_SPEED_KMPH
        ) *
          60
      )
    );
  }


  return 999;
}


// ============================================================
// PROCESS ONE VERIFIED TRAIN
// ============================================================

function processTrain(
  boardItem,
  verified
) {

  const train =
    verified.train ||
    {};

  const live =
    verified.live ||
    {};

  const stop =
    verified.stop ||
    {};

  const trainNo =
    String(
      train.number ||
      boardItem?.train?.number ||
      ""
    ).trim();


  if (!trainNo) {

    return null;
  }


  const trainName =
    train.name ||
    boardItem?.train?.name ||
    `Train ${trainNo}`;


  const origin =
    getOrigin(
      train,
      boardItem
    );


  const destination =
    getDestination(
      train,
      boardItem
    );


  const delayMinutes =
    Number(
      verified.delayMinutes ||
      live.delayMinutes ||
      0
    );


  const route =
    verified.route ||
    live.route ||
    train.route ||
    [];


  const direction =
    getRouteDirection(
      {
        ...train,
        route,
        currentLocation:
          verified.currentLocation
      },

      {
        ...live,
        route,
        currentLocation:
          verified.currentLocation
      }
    );


  const corridor =
    determinePhysicalCorridor(
      {
        ...train,
        route
      },

      {
        ...live,
        route,
        currentLocation:
          verified.currentLocation
      },

      boardItem
    );


  /*
   * Actual position.
   */

  const actualPosition =
    getActualPosition(
      {
        ...train,
        route,
        currentLocation:
          verified.currentLocation
      },

      {
        ...live,
        route,
        currentLocation:
          verified.currentLocation
      }
    );


  /*
   * GDR station route position.
   */

  let gdrDistanceKm =
    null;


  const currentLocation =
    verified.currentLocation ||
    live.currentLocation ||
    {};


  /*
   * If RailRadar supplies actual distance from origin
   * and route distances, use the route difference.
   */

  if (
    actualPosition
  ) {

    gdrDistanceKm =
      distanceKm(
        actualPosition.lat,
        actualPosition.lng,
        GDR_LAT,
        GDR_LNG
      );

  }


  /*
   * If no physical coordinate exists, use route station
   * distance for UPCOMING display only.
   */

  if (
    gdrDistanceKm === null
  ) {

    const gdrStop =
      findRouteStop(
        route,
        "GDR"
      );


    const currentStop =
      findRouteStopBySequence(
        route,
        currentLocation.sequence
      );


    if (
      gdrStop &&
      currentStop &&
      Number.isFinite(
        Number(
          gdrStop.distance
        )
      ) &&
      Number.isFinite(
        Number(
          currentStop.distance
        )
      )
    ) {

      gdrDistanceKm =
        Math.abs(
          Number(
            gdrStop.distance
          ) -
          Number(
            currentStop.distance
          )
        );
    }

    else if (
      Number.isFinite(
        Number(
          currentLocation.distanceFromOriginKm
        )
      ) &&
      gdrStop &&
      Number.isFinite(
        Number(
          gdrStop.distance
        )
      )
    ) {

      gdrDistanceKm =
        Math.abs(
          Number(
            gdrStop.distance
          ) -
          Number(
            currentLocation.distanceFromOriginKm
          )
        );
    }
  }


  /*
   * Arrival time.
   */

  const arrivalTime =
    stop.arrival ||
    live.expectedArrivalTime ||
    null;


  /*
   * Departure time.
   */

  const departureTime =
    stop.departure ||
    live.expectedDepartureTime ||
    null;


  /*
   * Physical gate distances.
   */

  const gateDistances =
    calculateGateDistances(
      actualPosition
    );


  /*
   * Actual gate closure decision.
   */

  const gateDecision =
    shouldCloseGate(
      corridor,
      actualPosition,
      gateDistances
    );


  /*
   * ETA.
   */

  const etaMinutes =
    estimateEtaMinutes({

      actualPosition,

      gdrDistanceKm,

      arrivalTime,

      delayMinutes

    });


  return {

    trainNo,

    name:
      trainName,

    origin:
      origin || "Unknown",

    destination:
      destination || "Gudur",

    corridor,

    direction,

    delayMinutes,

    actualPosition,

    positionSource:
      actualPosition
        ? actualPosition.source
        : "NONE",

    gdrDistanceKm,

    chennaiGateDistanceKm:
      gateDistances.chennai,

    tirupatiGateDistanceKm:
      gateDistances.tirupati,

    arrivalTime,

    departureTime,

    etaMinutes,

    platform:
      live.platform ||
      stop.platform ||
      "—",

    gateDecision

  };
}


// ============================================================
// FORMAT DISTANCE FOR LOG
// ============================================================

function formatDistance(
  value
) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    )
  ) {

    return "?km";
  }


  return (
    Number(value)
      .toFixed(2) +
    "km"
  );
}


// ============================================================
// MAIN MONITOR
// ============================================================

async function updateGateSystem() {

  const startedAt =
    Date.now();


  const now =
    new Date();


  console.log(
    "\n=========================================="
  );

  console.log(
    " RailRadar Real-time Gudur Gate Monitor "
  );

  console.log(
    "=========================================="
  );

  console.log(
    `[${now.toLocaleTimeString()}] Starting monitor cycle...`
  );


  let apiRequests =
    0;


  try {

    // ========================================================
    // STATION BOARD
    // ========================================================

    console.log(
      "\n[1] Querying RailRadar Live Station Board for GDR..."
    );


    apiRequests++;


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
              STATION_BOARD_HOURS

          },

          timeout:
            15000

        }
      );


    const boardData =
      boardResponse.data;


    const trainsArray =
      boardData?.data?.trains ||
      [];


    if (
      !Array.isArray(
        trainsArray
      )
    ) {

      throw new Error(
        "RailRadar returned invalid station-board data."
      );
    }


    console.log(
      `RailRadar returned ${trainsArray.length} board records.`
    );


    // ========================================================
    // CREATE VERIFICATION QUEUE
    // ========================================================

    const candidates =
      trainsArray
        .filter(
          item =>
            item?.train?.number
        )
        .slice(
          0,
          MAX_BOARD_CANDIDATES
        );


    console.log(
      `Verification queue: ${candidates.length}`
    );


    const verificationQueue =
      candidates.slice(
        0,
        MAX_LIVE_VERIFICATIONS
      );


    console.log(
      `Live verification: ${verificationQueue.length}`
    );


    // ========================================================
    // VERIFY LIVE TRAINS
    // ========================================================

    const verifiedTrains =
      [];


    for (
      let i = 0;
      i < verificationQueue.length;
      i++
    ) {

      const boardItem =
        verificationQueue[i];


      const trainNo =
        String(
          boardItem?.train?.number ||
          ""
        ).trim();


      if (!trainNo) {
        continue;
      }


      console.log(
        `\n[LIVE REQUEST ${i + 1}/${verificationQueue.length}] ${trainNo}`
      );


      try {

        apiRequests++;


        const liveResponse =
          await fetchLiveTrain(
            trainNo
          );


        if (
          !liveResponse
        ) {

          console.log(
            `[LIVE] ${trainNo} - no live response`
          );

          continue;
        }


        const merged =
          mergeVerifiedData(
            boardItem,
            liveResponse
          );


        const processed =
          processTrain(
            boardItem,
            merged
          );


        if (
          processed
        ) {

          verifiedTrains.push(
            processed
          );


          console.log(
            `[LIVE] ${processed.trainNo} ${processed.name}`
          );

          console.log(
            `       Direction: ${processed.direction}`
          );

          console.log(
            `       Corridor: ${processed.corridor}`
          );

          console.log(
            `       GDR: ${formatDistance(processed.gdrDistanceKm)}`
          );

          console.log(
            `       Chennai Gate: ${formatDistance(processed.chennaiGateDistanceKm)}`
          );

          console.log(
            `       Tirupati Gate: ${formatDistance(processed.tirupatiGateDistanceKm)}`
          );

          console.log(
            `       Position: ${processed.positionSource}`
          );


          if (
            processed.gateDecision?.close
          ) {

            console.log(
              `       🚨 GATE CLOSE: ${processed.gateDecision.gate} (${formatDistance(processed.gateDecision.distance)})`
            );
          }

        }

      }

      catch (error) {

        console.error(
          `[LIVE ERROR] ${trainNo}: ${error.message}`
        );
      }
    }


    // ========================================================
    // DEFAULT GATE STATES
    // ========================================================

    let masGate = {

      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        null,

      corridor:
        "MAS",

      distanceKm:
        null

    };


    let tptyGate = {

      status:
        "OPEN",

      waitMinutes:
        0,

      activeTrain:
        "Tracks clear",

      direction:
        null,

      corridor:
        "TPTY",

      distanceKm:
        null

    };


    // ========================================================
    // UPCOMING TRAINS
    // ========================================================

    const upcomingList =
      [];


    // ========================================================
    // PROCESS VERIFIED TRAINS
    // ========================================================

    for (
      const processed of verifiedTrains
    ) {

      /*
       * ------------------------------------------------------
       * ACTUAL GATE CLOSURE
       * ------------------------------------------------------
       */

      if (
        processed.gateDecision?.close
      ) {

        const gate =
          processed.gateDecision.gate;


        const distance =
          processed.gateDecision.distance;


        const speed =
          Number(
            processed.actualPosition?.speedKmh
          );


        let waitMinutes =
          2;


        /*
         * Estimate a small remaining crossing window
         * from actual distance and speed.
         */

        if (
          Number.isFinite(speed) &&
          speed >= MIN_SPEED_KMPH
        ) {

          waitMinutes =
            Math.max(
              1,
              Math.ceil(
                (
                  distance /
                  speed
                ) *
                60
              ) + 1
            );
        }


        /*
         * Cap display value.
         */

        waitMinutes =
          Math.min(
            waitMinutes,
            15
          );


        const label =
          `${processed.trainNo} ${processed.name}`;


        const payload = {

          status:
            "CLOSED",

          waitMinutes,

          activeTrain:
            label,

          direction:
            processed.direction,

          corridor:
            processed.corridor,

          distanceKm:
            Number(
              distance.toFixed(3)
            ),

          positionSource:
            processed.positionSource,

          speedKmh:
            Number.isFinite(
              speed
            )
              ? speed
              : null

        };


        if (
          gate === "MAS"
        ) {

          /*
           * If multiple trains are close,
           * keep the one closest to the gate.
           */

          if (
            masGate.status !== "CLOSED" ||
            distance <
              Number(
                masGate.distanceKm ??
                Infinity
              )
          ) {

            masGate =
              payload;
          }
        }


        if (
          gate === "TPTY"
        ) {

          if (
            tptyGate.status !== "CLOSED" ||
            distance <
              Number(
                tptyGate.distanceKm ??
                Infinity
              )
          ) {

            tptyGate =
              payload;
          }
        }
      }


      /*
       * ------------------------------------------------------
       * UPCOMING INBOUND TRAINS
       * ------------------------------------------------------
       */

      if (
        shouldShowUpcoming(
          processed
        )
      ) {

        upcomingList.push({

          trainNo:
            processed.trainNo,

          name:
            processed.name,

          origin:
            processed.origin,

          destination:
            processed.destination,

          etaMinutes:
            processed.etaMinutes,

          delayMinutes:
            processed.delayMinutes,

          corridor:
            processed.corridor,

          direction:
            "TOWARD GUDUR",

          platform:
            processed.platform,

          gdrDistanceKm:
            processed.gdrDistanceKm,

          positionSource:
            processed.positionSource

        });
      }
    }


    // ========================================================
    // SORT UPCOMING
    // ========================================================

    upcomingList.sort(
      (a, b) =>
        Number(
          a.etaMinutes || 9999
        ) -
        Number(
          b.etaMinutes || 9999
        )
    );


    const topUpcoming =
      upcomingList.slice(
        0,
        5
      );


    // ========================================================
    // MONITOR STATUS
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        startedAt
      ) / 1000;


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

      lastUpdatedLocal:
        now.toLocaleString(),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedAtMs:
        Date.now(),

      verifiedTrains:
        verifiedTrains.length,

      apiRequests,

      monitorStatus:
        "OK",

      monitorDurationSeconds:
        Number(
          durationSeconds.toFixed(
            1
          )
        )

    });


    // ========================================================
    // SUCCESS
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
      ` -> Chennai Gate : ${masGate.status} | ${masGate.activeTrain}`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} | ${tptyGate.activeTrain}`
    );

    console.log(
      ` -> Verified trains: ${verifiedTrains.length}`
    );

    console.log(
      ` -> Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      ` -> API requests: ${apiRequests}`
    );

    console.log(
      ` -> Cycle duration: ${durationSeconds.toFixed(1)}s`
    );


    if (
      topUpcoming.length > 0
    ) {

      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );


      topUpcoming.forEach(
        train => {

          console.log(

            `   ${train.corridor} | ` +
            `${train.trainNo} ${train.name} | ` +
            `ETA ${train.etaMinutes}m | ` +
            `GDR ${formatDistance(train.gdrDistanceKm)} | ` +
            `${train.positionSource}`

          );
        }
      );

    }

    else {

      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }


    return true;

  }

  catch (error) {

    console.error(
      "\n=========================================="
    );

    console.error(
      "❌ MONITOR ERROR"
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

    }

    else {

      console.error(
        error.message
      );
    }


    /*
     * Keep Firebase showing a safe known state
     * when the monitor itself fails.
     */

    try {

      await gateRef.set({

        tirupatiGate: {

          status:
            "OPEN",

          waitMinutes:
            0,

          activeTrain:
            "Monitor error",

          corridor:
            "TPTY"

        },

        chennaiGate: {

          status:
            "OPEN",

          waitMinutes:
            0,

          activeTrain:
            "Monitor error",

          corridor:
            "MAS"

        },

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

        verifiedTrains:
          0,

        apiRequests,

        monitorStatus:
          "ERROR",

        error:
          error.message

      });

    }

    catch (firebaseError) {

      console.error(
        "Firebase error while writing ERROR state:",
        firebaseError.message
      );
    }


    return false;
  }
}


// ============================================================
// START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gudur Gate Monitor "
);

console.log(
  "=========================================="
);

console.log(
  `Gudur Station: ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  `Chennai Gate:  ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  `Tirupati Gate: ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  "=========================================="
);

console.log(
  "RailRadar API: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "=========================================="
);

console.log(
  "GATE LOGIC:"
);

console.log(
  "Chennai Gate = BOTH DIRECTIONS"
);

console.log(
  "Tirupati Gate = BOTH DIRECTIONS"
);

console.log(
  `Physical gate radius = ${GATE_STOP_DISTANCE_KM} km`
);

console.log(
  "Route interpolation NEVER closes a gate."
);

console.log(
  "=========================================="
);


// ============================================================
// GITHUB ACTIONS
// ============================================================
//
// GitHub scheduled workflow starts one monitor cycle and exits.
//
// ============================================================

if (
  process.env.GITHUB_ACTIONS
) {

  updateGateSystem()
    .then(
      success => {

        console.log(
          "\n=========================================="
        );

        console.log(
          " GitHub Actions monitor cycle completed "
        );

        console.log(
          "=========================================="
        );


        /*
         * Do not leave Node running inside GitHub Actions.
         */

        process.exit(
          success
            ? 0
            : 1
        );
      }
    )

    .catch(
      error => {

        console.error(
          "\n❌ Monitor cycle failed:"
        );

        console.error(
          error
        );

        process.exit(1);
      }
    );

}

else {

  /*
   * Local development mode.
   */

  updateGateSystem();


  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}
