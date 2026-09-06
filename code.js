const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

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

    console.log(
      "Firebase service account: GitHub Secret"
    );
  } else {
    serviceAccount = require("./serviceAccountKey.json");

    console.log(
      "Firebase service account: serviceAccountKey.json"
    );
  }
} catch (error) {
  console.error(
    "❌ Firebase service account could not be loaded."
  );

  console.error(error.message);

  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

// ============================================================
// GUDUR / GATE LOCATIONS
// ============================================================

const GDR_LAT = 14.14842;
const GDR_LNG = 79.84524;

const CHENNAI_GATE_LAT = 14.1396639;
const CHENNAI_GATE_LNG = 79.8441306;

const TIRUPATI_GATE_LAT = 14.1402056;
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SETTINGS
// ============================================================

// Upcoming trains
const UPCOMING_MAX_DISTANCE_KM = 150;
const UPCOMING_MAX_ETA_MINUTES = 360;

// Gate closure
const GATE_STOP_DISTANCE_KM = 0.60;

// Board processing
const MAX_BOARD_CANDIDATES = 30;

// Live verification is ONLY used for gate safety.
// Upcoming trains do NOT require live verification.
const MAX_LIVE_VERIFICATIONS = 12;

// RailRadar station-board window
const BOARD_HOURS = 4;

// Default ETA speed when no better information exists
const DEFAULT_SPEED_KMH = 55;

const MIN_SPEED_KMH = 5;

// ============================================================
// KNOWN TIRUPATI CORRIDOR TRAINS
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
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
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
// NUMBER HELPER
// ============================================================

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

// ============================================================
// NESTED VALUE FINDER
// ============================================================

function findNested(
  obj,
  keys,
  maxDepth = 5
) {
  if (
    obj === null ||
    obj === undefined ||
    maxDepth < 0
  ) {
    return null;
  }

  if (
    typeof obj !== "object"
  ) {
    return null;
  }

  for (const key of keys) {
    if (
      Object.prototype.hasOwnProperty.call(
        obj,
        key
      )
    ) {
      const value =
        obj[key];

      if (
        value !== null &&
        value !== undefined &&
        value !== ""
      ) {
        return value;
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const value =
      obj[key];

    if (
      value &&
      typeof value === "object"
    ) {
      const result =
        findNested(
          value,
          keys,
          maxDepth - 1
        );

      if (
        result !== null &&
        result !== undefined &&
        result !== ""
      ) {
        return result;
      }
    }
  }

  return null;
}

// ============================================================
// IST TIME
// ============================================================

function getISTParts() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    ).formatToParts(
      new Date()
    );

  const result = {};

  for (const part of parts) {
    result[part.type] =
      part.value;
  }

  return result;
}

function getISTMinutes() {
  const parts =
    getISTParts();

  return (
    Number(parts.hour) *
      60 +
    Number(parts.minute)
  );
}

function getISTTimeString() {
  const parts =
    getISTParts();

  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

// ============================================================
// TIME PARSING
// ============================================================
//
// Important:
// GitHub Actions runs in UTC.
//
// Time-only values such as "23:45" are therefore explicitly
// interpreted as IST.
//
// ISO timestamps containing timezone offsets are parsed normally.
//

function parseTimeValue(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  // Numeric value
  if (
    typeof value === "number"
  ) {
    return value;
  }

  const text =
    String(value).trim();

  // ----------------------------------------------------------
  // HH:MM or HH:MM:SS
  // ----------------------------------------------------------

  const timeMatch =
    text.match(
      /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );

  if (timeMatch) {
    const hour =
      Number(timeMatch[1]);

    const minute =
      Number(timeMatch[2]);

    const second =
      Number(
        timeMatch[3] || 0
      );

    if (
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      return {
        type: "ist-time",
        hour,
        minute,
        second
      };
    }
  }

  // ----------------------------------------------------------
  // ISO / Date timestamp
  // ----------------------------------------------------------

  const date =
    new Date(text);

  if (
    !Number.isNaN(
      date.getTime()
    )
  ) {
    return {
      type: "timestamp",
      ms: date.getTime()
    };
  }

  return null;
}

// ============================================================
// CALCULATE MINUTES UNTIL IST TIME
// ============================================================

function minutesUntilISTTime(
  parsed
) {
  if (!parsed) {
    return null;
  }

  if (
    parsed.type ===
    "timestamp"
  ) {
    const diff =
      (
        parsed.ms -
        Date.now()
      ) / 60000;

    return diff;
  }

  const current =
    getISTMinutes();

  let target =
    parsed.hour * 60 +
    parsed.minute;

  const seconds =
    parsed.second || 0;

  const currentSeconds =
    current * 60;

  let diff =
    (
      target * 60 +
      seconds -
      currentSeconds
    ) / 60;

  // Next day
  if (diff < -720) {
    diff += 1440;
  }

  // Previous day / stale
  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// EXTRACT TIME
// ============================================================

function extractArrivalTime(
  train,
  live,
  stop,
  item
) {
  return (
    stop.arrival ||
    stop.expectedArrival ||
    stop.expectedArrivalTime ||
    stop.scheduledArrival ||
    live.expectedArrival ||
    live.expectedArrivalTime ||
    live.arrival ||
    item.arrival ||
    item.expectedArrival ||
    item.expectedArrivalTime ||
    item.scheduledArrival ||
    null
  );
}

function extractDepartureTime(
  train,
  live,
  stop,
  item
) {
  return (
    stop.departure ||
    stop.expectedDeparture ||
    stop.expectedDepartureTime ||
    stop.scheduledDeparture ||
    live.expectedDeparture ||
    live.expectedDepartureTime ||
    live.departure ||
    item.departure ||
    item.expectedDeparture ||
    item.expectedDepartureTime ||
    item.scheduledDeparture ||
    null
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  const origin =
    train.source ||
    train.origin ||
    train.from ||
    train.fromStation ||
    train.startStation ||
    train.start ||
    item.source ||
    item.origin ||
    item.from ||
    item.fromStation ||
    item.startStation ||
    item.start ||
    "";

  if (
    typeof origin ===
    "object"
  ) {
    return (
      origin.name ||
      origin.code ||
      ""
    );
  }

  return String(origin);
}

// ============================================================
// DESTINATION
// ============================================================

function getDestination(
  train,
  item
) {
  const destination =
    train.destination ||
    train.to ||
    train.destinationStation ||
    train.endStation ||
    item.destination ||
    item.to ||
    item.destinationStation ||
    item.endStation ||
    "";

  if (
    typeof destination ===
    "object"
  ) {
    return (
      destination.name ||
      destination.code ||
      ""
    );
  }

  return String(destination);
}

// ============================================================
// SOURCE / ORIGIN CORRIDOR
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const origin =
    getOrigin(
      train,
      item
    );

  return containsAny(
    origin,
    [
      "CHENNAI",
      "MAS",
      "MGR CHENNAI CENTRAL",
      "DR MGR CHENNAI CENTRAL",
      "PURATCHI THALAIVAR DR MGR CENTRAL",
      "AVADI",
      "PERAMBUR",
      "SULLURUPETA",
      "NAYUDUPETA"
    ]
  );
}

function isFromTirupatiSide(
  train,
  item
) {
  const origin =
    getOrigin(
      train,
      item
    );

  return containsAny(
    origin,
    [
      "TIRUPATI",
      "TPTY",
      "RENIGUNTA",
      "RU"
    ]
  );
}

// ============================================================
// ROUTE EXTRACTION
// ============================================================

function getRouteArray(
  train,
  live,
  item
) {
  const candidates = [
    train.route,
    train.stations,
    train.routeStations,
    train.stops,
    train.routeStops,

    live.route,
    live.stations,
    live.routeStations,
    live.stops,
    live.routeStops,

    item.route,
    item.stations,
    item.routeStations,
    item.stops,
    item.routeStops
  ];

  for (
    const candidate of candidates
  ) {
    if (
      Array.isArray(candidate) &&
      candidate.length > 0
    ) {
      return candidate;
    }
  }

  return [];
}

// ============================================================
// STATION CODE
// ============================================================

function getStationCode(
  value
) {
  if (
    !value
  ) {
    return "";
  }

  if (
    typeof value ===
    "object"
  ) {
    return normalizeText(
      value.code ||
      value.stationCode ||
      value.station ||
      ""
    );
  }

  return normalizeText(
    value
  );
}

// ============================================================
// CURRENT LOCATION
// ============================================================

function getCurrentLocation(
  train,
  live,
  item
) {
  return (
    live.currentLocation ||
    train.currentLocation ||
    item.currentLocation ||
    live.currentStation ||
    train.currentStation ||
    item.currentStation ||
    live.location ||
    train.location ||
    item.location ||
    null
  );
}

// ============================================================
// ROUTE SEQUENCE
// ============================================================

function getSequence(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value ===
    "object"
  ) {
    return toNumber(
      value.sequence ??
      value.stopSequence ??
      value.routeSequence ??
      value.index
    );
  }

  return toNumber(
    value
  );
}

// ============================================================
// GET GDR SEQUENCE
// ============================================================

function getGDRSequence(
  route
) {
  if (
    !Array.isArray(route)
  ) {
    return null;
  }

  for (
    let i = 0;
    i < route.length;
    i++
  ) {
    const stop =
      route[i];

    const code =
      getStationCode(
        stop
      );

    const name =
      normalizeText(
        stop?.name ||
        stop?.stationName ||
        stop?.station ||
        ""
      );

    if (
      code === "GDR" ||
      name.includes(
        "GUDUR"
      )
    ) {
      return (
        getSequence(
          stop
        ) ?? i
      );
    }
  }

  return null;
}

// ============================================================
// GET CURRENT SEQUENCE
// ============================================================

function getCurrentSequence(
  currentLocation
) {
  if (
    !currentLocation
  ) {
    return null;
  }

  return (
    getSequence(
      currentLocation
    )
  );
}

// ============================================================
// DIRECTION TEXT
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  const fields = [
    train.direction,
    train.travelDirection,
    train.routeDirection,
    train.runningDirection,
    train.towards,
    train.toward,

    live.direction,
    live.travelDirection,
    live.routeDirection,
    live.runningDirection,
    live.towards,
    live.toward,

    stop.direction,
    stop.travelDirection,
    stop.routeDirection,
    stop.towards,
    stop.toward,

    item.direction,
    item.travelDirection,
    item.routeDirection,
    item.runningDirection,
    item.towards,
    item.toward
  ];

  return fields
    .filter(Boolean)
    .map(
      normalizeText
    )
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION
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
    return null;
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
      "APPROACHING GUDUR"
    ) ||
    direction === "INBOUND"
  ) {
    return true;
  }

  if (
    direction.includes(
      "FROM GUDUR"
    ) ||
    direction.includes(
      "GUDUR OUTBOUND"
    ) ||
    direction.includes(
      "AWAY FROM GUDUR"
    ) ||
    direction.includes(
      "TO CHENNAI"
    ) ||
    direction.includes(
      "TOWARD CHENNAI"
    ) ||
    direction.includes(
      "TOWARDS CHENNAI"
    ) ||
    direction.includes(
      "TO TIRUPATI"
    ) ||
    direction.includes(
      "TOWARD TIRUPATI"
    ) ||
    direction.includes(
      "TOWARDS TIRUPATI"
    )
  ) {
    return false;
  }

  return null;
}

// ============================================================
// ROUTE DIRECTION
// ============================================================
//
// IMPORTANT:
// Sequence is checked BEFORE "DEPART" status.
//
// This prevents a train departing from a station before Gudur
// from being incorrectly classified as outbound.
//

function getRouteDirection(
  train,
  live,
  stop,
  item
) {
  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  const route =
    getRouteArray(
      train,
      live,
      item
    );

  const currentSeq =
    getCurrentSequence(
      currentLocation
    );

  const gdrSeq =
    getGDRSequence(
      route
    );

  if (
    currentSeq !== null &&
    gdrSeq !== null
  ) {
    if (
      currentSeq <
      gdrSeq
    ) {
      return true;
    }

    if (
      currentSeq >
      gdrSeq
    ) {
      return false;
    }

    // At GDR itself
    if (
      currentSeq ===
      gdrSeq
    ) {
      const status =
        normalizeText(
          currentLocation?.status ||
          live.status ||
          item.status ||
          ""
        );

      if (
        status.includes(
          "DEPART"
        ) ||
        status.includes(
          "LEFT"
        )
      ) {
        return false;
      }

      return true;
    }
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo =
    String(
      train.number ||
      item.trainNumber ||
      item.number ||
      ""
    ).trim();

  // ----------------------------------------------------------
  // Explicit corridor
  // ----------------------------------------------------------

  const corridorText =
    normalizeText(
      train.corridor ||
      train.line ||
      train.routeName ||
      live.corridor ||
      live.line ||
      item.corridor ||
      item.line ||
      ""
    );

  if (
    corridorText.includes(
      "TPTY"
    ) ||
    corridorText.includes(
      "TIRUPATI"
    )
  ) {
    return "TPTY";
  }

  if (
    corridorText.includes(
      "MAS"
    ) ||
    corridorText.includes(
      "CHENNAI"
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Route anchors
  // ----------------------------------------------------------

  const route =
    getRouteArray(
      train,
      live,
      item
    );

  if (
    Array.isArray(route)
  ) {
    let gdrIndex =
      -1;

    for (
      let i = 0;
      i < route.length;
      i++
    ) {
      const code =
        getStationCode(
          route[i]
        );

      const name =
        normalizeText(
          route[i]?.name ||
          route[i]?.stationName ||
          route[i]?.station ||
          ""
        );

      if (
        code === "GDR" ||
        name.includes(
          "GUDUR"
        )
      ) {
        gdrIndex = i;
        break;
      }
    }

    if (
      gdrIndex >= 0
    ) {
      const beforeGDR =
        route.slice(
          0,
          gdrIndex
        );

      const beforeText =
        beforeGDR
          .map(
            (s) =>
              `${getStationCode(
                s
              )} ${normalizeText(
                s?.name ||
                s?.stationName ||
                ""
              )}`
          )
          .join(" ");

      if (
        containsAny(
          beforeText,
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

      if (
        containsAny(
          beforeText,
          [
            "CHENNAI",
            "MAS",
            "AVADI",
            "PERAMBUR",
            "SULLURUPETA",
            "NAYUDUPETA"
          ]
        )
      ) {
        return "MAS";
      }
    }
  }

  // ----------------------------------------------------------
  // Origin fallback
  // ----------------------------------------------------------

  if (
    isFromTirupatiSide(
      train,
      item
    )
  ) {
    return "TPTY";
  }

  if (
    isFromChennaiSide(
      train,
      item
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Known TPTY trains
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// ACTUAL GPS POSITION
// ============================================================

function extractActualGpsPosition(
  train,
  live,
  item
) {
  const objects = [
    live,
    train,
    item,
    live.currentLocation,
    train.currentLocation,
    item.currentLocation,
    live.location,
    train.location,
    item.location
  ].filter(Boolean);

  for (
    const obj of objects
  ) {
    const lat =
      toNumber(
        obj.lat ??
        obj.latitude
      );

    const lng =
      toNumber(
        obj.lng ??
        obj.lon ??
        obj.longitude
      );

    if (
      lat !== null &&
      lng !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      const actual =
        obj.isActualPosition;

      if (
        actual === true ||
        actual === "true" ||
        actual === 1
      ) {
        return {
          lat,
          lng,
          bearing:
            toNumber(
              obj.bearing ??
              obj.heading
            ),
          speed:
            toNumber(
              obj.speed ??
              obj.speedKmh ??
              obj.speedKmH
            ),
          isActualPosition:
            true,
          source:
            "gps"
        };
      }
    }
  }

  return null;
}

// ============================================================
// ACTUAL STATION POSITION
// ============================================================

function extractActualStationPosition(
  train,
  live,
  item
) {
  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  if (
    !currentLocation
  ) {
    return null;
  }

  const isActual =
    currentLocation.isActualPosition;

  if (
    !(
      isActual === true ||
      isActual === "true" ||
      isActual === 1
    )
  ) {
    return null;
  }

  const code =
    getStationCode(
      currentLocation
    );

  const name =
    normalizeText(
      currentLocation.name ||
      currentLocation.stationName ||
      currentLocation.station ||
      ""
    );

  if (
    code === "GDR" ||
    name.includes(
      "GUDUR"
    )
  ) {
    return {
      lat: GDR_LAT,
      lng: GDR_LNG,
      isActualPosition:
        true,
      source:
        "station-code"
    };
  }

  return null;
}

// ============================================================
// ACTUAL POSITION
// ============================================================

function getActualPosition(
  train,
  live,
  item
) {
  const gps =
    extractActualGpsPosition(
      train,
      live,
      item
    );

  if (gps) {
    return gps;
  }

  const station =
    extractActualStationPosition(
      train,
      live,
      item
    );

  if (station) {
    return station;
  }

  return null;
}

// ============================================================
// HAVERSINE
// ============================================================

function haversineKm(
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
      lat1 *
        Math.PI /
        180
    ) *
      Math.cos(
        lat2 *
          Math.PI /
          180
      ) *
      Math.sin(
        dLng / 2
      ) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

// ============================================================
// DISTANCE TO GUDUR
// ============================================================

function getDistanceToGudur(
  position
) {
  if (
    !position
  ) {
    return null;
  }

  return haversineKm(
    position.lat,
    position.lng,
    GDR_LAT,
    GDR_LNG
  );
}

// ============================================================
// SPEED
// ============================================================

function getTrainSpeed(
  live,
  position
) {
  const speed =
    toNumber(
      position?.speed ??
      live?.speed ??
      live?.speedKmh ??
      live?.speedKmH
    );

  if (
    speed !== null &&
    speed >= MIN_SPEED_KMH
  ) {
    return speed;
  }

  return DEFAULT_SPEED_KMH;
}

// ============================================================
// ETA FROM PHYSICAL DISTANCE
// ============================================================

function calculatePhysicalEta(
  distanceKm,
  speedKmh
) {
  if (
    distanceKm === null ||
    distanceKm === undefined ||
    speedKmh <= 0
  ) {
    return null;
  }

  return (
    distanceKm /
    speedKmh *
    60
  );
}

// ============================================================
// BOARD ETA
// ============================================================

function getBoardEtaMinutes(
  train,
  live,
  stop,
  item
) {
  // ----------------------------------------------------------
  // Direct numeric ETA fields
  // ----------------------------------------------------------

  const numericEta =
    findNested(
      item,
      [
        "etaMinutes",
        "etaMins",
        "minutesToArrival",
        "minutesAway",
        "arrivalInMinutes"
      ]
    );

  const numeric =
    toNumber(
      numericEta
    );

  if (
    numeric !== null
  ) {
    return numeric;
  }

  // ----------------------------------------------------------
  // Distance + speed
  // ----------------------------------------------------------

  const distance =
    toNumber(
      findNested(
        item,
        [
          "distanceFromGudurKm",
          "distanceToGudurKm",
          "distanceFromStationKm",
          "distanceKm"
        ]
      )
    );

  if (
    distance !== null
  ) {
    const speed =
      toNumber(
        findNested(
          item,
          [
            "speed",
            "speedKmh",
            "speedKmH"
          ]
        )
      ) ||
      DEFAULT_SPEED_KMH;

    return calculatePhysicalEta(
      distance,
      Math.max(
        MIN_SPEED_KMH,
        speed
      )
    );
  }

  // ----------------------------------------------------------
  // Arrival time
  // ----------------------------------------------------------

  const arrival =
    extractArrivalTime(
      train,
      live,
      stop,
      item
    );

  if (
    arrival
  ) {
    const parsed =
      parseTimeValue(
        arrival
      );

    const diff =
      minutesUntilISTTime(
        parsed
      );

    if (
      diff !== null
    ) {
      return diff;
    }
  }

  return null;
}

// ============================================================
// LIVE ETA
// ============================================================

function calculateLiveEta(
  train,
  live,
  stop,
  item,
  actualPosition
) {
  const distance =
    getDistanceToGudur(
      actualPosition
    );

  if (
    distance !== null
  ) {
    const speed =
      getTrainSpeed(
        live,
        actualPosition
      );

    const eta =
      calculatePhysicalEta(
        distance,
        speed
      );

    if (
      eta !== null
    ) {
      return eta;
    }
  }

  return getBoardEtaMinutes(
    train,
    live,
    stop,
    item
  );
}

// ============================================================
// BOARD UPCOMING DECISION
// ============================================================
//
// A GDR station board is specifically a board for trains
// associated with Gudur station.
//
// Therefore, when RailRadar gives an arrival time but does not
// provide an explicit direction, we can safely treat the future
// arrival as an inbound-to-Gudur candidate.
//
// We still reject trains that are explicitly departing/away.
//

function isBoardTrainUpcoming(
  train,
  live,
  stop,
  item
) {
  const explicit =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  if (
    explicit === false
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // Check current station status
  // ----------------------------------------------------------

  const currentLocation =
    getCurrentLocation(
      train,
      live,
      item
    );

  const status =
    normalizeText(
      currentLocation?.status ||
      live.status ||
      item.status ||
      stop.status ||
      ""
    );

  if (
    status.includes(
      "DEPARTED"
    ) ||
    status.includes(
      "LEFT GUDUR"
    ) ||
    status.includes(
      "OUTBOUND"
    )
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // Route direction
  // ----------------------------------------------------------

  const routeDirection =
    getRouteDirection(
      train,
      live,
      stop,
      item
    );

  if (
    routeDirection === false
  ) {
    return false;
  }

  // ----------------------------------------------------------
  // Arrival ETA
  // ----------------------------------------------------------

  const eta =
    getBoardEtaMinutes(
      train,
      live,
      stop,
      item
    );

  if (
    eta === null
  ) {
    return false;
  }

  // Already passed
  if (
    eta < -15
  ) {
    return false;
  }

  // Outside upcoming window
  if (
    eta >
    UPCOMING_MAX_ETA_MINUTES
  ) {
    return false;
  }

  return true;
}

// ============================================================
// GATE CLOSURE
// ============================================================
//
// VERY IMPORTANT:
//
// The gate is CLOSED only when:
//
// 1. Live data exists
// 2. Position is confirmed actual
// 3. Train is on MAS or TPTY corridor
// 4. Actual physical distance <= 0.60 km
//
// Station-board ETA alone NEVER closes a gate.
//

function shouldCloseGate(
  corridor,
  actualPosition
) {
  if (
    !actualPosition ||
    !actualPosition.isActualPosition
  ) {
    return false;
  }

  if (
    corridor !== "MAS" &&
    corridor !== "TPTY"
  ) {
    return false;
  }

  const distance =
    getDistanceToGudur(
      actualPosition
    );

  if (
    distance === null
  ) {
    return false;
  }

  return (
    distance <=
    GATE_STOP_DISTANCE_KM
  );
}

// ============================================================
// GATE WAIT TIME
// ============================================================

function calculateGateWait(
  distanceKm,
  speedKmh,
  stopStatus
) {
  if (
    stopStatus ===
    "AT STATION"
  ) {
    return 5;
  }

  if (
    distanceKm === null
  ) {
    return 5;
  }

  const eta =
    calculatePhysicalEta(
      distanceKm,
      speedKmh
    );

  if (
    eta === null
  ) {
    return 5;
  }

  return Math.max(
    1,
    Math.ceil(
      eta + 2
    )
  );
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(
  train,
  item
) {
  return String(
    train.number ||
    item.trainNumber ||
    train.trainNumber ||
    item.number ||
    ""
  ).trim();
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  train,
  item
) {
  return (
    train.name ||
    item.trainName ||
    train.trainName ||
    `Express ${getTrainNumber(
      train,
      item
    )}`
  );
}

// ============================================================
// PLATFORM
// ============================================================

function getPlatform(
  train,
  live,
  stop,
  item
) {
  return String(
    live.platform ||
    stop.platform ||
    item.platform ||
    train.platform ||
    "1"
  );
}

// ============================================================
// LIVE REQUEST
// ============================================================

async function getLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
      trainNo
    )}/live`;

  console.log(
    `   Live request: /trains/${trainNo}/live`
  );

  const response =
    await axios.get(
      url,
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

  return response.data;
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  const startedAt =
    Date.now();

  let apiRequests = 0;

  try {
    const now =
      new Date();

    console.log(
      "\n=========================================="
    );

    console.log(
      ` RailRadar Real-time Gate Monitor Active`
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Gudur: ${GDR_LAT}, ${GDR_LNG}`
    );

    console.log(
      `Chennai Gate: ${CHENNAI_GATE_LAT}, ${CHENNAI_GATE_LNG}`
    );

    console.log(
      `Tirupati Gate: ${TIRUPATI_GATE_LAT}, ${TIRUPATI_GATE_LNG}`
    );

    console.log(
      "=========================================="
    );

    console.log(
      "Firebase: Configured"
    );

    console.log(
      "RailRadar: Configured"
    );

    console.log(
      "Gate closure: ACTUAL POSITION ONLY"
    );

    console.log(
      "Gate direction: BOTH DIRECTIONS"
    );

    console.log(
      `Upcoming max distance: ${UPCOMING_MAX_DISTANCE_KM} km`
    );

    console.log(
      `Upcoming max ETA: ${UPCOMING_MAX_ETA_MINUTES} minutes`
    );

    console.log(
      `Live verification limit: ${MAX_LIVE_VERIFICATIONS}`
    );

    console.log(
      "=========================================="
    );

    console.log(
      `\n[${getISTTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    if (
      !RAILRADAR_API_KEY
    ) {
      throw new Error(
        "RAILRADAR_API_KEY is missing."
      );
    }

    // ========================================================
    // STATION BOARD
    // ========================================================

    const boardUrl =
      `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=${BOARD_HOURS}`;

    const boardRes =
      await axios.get(
        boardUrl,
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

    apiRequests++;

    const responseBody =
      boardRes.data;

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
        "RailRadar returned invalid train data."
      );
    }

    console.log(
      `✅ RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // GATE DEFAULTS
    // ========================================================

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear",
      direction:
        "CLEAR",
      corridor:
        "MAS"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain:
        "Tracks clear",
      direction:
        "CLEAR",
      corridor:
        "TPTY"
    };

    // ========================================================
    // UPCOMING LIST
    // ========================================================

    const upcomingMap =
      new Map();

    // ========================================================
    // LIVE VERIFICATION CANDIDATES
    // ========================================================

    const liveCandidates = [];

    // ========================================================
    // PROCESS BOARD
    // ========================================================

    const boardLimit =
      Math.min(
        trainsArray.length,
        MAX_BOARD_CANDIDATES
      );

    for (
      let index = 0;
      index < boardLimit;
      index++
    ) {
      const item =
        trainsArray[index] ||
        {};

      const train =
        item.train ||
        {};

      const live =
        item.live ||
        {};

      const stop =
        item.stop ||
        {};

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

      const trainName =
        getTrainName(
          train,
          item
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

      const corridor =
        determineCorridor(
          train,
          live,
          stop,
          item
        );

      const explicitDirection =
        getExplicitDirection(
          train,
          live,
          stop,
          item
        );

      const routeDirection =
        getRouteDirection(
          train,
          live,
          stop,
          item
        );

      let direction =
        null;

      if (
        explicitDirection !==
        null
      ) {
        direction =
          explicitDirection
            ? "TOWARD_GUDUR"
            : "AWAY_FROM_GUDUR";
      } else if (
        routeDirection !==
        null
      ) {
        direction =
          routeDirection
            ? "TOWARD_GUDUR"
            : "AWAY_FROM_GUDUR";
      } else {
        direction =
          "UNKNOWN";
      }

      const boardEta =
        getBoardEtaMinutes(
          train,
          live,
          stop,
          item
        );

      console.log(
        `[BOARD ${index + 1}/${boardLimit}] ${trainNo} ${trainName} | ${corridor || "UNKNOWN"} | ${direction} | ETA ${
          boardEta === null
            ? "UNKNOWN"
            : `${Math.round(boardEta)}m`
        }`
      );

      // ======================================================
      // UPCOMING
      // ======================================================

      const upcoming =
        isBoardTrainUpcoming(
          train,
          live,
          stop,
          item
        );

      if (
        upcoming &&
        boardEta !== null
      ) {
        let upcomingCorridor =
          corridor;

        // ----------------------------------------------------
        // If corridor unknown, known TPTY list can identify it.
        // Otherwise keep OTHER so frontend does not falsely
        // label it MAS/TPTY.
        // ----------------------------------------------------

        if (
          !upcomingCorridor &&
          TIRUPATI_CORRIDOR_TRAINS.has(
            trainNo
          )
        ) {
          upcomingCorridor =
            "TPTY";
        }

        const etaMinutes =
          Math.max(
            0,
            Math.round(
              boardEta
            )
          );

        const key =
          trainNo;

        upcomingMap.set(
          key,
          {
            trainNo,
            name:
              trainName,

            origin:
              origin ||
              "Unknown origin",

            destination:
              destination ||
              "Gudur",

            etaMinutes,

            delayMinutes:
              Number(
                live.delayMinutes ||
                item.delayMinutes ||
                0
              ),

            corridor:
              upcomingCorridor ||
              "OTHER",

            direction:
              "TOWARD_GUDUR",

            platform:
              getPlatform(
                train,
                live,
                stop,
                item
              )
          }
        );

        console.log(
          `   [UPCOMING] ${trainNo} accepted for upcoming list`
        );
      } else {
        console.log(
          `   [UPCOMING] ${trainNo} not added`
        );
      }

      // ======================================================
      // LIVE VERIFICATION CANDIDATE
      // ======================================================
      //
      // Only trains that may be relevant to a MAS/TPTY gate
      // are sent to the live endpoint.
      //
      // This avoids unnecessarily requesting every board train.
      //

      const likelyCorridor =
        corridor === "MAS" ||
        corridor === "TPTY";

      const likelyNear =
        boardEta !== null &&
        boardEta <= 180;

      const likelyDirection =
        explicitDirection !== false &&
        routeDirection !== false;

      if (
        likelyCorridor &&
        likelyDirection &&
        likelyNear
      ) {
        liveCandidates.push({
          index,
          item,
          train,
          live,
          stop,
          trainNo,
          trainName,
          corridor,
          boardEta
        });
      }
    }

    // ========================================================
    // SORT LIVE CANDIDATES
    // ========================================================

    liveCandidates.sort(
      (a, b) => {
        const aEta =
          a.boardEta ??
          999999;

        const bEta =
          b.boardEta ??
          999999;

        return (
          aEta -
          bEta
        );
      }
    );

    // ========================================================
    // LIVE VERIFY
    // ========================================================

    const verifyCount =
      Math.min(
        liveCandidates.length,
        MAX_LIVE_VERIFICATIONS
      );

    const verifiedTrains =
      [];

    for (
      let i = 0;
      i < verifyCount;
      i++
    ) {
      const candidate =
        liveCandidates[i];

      try {
        const liveResponse =
          await getLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        const liveData =
          liveResponse?.data ||
          liveResponse;

        const verifiedTrain =
          liveData?.train ||
          candidate.train;

        const verifiedLive =
          liveData?.live ||
          liveData;

        const verifiedStop =
          liveData?.stop ||
          candidate.stop;

        const verifiedItem = {
          ...candidate.item,
          live:
            verifiedLive,
          stop:
            verifiedStop,
          train:
            verifiedTrain,
          currentLocation:
            liveData?.currentLocation
        };

        // ----------------------------------------------------
        // Actual position
        // ----------------------------------------------------

        const actualPosition =
          getActualPosition(
            verifiedTrain,
            verifiedLive,
            verifiedItem
          );

        const actualDistance =
          getDistanceToGudur(
            actualPosition
          );

        // ----------------------------------------------------
        // Recalculate direction/corridor using live data
        // ----------------------------------------------------

        const verifiedCorridor =
          determineCorridor(
            verifiedTrain,
            verifiedLive,
            verifiedStop,
            verifiedItem
          ) ||
          candidate.corridor;

        const verifiedDirection =
          getExplicitDirection(
            verifiedTrain,
            verifiedLive,
            verifiedStop,
            verifiedItem
          );

        const routeDirection =
          getRouteDirection(
            verifiedTrain,
            verifiedLive,
            verifiedStop,
            verifiedItem
          );

        let finalDirection;

        if (
          verifiedDirection !==
          null
        ) {
          finalDirection =
            verifiedDirection;
        } else if (
          routeDirection !==
          null
        ) {
          finalDirection =
            routeDirection;
        } else {
          finalDirection =
            true;
        }

        const delayMin =
          Number(
            verifiedLive?.delayMinutes ||
            0
          );

        const speed =
          getTrainSpeed(
            verifiedLive,
            actualPosition
          );

        const liveEta =
          calculateLiveEta(
            verifiedTrain,
            verifiedLive,
            verifiedStop,
            verifiedItem,
            actualPosition
          );

        const stationStatus =
          normalizeText(
            verifiedLive?.status ||
            liveData?.currentLocation?.status ||
            ""
          );

        console.log(
          `   [VERIFY] ${candidate.trainNo} | corridor=${verifiedCorridor || "UNKNOWN"} | direction=${
            finalDirection
              ? "TOWARD_GUDUR"
              : "AWAY_FROM_GUDUR"
          } | actual=${
            actualPosition
              ? "YES"
              : "NO"
          } | distance=${
            actualDistance === null
              ? "UNKNOWN"
              : `${actualDistance.toFixed(3)} km`
          } | ETA=${
            liveEta === null
              ? "UNKNOWN"
              : `${Math.round(liveEta)}m`
          }`
        );

        verifiedTrains.push({
          trainNo:
            candidate.trainNo,
          name:
            getTrainName(
              verifiedTrain,
              verifiedItem
            ),
          corridor:
            verifiedCorridor ||
            "OTHER",
          direction:
            finalDirection
              ? "TOWARD_GUDUR"
              : "AWAY_FROM_GUDUR",
          actualPosition:
            Boolean(
              actualPosition
            ),
          distanceToGudurKm:
            actualDistance === null
              ? null
              : Number(
                  actualDistance.toFixed(
                    3
                  )
                ),
          etaMinutes:
            liveEta === null
              ? null
              : Number(
                  Math.max(
                    0,
                    liveEta
                  ).toFixed(
                    1
                  )
                ),
          delayMinutes:
            delayMin,
          speedKmh:
            speed,
          status:
            stationStatus ||
            "RUNNING"
        });

        // ====================================================
        // GATE CLOSURE
        // ====================================================

        const closeGate =
          finalDirection === true &&
          shouldCloseGate(
            verifiedCorridor,
            actualPosition
          );

        if (
          closeGate
        ) {
          const gateStatus =
            stationStatus.includes(
              "AT STATION"
            )
              ? "AT STATION"
              : delayMin > 0
                ? `${delayMin}m late`
                : "Approaching";

          const waitMinutes =
            calculateGateWait(
              actualDistance,
              speed,
              stationStatus.includes(
                "AT STATION"
              )
                ? "AT STATION"
                : "RUNNING"
            );

          const payload = {
            status:
              "CLOSED",

            waitMinutes,

            activeTrain:
              `${candidate.trainNo} ${getTrainName(
                verifiedTrain,
                verifiedItem
              )} (${gateStatus})`,

            direction:
              "TOWARD_GUDUR",

            corridor:
              verifiedCorridor,

            distanceToGudurKm:
              actualDistance === null
                ? null
                : Number(
                    actualDistance.toFixed(
                      3
                    )
                  ),

            speedKmh:
              speed
          };

          if (
            verifiedCorridor ===
            "MAS"
          ) {
            masGate =
              payload;
          }

          if (
            verifiedCorridor ===
            "TPTY"
          ) {
            tptyGate =
              payload;
          }

          console.log(
            `   🚨 GATE CLOSE: ${candidate.trainNo} -> ${verifiedCorridor}`
          );
        }
      } catch (liveError) {
        console.error(
          `   ❌ Live verification failed for ${candidate.trainNo}: ${liveError.message}`
        );
      }
    }

    // ========================================================
    // FINAL UPCOMING LIST
    // ========================================================

    const upcomingList =
      Array.from(
        upcomingMap.values()
      )
      .filter(
        (train) =>
          train.etaMinutes >= 0 &&
          train.etaMinutes <=
            UPCOMING_MAX_ETA_MINUTES
      )
      .sort(
        (a, b) =>
          a.etaMinutes -
          b.etaMinutes
      )
      .slice(
        0,
        5
      );

    // ========================================================
    // IMPORTANT:
    //
    // If live verification discovers a more accurate ETA for
    // an upcoming train, update the corresponding record.
    // ========================================================

    for (
      const verified of
      verifiedTrains
    ) {
      if (
        verified.direction !==
        "TOWARD_GUDUR"
      ) {
        continue;
      }

      const existing =
        upcomingMap.get(
          verified.trainNo
        );

      if (
        !existing
      ) {
        continue;
      }

      if (
        verified.etaMinutes !==
          null &&
        verified.etaMinutes <=
          UPCOMING_MAX_ETA_MINUTES
      ) {
        existing.etaMinutes =
          Math.round(
            verified.etaMinutes
          );
      }

      if (
        verified.corridor ===
          "MAS" ||
        verified.corridor ===
          "TPTY"
      ) {
        existing.corridor =
          verified.corridor;
      }

      existing.direction =
        "TOWARD_GUDUR";
    }

    const safeUpcoming =
      Array.from(
        upcomingMap.values()
      )
      .filter(
        (train) =>
          train.etaMinutes >= 0 &&
          train.etaMinutes <=
            UPCOMING_MAX_ETA_MINUTES
      )
      .sort(
        (a, b) =>
          a.etaMinutes -
          b.etaMinutes
      )
      .slice(
        0,
        5
      );

    // ========================================================
    // FIREBASE UPDATE
    // ========================================================

    const durationSeconds =
      (
        Date.now() -
        startedAt
      ) / 1000;

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        safeUpcoming,

      lastUpdated:
        getISTTimeString(),

      lastUpdatedLocal:
        new Date().toLocaleString(
          "en-IN",
          {
            timeZone:
              "Asia/Kolkata"
          }
        ),

      lastUpdatedAt:
        new Date().toISOString(),

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
      "       SYNC SUCCESS"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Chennai Gate : ${masGate.status}`
    );

    if (
      masGate.status ===
      "CLOSED"
    ) {
      console.log(
        `  Train: ${masGate.activeTrain}`
      );

      console.log(
        `  Distance: ${masGate.distanceToGudurKm} km`
      );
    }

    console.log(
      `Tirupati Gate: ${tptyGate.status}`
    );

    if (
      tptyGate.status ===
      "CLOSED"
    ) {
      console.log(
        `  Train: ${tptyGate.activeTrain}`
      );

      console.log(
        `  Distance: ${tptyGate.distanceToGudurKm} km`
      );
    }

    console.log(
      `Upcoming     : ${safeUpcoming.length}`
    );

    console.log(
      `Verified     : ${verifiedTrains.length}`
    );

    console.log(
      `API Requests : ${apiRequests}`
    );

    console.log(
      `Duration     : ${durationSeconds.toFixed(1)} sec`
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // SHOW UPCOMING TRAINS
    // ========================================================

    if (
      safeUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      safeUpcoming.forEach(
        (train, index) => {
          console.log(
            ` ${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} | ETA ${train.etaMinutes}m | PF ${train.platform}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    console.log(
      "\n=========================================="
    );

    console.log(
      " GitHub Actions monitor cycle completed"
    );

    console.log(
      "=========================================="
    );
  } catch (err) {
    const durationSeconds =
      (
        Date.now() -
        startedAt
      ) / 1000;

    console.error(
      "\n=========================================="
    );

    console.error(
      "       MONITOR ERROR"
    );

    console.error(
      "=========================================="
    );

    if (
      err.response
    ) {
      console.error(
        `HTTP ${err.response.status}`
      );

      console.error(
        "Response:",
        err.response.data
      );
    } else {
      console.error(
        err.message
      );
    }

    // ========================================================
    // FAIL-SAFE FIREBASE STATE
    // ========================================================
    //
    // On API failure we do NOT claim a train is approaching.
    // Gates return to OPEN / UNKNOWN data state.
    //

    try {
      await gateRef.set({
        tirupatiGate: {
          status: "OPEN",
          waitMinutes: 0,
          activeTrain:
            "Monitoring unavailable",
          direction:
            "UNKNOWN",
          corridor:
            "TPTY"
        },

        chennaiGate: {
          status: "OPEN",
          waitMinutes: 0,
          activeTrain:
            "Monitoring unavailable",
          direction:
            "UNKNOWN",
          corridor:
            "MAS"
        },

        upcomingTrains: [],

        lastUpdated:
          getISTTimeString(),

        lastUpdatedLocal:
          new Date().toLocaleString(
            "en-IN",
            {
              timeZone:
                "Asia/Kolkata"
            }
          ),

        lastUpdatedAt:
          new Date().toISOString(),

        lastUpdatedAtMs:
          Date.now(),

        verifiedTrains: 0,

        apiRequests,

        monitorStatus:
          "ERROR",

        monitorDurationSeconds:
          Number(
            durationSeconds.toFixed(
              1
            )
          )
      });
    } catch (
      firebaseError
    ) {
      console.error(
        "Firebase error:",
        firebaseError.message
      );
    }

    process.exitCode = 1;
  }
}

// ============================================================
// START
// ============================================================

updateGateSystem();

// ============================================================
// GITHUB ACTIONS:
// One execution per workflow run.
//
// Local/server execution:
// refresh every 60 seconds.
//
// GitHub Actions normally runs this file once per workflow.
// ============================================================

if (
  process.env.GITHUB_ACTIONS !==
  "true"
) {
  setInterval(
    updateGateSystem,
    60000
  );
}
