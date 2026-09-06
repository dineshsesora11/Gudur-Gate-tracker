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
  } else {
    serviceAccount = require("./serviceAccountKey.json");
  }
} catch (error) {
  console.error("❌ Could not load Firebase service account.");
  console.error(
    "Set FIREBASE_SERVICE_ACCOUNT or place serviceAccountKey.json beside code.js."
  );
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

const db = getDatabase();
const gateRef = db.ref("gudur_gates");

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
const TIRUPATI_GATE_LNG = 79.8436;

// ============================================================
// SETTINGS
// ============================================================

const UPCOMING_MAX_DISTANCE_KM = 150;
const UPCOMING_MAX_ETA_MINUTES = 360;

// Live verification starts when ETA is <= 60 minutes.
const LIVE_VERIFY_ETA_MINUTES = 60;

// Maximum live train API calls per monitor execution.
const MAX_LIVE_CALLS = 2;

// Gate closes when actual train position is within 0.60 km
// of the corresponding gate.
const GATE_TRIGGER_DISTANCE_KM = 0.60;

// ============================================================
// KNOWN TIRUPATI CORRIDOR TRAINS
// ============================================================

const TIRUPATI_CORRIDOR_TRAINS = new Set([
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

function containsAny(text, values) {
  const normalized = normalizeText(text);

  return values.some((value) =>
    normalized.includes(
      normalizeText(value)
    )
  );
}

// ============================================================
// NUMBER HELPERS
// ============================================================

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// DISTANCE
// ============================================================

function distanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const a = toNumber(lat1);
  const b = toNumber(lon1);
  const c = toNumber(lat2);
  const d = toNumber(lon2);

  if (
    a === null ||
    b === null ||
    c === null ||
    d === null
  ) {
    return null;
  }

  const R = 6371;

  const dLat =
    (c - a) *
    Math.PI /
    180;

  const dLon =
    (d - b) *
    Math.PI /
    180;

  const x =
    Math.sin(dLat / 2) *
    Math.sin(dLat / 2) +
    Math.cos(a * Math.PI / 180) *
    Math.cos(c * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  const y =
    2 *
    Math.atan2(
      Math.sqrt(x),
      Math.sqrt(1 - x)
    );

  return R * y;
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(
  timeStr,
  delayMinutes = 0
) {
  if (!timeStr) {
    return -1;
  }

  let totalMinutes = -1;

  const date = new Date(timeStr);

  if (!isNaN(date.getTime())) {
    totalMinutes =
      date.getHours() * 60 +
      date.getMinutes();
  } else {
    const match =
      String(timeStr)
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

  if (totalMinutes === -1) {
    return -1;
  }

  return (
    totalMinutes +
    Number(delayMinutes || 0)
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

  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// GET ORIGIN
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
    train?.start ||
    item?.origin ||
    item?.source ||
    item?.from ||
    item?.fromStation ||
    item?.startStation ||
    ""
  );
}

// ============================================================
// GET DESTINATION
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
// GET DIRECTION TEXT
// ============================================================

function getDirectionText(
  train,
  live,
  stop,
  item
) {
  const fields = [
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
  ];

  return fields
    .filter(Boolean)
    .map(normalizeText)
    .join(" ");
}

// ============================================================
// EXPLICIT DIRECTION
// ============================================================

function hasInboundDirection(
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
      "INBOUND"
    ) ||
    direction.includes(
      "APPROACHING GUDUR"
    )
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
      "OUTBOUND"
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
// CHENNAI-SIDE DETECTION
// ============================================================

function isFromChennaiSide(
  train,
  item
) {
  const originText = [
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
  ]
    .filter(Boolean)
    .join(" ");

  return containsAny(
    originText,
    [
      "CHENNAI",
      "MAS",
      "CHENNAI CENTRAL",
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

// ============================================================
// TIRUPATI-SIDE DETECTION
// ============================================================

function isFromTirupatiSide(
  train,
  item
) {
  const originText = [
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
  ]
    .filter(Boolean)
    .join(" ");

  return containsAny(
    originText,
    [
      "TIRUPATI",
      "TPTY",
      "TIRUPATI MAIN",
      "RENIGUNTA",
      "RU"
    ]
  );
}

// ============================================================
// ROUTE HELPERS
// ============================================================

function routeContainsStation(
  route,
  stationCodes
) {
  if (!Array.isArray(route)) {
    return false;
  }

  const codes =
    stationCodes.map(
      normalizeText
    );

  return route.some(
    (station) => {
      const code =
        normalizeText(
          station?.stationCode ||
          station?.code ||
          station?.station?.code ||
          ""
        );

      return codes.includes(code);
    }
  );
}

function getStationSequence(
  route,
  stationCodes
) {
  if (!Array.isArray(route)) {
    return null;
  }

  const codes =
    stationCodes.map(
      normalizeText
    );

  for (const station of route) {
    const code =
      normalizeText(
        station?.stationCode ||
        station?.code ||
        station?.station?.code ||
        ""
      );

    if (
      codes.includes(code)
    ) {
      const sequence =
        Number(
          station?.sequence
        );

      if (
        Number.isFinite(
          sequence
        )
      ) {
        return sequence;
      }
    }
  }

  return null;
}

// ============================================================
// DETERMINE CORRIDOR FROM ROUTE
// ============================================================
//
// MAS = Chennai side -> Gudur
// TPTY = Tirupati side -> Gudur
//
// We intentionally DO NOT guess MAS when route evidence
// is missing. This prevents the wrong gate from closing.
//

function determineCorridorFromRoute(
  train,
  item,
  route
) {
  const trainNo =
    String(
      train?.number || ""
    ).trim();

  const explicitDirection =
    hasInboundDirection(
      train,
      item?.live || {},
      item?.stop || {},
      item
    );

  if (
    explicitDirection === false
  ) {
    return null;
  }

  const gudurSeq =
    getStationSequence(
      route,
      ["GDR"]
    );

  const masSeq =
    getStationSequence(
      route,
      ["MAS"]
    );

  const tptySeq =
    getStationSequence(
      route,
      ["TPTY", "RU"]
    );

  // ----------------------------------------------------------
  // Chennai -> Gudur
  // ----------------------------------------------------------

  if (
    masSeq !== null &&
    gudurSeq !== null &&
    masSeq < gudurSeq
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Tirupati / Renigunta -> Gudur
  // ----------------------------------------------------------

  if (
    tptySeq !== null &&
    gudurSeq !== null &&
    tptySeq < gudurSeq
  ) {
    return "TPTY";
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
  // Known TPTY train fallback
  // ----------------------------------------------------------

  if (
    explicitDirection === true &&
    TIRUPATI_CORRIDOR_TRAINS.has(
      trainNo
    )
  ) {
    return "TPTY";
  }

  return null;
}

// ============================================================
// UPCOMING STATUS CHECK
// ============================================================
//
// THIS WAS THE MISSING FUNCTION THAT CAUSED YOUR ERROR.
//
// RailRadar live board statuses include:
// upcoming
// scheduled
// at-station
// departed
//
// We allow upcoming/scheduled for the upcoming list.
// at-station is handled separately.
// departed is removed.
//

function isUpcomingStatus(
  live,
  stop
) {
  const status =
    String(
      live?.type ||
      live?.status ||
      stop?.status ||
      ""
    )
      .trim()
      .toLowerCase();

  return (
    status === "upcoming" ||
    status === "scheduled"
  );
}

// ============================================================
// CHECK WHETHER TRAIN HAS PASSED GUDUR
// ============================================================

function hasPassedGudurFromLive(
  liveData
) {
  if (!liveData) {
    return false;
  }

  const current =
    liveData.currentLocation || {};

  const stationCode =
    normalizeText(
      current.stationCode ||
      current.code ||
      ""
    );

  const status =
    normalizeText(
      current.status ||
      ""
    );

  // ----------------------------------------------------------
  // Train is physically at Gudur
  // ----------------------------------------------------------

  if (
    stationCode === "GDR"
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Check route sequence
  // ----------------------------------------------------------

  const route =
    Array.isArray(
      liveData.route
    )
      ? liveData.route
      : [];

  const gudurSeq =
    getStationSequence(
      route,
      ["GDR"]
    );

  const currentSeq =
    Number(
      current.sequence
    );

  if (
    gudurSeq !== null &&
    Number.isFinite(
      currentSeq
    ) &&
    currentSeq > gudurSeq
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Explicit departed status + GDR current station
  // ----------------------------------------------------------

  if (
    stationCode === "GDR" &&
    (
      status === "DEPARTED" ||
      status === "AT STATION"
    )
  ) {
    return true;
  }

  return false;
}

// ============================================================
// GET LIVE POSITION
// ============================================================

function getLivePosition(
  liveData
) {
  const current =
    liveData?.currentLocation;

  if (!current) {
    return null;
  }

  const lat =
    toNumber(
      current.lat ||
      current.latitude
    );

  const lng =
    toNumber(
      current.lng ||
      current.longitude
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
    stationCode:
      current.stationCode ||
      "",
    status:
      current.status ||
      "",
    sequence:
      Number.isFinite(
        Number(
          current.sequence
        )
      )
        ? Number(
            current.sequence
          )
        : null,
    speedKmh:
      toNumber(
        current.speedKmh
      ),
    isActualPosition:
      current.isActualPosition === true
  };
}

// ============================================================
// DETERMINE LIVE CORRIDOR
// ============================================================

function determineLiveCorridor(
  trainNo,
  liveData,
  originalTrain,
  originalItem
) {
  const route =
    Array.isArray(
      liveData?.route
    )
      ? liveData.route
      : [];

  const liveTrain = {
    ...(originalTrain || {})
  };

  const liveItem = {
    ...(originalItem || {}),
    live: {
      ...(originalItem?.live || {}),
      ...(liveData || {})
    }
  };

  // ----------------------------------------------------------
  // Route is strongest evidence.
  // ----------------------------------------------------------

  const routeCorridor =
    determineCorridorFromRoute(
      liveTrain,
      liveItem,
      route
    );

  if (routeCorridor) {
    return routeCorridor;
  }

  // ----------------------------------------------------------
  // Known TPTY train.
  // ----------------------------------------------------------

  if (
    TIRUPATI_CORRIDOR_TRAINS.has(
      String(trainNo)
    )
  ) {
    return "TPTY";
  }

  // ----------------------------------------------------------
  // Origin fallback.
  // ----------------------------------------------------------

  if (
    isFromTirupatiSide(
      liveTrain,
      liveItem
    )
  ) {
    return "TPTY";
  }

  if (
    isFromChennaiSide(
      liveTrain,
      liveItem
    )
  ) {
    return "MAS";
  }

  // IMPORTANT:
  // Never guess MAS.
  return null;
}

// ============================================================
// GET LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
      trainNo
    )}/live?authoritative=true&includeCoordinates=true`;

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

  return (
    response?.data?.data ||
    null
  );
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  let apiRequests = 0;

  try {
    const now =
      new Date();

    const currentMin =
      now.getHours() * 60 +
      now.getMinutes();

    console.log(
      "\n=========================================="
    );

    console.log(
      `[${now.toLocaleTimeString()}] Stage 1: Reading GDR live board...`
    );

    // --------------------------------------------------------
    // STAGE 1: LIVE STATION BOARD
    // --------------------------------------------------------

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`,
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

    // --------------------------------------------------------
    // GATE DEFAULTS
    // --------------------------------------------------------

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

    const boardCandidates = [];

    // --------------------------------------------------------
    // PROCESS STATION BOARD
    // --------------------------------------------------------

    for (
      const item of trainsArray
    ) {
      const train =
        item?.train || {};

      const live =
        item?.live || {};

      const stop =
        item?.stop || {};

      const trainNo =
        String(
          train?.number || ""
        ).trim();

      if (!trainNo) {
        continue;
      }

      const trainName =
        train?.name ||
        `Express ${trainNo}`;

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

      const boardStatus =
        String(
          live?.type ||
          live?.status ||
          stop?.status ||
          ""
        )
          .trim()
          .toLowerCase();

      // ------------------------------------------------------
      // REMOVE DEPARTED TRAINS
      // ------------------------------------------------------

      if (
        boardStatus ===
        "departed"
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - RailRadar says DEPARTED`
        );

        continue;
      }

      // ------------------------------------------------------
      // ARRIVAL TIME
      // ------------------------------------------------------

      const delayMin =
        Number(
          live?.delayMinutes ||
          0
        );

      const arrTimeStr =
        stop?.arrival ||
        live?.expectedArrivalTime ||
        "";

      const depTimeStr =
        stop?.departure ||
        live?.expectedDepartureTime ||
        arrTimeStr;

      const arrMin =
        parseTimeToMinutes(
          arrTimeStr,
          delayMin
        );

      const depMin =
        parseTimeToMinutes(
          depTimeStr,
          delayMin
        );

      if (
        arrMin === -1
      ) {
        continue;
      }

      const diff =
        calculateTimeDifference(
          arrMin,
          currentMin
        );

      // ------------------------------------------------------
      // REMOVE TRAINS THAT ARE TOO OLD
      // ------------------------------------------------------

      if (
        diff < -15
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - arrival passed ${Math.abs(
            diff
          )}m ago`
        );

        continue;
      }

      // ------------------------------------------------------
      // REMOVE TRAINS TOO FAR INTO FUTURE
      // ------------------------------------------------------

      if (
        diff >
        UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      // ------------------------------------------------------
      // DETERMINE CORRIDOR
      // ------------------------------------------------------

      let corridor =
        determineCorridorFromRoute(
          train,
          item,
          item?.route ||
            train?.route ||
            []
        );

      // If board does not expose route, use origin.
      if (!corridor) {
        if (
          isFromTirupatiSide(
            train,
            item
          )
        ) {
          corridor = "TPTY";
        } else if (
          isFromChennaiSide(
            train,
            item
          )
        ) {
          corridor = "MAS";
        } else if (
          TIRUPATI_CORRIDOR_TRAINS.has(
            trainNo
          )
        ) {
          corridor = "TPTY";
        }
      }

      if (!corridor) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} - corridor not confirmed`
        );

        continue;
      }

      // ------------------------------------------------------
      // UPCOMING / SCHEDULED
      // ------------------------------------------------------

      const upcoming =
        isUpcomingStatus(
          live,
          stop
        );

      // ------------------------------------------------------
      // AT STATION
      // ------------------------------------------------------

      const isAtStation =
        boardStatus ===
          "at-station" ||
        (
          currentMin >= arrMin &&
          currentMin <=
            (
              depMin !== -1
                ? depMin
                : arrMin + 5
            )
        );

      // ------------------------------------------------------
      // ADD TO UPCOMING CANDIDATES
      //
      // We allow both upcoming and at-station trains.
      // At-station trains will be verified in Stage 2.
      // ------------------------------------------------------

      if (
        upcoming ||
        isAtStation ||
        (
          diff >= 0 &&
          diff <=
            UPCOMING_MAX_ETA_MINUTES
        )
      ) {
        boardCandidates.push({
          trainNo,
          trainName,
          origin:
            origin ||
            "Southern side",
          destination:
            destination ||
            "Gudur",
          etaMinutes:
            Math.max(
              0,
              diff
            ),
          delayMinutes:
            delayMin,
          corridor,
          direction:
            "TOWARD GUDUR",
          platform:
            String(
              live?.platform ||
              stop?.platform ||
              "1"
            ),
          boardStatus,
          isAtStation
        });
      }
    }

    // ========================================================
    // STAGE 2
    // LIVE VERIFICATION
    // ========================================================

    console.log(
      "\n=========================================="
    );

    console.log(
      "Stage 2: Actual-position verification"
    );

    console.log(
      "=========================================="
    );

    const liveCandidates =
      boardCandidates
        .filter(
          (t) =>
            t.etaMinutes <=
            LIVE_VERIFY_ETA_MINUTES
        )
        .sort(
          (a, b) =>
            a.etaMinutes -
            b.etaMinutes
        )
        .slice(
          0,
          MAX_LIVE_CALLS
        );

    console.log(
      `Live verification candidates: ${liveCandidates.length}`
    );

    const verifiedTrains = [];

    for (
      const candidate of
        liveCandidates
    ) {
      try {
        console.log(
          `[LIVE CHECK] ${candidate.trainNo} ${candidate.trainName}`
        );

        const liveData =
          await fetchLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        if (!liveData) {
          console.log(
            `[LIVE SKIP] ${candidate.trainNo} - no live data`
          );

          verifiedTrains.push(
            candidate
          );

          continue;
        }

        // ----------------------------------------------------
        // CROSSING / PASSED GUDUR CHECK
        // ----------------------------------------------------

        if (
          hasPassedGudurFromLive(
            liveData
          )
        ) {
          console.log(
            `[CROSSED] ${candidate.trainNo} ${candidate.trainName} - already passed Gudur`
          );

          continue;
        }

        // ----------------------------------------------------
        // LIVE POSITION
        // ----------------------------------------------------

        const position =
          getLivePosition(
            liveData
          );

        if (
          position
        ) {
          const gateLat =
            candidate.corridor ===
            "TPTY"
              ? TIRUPATI_GATE_LAT
              : CHENNAI_GATE_LAT;

          const gateLng =
            candidate.corridor ===
            "TPTY"
              ? TIRUPATI_GATE_LNG
              : CHENNAI_GATE_LNG;

          const gateDistance =
            distanceKm(
              position.lat,
              position.lng,
              gateLat,
              gateLng
            );

          candidate.liveDistanceKm =
            gateDistance;

          candidate.liveSpeedKmh =
            position.speedKmh;

          candidate.actualPosition =
            position.isActualPosition;

          console.log(
            `[LIVE POSITION] ${candidate.trainNo} | ${gateDistance !== null ? gateDistance.toFixed(3) : "?"} km from gate | ${position.speedKmh ?? "?"} km/h`
          );

          // --------------------------------------------------
          // TRAIN HAS REACHED GATE
          // --------------------------------------------------

          if (
            gateDistance !==
              null &&
            gateDistance <=
              GATE_TRIGGER_DISTANCE_KM
          ) {
            const waitTime =
              Math.max(
                1,
                candidate.etaMinutes +
                  2
              );

            const payload = {
              status:
                "CLOSED",
              waitMinutes:
                waitTime,
              activeTrain:
                `${candidate.trainNo} ${candidate.trainName}`,
              direction:
                "TOWARD GUDUR",
              corridor:
                candidate.corridor
            };

            if (
              candidate.corridor ===
              "TPTY"
            ) {
              tptyGate =
                payload;
            }

            if (
              candidate.corridor ===
              "MAS"
            ) {
              masGate =
                payload;
            }

            console.log(
              `[GATE CLOSED] ${candidate.corridor} | ${candidate.trainNo} ${candidate.trainName} | ${gateDistance.toFixed(
                3
              )} km`
            );
          }
        }

        // ----------------------------------------------------
        // KEEP TRAIN
        // ----------------------------------------------------

        verifiedTrains.push(
          candidate
        );

      } catch (error) {
        console.error(
          `[LIVE ERROR] ${candidate.trainNo}: ${error.message}`
        );

        // Keep board data if live check fails.
        verifiedTrains.push(
          candidate
        );
      }
    }

    // ========================================================
    // MERGE BOARD + LIVE RESULTS
    // ========================================================

    const liveCheckedNumbers =
      new Set(
        liveCandidates.map(
          (t) => t.trainNo
        )
      );

    const crossedNumbers =
      new Set();

    // Live candidates that disappeared from verifiedTrains
    // were most likely already crossed/removed.
    for (
      const candidate of
        liveCandidates
    ) {
      const stillExists =
        verifiedTrains.some(
          (t) =>
            t.trainNo ===
            candidate.trainNo
        );

      if (!stillExists) {
        crossedNumbers.add(
          candidate.trainNo
        );
      }
    }

    const finalUpcoming =
      boardCandidates.filter(
        (train) =>
          !crossedNumbers.has(
            train.trainNo
          )
      );

    // ========================================================
    // SORT
    // ========================================================

    finalUpcoming.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    // ========================================================
    // MAXIMUM 5 TRAINS
    // ========================================================

    const topUpcoming =
      finalUpcoming
        .slice(
          0,
          5
        )
        .map(
          (train) => ({
            trainNo:
              train.trainNo,

            name:
              train.trainName,

            origin:
              train.origin,

            destination:
              train.destination,

            etaMinutes:
              train.etaMinutes,

            delayMinutes:
              train.delayMinutes,

            corridor:
              train.corridor,

            direction:
              "TOWARD GUDUR",

            platform:
              train.platform
          })
        );

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

      monitorMode:
        "TWO-STAGE",

      liveVerified:
        verifiedTrains.length,

      apiRequests:
        apiRequests
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
      `Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );

    console.log(
      `Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );

    console.log(
      `Upcoming trains: ${topUpcoming.length}`
    );

    console.log(
      `Live verified: ${verifiedTrains.length}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    // ========================================================
    // UPCOMING DISPLAY
    // ========================================================

    if (
      topUpcoming.length > 0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }

    if (
      crossedNumbers.size > 0
    ) {
      console.log(
        "\n[CROSSED / REMOVED]"
      );

      for (
        const trainNo of
          crossedNumbers
      ) {
        console.log(
          `   ${trainNo}`
        );
      }
    }

    console.log(
      "==========================================\n"
    );

  } catch (err) {
    console.error(
      "\n[MONITOR ERROR]"
    );

    if (
      err.response
    ) {
      console.error(
        `HTTP ${err.response.status}`
      );

      console.error(
        JSON.stringify(
          err.response.data,
          null,
          2
        )
      );
    } else {
      console.error(
        err.message
      );
    }

    console.error(
      "=========================================="
    );
  }
}

// ============================================================
// START
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor Active "
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
  `RailRadar API Key: ${
    RAILRADAR_API_KEY
      ? "Configured"
      : "MISSING"
  }`
);

console.log(
  "MODE: TWO-STAGE"
);

console.log(
  "Stage 1: Upcoming MAS + TPTY"
);

console.log(
  "Stage 2: Actual position → gate closure"
);

console.log(
  `Upcoming max ETA: ${UPCOMING_MAX_ETA_MINUTES} minutes`
);

console.log(
  `Live verification window: ${LIVE_VERIFY_ETA_MINUTES} minutes`
);

console.log(
  `Gate trigger distance: ${GATE_TRIGGER_DISTANCE_KM} km`
);

console.log(
  `Maximum live calls: ${MAX_LIVE_CALLS}`
);

console.log(
  "GitHub Actions: RUN ONCE"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN ONCE
// ============================================================

updateGateSystem();
