const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");

// ============================================================
// GUDUR GATE MONITOR
// ============================================================
//
// CORRECT GATE LOGIC:
//
// CHENNAI -> GUDUR       => CHENNAI GATE
// GUDUR   -> CHENNAI    => CHENNAI GATE
//
// TIRUPATI -> GUDUR     => TIRUPATI GATE
// GUDUR    -> TIRUPATI  => TIRUPATI GATE
//
// A gate closes ONLY when the train is actually approaching
// that gate and is within GATE_STOP_DISTANCE_KM.
//
// Actual GPS / actual station-code position is required for
// automatic gate closure.
//
// Route interpolation is allowed for ETA/display only.
// It is NEVER used by itself to close a gate.
//
// ============================================================


// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

const SERVICE_ACCOUNT_FILE =
  "./serviceAccountKey.json";


// ============================================================
// LOAD FIREBASE SERVICE ACCOUNT
// ============================================================
//
// GitHub Actions:
//   FIREBASE_SERVICE_ACCOUNT secret
//
// Local computer:
//   serviceAccountKey.json
//
// ============================================================

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount =
      JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      );

    console.log(
      "Firebase: Service account loaded from environment."
    );
  } catch (error) {
    console.error(
      "❌ FIREBASE_SERVICE_ACCOUNT exists but is not valid JSON."
    );

    console.error(error.message);

    process.exit(1);
  }
} else {
  try {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
      throw new Error(
        `File not found: ${SERVICE_ACCOUNT_FILE}`
      );
    }

    serviceAccount =
      require(SERVICE_ACCOUNT_FILE);

    console.log(
      "Firebase: serviceAccountKey.json loaded."
    );
  } catch (error) {
    console.error(
      "❌ Could not load Firebase service account."
    );

    console.error(
      "For local use, place serviceAccountKey.json beside code.js."
    );

    console.error(
      "For GitHub Actions, configure FIREBASE_SERVICE_ACCOUNT."
    );

    console.error(error.message);

    process.exit(1);
  }
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
// GUDUR / GATE LOCATIONS
// ============================================================

const GDR_LAT =
  14.14842;

const GDR_LNG =
  79.84524;


// Chennai-side crossing

const CHENNAI_GATE_LAT =
  14.1396639;

const CHENNAI_GATE_LNG =
  79.8441306;


// Tirupati-side crossing

const TIRUPATI_GATE_LAT =
  14.1402056;

const TIRUPATI_GATE_LNG =
  79.8436000;


// ============================================================
// SETTINGS
// ============================================================

// Maximum distance for showing an upcoming train.

const UPCOMING_MAX_DISTANCE_KM =
  150;


// Distance at which a gate is automatically CLOSED.

const GATE_STOP_DISTANCE_KM =
  0.6;


// Maximum RailRadar requests per monitor cycle:
//
// 1 station board
// +
// maximum 7 live train requests
//
// TOTAL = 8

const MAX_LIVE_REQUESTS =
  7;


// Maximum station-board candidates.

const MAX_BOARD_CANDIDATES =
  22;


// Local continuous-monitor refresh.

const REFRESH_INTERVAL_MS =
  60000;


// Default ETA speed when only route distance
// is available.

const DEFAULT_SPEED_KMH =
  55;


// Minimum speed accepted.

const MIN_SPEED_KMH =
  5;


// ============================================================
// KNOWN TRAIN NUMBERS
// ============================================================
//
// These are useful as a fallback for identifying the
// Tirupati corridor when the API does not provide a clean
// origin string.
//
// They DO NOT by themselves decide gate closure.
//
// Gate closure still requires an actual position near
// the corresponding gate.
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
    "07670"
  ]);


// ============================================================
// TEXT HELPERS
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
// NUMBER HELPERS
// ============================================================

function toNumber(value) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// DISTANCE CALCULATION
// ============================================================

function haversineKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }

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
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      lat1 * Math.PI / 180
    ) *
    Math.cos(
      lat2 * Math.PI / 180
    ) *
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
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeValue,
  delayMinutes = 0
) {
  if (!timeValue) {
    return -1;
  }

  let totalMinutes =
    -1;

  const date =
    new Date(timeValue);

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
      String(timeValue)
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
  targetMinutes,
  currentMinutes
) {
  let diff =
    targetMinutes -
    currentMinutes;

  // Midnight crossing.

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}


// ============================================================
// GENERIC NESTED LOOKUP
// ============================================================

function firstValue(
  ...values
) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}


// ============================================================
// GET ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const origin =
    firstValue(
      train?.origin,
      train?.source,
      train?.from,
      train?.fromStation,
      train?.startStation,
      train?.start,
      item?.origin,
      item?.source,
      item?.from,
      item?.fromStation,
      item?.startStation
    );

  if (
    typeof origin === "object"
  ) {
    return firstValue(
      origin.code,
      origin.name
    ) || "";
  }

  return String(
    origin || ""
  );
}


// ============================================================
// GET DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const destination =
    firstValue(
      train?.destination,
      train?.to,
      train?.destinationStation,
      train?.endStation,
      item?.destination,
      item?.to,
      item?.destinationStation
    );

  if (
    typeof destination === "object"
  ) {
    return firstValue(
      destination.code,
      destination.name
    ) || "";
  }

  return String(
    destination || ""
  );
}


// ============================================================
// GET DIRECTION TEXT
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  return [
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
  ]
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}


// ============================================================
// EXPLICIT DIRECTION
// ============================================================
//
// Returns:
//
// TOWARD_GUDUR
// AWAY_FROM_GUDUR
// UNKNOWN
//
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
    return "UNKNOWN";
  }

  if (
    direction.includes(
      "TOWARD GUDUR"
    ) ||
    direction.includes(
      "TOWARDS GUDUR"
    ) ||
    direction.includes(
      "TO GUDUR"
    ) ||
    direction.includes(
      "GUDUR INBOUND"
    ) ||
    direction.includes(
      "INBOUND"
    ) ||
    direction.includes(
      "APPROACHING GUDUR"
    )
  ) {
    return "TOWARD_GUDUR";
  }

  if (
    direction.includes(
      "FROM GUDUR"
    ) ||
    direction.includes(
      "GUDUR OUTBOUND"
    ) ||
    direction.includes(
      "OUTBOUND"
    ) ||
    direction.includes(
      "AWAY FROM GUDUR"
    )
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return "UNKNOWN";
}


// ============================================================
// EXTRACT ROUTE
// ============================================================

function getRoute(
  verified
) {
  const route =
    verified?.route ||
    verified?.data?.route ||
    verified?.train?.route ||
    [];

  return Array.isArray(route)
    ? route
    : [];
}


// ============================================================
// FIND GUDUR IN ROUTE
// ============================================================

function findGudurRouteStop(
  route
) {
  if (!Array.isArray(route)) {
    return null;
  }

  return (
    route.find(
      (stop) =>
        normalizeText(
          stop?.stationCode
        ) === "GDR"
    ) ||
    route.find(
      (stop) =>
        containsAny(
          stop?.stationName,
          [
            "GUDUR",
            "GUDUR JN",
            "GUDUR JUNCTION"
          ]
        )
    ) ||
    null
  );
}


// ============================================================
// FIND CURRENT ROUTE STOP
// ============================================================

function findCurrentRouteStop(
  route,
  currentLocation
) {
  if (
    !Array.isArray(route) ||
    !currentLocation
  ) {
    return null;
  }

  const currentCode =
    normalizeText(
      currentLocation.stationCode
    );

  const currentSequence =
    toNumber(
      currentLocation.sequence
    );

  if (currentCode) {
    const byCode =
      route.find(
        (stop) =>
          normalizeText(
            stop?.stationCode
          ) === currentCode
      );

    if (byCode) {
      return byCode;
    }
  }

  if (
    currentSequence !== null
  ) {
    const bySequence =
      route.find(
        (stop) =>
          Number(
            stop?.sequence
          ) === currentSequence
      );

    if (bySequence) {
      return bySequence;
    }
  }

  return null;
}


// ============================================================
// GET ROUTE SEQUENCE
// ============================================================

function getSequence(
  currentLocation,
  currentStop
) {
  return firstValue(
    toNumber(
      currentLocation?.sequence
    ),
    toNumber(
      currentStop?.sequence
    )
  );
}


// ============================================================
// ROUTE SIDE DETECTION
// ============================================================
//
// We need to know which side of Gudur the train is on.
//
// MAS side:
//
// Chennai / MAS / Avadi / Perambur / Sullurupeta
//
// TPTY side:
//
// Tirupati / TPTY / Renigunta
//
// We use route topology first, then origin/destination
// information, then known train numbers.
//
// ============================================================

function routeContainsAny(
  route,
  values
) {
  if (
    !Array.isArray(route)
  ) {
    return false;
  }

  return route.some(
    (stop) =>
      containsAny(
        [
          stop?.stationCode,
          stop?.stationName
        ]
          .filter(Boolean)
          .join(" "),
        values
      )
  );
}


// ============================================================
// DETECT CHENNAI SIDE
// ============================================================

function routeHasChennaiAnchor(
  route,
  gdrSequence
) {
  if (
    !Array.isArray(route)
  ) {
    return false;
  }

  return route.some(
    (stop) => {
      const sequence =
        toNumber(
          stop?.sequence
        );

      if (
        gdrSequence !== null &&
        sequence !== null &&
        sequence >= gdrSequence
      ) {
        return false;
      }

      return containsAny(
        [
          stop?.stationCode,
          stop?.stationName
        ]
          .filter(Boolean)
          .join(" "),
        [
          "MAS",
          "CHENNAI",
          "MGR CHENNAI CENTRAL",
          "DR MGR CHENNAI CENTRAL",
          "CHENNAI CENTRAL",
          "AVADI",
          "PERAMBUR",
          "SULLURUPETA",
          "NAYUDUPETA"
        ]
      );
    }
  );
}


// ============================================================
// DETECT TIRUPATI SIDE
// ============================================================

function routeHasTirupatiAnchor(
  route,
  gdrSequence
) {
  if (
    !Array.isArray(route)
  ) {
    return false;
  }

  return route.some(
    (stop) => {
      const sequence =
        toNumber(
          stop?.sequence
        );

      if (
        gdrSequence !== null &&
        sequence !== null &&
        sequence >= gdrSequence
      ) {
        return false;
      }

      return containsAny(
        [
          stop?.stationCode,
          stop?.stationName
        ]
          .filter(Boolean)
          .join(" "),
        [
          "TPTY",
          "TIRUPATI",
          "TIRUPATI MAIN",
          "RENIGUNTA",
          "RU"
        ]
      );
    }
  );
}


// ============================================================
// ORIGIN SIDE DETECTION
// ============================================================

function getOriginSide(
  origin
) {
  const text =
    normalizeText(
      origin
    );

  if (
    containsAny(
      text,
      [
        "MAS",
        "CHENNAI",
        "MGR CHENNAI CENTRAL",
        "CHENNAI CENTRAL",
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
      text,
      [
        "TPTY",
        "TIRUPATI",
        "TIRUPATI MAIN",
        "RENIGUNTA",
        "RU"
      ]
    )
  ) {
    return "TPTY";
  }

  return "UNKNOWN";
}


// ============================================================
// DETERMINE CORRIDOR
// ============================================================
//
// IMPORTANT:
//
// corridor means the SIDE of Gudur relevant to the gate.
//
// MAS:
//   Chennai-side gate
//
// TPTY:
//   Tirupati-side gate
//
// ============================================================

function determineCorridor({
  train,
  item,
  route,
  gdrSequence,
  trainNumber
}) {
  const origin =
    getOrigin(
      train,
      item
    );

  const originSide =
    getOriginSide(
      origin
    );

  // ----------------------------------------------------------
  // FIRST: explicit origin
  // ----------------------------------------------------------

  if (
    originSide === "MAS"
  ) {
    return "MAS";
  }

  if (
    originSide === "TPTY"
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // SECOND: route anchors
  // ----------------------------------------------------------

  const hasMas =
    routeHasChennaiAnchor(
      route,
      gdrSequence
    );

  const hasTpty =
    routeHasTirupatiAnchor(
      route,
      gdrSequence
    );

  if (
    hasMas &&
    !hasTpty
  ) {
    return "MAS";
  }

  if (
    hasTpty &&
    !hasMas
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // THIRD: known TPTY trains
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      String(trainNumber)
    )
  ) {
    return "TPTY";
  }


  // ----------------------------------------------------------
  // UNKNOWN
  // ----------------------------------------------------------

  return "OTHER";
}


// ============================================================
// DETERMINE SIDE / GATE FROM ROUTE
// ============================================================
//
// This is the critical correction.
//
// The train can be:
//
// Chennai -> Gudur
// OR
// Gudur -> Chennai
//
// Both use CHENNAI GATE.
//
// Likewise:
//
// Tirupati -> Gudur
// OR
// Gudur -> Tirupati
//
// Both use TIRUPATI GATE.
//
// Therefore the gate is selected from the train's
// geographical corridor, NOT simply from whether it is
// inbound or outbound.
//
// ============================================================

function getGateForCorridor(
  corridor
) {
  if (
    corridor === "MAS"
  ) {
    return {
      gate: "CHENNAI",
      name: "Chennai Gate",
      lat:
        CHENNAI_GATE_LAT,
      lng:
        CHENNAI_GATE_LNG
    };
  }

  if (
    corridor === "TPTY"
  ) {
    return {
      gate: "TIRUPATI",
      name: "Tirupati Gate",
      lat:
        TIRUPATI_GATE_LAT,
      lng:
        TIRUPATI_GATE_LNG
    };
  }

  return null;
}


// ============================================================
// ACTUAL GPS POSITION
// ============================================================
//
// Supports several possible RailRadar formats.
//
// ============================================================

function extractGpsPosition(
  verified
) {
  const data =
    verified?.data ||
    verified ||
    {};

  const current =
    data?.currentLocation ||
    verified?.currentLocation ||
    {};

  const live =
    data?.live ||
    verified?.live ||
    {};

  const train =
    data?.train ||
    verified?.train ||
    {};

  const candidates = [
    current,
    live,
    train
  ];

  for (
    const candidate of candidates
  ) {
    const lat =
      toNumber(
        firstValue(
          candidate?.lat,
          candidate?.latitude,
          candidate?.location?.lat,
          candidate?.location?.latitude
        )
      );

    const lng =
      toNumber(
        firstValue(
          candidate?.lng,
          candidate?.lon,
          candidate?.longitude,
          candidate?.location?.lng,
          candidate?.location?.lon,
          candidate?.location?.longitude
        )
      );

    if (
      lat !== null &&
      lng !== null
    ) {
      return {
        lat,
        lng,

        speedKmh:
          toNumber(
            firstValue(
              candidate?.speedKmh,
              candidate?.speed,
              candidate?.speedKmH
            )
          ),

        bearingDegrees:
          toNumber(
            firstValue(
              candidate?.bearingDegrees,
              candidate?.bearing,
              candidate?.directionDegrees
            )
          ),

        isActualPosition:
          candidate?.isActualPosition === true,

        source:
          "GPS"
      };
    }
  }

  return null;
}


// ============================================================
// STATION-CODE ACTUAL POSITION
// ============================================================
//
// RailRadar may report:
//
// currentLocation.stationCode = GDR
//
// with:
//
// isActualPosition = true
//
// but without lat/lng.
//
// Because includeCoordinates=true is requested, the matching
// route stop should normally contain coordinates.
//
// ============================================================

function extractStationCodePosition(
  verified,
  route
) {
  const data =
    verified?.data ||
    verified ||
    {};

  const current =
    data?.currentLocation ||
    verified?.currentLocation ||
    {};

  if (
    current?.isActualPosition !== true
  ) {
    return null;
  }

  const stationCode =
    normalizeText(
      current?.stationCode
    );

  if (!stationCode) {
    return null;
  }

  const sequence =
    toNumber(
      current?.sequence
    );

  let stop =
    route.find(
      (item) =>
        normalizeText(
          item?.stationCode
        ) === stationCode
    );

  if (!stop && sequence !== null) {
    stop =
      route.find(
        (item) =>
          Number(
            item?.sequence
          ) === sequence
      );
  }

  if (!stop) {
    return null;
  }

  const lat =
    toNumber(
      firstValue(
        stop?.lat,
        stop?.latitude
      )
    );

  const lng =
    toNumber(
      firstValue(
        stop?.lng,
        stop?.lon,
        stop?.longitude
      )
    );

  if (
    lat === null ||
    lng === null
  ) {
    return null;
  }

  return {
    lat,
    lng,

    speedKmh:
      toNumber(
        firstValue(
          current?.speedKmh,
          current?.speed
        )
      ),

    bearingDegrees:
      toNumber(
        firstValue(
          current?.bearingDegrees,
          current?.bearing
        )
      ),

    isActualPosition:
      true,

    source:
      "STATION_CODE",

    stationCode
  };
}


// ============================================================
// GUDUR FALLBACK POSITION
// ============================================================
//
// If RailRadar says:
//
// stationCode = GDR
// isActualPosition = true
//
// but route coordinates are unavailable,
// use the known Gudur coordinate.
//
// ============================================================

function getGudurFallbackPosition(
  verified
) {
  const data =
    verified?.data ||
    verified ||
    {};

  const current =
    data?.currentLocation ||
    verified?.currentLocation ||
    {};

  if (
    current?.isActualPosition !== true
  ) {
    return null;
  }

  if (
    normalizeText(
      current?.stationCode
    ) !== "GDR"
  ) {
    return null;
  }

  return {
    lat:
      GDR_LAT,

    lng:
      GDR_LNG,

    speedKmh:
      toNumber(
        current?.speedKmh
      ),

    bearingDegrees:
      toNumber(
        current?.bearingDegrees
      ),

    isActualPosition:
      true,

    source:
      "GDR_KNOWN_COORDINATE",

    stationCode:
      "GDR"
  };
}


// ============================================================
// ROUTE INTERPOLATED POSITION
// ============================================================
//
// This is ONLY for display and ETA.
//
// NEVER use this position alone for gate closure.
//
// ============================================================

function extractInterpolatedRoutePosition(
  verified,
  route
) {
  const data =
    verified?.data ||
    verified ||
    {};

  const current =
    data?.currentLocation ||
    verified?.currentLocation ||
    {};

  const sequence =
    toNumber(
      current?.sequence
    );

  const progress =
    toNumber(
      current?.segmentProgress
    );

  if (
    sequence === null ||
    progress === null ||
    !Array.isArray(route)
  ) {
    return null;
  }

  const currentStop =
    route.find(
      (stop) =>
        Number(
          stop?.sequence
        ) === sequence
    );

  if (!currentStop) {
    return null;
  }

  const nextStop =
    route.find(
      (stop) =>
        Number(
          stop?.sequence
        ) ===
        sequence + 1
    );

  if (!nextStop) {
    return null;
  }

  const lat1 =
    toNumber(
      firstValue(
        currentStop?.lat,
        currentStop?.latitude
      )
    );

  const lng1 =
    toNumber(
      firstValue(
        currentStop?.lng,
        currentStop?.lon,
        currentStop?.longitude
      )
    );

  const lat2 =
    toNumber(
      firstValue(
        nextStop?.lat,
        nextStop?.latitude
      )
    );

  const lng2 =
    toNumber(
      firstValue(
        nextStop?.lng,
        nextStop?.lon,
        nextStop?.longitude
      )
    );

  if (
    lat1 === null ||
    lng1 === null ||
    lat2 === null ||
    lng2 === null
  ) {
    return null;
  }

  const p =
    Math.max(
      0,
      Math.min(
        1,
        progress
      )
    );

  return {
    lat:
      lat1 +
      (
        lat2 - lat1
      ) *
        p,

    lng:
      lng1 +
      (
        lng2 - lng1
      ) *
        p,

    speedKmh:
      toNumber(
        firstValue(
          current?.speedKmh,
          current?.speed
        )
      ),

    bearingDegrees:
      toNumber(
        firstValue(
          current?.bearingDegrees,
          current?.bearing
        )
      ),

    isActualPosition:
      false,

    source:
      "ROUTE_INTERPOLATED"
  };
}


// ============================================================
// BEST DISPLAY POSITION
// ============================================================
//
// Priority:
//
// 1. Actual GPS
// 2. Actual station-code coordinate
// 3. Known GDR coordinate
// 4. Route interpolation
//
// ============================================================

function getBestPosition(
  verified,
  route
) {
  const gps =
    extractGpsPosition(
      verified
    );

  if (gps) {
    return gps;
  }

  const stationPosition =
    extractStationCodePosition(
      verified,
      route
    );

  if (stationPosition) {
    return stationPosition;
  }

  const gudurFallback =
    getGudurFallbackPosition(
      verified
    );

  if (gudurFallback) {
    return gudurFallback;
  }

  return extractInterpolatedRoutePosition(
    verified,
    route
  );
}


// ============================================================
// ACTUAL POSITION FOR GATE CLOSURE
// ============================================================
//
// Only actual positions are accepted.
//
// ROUTE_INTERPOLATED is explicitly rejected.
//
// ============================================================

function getActualGatePosition(
  verified,
  route
) {
  const gps =
    extractGpsPosition(
      verified
    );

  if (
    gps &&
    gps.isActualPosition === true
  ) {
    return gps;
  }

  const stationPosition =
    extractStationCodePosition(
      verified,
      route
    );

  if (
    stationPosition &&
    stationPosition.isActualPosition === true
  ) {
    return stationPosition;
  }

  const gudurFallback =
    getGudurFallbackPosition(
      verified
    );

  if (
    gudurFallback &&
    gudurFallback.isActualPosition === true
  ) {
    return gudurFallback;
  }

  return null;
}


// ============================================================
// ROUTE DISTANCE TO GUDUR
// ============================================================
//
// Uses route cumulative distance.
//
// This can be used for ETA/display.
//
// ============================================================

function calculateRouteDistanceToGudur(
  verified,
  route,
  currentSequence
) {
  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  const gdrStop =
    findGudurRouteStop(
      route
    );

  if (!gdrStop) {
    return null;
  }

  const gdrDistance =
    toNumber(
      gdrStop?.distance
    );

  if (
    gdrDistance === null
  ) {
    return null;
  }

  const data =
    verified?.data ||
    verified ||
    {};

  const current =
    data?.currentLocation ||
    verified?.currentLocation ||
    {};

  const progress =
    toNumber(
      current?.segmentProgress
    );

  const currentStop =
    route.find(
      (stop) =>
        Number(
          stop?.sequence
        ) === currentSequence
    );

  if (!currentStop) {
    return null;
  }

  let currentDistance =
    toNumber(
      currentStop?.distance
    );

  if (
    currentDistance === null
  ) {
    return null;
  }

  // Interpolate between current and next stop.

  if (
    progress !== null
  ) {
    const nextStop =
      route.find(
        (stop) =>
          Number(
            stop?.sequence
          ) ===
          currentSequence + 1
      );

    const nextDistance =
      toNumber(
        nextStop?.distance
      );

    if (
      nextDistance !== null
    ) {
      const p =
        Math.max(
          0,
          Math.min(
            1,
            progress
          )
        );

      currentDistance =
        currentDistance +
        (
          nextDistance -
          currentDistance
        ) *
          p;
    }
  }

  return Math.abs(
    gdrDistance -
    currentDistance
  );
}


// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// sequence < GDR sequence:
//
//   train is on the route before Gudur
//
// sequence > GDR sequence:
//
//   train has passed Gudur
//
// sequence == GDR:
//
//   train is at Gudur
//
// We do NOT use this alone to select the gate.
// Corridor determines which gate.
//
// ============================================================

function getRouteDirection(
  route,
  currentLocation,
  currentStop
) {
  const gdrStop =
    findGudurRouteStop(
      route
    );

  if (!gdrStop) {
    return "UNKNOWN";
  }

  const gdrSequence =
    toNumber(
      gdrStop?.sequence
    );

  const currentSequence =
    getSequence(
      currentLocation,
      currentStop
    );

  if (
    gdrSequence === null ||
    currentSequence === null
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

  return "AT_GUDUR";
}


// ============================================================
// GET CURRENT STATION CODE
// ============================================================

function getCurrentStationCode(
  verified
) {
  const data =
    verified?.data ||
    verified ||
    {};

  const current =
    data?.currentLocation ||
    verified?.currentLocation ||
    {};

  return normalizeText(
    current?.stationCode
  );
}


// ============================================================
// CHECK IF TRAIN IS AT GUDUR
// ============================================================

function isAtGudur(
  verified,
  routeDirection
) {
  if (
    routeDirection ===
    "AT_GUDUR"
  ) {
    return true;
  }

  return (
    getCurrentStationCode(
      verified
    ) === "GDR"
  );
}


// ============================================================
// DETERMINE DEPARTURE DIRECTION FROM GUDUR
// ============================================================
//
// When a train is physically at Gudur, routeDirection is
// AT_GUDUR.
//
// We need to determine which gate it will use next.
//
// If the next route stop is on the Chennai side,
// Chennai Gate.
//
// If the next route stop is on the Tirupati side,
// Tirupati Gate.
//
// We use corridor when available.
//
// ============================================================

function determineGateCorridor(
  corridor,
  route,
  currentSequence,
  destination
) {
  if (
    corridor === "MAS" ||
    corridor === "TPTY"
  ) {
    return corridor;
  }

  // ----------------------------------------------------------
  // Try next stop
  // ----------------------------------------------------------

  if (
    Array.isArray(route) &&
    currentSequence !== null
  ) {
    const nextStop =
      route.find(
        (stop) =>
          Number(
            stop?.sequence
          ) ===
          currentSequence + 1
      );

    if (nextStop) {
      const nextText =
        [
          nextStop?.stationCode,
          nextStop?.stationName
        ]
          .filter(Boolean)
          .join(" ");

      if (
        containsAny(
          nextText,
          [
            "MAS",
            "CHENNAI",
            "NAYUDUPETA",
            "SULLURUPETA",
            "SPE",
            "NLR",
            "NELLORE"
          ]
        )
      ) {
        return "MAS";
      }

      if (
        containsAny(
          nextText,
          [
            "TPTY",
            "TIRUPATI",
            "RENIGUNTA",
            "RU"
          ]
        )
      ) {
        return "TPTY";
      }
    }
  }

  // ----------------------------------------------------------
  // Try destination
  // ----------------------------------------------------------

  if (
    containsAny(
      destination,
      [
        "CHENNAI",
        "MAS",
        "NELLORE"
      ]
    )
  ) {
    return "MAS";
  }

  if (
    containsAny(
      destination,
      [
        "TIRUPATI",
        "TPTY",
        "RENIGUNTA"
      ]
    )
  ) {
    return "TPTY";
  }

  return "OTHER";
}


// ============================================================
// CHECK GATE DISTANCE
// ============================================================

function getGateDistance(
  position,
  gate
) {
  if (
    !position ||
    !gate
  ) {
    return null;
  }

  return haversineKm(
    position.lat,
    position.lng,
    gate.lat,
    gate.lng
  );
}


// ============================================================
// DETERMINE CLOSURE ELIGIBILITY
// ============================================================
//
// A gate closes when:
//
// 1. Train is identified as MAS/TPTY.
// 2. We have an ACTUAL position.
// 3. Actual train position is within 0.6 km of that gate.
//
// This works in BOTH directions.
//
// Example:
//
// Chennai -> Gudur:
//   approaching Chennai Gate => CLOSE
//
// Gudur -> Chennai:
//   leaving Gudur toward Chennai => CLOSE
//
// Tirupati -> Gudur:
//   approaching Tirupati Gate => CLOSE
//
// Gudur -> Tirupati:
//   leaving Gudur toward Tirupati => CLOSE
//
// ============================================================

function getGateClosureInfo({
  corridor,
  routeDirection,
  route,
  currentSequence,
  actualPosition,
  destination
}) {
  let gateCorridor =
    corridor;

  // ----------------------------------------------------------
  // If at Gudur, determine departure side.
  // ----------------------------------------------------------

  if (
    routeDirection ===
    "AT_GUDUR"
  ) {
    gateCorridor =
      determineGateCorridor(
        corridor,
        route,
        currentSequence,
        destination
      );
  }

  const gate =
    getGateForCorridor(
      gateCorridor
    );

  if (!gate) {
    return {
      shouldClose: false,
      gate: null,
      distanceKm: null,
      reason:
        "Unknown corridor"
    };
  }

  // ----------------------------------------------------------
  // NO ACTUAL POSITION = NO AUTOMATIC CLOSURE
  // ----------------------------------------------------------

  if (!actualPosition) {
    return {
      shouldClose: false,
      gate,
      distanceKm: null,
      reason:
        "No actual train position"
    };
  }

  // ----------------------------------------------------------
  // ACTUAL DISTANCE TO CORRESPONDING GATE
  // ----------------------------------------------------------

  const distanceKm =
    getGateDistance(
      actualPosition,
      gate
    );

  if (
    distanceKm === null
  ) {
    return {
      shouldClose: false,
      gate,
      distanceKm: null,
      reason:
        "Gate distance unavailable"
    };
  }

  // ----------------------------------------------------------
  // SAFETY DISTANCE
  // ----------------------------------------------------------

  const shouldClose =
    distanceKm <=
    GATE_STOP_DISTANCE_KM;

  return {
    shouldClose,
    gate,
    distanceKm,
    reason:
      shouldClose
        ? "Train is within gate safety distance"
        : "Train is outside gate safety distance"
  };
}


// ============================================================
// ETA CALCULATION
// ============================================================

function calculateEtaMinutes({
  distanceToGateKm,
  distanceToGudurKm,
  speedKmh
}) {
  let distanceKm =
    distanceToGateKm;

  if (
    distanceKm === null ||
    distanceKm === undefined
  ) {
    distanceKm =
      distanceToGudurKm;
  }

  if (
    distanceKm === null ||
    distanceKm === undefined
  ) {
    return null;
  }

  const speed =
    Number(
      speedKmh
    ) > MIN_SPEED_KMH
      ? Number(
          speedKmh
        )
      : DEFAULT_SPEED_KMH;

  return Math.max(
    0,
    Math.round(
      (
        distanceKm /
        speed
      ) *
        60
    )
  );
}


// ============================================================
// MERGE VERIFIED DATA
// ============================================================

function mergeVerifiedData(
  boardItem,
  liveResponse
) {
  const boardTrain =
    boardItem?.train ||
    {};

  const boardLive =
    boardItem?.live ||
    {};

  const boardStop =
    boardItem?.stop ||
    {};

  const liveData =
    liveResponse?.data ||
    {};

  return {
    ...liveData,

    train: {
      ...boardTrain,
      ...(liveData?.train || {})
    },

    live: {
      ...boardLive,
      ...(liveData?.live || {})
    },

    stop: {
      ...boardStop,
      ...(liveData?.stop || {})
    },

    currentLocation:
      liveData?.currentLocation ||
      null,

    previousHalt:
      liveData?.previousHalt ||
      null,

    nextHalt:
      liveData?.nextHalt ||
      null,

    route:
      liveData?.route ||
      [],

    delayMinutes:
      firstValue(
        liveData?.delayMinutes,
        boardLive?.delayMinutes,
        0
      ),

    isLive:
      firstValue(
        liveData?.isLive,
        boardLive?.isLive,
        false
      ),

    status:
      firstValue(
        liveData?.status,
        boardLive?.status,
        "unknown"
      ),

    lastUpdatedAt:
      firstValue(
        liveData?.lastUpdatedAt,
        boardLive?.lastUpdatedAt,
        null
      )
  };
}


// ============================================================
// LIVE TRAIN REQUEST
// ============================================================
//
// RailRadar supports includeCoordinates=true.
//
// This lets route stops provide GPS coordinates.
//
// ============================================================

async function fetchLiveTrain(
  trainNumber
) {
  const endpoints = [
    `/trains/${trainNumber}/live`,
    `/trains/${trainNumber}`,
    `/train/${trainNumber}/live`
  ];

  let lastError =
    null;

  for (
    const endpoint of endpoints
  ) {
    try {
      const response =
        await axios.get(
          `${RAILRADAR_BASE_URL}${endpoint}`,
          {
            params: {
              includeCoordinates:
                "true"
            },

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

      return response.data;

    } catch (error) {
      lastError =
        error;

      const status =
        error?.response?.status;

      // Only try the next endpoint if
      // the endpoint does not exist.

      if (
        status !== 404
      ) {
        break;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      `Unable to fetch live train ${trainNumber}`
    )
  );
}


// ============================================================
// PROCESS TRAIN
// ============================================================

function processTrain({
  boardItem,
  verified
}) {
  const train =
    verified?.train ||
    boardItem?.train ||
    {};

  const live =
    verified?.live ||
    boardItem?.live ||
    {};

  const stop =
    verified?.stop ||
    boardItem?.stop ||
    {};

  const trainNumber =
    String(
      firstValue(
        train?.number,
        boardItem?.trainNumber
      ) || ""
    ).trim();

  const trainName =
    firstValue(
      train?.name,
      boardItem?.trainName,
      `Express ${trainNumber}`
    );

  if (!trainNumber) {
    return null;
  }

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

  const route =
    getRoute(
      verified
    );

  const currentLocation =
    verified?.currentLocation ||
    null;

  const currentStop =
    findCurrentRouteStop(
      route,
      currentLocation
    );

  const currentSequence =
    getSequence(
      currentLocation,
      currentStop
    );

  const gdrStop =
    findGudurRouteStop(
      route
    );

  const gdrSequence =
    toNumber(
      gdrStop?.sequence
    );

  const routeDirection =
    getRouteDirection(
      route,
      currentLocation,
      currentStop
    );

  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      boardItem
    );

  const corridor =
    determineCorridor({
      train,
      item: boardItem,
      route,
      gdrSequence,
      trainNumber
    });

  // ----------------------------------------------------------
  // POSITION
  // ----------------------------------------------------------

  const displayPosition =
    getBestPosition(
      verified,
      route
    );

  const actualPosition =
    getActualGatePosition(
      verified,
      route
    );

  // ----------------------------------------------------------
  // DISTANCE TO GUDUR
  // ----------------------------------------------------------

  let distanceToGudurKm =
    null;

  if (
    displayPosition
  ) {
    distanceToGudurKm =
      haversineKm(
        displayPosition.lat,
        displayPosition.lng,
        GDR_LAT,
        GDR_LNG
      );
  }

  if (
    distanceToGudurKm === null &&
    currentSequence !== null
  ) {
    distanceToGudurKm =
      calculateRouteDistanceToGudur(
        verified,
        route,
        currentSequence
      );
  }

  // ----------------------------------------------------------
  // GATE
  // ----------------------------------------------------------

  const closure =
    getGateClosureInfo({
      corridor,
      routeDirection,
      route,
      currentSequence,
      actualPosition,
      destination
    });

  // ----------------------------------------------------------
  // GATE DISTANCE
  // ----------------------------------------------------------

  const distanceToGateKm =
    closure.distanceKm;

  // ----------------------------------------------------------
  // SPEED
  // ----------------------------------------------------------

  const speedKmh =
    firstValue(
      actualPosition?.speedKmh,
      displayPosition?.speedKmh,
      live?.speedKmh,
      verified?.currentLocation?.speedKmh
    );

  // ----------------------------------------------------------
  // ETA
  // ----------------------------------------------------------

  const etaMinutes =
    calculateEtaMinutes({
      distanceToGateKm,
      distanceToGudurKm,
      speedKmh
    });

  // ----------------------------------------------------------
  // GUDUR STATUS
  // ----------------------------------------------------------

  const atGudur =
    isAtGudur(
      verified,
      routeDirection
    );

  // ----------------------------------------------------------
  // ACTUAL STATION
  // ----------------------------------------------------------

  const currentStation =
    firstValue(
      verified?.currentLocation?.stationName,
      currentStop?.stationName,
      verified?.currentLocation?.stationCode,
      ""
    );

  // ----------------------------------------------------------
  // DELAY
  // ----------------------------------------------------------

  const delayMinutes =
    Number(
      firstValue(
        verified?.delayMinutes,
        live?.delayMinutes,
        0
      )
    ) || 0;

  // ----------------------------------------------------------
  // POSITION SOURCE
  // ----------------------------------------------------------

  const positionSource =
    actualPosition?.source ||
    displayPosition?.source ||
    "NONE";

  // ----------------------------------------------------------
  // FINAL DIRECTION LABEL
  // ----------------------------------------------------------

  let direction =
    "UNKNOWN";

  if (
    routeDirection ===
    "TOWARD_GUDUR"
  ) {
    direction =
      "TOWARD GUDUR";
  } else if (
    routeDirection ===
    "AWAY_FROM_GUDUR"
  ) {
    direction =
      "AWAY FROM GUDUR";
  } else if (
    routeDirection ===
    "AT_GUDUR"
  ) {
    direction =
      "AT GUDUR";
  } else if (
    explicitDirection ===
    "TOWARD_GUDUR"
  ) {
    direction =
      "TOWARD GUDUR";
  } else if (
    explicitDirection ===
    "AWAY_FROM_GUDUR"
  ) {
    direction =
      "AWAY FROM GUDUR";
  }

  return {
    trainNumber,
    trainName,

    origin:
      origin ||
      "Unknown",

    destination:
      destination ||
      "Unknown",

    corridor,

    direction,

    routeDirection,

    explicitDirection,

    currentStation:
      currentStation ||
      "Unknown",

    currentSequence,

    gdrSequence,

    atGudur,

    delayMinutes,

    speedKmh:
      speedKmh !== null
        ? Number(
            speedKmh
          )
        : null,

    distanceToGudurKm:
      distanceToGudurKm !== null
        ? Number(
            distanceToGudurKm.toFixed(
              2
            )
          )
        : null,

    distanceToGateKm:
      distanceToGateKm !== null
        ? Number(
            distanceToGateKm.toFixed(
              3
            )
          )
        : null,

    etaMinutes,

    positionSource,

    hasActualPosition:
      Boolean(
        actualPosition
      ),

    gate:
      closure.gate?.gate ||
      null,

    gateName:
      closure.gate?.name ||
      null,

    shouldClose:
      closure.shouldClose,

    closureReason:
      closure.reason,

    gps:
      displayPosition
        ? {
            lat:
              Number(
                displayPosition.lat.toFixed(
                  6
                )
              ),

            lng:
              Number(
                displayPosition.lng.toFixed(
                  6
                )
              )
          }
        : null,

    platform:
      String(
        firstValue(
          live?.platform,
          stop?.platform,
          "1"
        )
      )
  };
}


// ============================================================
// UPCOMING TRAIN FILTER
// ============================================================
//
// Upcoming list should contain trains relevant to either
// corridor and within 150 km of Gudur.
//
// IMPORTANT:
//
// Both directions are allowed.
//
// Chennai -> Gudur
// Gudur -> Chennai
// Tirupati -> Gudur
// Gudur -> Tirupati
//
// However, the train must be geographically associated with
// MAS or TPTY.
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
    processed.atGudur
  ) {
    return false;
  }

  if (
    processed.distanceToGudurKm === null
  ) {
    return false;
  }

  if (
    processed.distanceToGudurKm >
    UPCOMING_MAX_DISTANCE_KM
  ) {
    return false;
  }

  return true;
}


// ============================================================
// GATE STATE OBJECT
// ============================================================

function createOpenGate() {
  return {
    status:
      "OPEN",

    waitMinutes:
      0,

    activeTrain:
      "Tracks clear",

    direction:
      "NO TRAIN",

    corridor:
      "NONE",

    distanceKm:
      null
  };
}


// ============================================================
// APPLY CLOSURE
// ============================================================
//
// If multiple trains are close to the same gate, the nearest
// one wins.
//
// ============================================================

function applyGateClosure(
  currentGate,
  processed
) {
  if (
    !processed?.shouldClose
  ) {
    return currentGate;
  }

  if (
    !processed.gate
  ) {
    return currentGate;
  }

  const newDistance =
    Number(
      processed.distanceToGateKm
    );

  const currentDistance =
    Number(
      currentGate.distanceKm
    );

  // Keep nearest train.

  if (
    currentGate.status ===
      "CLOSED" &&
    Number.isFinite(
      currentDistance
    ) &&
    Number.isFinite(
      newDistance
    ) &&
    currentDistance <=
      newDistance
  ) {
    return currentGate;
  }

  let waitMinutes =
    1;

  if (
    processed.etaMinutes !==
      null &&
    processed.etaMinutes !==
      undefined
  ) {
    waitMinutes =
      Math.max(
        1,
        Number(
          processed.etaMinutes
        ) + 2
      );
  }

  if (
    processed.atGudur
  ) {
    waitMinutes =
      Math.max(
        1,
        waitMinutes
      );
  }

  const statusText =
    processed.delayMinutes > 0
      ? `${processed.delayMinutes}m late`
      : "Live";

  return {
    status:
      "CLOSED",

    waitMinutes,

    activeTrain:
      `${processed.trainNumber} ${processed.trainName} (${statusText})`,

    direction:
      processed.direction,

    corridor:
      processed.corridor,

    distanceKm:
      Number(
        processed.distanceToGateKm
      ),

    positionSource:
      processed.positionSource,

    origin:
      processed.origin,

    destination:
      processed.destination
  };
}


// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  const cycleStart =
    Date.now();

  try {
    const now =
      new Date();

    const currentMinutes =
      now.getHours() * 60 +
      now.getMinutes();

    console.log(
      "\n=================================================="
    );

    console.log(
      `[${now.toLocaleTimeString()}] Gudur Gate Monitor`
    );

    console.log(
      "=================================================="
    );

    console.log(
      "Querying RailRadar live station board for GDR..."
    );


    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardResponse =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours: 4
          },

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

    let apiRequests =
      1;

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
      throw new Error(
        "RailRadar returned invalid station-board data."
      );
    }

    console.log(
      `RailRadar returned ${trainsArray.length} station-board records.`
    );


    // ========================================================
    // BUILD BOARD CANDIDATES
    // ========================================================
    //
    // We don't blindly verify the first 7 records.
    //
    // We prioritize trains that appear relevant to the two
    // Gudur corridors.
    //
    // ========================================================

    const candidates =
      trainsArray
        .map(
          (item) => {
            const train =
              item?.train ||
              {};

            const trainNumber =
              String(
                firstValue(
                  train?.number,
                  item?.trainNumber
                ) || ""
              ).trim();

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

            const text =
              normalizeText(
                [
                  train?.number,
                  train?.name,
                  origin,
                  destination
                ]
                  .filter(Boolean)
                  .join(" ")
              );

            let priority =
              0;

            // Known TPTY trains.

            if (
              TIRUPATI_CORRIDOR_TRAINS.has(
                trainNumber
              )
            ) {
              priority += 100;
            }

            // Chennai-side identifiers.

            if (
              containsAny(
                text,
                [
                  "MAS",
                  "CHENNAI",
                  "AVADI",
                  "PERAMBUR",
                  "SULLURUPETA",
                  "NAYUDUPETA"
                ]
              )
            ) {
              priority += 80;
            }

            // Tirupati-side identifiers.

            if (
              containsAny(
                text,
                [
                  "TPTY",
                  "TIRUPATI",
                  "RENIGUNTA"
                ]
              )
            ) {
              priority += 80;
            }

            // All station-board trains still get a small
            // priority so we can verify them when slots exist.

            priority += 1;

            return {
              item,
              priority
            };
          }
        )
        .sort(
          (a, b) =>
            b.priority -
            a.priority
        )
        .slice(
          0,
          MAX_BOARD_CANDIDATES
        );


    console.log(
      `Candidate trains selected: ${candidates.length}`
    );


    // ========================================================
    // VERIFY LIVE TRAINS
    // ========================================================

    const verifiedTrains =
      [];

    for (
      const candidate of candidates
    ) {
      if (
        verifiedTrains.length >=
        MAX_LIVE_REQUESTS
      ) {
        break;
      }

      const boardItem =
        candidate.item;

      const train =
        boardItem?.train ||
        {};

      const trainNumber =
        String(
          firstValue(
            train?.number,
            boardItem?.trainNumber
          ) || ""
        ).trim();

      if (!trainNumber) {
        continue;
      }

      try {
        console.log(
          `\n[LIVE ${verifiedTrains.length + 1}/${MAX_LIVE_REQUESTS}] ${trainNumber}`
        );

        const liveResponse =
          await fetchLiveTrain(
            trainNumber
          );

        apiRequests += 1;

        const merged =
          mergeVerifiedData(
            boardItem,
            liveResponse
          );

        verifiedTrains.push({
          boardItem,
          verified:
            merged
        });

      } catch (error) {
        apiRequests += 1;

        console.error(
          `[LIVE ERROR] ${trainNumber}: ${error.message}`
        );
      }
    }


    // ========================================================
    // DEFAULT GATE STATES
    // ========================================================

    let chennaiGate =
      createOpenGate();

    let tirupatiGate =
      createOpenGate();


    // ========================================================
    // UPCOMING TRAINS
    // ========================================================

    const upcomingList =
      [];


    // ========================================================
    // PROCESS VERIFIED TRAINS
    // ========================================================

    for (
      const entry of verifiedTrains
    ) {
      const processed =
        processTrain(
          entry
        );

      if (!processed) {
        continue;
      }


      // ------------------------------------------------------
      // LOG POSITION
      // ------------------------------------------------------

      console.log(
        `[TRAIN] ${processed.trainNumber} ${processed.trainName}`
      );

      console.log(
        `        ${processed.origin} -> ${processed.destination}`
      );

      console.log(
        `        direction=${processed.direction} corridor=${processed.corridor}`
      );

      console.log(
        `        position=${processed.positionSource} actual=${processed.hasActualPosition}`
      );

      console.log(
        `        GDR=${processed.distanceToGudurKm ?? "?"} km`
      );

      console.log(
        `        gate=${processed.gate || "?"} distance=${processed.distanceToGateKm ?? "?"} km`
      );


      // ------------------------------------------------------
      // UPCOMING LIST
      // ------------------------------------------------------

      if (
        shouldShowUpcoming(
          processed
        )
      ) {
        upcomingList.push(
          processed
        );
      }


      // ------------------------------------------------------
      // GATE CLOSURE
      // ------------------------------------------------------
      //
      // IMPORTANT:
      //
      // No direction restriction here.
      //
      // Both:
      //
      // Chennai -> Gudur
      // Gudur -> Chennai
      //
      // can close Chennai Gate.
      //
      // Both:
      //
      // Tirupati -> Gudur
      // Gudur -> Tirupati
      //
      // can close Tirupati Gate.
      //
      // ------------------------------------------------------

      if (
        processed.shouldClose
      ) {
        if (
          processed.gate ===
          "CHENNAI"
        ) {
          chennaiGate =
            applyGateClosure(
              chennaiGate,
              processed
            );

          console.log(
            `        🔴 CHENNAI GATE CLOSE: ${processed.trainNumber} (${processed.distanceToGateKm} km)`
          );
        }

        if (
          processed.gate ===
          "TIRUPATI"
        ) {
          tirupatiGate =
            applyGateClosure(
              tirupatiGate,
              processed
            );

          console.log(
            `        🔴 TIRUPATI GATE CLOSE: ${processed.trainNumber} (${processed.distanceToGateKm} km)`
          );
        }
      }
    }


    // ========================================================
    // SORT UPCOMING TRAINS
    // ========================================================

    upcomingList.sort(
      (a, b) => {
        const aDistance =
          a.distanceToGudurKm ??
          999999;

        const bDistance =
          b.distanceToGudurKm ??
          999999;

        return (
          aDistance -
          bDistance
        );
      }
    );


    // ========================================================
    // MAX 5 UPCOMING TRAINS
    // ========================================================

    const topUpcoming =
      upcomingList
        .slice(
          0,
          5
        )
        .map(
          (train) => ({
            trainNo:
              train.trainNumber,

            name:
              train.trainName,

            origin:
              train.origin,

            destination:
              train.destination,

            etaMinutes:
              train.etaMinutes,

            distanceToGudurKm:
              train.distanceToGudurKm,

            distanceToGateKm:
              train.distanceToGateKm,

            delayMinutes:
              train.delayMinutes,

            corridor:
              train.corridor,

            direction:
              train.direction,

            gate:
              train.gate,

            gateName:
              train.gateName,

            currentStation:
              train.currentStation,

            positionSource:
              train.positionSource,

            platform:
              train.platform
          })
        );


    // ========================================================
    // CYCLE DURATION
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        cycleStart
      ) /
      1000;


    // ========================================================
    // FIREBASE DATA
    // ========================================================

    const firebaseData = {
      tirupatiGate:
        tirupatiGate,

      chennaiGate:
        chennaiGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        now.toLocaleTimeString(),

      lastUpdatedLocal:
        now.toLocaleString(),

      verifiedTrains:
        verifiedTrains.length,

      apiRequests:
        apiRequests,

      monitorStatus:
        "OK",

      monitorDurationSeconds:
        Number(
          durationSeconds.toFixed(
            1
          )
        )
    };


    // ========================================================
    // WRITE FIREBASE
    // ========================================================

    await gateRef.set(
      firebaseData
    );


    // ========================================================
    // SUCCESS LOGS
    // ========================================================

    console.log(
      "\n=================================================="
    );

    console.log(
      "[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      ` -> Chennai Gate : ${chennaiGate.status}`
    );

    console.log(
      `    ${chennaiGate.activeTrain}`
    );

    console.log(
      ` -> Tirupati Gate: ${tirupatiGate.status}`
    );

    console.log(
      `    ${tirupatiGate.activeTrain}`
    );

    console.log(
      ` -> Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      ` -> API requests: ${apiRequests}`
    );

    console.log(
      ` -> Monitor duration: ${durationSeconds.toFixed(1)} sec`
    );

    console.log(
      "=================================================="
    );


    // ========================================================
    // UPCOMING TRAIN DISPLAY
    // ========================================================

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS]"
      );

      topUpcoming.forEach(
        (train) => {
          console.log(
            `   ${train.corridor} | ${train.trainNo} ${train.name}`
          );

          console.log(
            `      ${train.direction} | ${train.distanceToGudurKm ?? "?"} km from GDR | Gate: ${train.gate || "?"}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS] None"
      );
    }

  } catch (error) {
    // ========================================================
    // ERROR HANDLING
    // ========================================================

    console.error(
      "\n=================================================="
    );

    console.error(
      "[MONITOR ERROR]"
    );

    console.error(
      error.message
    );

    console.error(
      "=================================================="
    );

    try {
      await gateRef.set({
        chennaiGate:
          createOpenGate(),

        tirupatiGate:
          createOpenGate(),

        upcomingTrains:
          [],

        lastUpdated:
          new Date()
            .toLocaleTimeString(),

        lastUpdatedLocal:
          new Date()
            .toLocaleString(),

        verifiedTrains:
          0,

        apiRequests:
          0,

        monitorStatus:
          "ERROR",

        error:
          error.message
      });

      console.log(
        "Firebase error state written."
      );

    } catch (
      firebaseError
    ) {
      console.error(
        "❌ Could not write Firebase error state:"
      );

      console.error(
        firebaseError.message
      );
    }
  }
}


// ============================================================
// STARTUP
// ============================================================

console.log(
  "=================================================="
);

console.log(
  " Gudur Gate Real-Time Railway Monitor"
);

console.log(
  "=================================================="
);

console.log(
  "Chennai Gate:"
);

console.log(
  `  ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
);

console.log(
  "Tirupati Gate:"
);

console.log(
  `  ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
);

console.log(
  "Gudur:"
);

console.log(
  `  ${GDR_LAT}, ${GDR_LNG}`
);

console.log(
  "--------------------------------------------------"
);

console.log(
  "Gate logic:"
);

console.log(
  "  Chennai <-> Gudur  => Chennai Gate"
);

console.log(
  "  Tirupati <-> Gudur => Tirupati Gate"
);

console.log(
  "--------------------------------------------------"
);

console.log(
  `Gate closure distance: ${GATE_STOP_DISTANCE_KM} km`
);

console.log(
  `Upcoming distance: ${UPCOMING_MAX_DISTANCE_KM} km`
);

console.log(
  `Maximum live requests: ${MAX_LIVE_REQUESTS}`
);

console.log(
  "RailRadar coordinates: ENABLED"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "=================================================="
);


// ============================================================
// GITHUB ACTIONS MODE
// ============================================================
//
// GitHub Actions runs one monitor cycle and exits.
//
// ============================================================

if (
  process.env.GITHUB_ACTIONS
) {
  updateGateSystem()
    .then(
      () => {
        console.log(
          "\n=========================================="
        );

        console.log(
          " GitHub Actions monitor cycle completed "
        );

        console.log(
          "=========================================="
        );

        process.exit(0);
      }
    )
    .catch(
      (error) => {
        console.error(
          "\n❌ Monitor cycle failed:"
        );

        console.error(
          error
        );

        process.exit(1);
      }
    );

} else {

  // ==========================================================
  // LOCAL MODE
  // ==========================================================

  updateGateSystem();

  setInterval(
    updateGateSystem,
    REFRESH_INTERVAL_MS
  );
}
