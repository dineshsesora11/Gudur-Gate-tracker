const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR GATE TRACKER
// COMPLETE CORRECTED VERSION
// ============================================================
//
// IMPORTANT DESIGN:
//
// UPCOMING TRAINS
// ----------------
// Uses the RailRadar GDR station board.
//
// GPS is NOT required for an upcoming train.
//
// GATE CONTROL
// ------------
// Uses RailRadar live train data.
//
// GPS IS REQUIRED for WARNING/CLOSED.
//
// Therefore:
//
// Station board ETA  -> Upcoming Trains
//
// Live GPS           -> Gate WARNING/CLOSED
//
// If live GPS is unavailable:
//     Upcoming train can still be displayed.
//     Gate MUST remain OPEN.
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
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing and serviceAccountKey.json was not found."
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


// ============================================================
// FIREBASE INITIALIZATION
// ============================================================

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
//
// Keep the API key in GitHub Actions:
//
// Repository
// -> Settings
// -> Secrets and variables
// -> Actions
// -> RAILRADAR_API_KEY
//
// DO NOT hard-code the key here.
//

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
// GUDUR STATION
// ============================================================

const GDR = {
  lat: 14.14842,
  lng: 79.84524
};


// ============================================================
// CROSSING LOCATIONS
// ============================================================

const CHENNAI_GATE = {
  lat: 14.1396639,
  lng: 79.8441306
};

const TIRUPATI_GATE = {
  lat: 14.1402056,
  lng: 79.8436000
};


// ============================================================
// SYSTEM SETTINGS
// ============================================================

// Upcoming trains shown up to 4 hours.
const UPCOMING_WINDOW_MINUTES = 240;

// Gate warning distance.
const GATE_WARNING_DISTANCE_KM = 1.00;

// Gate closure distance.
const GATE_CLOSE_DISTANCE_KM = 0.60;

// Gate clears after train is outside this distance.
const GATE_CLEAR_DISTANCE_KM = 0.80;

// Maximum live train requests per cycle.
const MAX_LIVE_REQUESTS = 8;

// GitHub Actions normally runs every 5 minutes.
const REFRESH_INTERVAL_MS =
  5 * 60 * 1000;


// ============================================================
// APPROVED TIRUPATI-SIDE TRAINS
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
// APPROVED CHENNAI-SIDE TRAINS
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
// APPROVED OTHER / SPECIAL TRAINS
// ============================================================

const OTHER_TRAINS =
  new Set([
    "12743",
    "12744",
    "20498",
    "67226"
  ]);


// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeText(value) {
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


// ============================================================
// NUMBER CONVERSION
// ============================================================

function toNumber(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return String(
    train?.number ||
    train?.trainNumber ||
    item?.trainNumber ||
    item?.number ||
    ""
  ).trim();
}


// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  train,
  trainNo
) {
  return (
    train?.name ||
    train?.trainName ||
    `Train ${trainNo}`
  );
}


// ============================================================
// TRAIN ORIGIN
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
    item?.origin ||
    item?.source ||
    item?.from ||
    item?.fromStation ||
    item?.startStation ||
    ""
  );
}


// ============================================================
// TRAIN DESTINATION
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
// CORRIDOR
// ============================================================
//
// STRICT TRAIN-NUMBER BASED CLASSIFICATION.
//
// MAS:
// Chennai-side approved trains.
//
// TPTY:
// Tirupati-side approved trains.
//
// OTHER:
// Special approved trains.
//
// Unknown:
// ignored.
//

function determineCorridor(
  trainNo
) {
  const number =
    String(trainNo).trim();

  if (
    TPTY_TRAINS.has(number)
  ) {
    return "TPTY";
  }

  if (
    MAS_TRAINS.has(number)
  ) {
    return "MAS";
  }

  if (
    OTHER_TRAINS.has(number)
  ) {
    return "OTHER";
  }

  return null;
}


// ============================================================
// APPROVED TRAIN CHECK
// ============================================================

function isApprovedTrain(
  trainNo
) {
  return (
    TPTY_TRAINS.has(trainNo) ||
    MAS_TRAINS.has(trainNo) ||
    OTHER_TRAINS.has(trainNo)
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
      (lat1 * Math.PI) / 180
    ) *

    Math.cos(
      (lat2 * Math.PI) / 180
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
// COORDINATE EXTRACTION
// ============================================================

function extractLatLng(
  object
) {
  if (
    !object ||
    typeof object !== "object"
  ) {
    return null;
  }

  const pairs = [
    ["lat", "lng"],
    ["latitude", "longitude"],
    ["latitude", "lng"],
    ["lat", "longitude"]
  ];

  for (
    const [
      latKey,
      lngKey
    ] of pairs
  ) {
    const lat =
      toNumber(
        object[latKey]
      );

    const lng =
      toNumber(
        object[lngKey]
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
  }

  return null;
}


// ============================================================
// DEEP GPS SEARCH
// ============================================================

function findGpsDeep(
  object,
  depth = 0,
  maxDepth = 5
) {
  if (
    !object ||
    typeof object !== "object" ||
    depth > maxDepth
  ) {
    return null;
  }

  const direct =
    extractLatLng(
      object
    );

  if (direct) {
    return {
      ...direct,
      source: "nested"
    };
  }

  for (
    const key of Object.keys(object)
  ) {
    const value =
      object[key];

    if (
      value &&
      typeof value === "object"
    ) {
      const found =
        findGpsDeep(
          value,
          depth + 1,
          maxDepth
        );

      if (found) {
        return found;
      }
    }
  }

  return null;
}


// ============================================================
// CURRENT GPS
// ============================================================

function extractCurrentGps(
  liveData
) {
  if (
    !liveData ||
    typeof liveData !== "object"
  ) {
    return null;
  }

  const priorityObjects = [
    liveData.currentLocation,
    liveData.currentPosition,
    liveData.position,
    liveData.location,

    liveData.coordinates,

    liveData.live?.currentLocation,
    liveData.live?.currentPosition,
    liveData.live?.position,
    liveData.live?.location,

    liveData.data?.currentLocation,
    liveData.data?.currentPosition,
    liveData.data?.position,
    liveData.data?.location,

    liveData.train?.currentLocation
  ];

  for (
    const object of priorityObjects
  ) {
    const gps =
      extractLatLng(
        object
      );

    if (gps) {
      return {
        ...gps,
        source: "currentLocation"
      };
    }
  }

  return findGpsDeep(
    liveData
  );
}


// ============================================================
// SPEED
// ============================================================

function getSpeedKmh(
  liveData
) {
  const locations = [
    liveData?.currentLocation,
    liveData?.currentPosition,
    liveData?.position,
    liveData?.location,
    liveData?.live?.currentLocation,
    liveData?.live?.currentPosition
  ].filter(Boolean);

  for (
    const location of locations
  ) {
    const speed =
      toNumber(
        location.speedKmh
      ) ??
      toNumber(
        location.speed
      ) ??
      toNumber(
        location.speedKmH
      );

    if (
      speed !== null &&
      speed >= 0 &&
      speed <= 200
    ) {
      return speed;
    }
  }

  const directSpeed =
    toNumber(
      liveData?.speedKmh
    ) ??
    toNumber(
      liveData?.speed
    );

  if (
    directSpeed !== null &&
    directSpeed >= 0 &&
    directSpeed <= 200
  ) {
    return directSpeed;
  }

  return 55;
}


// ============================================================
// BEARING
// ============================================================

function getBearing(
  liveData
) {
  const locations = [
    liveData?.currentLocation,
    liveData?.currentPosition,
    liveData?.position,
    liveData?.location,
    liveData?.live?.currentLocation,
    liveData?.live?.currentPosition
  ].filter(Boolean);

  for (
    const location of locations
  ) {
    const bearing =
      toNumber(
        location.bearingDegrees
      ) ??
      toNumber(
        location.bearing
      ) ??
      toNumber(
        location.heading
      );

    if (
      bearing !== null &&
      bearing >= 0 &&
      bearing <= 360
    ) {
      return bearing;
    }
  }

  return null;
}


// ============================================================
// BEARING BETWEEN TWO POINTS
// ============================================================

function bearingBetween(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const phi1 =
    lat1 *
    Math.PI /
    180;

  const phi2 =
    lat2 *
    Math.PI /
    180;

  const lambda1 =
    lng1 *
    Math.PI /
    180;

  const lambda2 =
    lng2 *
    Math.PI /
    180;

  const y =
    Math.sin(
      lambda2 -
      lambda1
    ) *
    Math.cos(phi2);

  const x =
    Math.cos(phi1) *
      Math.sin(phi2) -

    Math.sin(phi1) *
      Math.cos(phi2) *
      Math.cos(
        lambda2 -
        lambda1
      );

  let bearing =
    Math.atan2(
      y,
      x
    ) *
    180 /
    Math.PI;

  return (
    bearing + 360
  ) % 360;
}


// ============================================================
// ANGULAR DIFFERENCE
// ============================================================

function angularDifference(
  a,
  b
) {
  let difference =
    Math.abs(
      a - b
    );

  if (
    difference > 180
  ) {
    difference =
      360 -
      difference;
  }

  return difference;
}


// ============================================================
// GPS VALIDATION
// ============================================================

function isGpsUsable(
  gps
) {
  if (!gps) {
    return false;
  }

  if (
    !Number.isFinite(
      gps.lat
    ) ||
    !Number.isFinite(
      gps.lng
    )
  ) {
    return false;
  }

  if (
    Math.abs(gps.lat) > 90 ||
    Math.abs(gps.lng) > 180
  ) {
    return false;
  }

  return true;
}


// ============================================================
// LIVE RESPONSE EXTRACTION
// ============================================================

function extractLiveData(
  responseBody
) {
  if (!responseBody) {
    return null;
  }

  if (
    responseBody.data &&
    typeof responseBody.data ===
      "object"
  ) {
    return responseBody.data;
  }

  return responseBody;
}


// ============================================================
// CURRENT STATION CODE
// ============================================================

function getCurrentStationCode(
  liveData
) {
  return (
    liveData?.currentLocation?.stationCode ||
    liveData?.currentLocation?.code ||
    liveData?.currentPosition?.stationCode ||
    liveData?.currentPosition?.code ||
    liveData?.stationCode ||
    ""
  );
}


// ============================================================
// CURRENT STATION NAME
// ============================================================

function getCurrentStationName(
  liveData
) {
  return (
    liveData?.currentLocation?.stationName ||
    liveData?.currentLocation?.station?.name ||
    liveData?.currentPosition?.stationName ||
    liveData?.stationName ||
    ""
  );
}


// ============================================================
// IS TRAIN AT GUDUR?
// ============================================================

function isAtGudur(
  liveData
) {
  const code =
    normalizeText(
      getCurrentStationCode(
        liveData
      )
    ).replace(
      /\s/g,
      ""
    );

  const name =
    normalizeText(
      getCurrentStationName(
        liveData
      )
    );

  if (
    code === "GDR" ||
    name === "GDR" ||
    name.includes("GUDUR")
  ) {
    return true;
  }

  const gps =
    extractCurrentGps(
      liveData
    );

  if (!gps) {
    return false;
  }

  const distance =
    distanceKm(
      gps.lat,
      gps.lng,
      GDR.lat,
      GDR.lng
    );

  return (
    distance <= 0.20
  );
}


// ============================================================
// ROUTE EXTRACTION
// ============================================================

function getRoute(
  liveData
) {
  const candidates = [
    liveData?.route?.stops,
    liveData?.route,
    liveData?.stops,
    liveData?.stations,
    liveData?.trainRoute,

    liveData?.data?.route?.stops,
    liveData?.data?.route,
    liveData?.data?.stops,
    liveData?.data?.stations,
    liveData?.data?.trainRoute
  ];

  for (
    const candidate of candidates
  ) {
    if (
      Array.isArray(candidate)
    ) {
      return candidate;
    }

    if (
      candidate &&
      typeof candidate ===
        "object"
    ) {
      if (
        Array.isArray(
          candidate.stops
        )
      ) {
        return candidate.stops;
      }

      if (
        Array.isArray(
          candidate.stations
        )
      ) {
        return candidate.stations;
      }
    }
  }

  return [];
}


// ============================================================
// STOP CODE
// ============================================================

function getStopCode(
  stop
) {
  return (
    stop?.code ||
    stop?.stationCode ||
    stop?.station?.code ||
    stop?.station?.stationCode ||
    ""
  );
}


// ============================================================
// STOP NAME
// ============================================================

function getStopName(
  stop
) {
  return (
    stop?.name ||
    stop?.stationName ||
    stop?.station ||
    stop?.station?.name ||
    stop?.code ||
    stop?.stationCode ||
    ""
  );
}


// ============================================================
// ROUTE SEQUENCE
// ============================================================

function getStopSequence(
  stop,
  fallback
) {
  return (
    toNumber(
      stop?.sequence
    ) ??
    toNumber(
      stop?.seq
    ) ??
    toNumber(
      stop?.index
    ) ??
    toNumber(
      stop?.stopSequence
    ) ??
    fallback
  );
}


// ============================================================
// FIND GDR IN ROUTE
// ============================================================

function findGdrRouteIndex(
  route
) {
  for (
    let i = 0;
    i < route.length;
    i++
  ) {
    const code =
      normalizeText(
        getStopCode(
          route[i]
        )
      ).replace(
        /\s/g,
        ""
      );

    const name =
      normalizeText(
        getStopName(
          route[i]
        )
      );

    if (
      code === "GDR" ||
      name === "GDR" ||
      name.includes("GUDUR")
    ) {
      return i;
    }
  }

  return -1;
}


// ============================================================
// FIND CURRENT ROUTE INDEX
// ============================================================

function findCurrentRouteIndex(
  liveData,
  route
) {
  if (
    !route.length
  ) {
    return -1;
  }

  const currentValues = [
    liveData?.currentLocation?.stationCode,
    liveData?.currentLocation?.code,
    liveData?.currentLocation?.stationName,
    liveData?.currentLocation?.station?.code,
    liveData?.currentLocation?.station?.name,

    liveData?.currentPosition?.stationCode,
    liveData?.currentPosition?.code,
    liveData?.currentPosition?.stationName,

    liveData?.stationCode,
    liveData?.stationName
  ]
    .filter(Boolean)
    .map(
      normalizeText
    );

  if (
    currentValues.length
  ) {
    for (
      let i = 0;
      i < route.length;
      i++
    ) {
      const stopCode =
        normalizeText(
          getStopCode(
            route[i]
          )
        );

      const stopName =
        normalizeText(
          getStopName(
            route[i]
          )
        );

      if (
        currentValues.some(
          value =>
            value ===
              stopCode ||
            value ===
              stopName ||
            value.includes(
              stopCode
            ) ||
            value.includes(
              stopName
            )
        )
      ) {
        return i;
      }
    }
  }

  const sequence =
    toNumber(
      liveData?.currentLocation?.sequence
    ) ??
    toNumber(
      liveData?.currentLocation?.stopSequence
    ) ??
    toNumber(
      liveData?.currentPosition?.sequence
    ) ??
    toNumber(
      liveData?.currentPosition?.stopSequence
    );

  if (
    sequence !== null
  ) {
    let bestIndex =
      -1;

    let bestDifference =
      Infinity;

    route.forEach(
      (
        stop,
        index
      ) => {
        const stopSequence =
          getStopSequence(
            stop,
            index
          );

        const difference =
          Math.abs(
            stopSequence -
            sequence
          );

        if (
          difference <
          bestDifference
        ) {
          bestDifference =
            difference;

          bestIndex =
            index;
        }
      }
    );

    return bestIndex;
  }

  return -1;
}


// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// current index < GDR index
//      => TOWARD_GUDUR
//
// current index > GDR index
//      => FROM_GUDUR
//
// current index === GDR index
//      => AT_GUDUR
//
// ============================================================

function determineDirection(
  liveData
) {
  const route =
    getRoute(
      liveData
    );

  const gdrIndex =
    findGdrRouteIndex(
      route
    );

  const gps =
    extractCurrentGps(
      liveData
    );

  if (
    isAtGudur(
      liveData
    )
  ) {
    return "AT_GUDUR";
  }

  if (
    gdrIndex >= 0
  ) {
    const currentIndex =
      findCurrentRouteIndex(
        liveData,
        route
      );

    if (
      currentIndex >= 0
    ) {
      if (
        currentIndex <
        gdrIndex
      ) {
        return "TOWARD_GUDUR";
      }

      if (
        currentIndex >
        gdrIndex
      ) {
        return "FROM_GUDUR";
      }

      return "AT_GUDUR";
    }
  }

  // If route data is unavailable,
  // do not guess direction from GPS alone.
  //
  // GPS can be used for distance,
  // but not for directional classification.

  if (
    gps
  ) {
    const distance =
      distanceKm(
        gps.lat,
        gps.lng,
        GDR.lat,
        GDR.lng
      );

    if (
      distance <= 0.20
    ) {
      return "AT_GUDUR";
    }
  }

  return "UNKNOWN";
}


// ============================================================
// LIVE METADATA
// ============================================================

function getLiveTimestamp(
  liveData
) {
  return (
    liveData?.currentLocation?.timestamp ||
    liveData?.currentLocation?.updatedAt ||
    liveData?.currentLocation?.lastUpdated ||
    liveData?.timestamp ||
    liveData?.updatedAt ||
    null
  );
}


// ============================================================
// LIVE POSITION AGE
// ============================================================

function getPositionAgeMinutes(
  liveData
) {
  const timestamp =
    getLiveTimestamp(
      liveData
    );

  if (!timestamp) {
    return null;
  }

  const parsed =
    new Date(
      timestamp
    );

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return null;
  }

  return Math.max(
    0,
    (
      Date.now() -
      parsed.getTime()
    ) /
      60000
  );
}


// ============================================================
// GATE DISTANCE
// ============================================================

function getGateDistance(
  gps,
  corridor
) {
  if (
    !gps ||
    !isGpsUsable(gps)
  ) {
    return null;
  }

  if (
    corridor === "MAS"
  ) {
    return distanceKm(
      gps.lat,
      gps.lng,
      CHENNAI_GATE.lat,
      CHENNAI_GATE.lng
    );
  }

  if (
    corridor === "TPTY"
  ) {
    return distanceKm(
      gps.lat,
      gps.lng,
      TIRUPATI_GATE.lat,
      TIRUPATI_GATE.lng
    );
  }

  return null;
}


// ============================================================
// GDR DISTANCE
// ============================================================

function getGdrDistance(
  gps
) {
  if (
    !gps ||
    !isGpsUsable(gps)
  ) {
    return null;
  }

  return distanceKm(
    gps.lat,
    gps.lng,
    GDR.lat,
    GDR.lng
  );
}


// ============================================================
// ETA FROM LIVE GPS
// ============================================================

function calculateGpsEta(
  distance,
  speedKmh
) {
  if (
    distance === null ||
    distance < 0
  ) {
    return null;
  }

  const usableSpeed =
    speedKmh > 5
      ? speedKmh
      : 55;

  return Math.max(
    0,
    Math.round(
      (
        distance /
        usableSpeed
      ) *
        60
    )
  );
}


// ============================================================
// TIME PARSING
// ============================================================

function parseDateValue(
  value
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
    return Number.isNaN(
      value.getTime()
    )
      ? null
      : value;
  }

  const direct =
    new Date(
      value
    );

  if (
    !Number.isNaN(
      direct.getTime()
    )
  ) {
    return direct;
  }

  return null;
}


// ============================================================
// EXTRACT BOARD TIME VALUE
// ============================================================

function getBoardTimeValue(
  stop,
  live,
  item
) {
  return (
    stop?.expectedArrival ||
    stop?.expectedArrivalTime ||
    stop?.arrivalExpected ||
    stop?.arrivalTime ||
    stop?.arrival ||
    live?.expectedArrival ||
    live?.expectedArrivalTime ||
    live?.expectedArrivalTimeLocal ||
    item?.expectedArrival ||
    item?.expectedArrivalTime ||
    item?.arrival ||
    item?.arrivalTime ||
    null
  );
}


// ============================================================
// PARSE TIME STRING
// ============================================================
//
// Handles:
//
// 17:20
// 05:20 PM
// ISO datetime
// ============================================================

function parseTimeOnToday(
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

  const direct =
    parseDateValue(
      value
    );

  if (
    direct
  ) {
    return direct;
  }

  const text =
    String(
      value
    ).trim();

  const match =
    text.match(
      /^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i
    );

  if (
    !match
  ) {
    return null;
  }

  let hour =
    Number(
      match[1]
    );

  const minute =
    Number(
      match[2]
    );

  const ampm =
    match[3]
      ? match[3].toUpperCase()
      : null;

  if (
    ampm === "PM" &&
    hour < 12
  ) {
    hour += 12;
  }

  if (
    ampm === "AM" &&
    hour === 12
  ) {
    hour = 0;
  }

  const result =
    new Date(
      now
    );

  result.setHours(
    hour,
    minute,
    0,
    0
  );

  // If the board time has already passed by
  // a very large amount, assume tomorrow.
  //
  // This protects midnight crossing.

  const difference =
    (
      result.getTime() -
      now.getTime()
    ) /
    60000;

  if (
    difference <
    -720
  ) {
    result.setDate(
      result.getDate() + 1
    );
  }

  return result;
}


// ============================================================
// BOARD ETA
// ============================================================

function getBoardEtaMinutes(
  item,
  now
) {
  const stop =
    item?.stop || {};

  const live =
    item?.live || {};

  const rawTime =
    getBoardTimeValue(
      stop,
      live,
      item
    );

  if (
    !rawTime
  ) {
    return null;
  }

  const arrival =
    parseTimeOnToday(
      rawTime,
      now
    );

  if (
    !arrival
  ) {
    return null;
  }

  const delay =
    Number(
      live?.delayMinutes ||
      item?.delayMinutes ||
      0
    );

  const adjusted =
    new Date(
      arrival
    );

  adjusted.setMinutes(
    adjusted.getMinutes() +
    (
      Number.isFinite(
        delay
      )
        ? delay
        : 0
    )
  );

  const difference =
    (
      adjusted.getTime() -
      now.getTime()
    ) /
    60000;

  return Math.round(
    difference
  );
}


// ============================================================
// BOARD DELAY
// ============================================================

function getBoardDelay(
  item
) {
  const delay =
    Number(
      item?.live?.delayMinutes ??
      item?.delayMinutes ??
      item?.train?.delayMinutes ??
      0
    );

  return Number.isFinite(
    delay
  )
    ? delay
    : 0;
}


// ============================================================
// BOARD STATUS
// ============================================================

function getBoardStatus(
  item
) {
  return (
    item?.live?.status ||
    item?.status ||
    item?.stop?.status ||
    ""
  );
}


// ============================================================
// BOARD TRAIN RECORD
// ============================================================
//
// THIS IS THE KEY FIX.
//
// We create an Upcoming Train record directly from
// the GDR station board.
//
// No live GPS is required.
//
// ============================================================

function buildUpcomingFromBoard(
  item,
  now
) {
  const train =
    item?.train || {};

  const trainNo =
    getTrainNumber(
      train,
      item
    );

  if (
    !trainNo
  ) {
    return null;
  }

  const corridor =
    determineCorridor(
      trainNo
    );

  if (
    !corridor
  ) {
    return null;
  }

  const etaMinutes =
    getBoardEtaMinutes(
      item,
      now
    );

  if (
    etaMinutes === null
  ) {
    return null;
  }

  // Do not show trains that already passed.
  if (
    etaMinutes < -15
  ) {
    return null;
  }

  // Only show the next 4 hours.
  if (
    etaMinutes >
    UPCOMING_WINDOW_MINUTES
  ) {
    return null;
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

  const delay =
    getBoardDelay(
      item
    );

  const stop =
    item?.stop || {};

  const live =
    item?.live || {};

  return {
    trainNo,

    name:
      getTrainName(
        train,
        trainNo
      ),

    origin:
      origin ||
      (
        corridor === "MAS"
          ? "Chennai side"
          : corridor === "TPTY"
            ? "Tirupati side"
            : "Southern corridor"
      ),

    destination:
      destination ||
      "Gudur",

    corridor,

    direction:
      "TOWARD GUDUR",

    etaMinutes:
      Math.max(
        0,
        etaMinutes
      ),

    delayMinutes:
      delay,

    platform:
      String(
        live?.platform ||
        stop?.platform ||
        item?.platform ||
        "1"
      ),

    positionVerified:
      false,

    positionSource:
      "STATION_BOARD",

    gpsAvailable:
      false,

    gateWarning:
      false,

    gateClosed:
      false,

    distanceKm:
      null,

    gateDistanceKm:
      null
  };
}


// ============================================================
// DEDUPLICATE UPCOMING
// ============================================================

function deduplicateUpcoming(
  trains
) {
  const map =
    new Map();

  for (
    const train of trains
  ) {
    if (
      !train?.trainNo
    ) {
      continue;
    }

    const existing =
      map.get(
        train.trainNo
      );

    if (
      !existing
    ) {
      map.set(
        train.trainNo,
        train
      );

      continue;
    }

    const existingEta =
      Number(
        existing.etaMinutes ??
        99999
      );

    const newEta =
      Number(
        train.etaMinutes ??
        99999
      );

    if (
      newEta <
      existingEta
    ) {
      map.set(
        train.trainNo,
        train
      );
    }
  }

  return [
    ...map.values()
  ];
}


// ============================================================
// FIND LIVE CANDIDATES
// ============================================================
//
// We prioritize trains that are closest in board ETA.
//
// This means the API requests are spent on trains most
// likely to need gate control soon.
//

function findLiveCandidates(
  board,
  now
) {
  const candidates =
    [];

  for (
    const item of board
  ) {
    const train =
      item?.train || {};

    const trainNo =
      getTrainNumber(
        train,
        item
      );

    if (
      !trainNo
    ) {
      continue;
    }

    const corridor =
      determineCorridor(
        trainNo
      );

    if (
      corridor !== "MAS" &&
      corridor !== "TPTY"
    ) {
      continue;
    }

    const eta =
      getBoardEtaMinutes(
        item,
        now
      );

    candidates.push({
      trainNo,
      etaMinutes:
        eta === null
          ? 99999
          : eta
    });
  }

  candidates.sort(
    (
      a,
      b
    ) =>
      a.etaMinutes -
      b.etaMinutes
  );

  return candidates;
}


// ============================================================
// RAILRADAR GET
// ============================================================

let requestsThisCycle =
  0;

async function railRadarGet(
  path,
  params = {}
) {
  if (
    requestsThisCycle >=
    MAX_LIVE_REQUESTS
  ) {
    throw new Error(
      "RailRadar request limit reached for this cycle."
    );
  }

  requestsThisCycle++;

  return axios.get(
    `${RAILRADAR_BASE_URL}${path}`,
    {
      params,

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
      await railRadarGet(
        `/trains/${encodeURIComponent(
          trainNo
        )}/live`,
        {
          authoritative:
            true,

          includeCoordinates:
            true
        }
      );

    const liveData =
      extractLiveData(
        response.data
      );

    if (
      !liveData
    ) {
      console.log(
        `[LIVE EMPTY] ${trainNo}`
      );

      return null;
    }

    const gps =
      extractCurrentGps(
        liveData
      );

    const direction =
      determineDirection(
        liveData
      );

    const corridor =
      determineCorridor(
        trainNo
      );

    const speedKmh =
      getSpeedKmh(
        liveData
      );

    const bearing =
      getBearing(
        liveData
      );

    const gdrDistance =
      getGdrDistance(
        gps
      );

    const gateDistance =
      getGateDistance(
        gps,
        corridor
      );

    const atGdr =
      isAtGudur(
        liveData
      );

    const positionAge =
      getPositionAgeMinutes(
        liveData
      );

    const liveEta =
      gateDistance !== null
        ? calculateGpsEta(
            gateDistance,
            speedKmh
          )
        : null;

    console.log(
      `[LIVE RESULT] ${trainNo}` +
      ` | direction=${direction}` +
      ` | corridor=${corridor || "UNKNOWN"}` +
      ` | GPS=${
        gps
          ? `${gps.lat.toFixed(6)},${gps.lng.toFixed(6)}`
          : "UNAVAILABLE"
      }` +
      ` | GDR=${
        gdrDistance !== null
          ? gdrDistance.toFixed(3)
          : "--"
      } km` +
      ` | gate=${
        gateDistance !== null
          ? gateDistance.toFixed(3)
          : "--"
      } km` +
      ` | atGDR=${atGdr}`
    );

    return {
      trainNo,

      gps,

      direction,

      corridor,

      speedKmh,

      bearing,

      gdrDistance,

      gateDistance,

      atGdr,

      positionAge,

      liveEta,

      liveData
    };

  } catch (error) {
    console.error(
      `[LIVE ERROR] ${trainNo} | ${
        error.response?.status ||
        error.message
      }`
    );

    if (
      error.response?.data
    ) {
      console.error(
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );
    }

    return null;
  }
}


// ============================================================
// BEARING SAFETY CHECK
// ============================================================
//
// Bearing is supplemental.
//
// If RailRadar supplies bearing, it should generally point
// toward the relevant gate.
//
// If bearing is unavailable, we do NOT reject the train.
//
// ============================================================

function isMovingTowardGate(
  gps,
  bearing,
  gate
) {
  if (
    !gps ||
    bearing === null
  ) {
    return true;
  }

  const targetBearing =
    bearingBetween(
      gps.lat,
      gps.lng,
      gate.lat,
      gate.lng
    );

  const difference =
    angularDifference(
      bearing,
      targetBearing
    );

  return (
    difference <= 100
  );
}


// ============================================================
// DETERMINE GATE STATE
// ============================================================
//
// CRITICAL:
//
// A gate can close ONLY when:
//
// 1. GPS exists
// 2. Train is MAS/TPTY
// 3. Direction is TOWARD_GUDUR or AT_GUDUR
// 4. Train is not already safely past the station
// 5. Train is within gate distance
//
// ETA alone can NEVER close the gate.
//

function determineGateState(
  live
) {
  if (
    !live
  ) {
    return null;
  }

  if (
    !isGpsUsable(
      live.gps
    )
  ) {
    return null;
  }

  if (
    live.corridor !==
      "MAS" &&
    live.corridor !==
      "TPTY"
  ) {
    return null;
  }

  if (
    live.direction !==
      "TOWARD_GUDUR" &&
    live.direction !==
      "AT_GUDUR"
  ) {
    return null;
  }

  // If RailRadar explicitly says the train is at Gudur,
  // we do NOT automatically close just because it is at
  // the station.
  //
  // The gate is only closed based on actual gate distance.

  const gate =
    live.corridor ===
      "MAS"
      ? CHENNAI_GATE
      : TIRUPATI_GATE;

  const gateDistance =
    live.gateDistance;

  if (
    gateDistance === null
  ) {
    return null;
  }

  if (
    !isMovingTowardGate(
      live.gps,
      live.bearing,
      gate
    )
  ) {
    console.log(
      `[GATE REJECT] ${live.trainNo} bearing does not point toward ${live.corridor} gate`
    );

    return null;
  }

  if (
    gateDistance <=
    GATE_CLOSE_DISTANCE_KM
  ) {
    return {
      status:
        "CLOSED",

      waitMinutes:
        Math.max(
          1,
          Math.min(
            10,
            (
              live.liveEta ??
              1
            ) + 2
          )
        ),

      activeTrain:
        `${live.trainNo} | ${live.corridor} | Approaching crossing`,

      trainNo:
        live.trainNo,

      corridor:
        live.corridor,

      direction:
        live.direction,

      distanceKm:
        Number(
          gateDistance.toFixed(
            3
          )
        ),

      speedKmh:
        Math.round(
          live.speedKmh || 0
        ),

      latitude:
        Number(
          live.gps.lat.toFixed(
            6
          )
        ),

      longitude:
        Number(
          live.gps.lng.toFixed(
            6
          )
        ),

      positionVerified:
        true,

      positionSource:
        live.gps.source ||
        "LIVE_GPS",

      actualGps:
        true,

      lastPositionCheck:
        new Date().toISOString()
    };
  }

  if (
    gateDistance <=
    GATE_WARNING_DISTANCE_KM
  ) {
    return {
      status:
        "WARNING",

      waitMinutes:
        Math.max(
          1,
          Math.min(
            10,
            (
              live.liveEta ??
              2
            ) + 2
          )
        ),

      activeTrain:
        `${live.trainNo} | ${live.corridor} | Approaching crossing`,

      trainNo:
        live.trainNo,

      corridor:
        live.corridor,

      direction:
        live.direction,

      distanceKm:
        Number(
          gateDistance.toFixed(
            3
          )
        ),

      speedKmh:
        Math.round(
          live.speedKmh || 0
        ),

      latitude:
        Number(
          live.gps.lat.toFixed(
            6
          )
        ),

      longitude:
        Number(
          live.gps.lng.toFixed(
            6
          )
        ),

      positionVerified:
        true,

      positionSource:
        live.gps.source ||
        "LIVE_GPS",

      actualGps:
        true,

      lastPositionCheck:
        new Date().toISOString()
    };
  }

  return null;
}


// ============================================================
// OPEN GATE
// ============================================================

function createOpenGate(
  now
) {
  return {
    status:
      "OPEN",

    waitMinutes:
      0,

    activeTrain:
      "Tracks clear",

    trainNo:
      null,

    corridor:
      null,

    direction:
      null,

    distanceKm:
      null,

    speedKmh:
      null,

    positionVerified:
      false,

    positionSource:
      null,

    actualGps:
      false,

    lastPositionCheck:
      now.toISOString()
  };
}


// ============================================================
// SELECT BEST GATE STATE
// ============================================================

function chooseGateState(
  current,
  candidate
) {
  if (
    !candidate
  ) {
    return current;
  }

  if (
    current.status ===
      "OPEN"
  ) {
    return candidate;
  }

  if (
    current.status ===
      "WARNING" &&
    candidate.status ===
      "CLOSED"
  ) {
    return candidate;
  }

  if (
    current.status ===
      candidate.status
  ) {
    const currentDistance =
      current.distanceKm ??
      999999;

    const candidateDistance =
      candidate.distanceKm ??
      999999;

    if (
      candidateDistance <
      currentDistance
    ) {
      return candidate;
    }
  }

  return current;
}


// ============================================================
// FIND BOARD ITEM
// ============================================================

function findBoardItem(
  board,
  trainNo
) {
  return board.find(
    item =>
      getTrainNumber(
        item?.train || {},
        item
      ) === trainNo
  );
}


// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  requestsThisCycle =
    0;

  const now =
    new Date();

  console.log(
    "\n=================================================="
  );

  console.log(
    "       GUDUR GATE TRACKER - LIVE SYNC"
  );

  console.log(
    `[${now.toLocaleString(
      "en-IN"
    )}]`
  );

  console.log(
    "=================================================="
  );

  try {

    // ==========================================================
    // SAFE DEFAULT GATES
    // ==========================================================

    let chennaiGate =
      createOpenGate(
        now
      );

    let tirupatiGate =
      createOpenGate(
        now
      );


    // ==========================================================
    // 1. GET GDR STATION BOARD
    // ==========================================================

    console.log(
      "\n[1/3] Fetching RailRadar GDR station board..."
    );

    const boardResponse =
      await railRadarGet(
        "/stations/GDR/live",
        {
          hours:
            4,

          includeIntermediate:
            true
        }
      );

    const responseBody =
      boardResponse.data;

    const trainsArray =
      responseBody?.data?.trains ||
      responseBody?.trains ||
      [];

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      throw new Error(
        "RailRadar returned invalid GDR station board."
      );
    }

    console.log(
      `✅ Raw board trains: ${trainsArray.length}`
    );


    // ==========================================================
    // 2. BUILD UPCOMING LIST FROM STATION BOARD
    // ==========================================================
    //
    // THIS IS THE MAIN FIX.
    //
    // We do this BEFORE live GPS.
    //
    // Therefore upcoming trains remain visible even when
    // /trains/{number}/live does not return GPS.
    //
    // ==========================================================

    console.log(
      "\n[2/3] Building Upcoming Trains from GDR station board..."
    );

    const upcomingRaw =
      [];

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (
        !trainNo
      ) {
        continue;
      }

      if (
        !isApprovedTrain(
          trainNo
        )
      ) {
        continue;
      }

      const record =
        buildUpcomingFromBoard(
          item,
          now
        );

      if (
        record
      ) {
        upcomingRaw.push(
          record
        );
      }
    }

    const upcomingUnique =
      deduplicateUpcoming(
        upcomingRaw
      );

    upcomingUnique.sort(
      (
        a,
        b
      ) =>
        (
          a.etaMinutes ??
          99999
        ) -
        (
          b.etaMinutes ??
          99999
        )
    );

    const topUpcoming =
      upcomingUnique.slice(
        0,
        10
      );

    console.log(
      `✅ Upcoming trains from station board: ${topUpcoming.length}`
    );

    if (
      topUpcoming.length
    ) {
      topUpcoming.forEach(
        train => {
          console.log(
            `   ${train.corridor} | ${train.trainNo} ${train.name} | ETA ${train.etaMinutes}m | source=${train.positionSource}`
          );
        }
      );
    } else {
      console.log(
        "   No approved upcoming trains in the 4-hour board."
      );
    }


    // ==========================================================
    // 3. LIVE GPS VERIFICATION
    // ==========================================================

    console.log(
      "\n[3/3] Performing live GPS verification..."
    );

    const candidates =
      findLiveCandidates(
        trainsArray,
        now
      );

    const limitedCandidates =
      candidates.slice(
        0,
        MAX_LIVE_REQUESTS - 1
      );

    console.log(
      `📍 Live candidates: ${limitedCandidates.length}`
    );

    const liveResults =
      new Map();

    for (
      const candidate of
      limitedCandidates
    ) {
      const live =
        await fetchLiveTrain(
          candidate.trainNo
        );

      if (
        live
      ) {
        liveResults.set(
          candidate.trainNo,
          live
        );
      }
    }


    // ==========================================================
    // APPLY LIVE GPS TO UPCOMING RECORDS
    // ==========================================================
    //
    // GPS is optional for Upcoming Trains.
    //
    // If available, we enrich the board record.
    //
    // If unavailable, the board record stays.
    //
    // ==========================================================

    for (
      const train of
      topUpcoming
    ) {
      const live =
        liveResults.get(
          train.trainNo
        );

      if (
        !live
      ) {
        continue;
      }

      if (
        live.gps &&
        isGpsUsable(
          live.gps
        )
      ) {
        train.gpsAvailable =
          true;

        train.positionVerified =
          true;

        train.positionSource =
          live.gps.source ||
          "LIVE_GPS";

        train.actualGps =
          true;

        train.latitude =
          Number(
            live.gps.lat.toFixed(
              6
            )
          );

        train.longitude =
          Number(
            live.gps.lng.toFixed(
              6
            )
          );

        if (
          live.gdrDistance !==
          null
        ) {
          train.distanceKm =
            Number(
              live.gdrDistance.toFixed(
                2
              )
            );
        }

        if (
          live.gateDistance !==
          null
        ) {
          train.gateDistanceKm =
            Number(
              live.gateDistance.toFixed(
                3
              )
            );
        }

        train.speedKmh =
          Math.round(
            live.speedKmh || 0
          );

        train.direction =
          live.direction ||
          train.direction;

        // Keep the station-board ETA if GPS ETA
        // is unavailable.
        //
        // If live GPS gives a valid ETA, use it
        // because it represents the physical distance
        // to the crossing.

        if (
          live.liveEta !==
            null &&
          live.liveEta !==
            undefined
        ) {
          train.liveEtaMinutes =
            live.liveEta;
        }
      }
    }


    // ==========================================================
    // GATE CONTROL
    // ==========================================================

    for (
      const live of
      liveResults.values()
    ) {
      const candidate =
        determineGateState(
          live
        );

      if (
        !candidate
      ) {
        continue;
      }

      console.log(
        `[GATE ${candidate.status}] ${live.trainNo} | ${live.corridor} | ${candidate.distanceKm} km`
      );

      if (
        live.corridor ===
        "MAS"
      ) {
        chennaiGate =
          chooseGateState(
            chennaiGate,
            candidate
          );
      }

      if (
        live.corridor ===
        "TPTY"
      ) {
        tirupatiGate =
          chooseGateState(
            tirupatiGate,
            candidate
          );
      }
    }


    // ==========================================================
    // IMPORTANT SAFETY CHECK
    // ==========================================================
    //
    // If there is no confirmed live GPS train near a gate,
    // the gate remains OPEN.
    //
    // Upcoming ETA does NOT close the gate.
    //
    // ==========================================================


    // ==========================================================
    // FIREBASE UPCOMING DATA
    // ==========================================================
    //
    // Use an object when records exist.
    //
    // Firebase may omit an empty array.
    //
    // null explicitly clears the previous upcoming data.
    //
    // ==========================================================

    let firebaseUpcoming =
      null;

    if (
      topUpcoming.length > 0
    ) {
      firebaseUpcoming =
        {};

      topUpcoming.forEach(
        (
          train,
          index
        ) => {
          firebaseUpcoming[
            String(index)
          ] = train;
        }
      );
    }


    // ==========================================================
    // FIREBASE WRITE
    // ==========================================================

    await gateRef.set({
      tirupatiGate,

      chennaiGate,

      upcomingTrains:
        firebaseUpcoming,

      systemMode:
        "GPS_LIVE",

      positionBased:
        true,

      gateControlRequiresGps:
        true,

      upcomingUsesStationBoard:
        true,

      upcomingGpsRequired:
        false,

      lastUpdated:
        now.toLocaleTimeString(
          "en-IN"
        ),

      lastUpdatedAt:
        now.toISOString(),

      lastUpdatedLocal:
        now.toLocaleString(
          "en-IN"
        ),

      apiRequestsThisCycle:
        requestsThisCycle,

      meta: {
        system:
          "GUDUR_GATE_TRACKER",

        version:
          "UPCOMING-BOARD-ETA-GPS-GATE",

        station:
          "GDR",

        upcomingSource:
          "RAILRADAR_STATION_BOARD",

        gateSource:
          "RAILRADAR_LIVE_GPS",

        gateWarningDistanceKm:
          GATE_WARNING_DISTANCE_KM,

        gateCloseDistanceKm:
          GATE_CLOSE_DISTANCE_KM,

        gateClearDistanceKm:
          GATE_CLEAR_DISTANCE_KM,

        upcomingWindowMinutes:
          UPCOMING_WINDOW_MINUTES,

        lastSyncAt:
          now.toISOString()
      }
    });


    // ==========================================================
    // FIREBASE VERIFICATION
    // ==========================================================

    const verifySnapshot =
      await gateRef.once(
        "value"
      );

    const verifyData =
      verifySnapshot.val() ||
      {};

    const verifiedUpcoming =
      verifyData.upcomingTrains;

    let verifiedCount =
      0;

    if (
      verifiedUpcoming &&
      typeof verifiedUpcoming ===
        "object"
    ) {
      verifiedCount =
        Array.isArray(
          verifiedUpcoming
        )
          ? verifiedUpcoming.length
          : Object.keys(
              verifiedUpcoming
            ).length;
    }

    // ==========================================================
    // SUCCESS LOG
    // ==========================================================

    console.log(
      "\n=================================================="
    );

    console.log(
      "                 SYNC SUCCESS"
    );

    console.log(
      "=================================================="
    );

    console.log(
      `Chennai Gate : ${chennaiGate.status}`
    );

    console.log(
      `Tirupati Gate: ${tirupatiGate.status}`
    );

    console.log(
      `Upcoming Trains: ${verifiedCount}`
    );

    console.log(
      `API requests: ${requestsThisCycle}`
    );

    console.log(
      "=================================================="
    );


    // ==========================================================
    // CHENNAI GATE DETAILS
    // ==========================================================

    if (
      chennaiGate.status ===
      "CLOSED"
    ) {
      console.log(
        `🚧 CHENNAI GATE CLOSED`
      );

      console.log(
        `   Train: ${chennaiGate.trainNo}`
      );

      console.log(
        `   Distance: ${chennaiGate.distanceKm} km`
      );
    } else if (
      chennaiGate.status ===
      "WARNING"
    ) {
      console.log(
        `🟠 CHENNAI GATE WARNING`
      );

      console.log(
        `   Train: ${chennaiGate.trainNo}`
      );

      console.log(
        `   Distance: ${chennaiGate.distanceKm} km`
      );
    } else {
      console.log(
        "🟢 CHENNAI GATE OPEN"
      );
    }


    // ==========================================================
    // TIRUPATI GATE DETAILS
    // ==========================================================

    if (
      tirupatiGate.status ===
      "CLOSED"
    ) {
      console.log(
        `🚧 TIRUPATI GATE CLOSED`
      );

      console.log(
        `   Train: ${tirupatiGate.trainNo}`
      );

      console.log(
        `   Distance: ${tirupatiGate.distanceKm} km`
      );
    } else if (
      tirupatiGate.status ===
      "WARNING"
    ) {
      console.log(
        `🟠 TIRUPATI GATE WARNING`
      );

      console.log(
        `   Train: ${tirupatiGate.trainNo}`
      );

      console.log(
        `   Distance: ${tirupatiGate.distanceKm} km`
      );
    } else {
      console.log(
        "🟢 TIRUPATI GATE OPEN"
      );
    }


    // ==========================================================
    // UPCOMING TRAIN DETAILS
    // ==========================================================

    if (
      topUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS]"
      );

      topUpcoming.forEach(
        train => {
          console.log(
            `  ${train.corridor} | ${train.trainNo} ${train.name}`
          );

          console.log(
            `     ETA: ${train.etaMinutes}m`
          );

          console.log(
            `     Origin: ${train.origin}`
          );

          console.log(
            `     Destination: ${train.destination}`
          );

          console.log(
            `     GPS: ${
              train.gpsAvailable
                ? "AVAILABLE"
                : "NOT AVAILABLE"
            }`
          );

          if (
            train.distanceKm !==
            null &&
            train.distanceKm !==
            undefined
          ) {
            console.log(
              `     Distance from GDR: ${train.distanceKm} km`
            );
          }
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS] None"
      );
    }


  } catch (error) {

    // ==========================================================
    // ERROR HANDLING
    // ==========================================================

    console.error(
      "\n=================================================="
    );

    console.error(
      "                 UPDATE ERROR"
    );

    console.error(
      "=================================================="
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

    console.error(
      `RailRadar requests used: ${requestsThisCycle}`
    );

    console.error(
      "Firebase was NOT overwritten with guessed gate status."
    );

    console.error(
      "=================================================="
    );
  }
}


// ============================================================
// STARTUP
// ============================================================

console.log(
  "=================================================="
);

console.log(
  "       GUDUR GATE TRACKER - LIVE GPS"
);

console.log(
  "=================================================="
);

console.log(
  `GDR Station : ${GDR.lat}, ${GDR.lng}`
);

console.log(
  `Chennai Gate: ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
);

console.log(
  `Tirupati Gate: ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
);

console.log(
  "--------------------------------------------------"
);

console.log(
  "Upcoming trains:"
);

console.log(
  "  RailRadar GDR station board ETA"
);

console.log(
  "  GPS NOT required"
);

console.log(
  "--------------------------------------------------"
);

console.log(
  "Gate control:"
);

console.log(
  "  RailRadar live GPS"
);

console.log(
  "  Direction required"
);

console.log(
  "  GPS required"
);

console.log(
  `  WARNING: <= ${GATE_WARNING_DISTANCE_KM} km`
);

console.log(
  `  CLOSED : <= ${GATE_CLOSE_DISTANCE_KM} km`
);

console.log(
  "--------------------------------------------------"
);

console.log(
  "Approved TPTY trains:",
  TPTY_TRAINS.size
);

console.log(
  "Approved MAS trains:",
  MAS_TRAINS.size
);

console.log(
  "Approved OTHER trains:",
  OTHER_TRAINS.size
);

console.log(
  "--------------------------------------------------"
);

console.log(
  "Firebase:",
  FIREBASE_DATABASE_URL
);

console.log(
  "RailRadar:",
  RAILRADAR_BASE_URL
);

console.log(
  "=================================================="
);


// ============================================================
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();


// ============================================================
// RUN EVERY 5 MINUTES
// ============================================================

setInterval(
  updateGateSystem,
  REFRESH_INTERVAL_MS
);
