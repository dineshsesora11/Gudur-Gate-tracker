const axios = require("axios");
const admin = require("firebase-admin");

// ============================================================
// GUDUR GATE RAILRADAR MONITOR
// ============================================================

const FIREBASE_DATABASE_URL =
  "https://gudur-gate-tracker-default-rtdb.firebaseio.com";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

// ============================================================
// FIREBASE INITIALIZATION
// ============================================================

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return;
  }

  // GitHub Actions:
  // FIREBASE_SERVICE_ACCOUNT should contain the complete JSON.
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount =
        JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_DATABASE_URL
      });

      return;
    } catch (error) {
      console.error(
        "❌ FIREBASE_SERVICE_ACCOUNT contains invalid JSON."
      );

      console.error(error.message);
      process.exit(1);
    }
  }

  // Local fallback:
  // serviceAccountKey.json
  try {
    const serviceAccount =
      require("./serviceAccountKey.json");

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DATABASE_URL
    });

    return;
  } catch (error) {
    console.error(
      "❌ Firebase service account not found."
    );

    console.error(
      "Set FIREBASE_SERVICE_ACCOUNT in GitHub Actions"
    );

    console.error(
      "or place serviceAccountKey.json beside code.js."
    );

    process.exit(1);
  }
}

initializeFirebase();

const db =
  admin.database();

const gateRef =
  db.ref("gudur_gates");

// ============================================================
// LOCATION CONFIGURATION
// ============================================================

const GUDUR_JUNCTION = {
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
// DISTANCE CONFIGURATION
// ============================================================
//
// 1 km = tracking/preparation radius.
//
// 0.60 km = actual gate closing zone.
//
// 0.80 km = train has cleared gate zone.
//
// IMPORTANT:
// The gate does NOT close merely because a train enters
// the 1 km tracking radius.
//
// It closes only when:
//   1. train has departed Gudur
//   2. live position is confirmed
//   3. train reaches the appropriate gate zone
//
// ============================================================

const TRACKING_DISTANCE_KM = 1.00;

const GATE_CLOSE_DISTANCE_KM = 0.60;

const GATE_CLEAR_DISTANCE_KM = 0.80;

// Keep old tracking records for this long.
const TRACKING_RETENTION_MINUTES = 45;

// Upcoming board display.
const UPCOMING_MAX_ETA_MINUTES = 360;

// ============================================================
// LIVE API QUOTA PROTECTION
// ============================================================
//
// Free API protection.
//
// Only one live-train request is allowed every 20 minutes.
//
// Board requests are still performed every GitHub Actions run.
//
// ============================================================

const LIVE_CALL_INTERVAL_MINUTES = 20;

// ============================================================
// KNOWN TIRUPATI -> GUDUR TRAINS
// ============================================================
//
// These are FALLBACK identifiers only.
//
// They are NOT sufficient to close a gate.
//
// Actual gate closure still requires live coordinates.
//
// ============================================================

const TIRUPATI_INBOUND_TRAINS =
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
    "12761",
    "12762",
    "12863",
    "12864"
  ]);

// ============================================================
// KNOWN CHENNAI / SOUTHBOUND TRAINS
// ============================================================
//
// Fallback classification.
//
// Again, these numbers NEVER directly close a gate.
//
// ============================================================

const CHENNAI_INBOUND_TRAINS =
  new Set([
    "16032",
    "12622",
    "12759",
    "12760",
    "12603",
    "12604",
    "12605",
    "12606",
    "12607",
    "12608",
    "12609",
    "12610",
    "12611",
    "12612",
    "12613",
    "12614",
    "12615",
    "12616",
    "12623",
    "12624",
    "12625",
    "12626",
    "12639",
    "12640",
    "12841",
    "12842",
    "12843",
    "12844",
    "12845",
    "12846",
    "16021",
    "16022",
    "16101",
    "16102",
    "16105",
    "16106",
    "16107",
    "16108",
    "18509",
    "22365",
    "03251",
    "66040"
  ]);

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

// ============================================================
// GENERIC FIELD HELPERS
// ============================================================

function firstValue(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return value;
    }
  }

  return "";
}

function textFromValues(values) {
  return values
    .filter(
      (value) =>
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ""
    )
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// STATION / LOCATION TEXT
// ============================================================

function stationText(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return normalizeText(value);
  }

  if (typeof value === "object") {
    return textFromValues([
      value.code,
      value.name,
      value.stationCode,
      value.stationName
    ]);
  }

  return normalizeText(value);
}

// ============================================================
// TRAIN NUMBER
// ============================================================

function getTrainNumber(train, item) {
  return String(
    firstValue(
      train?.number,
      train?.trainNumber,
      item?.trainNumber,
      item?.number
    )
  ).trim();
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(train, item) {
  return firstValue(
    train?.name,
    train?.trainName,
    item?.trainName,
    `Express ${getTrainNumber(train, item)}`
  );
}

// ============================================================
// ORIGIN
// ============================================================

function getOrigin(train, item) {
  const source =
    firstValue(
      train?.source,
      train?.origin,
      train?.from,
      train?.fromStation,
      train?.startStation,
      train?.start,
      item?.source,
      item?.origin,
      item?.from,
      item?.fromStation,
      item?.startStation
    );

  return stationText(source);
}

// ============================================================
// DESTINATION
// ============================================================

function getDestination(train, item) {
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

  return stationText(destination);
}

// ============================================================
// ORIGIN / DESTINATION RAW TEXT
// ============================================================

function getRouteText(train, item) {
  return textFromValues([
    getOrigin(train, item),
    getDestination(train, item),

    train?.route,
    train?.routeName,

    item?.route,
    item?.routeName
  ]);
}

// ============================================================
// CHENNAI SIDE DETECTION
// ============================================================

function isChennaiSide(train, item) {
  const text =
    textFromValues([
      getOrigin(train, item),

      train?.source,
      train?.origin,
      train?.from,
      train?.fromStation,
      train?.startStation,

      item?.source,
      item?.origin,
      item?.from,
      item?.fromStation,
      item?.startStation
    ]);

  return [
    "CHENNAI",
    "MGR CHENNAI",
    "MAS",
    "MGR",
    "TAMBARAM",
    "TBM",
    "CHENGALPATTU",
    "CGL",
    "ARAKKONAM",
    "AJJ",
    "MELPAKKAM",
    "PERAMBUR",
    "AVADI",
    "SULLURUPETA",
    "NAYUDUPETA"
  ].some(
    (name) =>
      text.includes(
        normalizeText(name)
      )
  );
}

// ============================================================
// TIRUPATI SIDE DETECTION
// ============================================================

function isTirupatiSide(train, item) {
  const text =
    textFromValues([
      getOrigin(train, item),

      train?.source,
      train?.origin,
      train?.from,
      train?.fromStation,
      train?.startStation,

      item?.source,
      item?.origin,
      item?.from,
      item?.fromStation,
      item?.startStation
    ]);

  return [
    "TIRUPATI",
    "TPTY",
    "RENIGUNTA",
    "RU",
    "KATPADDI",
    "KATPADI",
    "WALTAIR"
  ].some(
    (name) =>
      text.includes(
        normalizeText(name)
      )
  );
}

// ============================================================
// DESTINATION SIDE
// ============================================================

function destinationIsChennai(train, item) {
  const text =
    textFromValues([
      getDestination(train, item),

      train?.destination,
      train?.to,
      train?.destinationStation,
      train?.endStation,

      item?.destination,
      item?.to,
      item?.destinationStation
    ]);

  return [
    "CHENNAI",
    "MAS",
    "MGR CHENNAI",
    "TAMBARAM",
    "TBM",
    "CHENGALPATTU",
    "CGL"
  ].some(
    (name) =>
      text.includes(
        normalizeText(name)
      )
  );
}

function destinationIsTirupati(train, item) {
  const text =
    textFromValues([
      getDestination(train, item),

      train?.destination,
      train?.to,
      train?.destinationStation,
      train?.endStation,

      item?.destination,
      item?.to,
      item?.destinationStation
    ]);

  return [
    "TIRUPATI",
    "TPTY"
  ].some(
    (name) =>
      text.includes(
        normalizeText(name)
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
  return textFromValues([
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
  ]);
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
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("APPROACHING GUDUR") ||
    direction.includes("NORTHBOUND TO GUDUR")
  ) {
    return "TO_GUDUR";
  }

  if (
    direction.includes("FROM GUDUR") ||
    direction.includes("GUDUR OUTBOUND") ||
    direction.includes("AWAY FROM GUDUR") ||
    direction.includes("TO CHENNAI") ||
    direction.includes("TOWARD CHENNAI") ||
    direction.includes("TOWARDS CHENNAI") ||
    direction.includes("TO TIRUPATI") ||
    direction.includes("TOWARD TIRUPATI") ||
    direction.includes("TOWARDS TIRUPATI")
  ) {
    return "AWAY_FROM_GUDUR";
  }

  return null;
}

// ============================================================
// CORRIDOR CLASSIFICATION
// ============================================================
//
// Important:
//
// This classification is for identifying the line.
//
// It is NOT permission to close a gate.
//
// Actual gate closing requires live position.
//
// ============================================================

function determineCorridor(
  train,
  live,
  stop,
  item
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  const explicitDirection =
    getExplicitDirection(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // EXPLICITLY AWAY FROM GUDUR
  // ----------------------------------------------------------

  if (
    explicitDirection ===
    "AWAY_FROM_GUDUR"
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // TIRUPATI ORIGIN
  // ----------------------------------------------------------

  if (
    isTirupatiSide(
      train,
      item
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // CHENNAI ORIGIN
  // ----------------------------------------------------------

  if (
    isChennaiSide(
      train,
      item
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // DESTINATION FALLBACK
  // ----------------------------------------------------------

  if (
    destinationIsChennai(
      train,
      item
    )
  ) {
    return "MAS";
  }

  if (
    destinationIsTirupati(
      train,
      item
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // KNOWN TRAIN NUMBER FALLBACK
  // ----------------------------------------------------------

  if (
    TIRUPATI_INBOUND_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  if (
    CHENNAI_INBOUND_TRAINS.has(
      trainNo
    )
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // UNKNOWN
  // ----------------------------------------------------------

  return null;
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
  const R = 6371;

  const dLat =
    ((lat2 - lat1) *
      Math.PI) /
    180;

  const dLng =
    ((lng2 - lng1) *
      Math.PI) /
    180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      (lat1 * Math.PI) / 180
    ) *
      Math.cos(
        (lat2 * Math.PI) / 180
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
// COORDINATE EXTRACTION
// ============================================================

function getCoordinates(
  source
) {
  if (!source) {
    return null;
  }

  const candidates = [
    source?.coordinates,
    source?.location,
    source?.currentLocation,
    source?.position,

    source
  ];

  for (
    const candidate of candidates
  ) {
    if (!candidate) {
      continue;
    }

    const lat = Number(
      firstValue(
        candidate?.lat,
        candidate?.latitude
      )
    );

    const lng = Number(
      firstValue(
        candidate?.lng,
        candidate?.lon,
        candidate?.longitude
      )
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

  return null;
}

// ============================================================
// LIVE POSITION
// ============================================================

function getLiveCoordinates(
  liveData
) {
  return getCoordinates(
    liveData?.currentLocation
  ) ||
    getCoordinates(
      liveData?.currentPosition
    ) ||
    getCoordinates(
      liveData?.position
    ) ||
    getCoordinates(
      liveData
    );
}

// ============================================================
// GUDUR STATION DETECTION
// ============================================================

function isAtGudurStation(
  liveData
) {
  const current =
    liveData?.currentLocation;

  if (!current) {
    return false;
  }

  const stationCode =
    normalizeText(
      current.stationCode
    );

  const stationName =
    normalizeText(
      current.stationName
    );

  const status =
    normalizeText(
      current.status
    );

  if (
    stationCode === "GDR" ||
    stationName.includes(
      "GUDUR"
    )
  ) {
    return true;
  }

  const coords =
    getCoordinates(current);

  if (coords) {
    const distance =
      distanceKm(
        coords.lat,
        coords.lng,
        GUDUR_JUNCTION.lat,
        GUDUR_JUNCTION.lng
      );

    if (
      distance <= 0.30 &&
      (
        status ===
          "AT STATION" ||
        status ===
          "AT STATION"
      )
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// CURRENT SEQUENCE
// ============================================================

function getCurrentSequence(
  liveData
) {
  const value =
    firstValue(
      liveData?.currentLocation
        ?.sequence,
      liveData?.sequence
    );

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// ============================================================
// GDR SEQUENCE
// ============================================================

function getGudurSequence(
  liveData
) {
  const values = [
    liveData?.nextHalt,
    liveData?.previousHalt,
    liveData?.gudur,
    liveData?.station
  ];

  for (
    const value of values
  ) {
    if (!value) {
      continue;
    }

    const code =
      normalizeText(
        value.stationCode
      );

    const name =
      normalizeText(
        value.stationName
      );

    if (
      code === "GDR" ||
      name.includes("GUDUR")
    ) {
      const sequence =
        Number(
          value.sequence
        );

      if (
        Number.isFinite(sequence)
      ) {
        return sequence;
      }
    }
  }

  return null;
}

// ============================================================
// DETERMINE IF TRAIN HAS DEPARTED GUDUR
// ============================================================

function hasDepartedGudur(
  liveData
) {
  if (!liveData) {
    return false;
  }

  if (
    isAtGudurStation(
      liveData
    )
  ) {
    return false;
  }

  const currentSeq =
    getCurrentSequence(
      liveData
    );

  const previousHalt =
    liveData?.previousHalt;

  const previousCode =
    normalizeText(
      previousHalt?.stationCode
    );

  const previousName =
    normalizeText(
      previousHalt?.stationName
    );

  if (
    (
      previousCode === "GDR" ||
      previousName.includes(
        "GUDUR"
      )
    ) &&
    currentSeq !== null
  ) {
    const previousSeq =
      Number(
        previousHalt.sequence
      );

    if (
      Number.isFinite(
        previousSeq
      ) &&
      currentSeq >
        previousSeq
    ) {
      return true;
    }
  }

  const nextHalt =
    liveData?.nextHalt;

  const nextCode =
    normalizeText(
      nextHalt?.stationCode
    );

  const nextName =
    normalizeText(
      nextHalt?.stationName
    );

  if (
    (
      nextCode === "GDR" ||
      nextName.includes(
        "GUDUR"
      )
    ) &&
    currentSeq !== null
  ) {
    return false;
  }

  const status =
    normalizeText(
      liveData?.currentLocation
        ?.status
    );

  if (
    status === "DEPARTED"
  ) {
    const station =
      normalizeText(
        liveData?.currentLocation
          ?.stationCode
      );

    if (
      station === "GDR"
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// BEARING
// ============================================================

function calculateBearing(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const φ1 =
    (lat1 * Math.PI) / 180;

  const φ2 =
    (lat2 * Math.PI) / 180;

  const Δλ =
    ((lng2 - lng1) *
      Math.PI) /
    180;

  const y =
    Math.sin(Δλ) *
    Math.cos(φ2);

  const x =
    Math.cos(φ1) *
      Math.sin(φ2) -
    Math.sin(φ1) *
      Math.cos(φ2) *
      Math.cos(Δλ);

  let bearing =
    (Math.atan2(y, x) *
      180) /
    Math.PI;

  bearing =
    (bearing + 360) % 360;

  return bearing;
}

// ============================================================
// LIVE BEARING
// ============================================================

function getLiveBearing(
  liveData
) {
  const bearing =
    Number(
      firstValue(
        liveData?.currentLocation
          ?.bearingDegrees,
        liveData?.currentLocation
          ?.bearing,
        liveData?.bearingDegrees,
        liveData?.bearing
      )
    );

  return Number.isFinite(
    bearing
  )
    ? bearing
    : null;
}

// ============================================================
// GATE DIRECTION FROM LIVE POSITION
// ============================================================
//
// The two gates are very close together.
//
// Therefore nearest-gate alone is not enough.
//
// We combine:
//   - distance
//   - live bearing
//   - persisted corridor
//
// ============================================================

function determineGateFromPosition(
  coords,
  corridor,
  liveBearing
) {
  if (!coords) {
    return null;
  }

  const chennaiDistance =
    distanceKm(
      coords.lat,
      coords.lng,
      CHENNAI_GATE.lat,
      CHENNAI_GATE.lng
    );

  const tirupatiDistance =
    distanceKm(
      coords.lat,
      coords.lng,
      TIRUPATI_GATE.lat,
      TIRUPATI_GATE.lng
    );

  const nearest =
    chennaiDistance <=
    tirupatiDistance
      ? "MAS"
      : "TPTY";

  const nearestDistance =
    Math.min(
      chennaiDistance,
      tirupatiDistance
    );

  if (
    nearestDistance >
    TRACKING_DISTANCE_KM
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // Strong corridor evidence
  // ----------------------------------------------------------

  if (
    corridor === "MAS"
  ) {
    return {
      gate: "MAS",
      distanceKm:
        chennaiDistance
    };
  }

  if (
    corridor === "TPTY"
  ) {
    return {
      gate: "TPTY",
      distanceKm:
        tirupatiDistance
    };
  }

  // ----------------------------------------------------------
  // Bearing fallback
  // ----------------------------------------------------------

  if (
    liveBearing !== null
  ) {
    const masBearing =
      calculateBearing(
        GUDUR_JUNCTION.lat,
        GUDUR_JUNCTION.lng,
        CHENNAI_GATE.lat,
        CHENNAI_GATE.lng
      );

    const tptyBearing =
      calculateBearing(
        GUDUR_JUNCTION.lat,
        GUDUR_JUNCTION.lng,
        TIRUPATI_GATE.lat,
        TIRUPATI_GATE.lng
      );

    const masDiff =
      angularDifference(
        liveBearing,
        masBearing
      );

    const tptyDiff =
      angularDifference(
        liveBearing,
        tptyBearing
      );

    if (
      masDiff < tptyDiff
    ) {
      return {
        gate: "MAS",
        distanceKm:
          chennaiDistance
      };
    }

    return {
      gate: "TPTY",
      distanceKm:
        tirupatiDistance
    };
  }

  return {
    gate: nearest,
    distanceKm:
      nearestDistance
  };
}

// ============================================================
// ANGULAR DIFFERENCE
// ============================================================

function angularDifference(
  a,
  b
) {
  let diff =
    Math.abs(a - b);

  if (diff > 180) {
    diff =
      360 - diff;
  }

  return diff;
}

// ============================================================
// BOARD ETA PARSER
// ============================================================

function parseTimeValue(
  value
) {
  if (!value) {
    return null;
  }

  if (
    typeof value === "number"
  ) {
    return value;
  }

  const date =
    new Date(value);

  if (
    !isNaN(
      date.getTime()
    )
  ) {
    return (
      date.getHours() * 60 +
      date.getMinutes()
    );
  }

  const match =
    String(value)
      .trim()
      .match(
        /(\d{1,2}):(\d{2})/
      );

  if (!match) {
    return null;
  }

  return (
    Number(match[1]) * 60 +
    Number(match[2])
  );
}

// ============================================================
// CURRENT MINUTES
// ============================================================

function currentMinutes() {
  const now =
    new Date();

  return (
    now.getHours() * 60 +
    now.getMinutes()
  );
}

// ============================================================
// TIME DIFFERENCE
// ============================================================

function calculateTimeDifference(
  targetMinutes,
  nowMinutes
) {
  if (
    targetMinutes === null ||
    targetMinutes === undefined
  ) {
    return null;
  }

  let diff =
    targetMinutes -
    nowMinutes;

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
// BOARD ETA
// ============================================================
//
// IMPORTANT:
//
// Never turn a stale scheduled arrival into ETA 0.
//
// ETA 0 is reserved for an actual GDR live position.
//
// ============================================================

function getBoardEtaMinutes(
  train,
  live,
  stop,
  item
) {
  const now =
    currentMinutes();

  const expectedArrival =
    firstValue(
      live?.expectedArrivalTime,
      live?.expectedArrival,
      item?.expectedArrivalTime,
      item?.expectedArrival
    );

  if (
    expectedArrival
  ) {
    const target =
      parseTimeValue(
        expectedArrival
      );

    if (
      target !== null
    ) {
      const diff =
        calculateTimeDifference(
          target,
          now
        );

      if (
        diff !== null &&
        diff >= -15
      ) {
        return Math.max(
          0,
          diff
        );
      }
    }
  }

  // ----------------------------------------------------------
  // Scheduled arrival fallback
  // ----------------------------------------------------------

  const scheduledArrival =
    firstValue(
      stop?.arrival,
      item?.arrival,
      train?.arrival
    );

  if (
    !scheduledArrival
  ) {
    return null;
  }

  const target =
    parseTimeValue(
      scheduledArrival
    );

  if (
    target === null
  ) {
    return null;
  }

  const diff =
    calculateTimeDifference(
      target,
      now
    );

  // Do NOT display 0 from a stale schedule.
  if (
    diff < 0
  ) {
    return null;
  }

  return diff;
}

// ============================================================
// LIVE ETA
// ============================================================

function getLiveEtaMinutes(
  liveData
) {
  if (
    isAtGudurStation(
      liveData
    )
  ) {
    return 0;
  }

  const nextHalt =
    liveData?.nextHalt;

  const code =
    normalizeText(
      nextHalt?.stationCode
    );

  const name =
    normalizeText(
      nextHalt?.stationName
    );

  if (
    code !== "GDR" &&
    !name.includes(
      "GUDUR"
    )
  ) {
    return null;
  }

  const expected =
    firstValue(
      liveData?.nextHalt
        ?.expectedArrivalTime,

      liveData?.nextHalt
        ?.expectedArrival,

      liveData?.expectedArrivalTime
    );

  if (!expected) {
    return null;
  }

  const target =
    parseTimeValue(
      expected
    );

  if (
    target === null
  ) {
    return null;
  }

  return Math.max(
    0,
    calculateTimeDifference(
      target,
      currentMinutes()
    )
  );
}

// ============================================================
// TIMESTAMP HELPERS
// ============================================================

function timestampNow() {
  return Date.now();
}

function parseStoredTimestamp(
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  const numeric =
    Number(value);

  if (
    Number.isFinite(numeric) &&
    numeric > 0
  ) {
    return numeric;
  }

  const parsed =
    new Date(value);

  if (
    !isNaN(
      parsed.getTime()
    )
  ) {
    return parsed.getTime();
  }

  return null;
}

// ============================================================
// TRACKING RECORD
// ============================================================

function createTrackingRecord(
  trainNo,
  trainName,
  corridor,
  origin,
  destination,
  boardEta
) {
  return {
    trainNo,

    name:
      trainName,

    corridor:
      corridor || null,

    origin:
      origin || "Unknown",

    destination:
      destination || "Unknown",

    state:
      "APPROACHING_GUDUR",

    etaMinutes:
      boardEta,

    gate:
      null,

    distanceToGateKm:
      null,

    lastLiveCheck:
      null,

    lastSeen:
      timestampNow(),

    createdAt:
      timestampNow()
  };
}

// ============================================================
// STATE PRIORITY
// ============================================================

function stateRank(
  state
) {
  const ranks = {
    APPROACHING_GUDUR: 1,
    AT_GUDUR_STATION: 2,
    DEPARTED_GUDUR: 3,
    APPROACHING_GATE: 4,
    AT_GATE: 5,
    PASSED_GATE: 6
  };

  return (
    ranks[state] || 0
  );
}

// ============================================================
// UPDATE TRACKING RECORD
// ============================================================

function updateTrackingRecord(
  record,
  liveData,
  corridor
) {
  const now =
    timestampNow();

  const updated = {
    ...record,

    lastSeen:
      now
  };

  // ----------------------------------------------------------
  // Preserve known corridor.
  // ----------------------------------------------------------

  if (
    corridor &&
    !updated.corridor
  ) {
    updated.corridor =
      corridor;
  }

  // ----------------------------------------------------------
  // AT GUDUR
  // ----------------------------------------------------------

  if (
    isAtGudurStation(
      liveData
    )
  ) {
    updated.state =
      "AT_GUDUR_STATION";

    updated.etaMinutes =
      0;

    updated.gate =
      null;

    updated.distanceToGateKm =
      null;

    return updated;
  }

  // ----------------------------------------------------------
  // DEPARTED GUDUR
  // ----------------------------------------------------------

  const departed =
    hasDepartedGudur(
      liveData
    );

  const coords =
    getLiveCoordinates(
      liveData
    );

  const bearing =
    getLiveBearing(
      liveData
    );

  // ----------------------------------------------------------
  // If we have actual proof of departure,
  // ALWAYS transition to DEPARTED unless
  // already in a later gate state.
  // ----------------------------------------------------------

  if (
    departed &&
    stateRank(
      updated.state
    ) <
      stateRank(
        "APPROACHING_GATE"
      )
  ) {
    updated.state =
      "DEPARTED_GUDUR";

    updated.etaMinutes =
      null;
  }

  // ----------------------------------------------------------
  // No departure = no gate processing.
  // ----------------------------------------------------------

  if (!departed) {
    return updated;
  }

  // ----------------------------------------------------------
  // We need live coordinates for gate processing.
  // ----------------------------------------------------------

  if (!coords) {
    return updated;
  }

  // ----------------------------------------------------------
  // Determine gate.
  // ----------------------------------------------------------

  const gateInfo =
    determineGateFromPosition(
      coords,
      updated.corridor,
      bearing
    );

  if (!gateInfo) {
    return updated;
  }

  updated.gate =
    gateInfo.gate;

  updated.distanceToGateKm =
    Number(
      gateInfo.distanceKm.toFixed(
        3
      )
    );

  // ----------------------------------------------------------
  // PASSED GATE
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // Check persisted gate even if train is now
  // more than 1 km away.
  //
  // ----------------------------------------------------------

  if (
    updated.state ===
      "AT_GATE" ||
    updated.state ===
      "APPROACHING_GATE"
  ) {
    if (
      gateInfo.distanceKm >=
      GATE_CLEAR_DISTANCE_KM
    ) {
      updated.state =
        "PASSED_GATE";

      updated.etaMinutes =
        null;

      return updated;
    }
  }

  // ----------------------------------------------------------
  // AT GATE
  // ----------------------------------------------------------

  if (
    gateInfo.distanceKm <=
    GATE_CLOSE_DISTANCE_KM
  ) {
    updated.state =
      "AT_GATE";

    updated.etaMinutes =
      null;

    return updated;
  }

  // ----------------------------------------------------------
  // APPROACHING GATE
  // ----------------------------------------------------------

  if (
    gateInfo.distanceKm <=
    TRACKING_DISTANCE_KM
  ) {
    updated.state =
      "APPROACHING_GATE";

    updated.etaMinutes =
      null;

    return updated;
  }

  return updated;
}

// ============================================================
// BOARD TRAIN EXTRACTION
// ============================================================

function extractTrainItem(
  item
) {
  const train =
    item?.train || {};

  const live =
    item?.live || {};

  const stop =
    item?.stop || {};

  return {
    item,
    train,
    live,
    stop
  };
}

// ============================================================
// LIVE API
// ============================================================

async function getLiveTrain(
  trainNo
) {
  if (
    !RAILRADAR_API_KEY
  ) {
    console.error(
      "❌ RAILRADAR_API_KEY is missing."
    );

    return null;
  }

  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
          trainNo
        )}/live`,
        {
          params: {
            authoritative:
              "true",
            haltsOnly:
              "false",
            includeCoordinates:
              "true"
          },

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
      response?.data?.data ||
      null
    );
  } catch (error) {
    if (
      error.response
    ) {
      console.error(
        `[LIVE ERROR] ${trainNo} HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[LIVE ERROR] ${trainNo} ${error.message}`
      );
    }

    return null;
  }
}

// ============================================================
// SELECT LIVE CANDIDATE
// ============================================================
//
// Priority:
//
// 1. AT_GATE
// 2. APPROACHING_GATE
// 3. DEPARTED_GUDUR
// 4. AT_GUDUR_STATION
// 5. APPROACHING_GUDUR with lowest ETA
//
// This prevents an old upcoming train from starving
// a train that is already approaching the gate.
// ============================================================

function selectLiveCandidate(
  tracking,
  boardTrains
) {
  const records =
    Object.values(
      tracking || {}
    );

  const activeStates = [
    "AT_GATE",
    "APPROACHING_GATE",
    "DEPARTED_GUDUR",
    "AT_GUDUR_STATION"
  ];

  const active =
    records
      .filter(
        (record) =>
          activeStates.includes(
            record.state
          )
      )
      .sort(
        (a, b) =>
          stateRank(b.state) -
            stateRank(a.state) ||
          (
            Number(
              a.etaMinutes ?? 9999
            ) -
            Number(
              b.etaMinutes ?? 9999
            )
          )
      );

  if (
    active.length > 0
  ) {
    return active[0];
  }

  const upcoming =
    records
      .filter(
        (record) =>
          record.state ===
          "APPROACHING_GUDUR"
      )
      .filter(
        (record) =>
          Number.isFinite(
            Number(
              record.etaMinutes
            )
          )
      )
      .sort(
        (a, b) =>
          Number(
            a.etaMinutes
          ) -
          Number(
            b.etaMinutes
          )
      );

  if (
    upcoming.length > 0
  ) {
    return upcoming[0];
  }

  const boardCandidates =
    boardTrains
      .filter(
        (record) =>
          record.corridor
      )
      .filter(
        (record) =>
          record.etaMinutes !==
            null &&
          Number.isFinite(
            Number(
              record.etaMinutes
            )
          )
      )
      .sort(
        (a, b) =>
          Number(
            a.etaMinutes
          ) -
          Number(
            b.etaMinutes
          )
      );

  return (
    boardCandidates[0] ||
    null
  );
}

// ============================================================
// LIVE THROTTLE
// ============================================================

function canMakeLiveCall(
  tracking
) {
  let latest =
    null;

  for (
    const record of Object.values(
      tracking || {}
    )
  ) {
    const timestamp =
      parseStoredTimestamp(
        record.lastLiveCheck
      );

    if (
      timestamp &&
      (
        latest === null ||
        timestamp > latest
      )
    ) {
      latest =
        timestamp;
    }
  }

  if (
    latest === null
  ) {
    return true;
  }

  const elapsed =
    Date.now() -
    latest;

  return (
    elapsed >=
    LIVE_CALL_INTERVAL_MINUTES *
      60 *
      1000
  );
}

// ============================================================
// CLEAN OLD TRACKING
// ============================================================

function cleanTracking(
  tracking
) {
  const now =
    Date.now();

  const result = {};

  for (
    const [trainNo, record]
      of Object.entries(
        tracking || {}
      )
  ) {
    const timestamp =
      parseStoredTimestamp(
        record.lastSeen ||
        record.updatedAt ||
        record.createdAt
      );

    // Keep AT_GUDUR and AT_GATE records
    // longer so they cannot disappear because
    // of timestamp-format problems.
    if (
      record.state ===
        "AT_GUDUR_STATION" ||
      record.state ===
        "AT_GATE" ||
      record.state ===
        "APPROACHING_GATE"
    ) {
      result[trainNo] =
        record;

      continue;
    }

    if (
      timestamp === null
    ) {
      // Old record with unusable timestamp.
      // Keep it once rather than deleting it.
      result[trainNo] =
        record;

      continue;
    }

    const ageMinutes =
      (
        now -
        timestamp
      ) /
      60000;

    if (
      ageMinutes <=
      TRACKING_RETENTION_MINUTES
    ) {
      result[trainNo] =
        record;
    }
  }

  return result;
}

// ============================================================
// BUILD BOARD RECORD
// ============================================================

function buildBoardRecord(
  train,
  live,
  stop,
  item,
  trackingRecord
) {
  const trainNo =
    getTrainNumber(
      train,
      item
    );

  const name =
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
    ) ||
    trackingRecord?.corridor ||
    null;

  // ----------------------------------------------------------
  // LIVE DATA TAKES PRIORITY
  // ----------------------------------------------------------

  let eta =
    getLiveEtaMinutes(
      live
    );

  if (
    eta === null
  ) {
    eta =
      trackingRecord?.state ===
        "AT_GUDUR_STATION"
        ? 0
        : getBoardEtaMinutes(
            train,
            live,
            stop,
            item
          );
  }

  // ----------------------------------------------------------
  // NEVER SHOW ETA 0 UNLESS ACTUALLY AT GDR
  // ----------------------------------------------------------

  if (
    eta === 0 &&
    !isAtGudurStation(
      live
    ) &&
    trackingRecord?.state !==
      "AT_GUDUR_STATION"
  ) {
    eta = null;
  }

  const state =
    trackingRecord?.state ||
    (
      isAtGudurStation(
        live
      )
        ? "AT_GUDUR_STATION"
        : "APPROACHING_GUDUR"
    );

  return {
    trainNo,

    name,

    corridor:
      corridor || "UNKNOWN",

    origin:
      origin || "Unknown",

    destination:
      destination || "Unknown",

    etaMinutes:
      eta,

    state,

    direction:
      state ===
        "AT_GUDUR_STATION"
        ? "AT GUDUR"
        : state ===
            "APPROACHING_GUDUR"
          ? "TOWARD GUDUR"
          : "AFTER GUDUR",

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
// GATE OBJECT
// ============================================================

function openGate() {
  return {
    status:
      "OPEN",

    waitMinutes:
      0,

    activeTrain:
      "Tracks clear",

    direction:
      null,

    corridor:
      null
  };
}

// ============================================================
// GATE PAYLOAD FROM TRACKING
// ============================================================

function gatePayloadFromRecord(
  record
) {
  return {
    status:
      "CLOSED",

    waitMinutes:
      2,

    activeTrain:
      `${record.trainNo} ${record.name}`,

    direction:
      "TOWARD GATE",

    corridor:
      record.corridor,

    distanceKm:
      record.distanceToGateKm
  };
}

// ============================================================
// UPDATE GATES
// ============================================================

function updateGatesFromTracking(
  tracking
) {
  let masGate =
    openGate();

  let tptyGate =
    openGate();

  for (
    const record of Object.values(
      tracking || {}
    )
  ) {
    // --------------------------------------------------------
    // UNKNOWN corridor can NEVER close a gate.
    // --------------------------------------------------------

    if (
      record.corridor !== "MAS" &&
      record.corridor !== "TPTY"
    ) {
      continue;
    }

    // --------------------------------------------------------
    // ONLY AT_GATE closes.
    // --------------------------------------------------------

    if (
      record.state !==
      "AT_GATE"
    ) {
      continue;
    }

    const payload =
      gatePayloadFromRecord(
        record
      );

    if (
      record.corridor ===
      "MAS"
    ) {
      masGate =
        payload;
    }

    if (
      record.corridor ===
      "TPTY"
    ) {
      tptyGate =
        payload;
    }
  }

  return {
    masGate,
    tptyGate
  };
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
    `[${now.toLocaleString()}] GUDUR GATE MONITOR`
  );

  console.log(
    "=================================================="
  );

  console.log(
    `Gudur Junction : ${GUDUR_JUNCTION.lat}, ${GUDUR_JUNCTION.lng}`
  );

  console.log(
    `Chennai Gate   : ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
  );

  console.log(
    `Tirupati Gate  : ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
  );

  console.log(
    `[BOARD] Querying RailRadar GDR live board...`
  );

  // ==========================================================
  // FETCH EXISTING TRACKING
  // ==========================================================

  let tracking = {};

  try {
    const snapshot =
      await gateRef
        .child(
          "tracking"
        )
        .once(
          "value"
        );

    tracking =
      snapshot.val() ||
      {};
  } catch (error) {
    console.error(
      `[FIREBASE READ ERROR] ${error.message}`
    );
  }

  // ==========================================================
  // CLEAN TRACKING
  // ==========================================================

  tracking =
    cleanTracking(
      tracking
    );

  // ==========================================================
  // RAILRADAR BOARD
  // ==========================================================

  let trainsArray =
    [];

  try {
    const response =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live`,
        {
          params: {
            hours: 4,
            includeIntermediate:
              "true"
          },

          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,

            Accept:
              "application/json"
          },

          timeout: 12000
        }
      );

    trainsArray =
      response?.data?.data
        ?.trains ||
      [];

    if (
      !Array.isArray(
        trainsArray
      )
    ) {
      trainsArray = [];
    }

    console.log(
      `[BOARD] RailRadar returned ${trainsArray.length} trains.`
    );
  } catch (error) {
    if (
      error.response
    ) {
      console.error(
        `[BOARD ERROR] HTTP ${error.response.status}`
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(
        `[BOARD ERROR] ${error.message}`
      );
    }

    // Preserve existing tracking
    // if board request fails.
    const gates =
      updateGatesFromTracking(
        tracking
      );

    await gateRef.update({
      chennaiGate:
        gates.masGate,

      tirupatiGate:
        gates.tptyGate,

      lastUpdated:
        now.toISOString(),

      lastUpdatedDisplay:
        now.toLocaleTimeString()
    });

    return;
  }

  // ==========================================================
  // PROCESS BOARD
  // ==========================================================

  const boardRecords =
    [];

  for (
    const item of trainsArray
  ) {
    const {
      train,
      live,
      stop
    } =
      extractTrainItem(
        item
      );

    const trainNo =
      getTrainNumber(
        train,
        item
      );

    if (!trainNo) {
      continue;
    }

    const name =
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

    const boardEta =
      getBoardEtaMinutes(
        train,
        live,
        stop,
        item
      );

    // --------------------------------------------------------
    // Existing tracking record
    // --------------------------------------------------------

    let record =
      tracking[
        trainNo
      ];

    // --------------------------------------------------------
    // Create tracking record for relevant trains.
    //
    // We keep UNKNOWN trains in the board display,
    // but they cannot control gates.
    // --------------------------------------------------------

    if (
      !record &&
      (
        boardEta !== null &&
        boardEta <=
          UPCOMING_MAX_ETA_MINUTES
      )
    ) {
      record =
        createTrackingRecord(
          trainNo,
          name,
          corridor,
          origin,
          destination,
          boardEta
        );

      tracking[
        trainNo
      ] =
        record;
    }

    if (!record) {
      continue;
    }

    // --------------------------------------------------------
    // Improve missing metadata.
    // --------------------------------------------------------

    if (
      corridor &&
      !record.corridor
    ) {
      record.corridor =
        corridor;
    }

    if (
      origin &&
      (
        !record.origin ||
        record.origin ===
          "Unknown"
      )
    ) {
      record.origin =
        origin;
    }

    if (
      destination &&
      (
        !record.destination ||
        record.destination ===
          "Unknown"
      )
    ) {
      record.destination =
        destination;
    }

    // --------------------------------------------------------
    // If board has valid ETA and train is still
    // approaching GDR, update ETA.
    //
    // DO NOT overwrite AT_GUDUR with schedule.
    // --------------------------------------------------------

    if (
      record.state ===
        "APPROACHING_GUDUR" &&
      boardEta !== null
    ) {
      record.etaMinutes =
        boardEta;
    }

    record.name =
      name;

    record.lastSeen =
      timestampNow();

    // --------------------------------------------------------
    // If board itself confirms at-station,
    // preserve AT_GUDUR.
    // --------------------------------------------------------

    const boardLiveStatus =
      normalizeText(
        live?.type ||
        live?.status
      );

    if (
      (
        boardLiveStatus ===
          "AT STATION" ||
        boardLiveStatus ===
          "AT STATION"
      ) &&
      normalizeText(
        live?.stationCode ||
        live?.currentLocation
          ?.stationCode
      ) ===
        "GDR"
    ) {
      record.state =
        "AT_GUDUR_STATION";

      record.etaMinutes =
        0;

      record.gate =
        null;

      record.distanceToGateKm =
        null;
    }

    tracking[
      trainNo
    ] =
      record;

    // --------------------------------------------------------
    // Build display record.
    // --------------------------------------------------------

    const displayRecord =
      buildBoardRecord(
        train,
        live,
        stop,
        item,
        record
      );

    boardRecords.push(
      displayRecord
    );
  }

  // ==========================================================
  // LIVE VERIFICATION
  // ==========================================================

  let liveCandidate =
    null;

  if (
    canMakeLiveCall(
      tracking
    )
  ) {
    liveCandidate =
      selectLiveCandidate(
        tracking,
        boardRecords
      );
  } else {
    console.log(
      "[LIVE] Throttled to protect monthly quota."
    );
  }

  if (
    liveCandidate
  ) {
    const trainNo =
      liveCandidate.trainNo;

    console.log(
      `[LIVE] Verifying ${trainNo} ${liveCandidate.name}...`
    );

    const liveData =
      await getLiveTrain(
        trainNo
      );

    // --------------------------------------------------------
    // IMPORTANT:
    // Only consume the quota timestamp after
    // receiving a live API response.
    // --------------------------------------------------------

    if (
      liveData
    ) {
      const existing =
        tracking[
          trainNo
        ] || {
          trainNo,
          name:
            liveCandidate.name,
          corridor:
            liveCandidate.corridor
        };

      const corridor =
        existing.corridor ||
        liveCandidate.corridor ||
        null;

      const updated =
        updateTrackingRecord(
          {
            ...existing,

            name:
              liveCandidate.name,

            corridor
          },
          liveData,
          corridor
        );

      updated.lastLiveCheck =
        timestampNow();

      updated.lastSeen =
        timestampNow();

      tracking[
        trainNo
      ] =
        updated;

      const coords =
        getLiveCoordinates(
          liveData
        );

      if (
        coords
      ) {
        const gdrDistance =
          distanceKm(
            coords.lat,
            coords.lng,
            GUDUR_JUNCTION.lat,
            GUDUR_JUNCTION.lng
          );

        console.log(
          `[LIVE POSITION] ${trainNo} ${updated.name} | GDR ${gdrDistance.toFixed(
            3
          )} km | state=${updated.state} | gate=${
            updated.gate || "NONE"
          }`
        );
      } else {
        console.log(
          `[LIVE POSITION] ${trainNo} ${updated.name} | No GPS coordinates | state=${updated.state}`
        );
      }

      if (
        isAtGudurStation(
          liveData
        )
      ) {
        console.log(
          `[AT GUDUR] ${trainNo} ${updated.name} | ETA 0m | GATES OPEN`
        );
      }

      if (
        updated.state ===
        "AT_GATE"
      ) {
        console.log(
          `[AT GATE] ${trainNo} ${updated.name} | ${updated.gate} | GATE CLOSED`
        );
      }

      if (
        updated.state ===
        "PASSED_GATE"
      ) {
        console.log(
          `[PASSED GATE] ${trainNo} ${updated.name} | GATE OPEN`
        );
      }
    } else {
      console.log(
        `[LIVE] No usable response for ${trainNo}. Retry will be allowed on a future cycle.`
      );
    }
  }

  // ==========================================================
  // REMOVE PASSED GATE RECORDS
  // ==========================================================

  for (
    const [
      trainNo,
      record
    ] of Object.entries(
      tracking
    )
  ) {
    if (
      record.state ===
      "PASSED_GATE"
    ) {
      delete tracking[
        trainNo
      ];

      console.log(
        `[TRACKING REMOVE] ${trainNo} ${record.name} | passed gate`
      );
    }
  }

  // ==========================================================
  // REBUILD UPCOMING DISPLAY
  // ==========================================================

  const upcomingMap =
    new Map();

  // ----------------------------------------------------------
  // First use current board records.
  // ----------------------------------------------------------

  for (
    const record of boardRecords
  ) {
    upcomingMap.set(
      record.trainNo,
      record
    );
  }

  // ----------------------------------------------------------
  // Then include persisted records such as
  // AT_GUDUR_STATION even if the board no longer
  // lists them as "upcoming".
  // ----------------------------------------------------------

  for (
    const [
      trainNo,
      record
    ] of Object.entries(
      tracking
    )
  ) {
    if (
      record.state ===
        "AT_GUDUR_STATION" ||
      record.state ===
        "DEPARTED_GUDUR" ||
      record.state ===
        "APPROACHING_GATE" ||
      record.state ===
        "AT_GATE"
    ) {
      const existing =
        upcomingMap.get(
          trainNo
        );

      if (!existing) {
        upcomingMap.set(
          trainNo,
          {
            trainNo,

            name:
              record.name,

            corridor:
              record.corridor ||
              "UNKNOWN",

            origin:
              record.origin ||
              "Unknown",

            destination:
              record.destination ||
              "Unknown",

            etaMinutes:
              record.state ===
                "AT_GUDUR_STATION"
                ? 0
                : null,

            state:
              record.state,

            direction:
              record.state ===
                "AT_GUDUR_STATION"
                ? "AT GUDUR"
                : "AFTER GUDUR",

            platform:
              "1"
          }
        );
      }
    }
  }

  // ==========================================================
  // FINAL UPCOMING LIST
  // ==========================================================

  const upcoming =
    Array.from(
      upcomingMap.values()
    )
      .filter(
        (record) => {
          // Keep trains physically at GDR.
          if (
            record.state ===
            "AT_GUDUR_STATION"
          ) {
            return true;
          }

          // Keep trains already beyond GDR
          // while they are being tracked.
          if (
            record.state ===
              "DEPARTED_GUDUR" ||
            record.state ===
              "APPROACHING_GATE" ||
            record.state ===
              "AT_GATE"
          ) {
            return true;
          }

          // Normal approaching trains need valid ETA.
          return (
            record.etaMinutes !==
              null &&
            Number.isFinite(
              Number(
                record.etaMinutes
              )
            ) &&
            Number(
              record.etaMinutes
            ) >= 0 &&
            Number(
              record.etaMinutes
            ) <=
              UPCOMING_MAX_ETA_MINUTES
          );
        }
      )
      .sort(
        (a, b) => {
          // AT GDR first.
          if (
            a.state ===
              "AT_GUDUR_STATION" &&
            b.state !==
              "AT_GUDUR_STATION"
          ) {
            return -1;
          }

          if (
            b.state ===
              "AT_GUDUR_STATION" &&
            a.state !==
              "AT_GUDUR_STATION"
          ) {
            return 1;
          }

          const aEta =
            Number(
              a.etaMinutes ??
                99999
            );

          const bEta =
            Number(
              b.etaMinutes ??
                99999
            );

          return (
            aEta -
            bEta
          );
        }
      )
      .slice(
        0,
        10
      );

  // ==========================================================
  // GATES
  // ==========================================================

  const gates =
    updateGatesFromTracking(
      tracking
    );

  // ==========================================================
  // FIREBASE PAYLOAD
  // ==========================================================

  const firebasePayload = {
    tirupatiGate:
      gates.tptyGate,

    chennaiGate:
      gates.masGate,

    upcomingTrains:
      upcoming,

    lastUpdated:
      now.toISOString(),

    lastUpdatedDisplay:
      now.toLocaleTimeString(),

    tracking:
      tracking
  };

  await gateRef.set(
    firebasePayload
  );

  // ==========================================================
  // LOG RESULTS
  // ==========================================================

  console.log(
    "\n[SYNC SUCCESS] Firebase updated."
  );

  console.log(
    `Chennai Gate  : ${gates.masGate.status} (${gates.masGate.activeTrain})`
  );

  console.log(
    `Tirupati Gate : ${gates.tptyGate.status} (${gates.tptyGate.activeTrain})`
  );

  console.log(
    `Upcoming trains: ${upcoming.length}`
  );

  console.log(
    "\n[UPCOMING TRAINS]"
  );

  if (
    upcoming.length ===
    0
  ) {
    console.log(
      "None"
    );
  }

  upcoming.forEach(
    (train, index) => {
      const eta =
        train.etaMinutes ===
        null
          ? "--"
          : `${train.etaMinutes}m`;

      console.log(
        `${index + 1}. ${train.trainNo} ${train.name} | ${
          train.corridor || "UNKNOWN"
        } | ETA ${eta} | ${
          train.origin || "Unknown"
        } -> ${
          train.destination || "Unknown"
        } | state=${train.state}`
      );
    }
  );

  console.log(
    "\n[MONITOR] Run completed successfully."
  );
}

// ============================================================
// START
// ============================================================

console.log(
  "=================================================="
);

console.log(
  " GUDUR GATE RAILRADAR MONITOR"
);

console.log(
  "=================================================="
);

console.log(
  `Gudur Junction : ${GUDUR_JUNCTION.lat}, ${GUDUR_JUNCTION.lng}`
);

console.log(
  `Chennai Gate   : ${CHENNAI_GATE.lat}, ${CHENNAI_GATE.lng}`
);

console.log(
  `Tirupati Gate  : ${TIRUPATI_GATE.lat}, ${TIRUPATI_GATE.lng}`
);

console.log(
  `Tracking radius: ${TRACKING_DISTANCE_KM.toFixed(2)} km`
);

console.log(
  `Gate close zone: ${GATE_CLOSE_DISTANCE_KM.toFixed(2)} km`
);

console.log(
  `Gate clear zone: ${GATE_CLEAR_DISTANCE_KM.toFixed(2)} km`
);

console.log(
  "ETA 0 rule     : ONLY when actually at GDR"
);

console.log(
  "AT GUDUR       : GATES OPEN"
);

console.log(
  "AT_GATE        : GATE CLOSED"
);

console.log(
  "PASSED_GATE    : GATE OPEN"
);

console.log(
  `Live API       : ${LIVE_CALL_INTERVAL_MINUTES}-minute quota protection`
);

console.log(
  "=================================================="
);

if (
  !RAILRADAR_API_KEY
) {
  console.error(
    "❌ RAILRADAR_API_KEY is not configured."
  );
} else {
  console.log(
    "RailRadar API Key: Configured"
  );
}

console.log(
  "Firebase: Configured"
);

console.log(
  "=================================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem()
  .catch(
    (error) => {
      console.error(
        `[FATAL] ${error.message}`
      );
    }
  );
