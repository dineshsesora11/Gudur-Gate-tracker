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
    "Set FIREBASE_SERVICE_ACCOUNT or provide serviceAccountKey.json."
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
const TIRUPATI_GATE_LNG = 79.8436000;

// ============================================================
// SETTINGS
// ============================================================

// Upcoming trains shown to frontend
const UPCOMING_MAX_DISTANCE_KM = 150;
const UPCOMING_MAX_ETA_MINUTES = 360;
const UPCOMING_DISPLAY_LIMIT = 5;

// Live verification
// IMPORTANT:
// The closest train is ALWAYS checked first.
const LIVE_VERIFY_ETA_MINUTES = 60;
const MAX_LIVE_CALLS = 2;

// Gate closes only when verified train is physically
// close to the corresponding gate.
const GATE_TRIGGER_DISTANCE_KM = 0.60;

// How often this local process refreshes.
// GitHub Actions itself runs every 5 minutes.
const REFRESH_INTERVAL_MS = 180000;

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
    normalized.includes(normalizeText(value))
  );
}

// ============================================================
// INDIA TIME
// ============================================================

function getIndiaCurrentMinutes() {
  const parts = new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: "Asia/Kolkata",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    }
  ).formatToParts(new Date());

  const hour = Number(
    parts.find((p) => p.type === "hour")?.value || 0
  );

  const minute = Number(
    parts.find((p) => p.type === "minute")?.value || 0
  );

  return hour * 60 + minute;
}

function getIndiaTimeString() {
  return new Intl.DateTimeFormat(
    "en-IN",
    {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "medium"
    }
  ).format(new Date());
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

  const text = String(timeStr).trim();

  // ----------------------------------------------------------
  // ISO timestamp
  //
  // We intentionally extract the HH:MM portion directly
  // instead of converting it through the server's timezone.
  // ----------------------------------------------------------

  const isoMatch = text.match(
    /T(\d{1,2}):(\d{2})/
  );

  if (isoMatch) {
    const hour = Number(isoMatch[1]);
    const minute = Number(isoMatch[2]);

    return (
      hour * 60 +
      minute +
      Number(delayMinutes || 0)
    );
  }

  // ----------------------------------------------------------
  // Normal HH:MM
  // ----------------------------------------------------------

  const timeMatch = text.match(
    /(\d{1,2}):(\d{2})/
  );

  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);

    return (
      hour * 60 +
      minute +
      Number(delayMinutes || 0)
    );
  }

  return -1;
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

  // Midnight crossing
  if (diff < -720) {
    diff += 1440;
  }

  if (diff > 720) {
    diff -= 1440;
  }

  return diff;
}

// ============================================================
// DISTANCE CALCULATION
// ============================================================

function calculateDistanceKm(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) / 180;

  const dLng =
    ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) *
      Math.sin(dLat / 2) +
    Math.cos(
      (lat1 * Math.PI) / 180
    ) *
      Math.cos(
        (lat2 * Math.PI) / 180
      ) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

// ============================================================
// RAILRADAR SOURCE / DESTINATION
// ============================================================

function getRailRadarSource(
  train,
  item
) {
  return (
    train.source ||
    item.train?.source ||
    item.source ||
    {}
  );
}

function getRailRadarDestination(
  train,
  item
) {
  return (
    train.destination ||
    item.train?.destination ||
    item.destination ||
    {}
  );
}

function getSourceCode(
  train,
  item
) {
  const source =
    getRailRadarSource(
      train,
      item
    );

  if (typeof source === "string") {
    return normalizeText(source);
  }

  return normalizeText(
    source.code ||
      source.stationCode ||
      source.name ||
      ""
  );
}

function getDestinationCode(
  train,
  item
) {
  const destination =
    getRailRadarDestination(
      train,
      item
    );

  if (typeof destination === "string") {
    return normalizeText(
      destination
    );
  }

  return normalizeText(
    destination.code ||
      destination.stationCode ||
      destination.name ||
      ""
  );
}

function getSourceName(
  train,
  item
) {
  const source =
    getRailRadarSource(
      train,
      item
    );

  if (typeof source === "string") {
    return source;
  }

  return (
    source.name ||
    source.code ||
    ""
  );
}

function getDestinationName(
  train,
  item
) {
  const destination =
    getRailRadarDestination(
      train,
      item
    );

  if (typeof destination === "string") {
    return destination;
  }

  return (
    destination.name ||
    destination.code ||
    ""
  );
}

// ============================================================
// CHENNAI-SIDE DESTINATIONS
// ============================================================

const CHENNAI_SIDE_CODES = new Set([
  "MAS",
  "MS",
  "MSB",
  "TBM",
  "CGL",
  "AJJ",
  "PER",
  "AVD",
  "SPE",
  "NYP"
]);

// ============================================================
// SOUTHERN-SIDE DESTINATIONS
// ============================================================
//
// These are destinations on the Tirupati / southern side
// of the Gudur area.
//
// A train from a northern/Chennai side origin heading to
// these destinations approaches Gudur from the Chennai side.
//
// Therefore:
// destination SOUTH -> MAS GATE
//
// ============================================================

const SOUTHERN_SIDE_CODES = new Set([
  "TPTY",
  "RU",
  "GTL",
  "DMM",
  "SMVB",
  "SBC",
  "BNC",
  "YPR",
  "KJM",
  "KPD",
  "CCT",
  "COA",
  "NS",

  // Additional southern destinations
  "TVC",
  "CAPE",
  "TEN",
  "MDU",
  "ERS",
  "KCVL",
  "QLN",
  "ALLP",
  "AWY",
  "KTYM",
  "SRR",
  "MAQ",
  "CAN",
  "CLT",
  "PGT",
  "ED",
  "TCR",
  "KZJ"
]);

// ============================================================
// DESTINATION SIDE
// ============================================================

function getDestinationSide(
  train,
  item
) {
  const destinationCode =
    getDestinationCode(
      train,
      item
    );

  if (
    CHENNAI_SIDE_CODES.has(
      destinationCode
    )
  ) {
    return "CHENNAI";
  }

  if (
    SOUTHERN_SIDE_CODES.has(
      destinationCode
    )
  ) {
    return "SOUTH";
  }

  return null;
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

    live.direction,
    live.travelDirection,
    live.routeDirection,
    live.runningDirection,

    stop.direction,

    item.direction,
    item.travelDirection,
    item.routeDirection,
    item.runningDirection
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

  // ----------------------------------------------------------
  // Toward Gudur
  // ----------------------------------------------------------

  if (
    direction.includes("TOWARD GUDUR") ||
    direction.includes("TOWARDS GUDUR") ||
    direction.includes("TO GUDUR") ||
    direction.includes("GUDUR INBOUND") ||
    direction.includes("INBOUND") ||
    direction.includes("APPROACHING GUDUR")
  ) {
    return true;
  }

  // ----------------------------------------------------------
  // Away from Gudur
  // ----------------------------------------------------------

  if (
    direction.includes("FROM GUDUR") ||
    direction.includes("GUDUR OUTBOUND") ||
    direction.includes("OUTBOUND") ||
    direction.includes("AWAY FROM GUDUR") ||
    direction.includes("TO CHENNAI") ||
    direction.includes("TOWARD CHENNAI") ||
    direction.includes("TOWARDS CHENNAI") ||
    direction.includes("TO TIRUPATI") ||
    direction.includes("TOWARD TIRUPATI") ||
    direction.includes("TOWARDS TIRUPATI")
  ) {
    return false;
  }

  return null;
}

// ============================================================
// DETERMINE INBOUND CORRIDOR
// ============================================================
//
// IMPORTANT WORKING LOGIC:
//
// Destination on Chennai side
//     => TPTY gate
//
// Destination on southern side
//     => MAS gate
//
// Explicit outbound
//     => ignored
//
// Unknown
//     => ignored
//
// This keeps the MAS/TPTY classification that is currently
// working in the user's project.
// ============================================================

function determineInboundCorridor(
  train,
  live,
  stop,
  item
) {
  const explicitDirection =
    hasInboundDirection(
      train,
      live,
      stop,
      item
    );

  // ----------------------------------------------------------
  // Explicitly outbound = reject
  // ----------------------------------------------------------

  if (
    explicitDirection === false
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // Destination-side classification
  // ----------------------------------------------------------

  const destinationSide =
    getDestinationSide(
      train,
      item
    );

  if (
    destinationSide ===
    "CHENNAI"
  ) {
    return "TPTY";
  }

  if (
    destinationSide === "SOUTH"
  ) {
    return "MAS";
  }

  // ----------------------------------------------------------
  // Unknown
  // ----------------------------------------------------------

  return null;
}

// ============================================================
// TRAIN STATUS HELPERS
// ============================================================

function getTrainStatus(
  train,
  live,
  item
) {
  return normalizeText(
    live.status ||
      train.status ||
      item.status ||
      ""
  );
}

function isDepartedStatus(
  train,
  live,
  item
) {
  const status =
    getTrainStatus(
      train,
      live,
      item
    );

  return (
    status.includes("DEPARTED") ||
    status.includes("CANCELLED") ||
    status.includes("CANCELED") ||
    status.includes("TERMINATED") ||
    status.includes("COMPLETED")
  );
}

// ============================================================
// UPCOMING STATUS
// ============================================================

function isUpcomingStatus(
  train,
  live,
  item
) {
  const status =
    getTrainStatus(
      train,
      live,
      item
    );

  if (!status) {
    return true;
  }

  if (
    status.includes("DEPARTED") ||
    status.includes("CANCELLED") ||
    status.includes("CANCELED") ||
    status.includes("TERMINATED") ||
    status.includes("COMPLETED")
  ) {
    return false;
  }

  return true;
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
      item.number ||
      ""
  ).trim();
}

// ============================================================
// TRAIN NAME
// ============================================================

function getTrainName(
  train,
  item,
  trainNo
) {
  return (
    train.name ||
    item.trainName ||
    item.name ||
    `Express ${trainNo}`
  );
}

// ============================================================
// DESTINATION / ORIGIN
// ============================================================

function getOrigin(
  train,
  item
) {
  return (
    getSourceName(
      train,
      item
    ) ||
    "Southern side"
  );
}

function getDestination(
  train,
  item
) {
  return (
    getDestinationName(
      train,
      item
    ) ||
    "Gudur"
  );
}

// ============================================================
// LIVE COORDINATES
// ============================================================

function getLiveCoordinates(
  currentLocation
) {
  if (!currentLocation) {
    return null;
  }

  const lat =
    Number(
      currentLocation.latitude ??
        currentLocation.lat
    );

  const lng =
    Number(
      currentLocation.longitude ??
        currentLocation.lng ??
        currentLocation.lon
    );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  return {
    lat,
    lng
  };
}

// ============================================================
// LIVE POSITION STATUS
// ============================================================

function isActualPosition(
  currentLocation
) {
  if (!currentLocation) {
    return false;
  }

  return (
    currentLocation.isActualPosition ===
      true ||
    currentLocation.positionSource ===
      "gps" ||
    currentLocation.positionSource ===
      "station-code"
  );
}

// ============================================================
// FETCH LIVE TRAIN
// ============================================================

async function fetchLiveTrain(
  trainNo
) {
  const url =
    `${RAILRADAR_BASE_URL}/trains/${encodeURIComponent(
      trainNo
    )}/live?authoritative=true&includeCoordinates=true`;

  return axios.get(
    url,
    {
      headers: {
        Authorization:
          `Bearer ${RAILRADAR_API_KEY}`,
        Accept: "application/json"
      },
      timeout: 12000
    }
  );
}

// ============================================================
// MAIN UPDATE
// ============================================================

async function updateGateSystem() {
  let apiRequests = 0;
  let liveVerifiedCount = 0;

  try {
    const currentMinutes =
      getIndiaCurrentMinutes();

    console.log(
      `\n[${getIndiaTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // ========================================================
    // STAGE 1 — STATION BOARD
    // ========================================================

    const boardRes =
      await axios.get(
        `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4&includeIntermediate=true`,
        {
          headers: {
            Authorization:
              `Bearer ${RAILRADAR_API_KEY}`,
            Accept: "application/json"
          },
          timeout: 12000
        }
      );

    apiRequests++;

    const responseBody =
      boardRes.data;

    const trainsArray =
      responseBody?.data?.trains || [];

    if (
      !Array.isArray(trainsArray)
    ) {
      console.error(
        "❌ RailRadar returned invalid train data."
      );

      console.error(
        JSON.stringify(
          responseBody,
          null,
          2
        )
      );

      return;
    }

    console.log(
      `RailRadar returned ${trainsArray.length} trains.`
    );

    // ========================================================
    // DEFAULT GATES
    // ========================================================

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain: "Tracks clear"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain: "Tracks clear"
    };

    const upcomingList = [];

    // ========================================================
    // STAGE 1 PROCESSING
    // ========================================================

    for (
      const item of trainsArray
    ) {
      const train =
        item.train || {};

      const live =
        item.live || {};

      const stop =
        item.stop || {};

      const trainNo =
        getTrainNumber(
          train,
          item
        );

      if (!trainNo) {
        continue;
      }

      const trainName =
        getTrainName(
          train,
          item,
          trainNo
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

      const delayMin =
        Number(
          live.delayMinutes ||
            item.delayMinutes ||
            0
        );

      // ------------------------------------------------------
      // Ignore explicitly departed/cancelled trains
      // ------------------------------------------------------

      if (
        !isUpcomingStatus(
          train,
          live,
          item
        )
      ) {
        console.log(
          `[REMOVED] ${trainNo} ${trainName} - RailRadar status: ${getTrainStatus(
            train,
            live,
            item
          )}`
        );

        continue;
      }

      // ------------------------------------------------------
      // Arrival
      // ------------------------------------------------------

      const arrTimeStr =
        stop.arrival ||
        live.expectedArrivalTime ||
        item.expectedArrivalTime ||
        item.arrival ||
        "";

      const depTimeStr =
        stop.departure ||
        live.expectedDepartureTime ||
        item.expectedDepartureTime ||
        item.departure ||
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
          currentMinutes
        );

      // ------------------------------------------------------
      // Ignore passed trains and very distant trains
      // ------------------------------------------------------

      if (
        diff < -15 ||
        diff >
          UPCOMING_MAX_ETA_MINUTES
      ) {
        continue;
      }

      // ======================================================
      // CORRIDOR
      // ======================================================

      const corridor =
        determineInboundCorridor(
          train,
          live,
          stop,
          item
        );

      if (!corridor) {
        console.log(
          `[IGNORED] ${trainNo} ${trainName} | ${origin} -> ${destination} | corridor not confirmed`
        );

        continue;
      }

      console.log(
        `[INBOUND ${corridor}] ${trainNo} ${trainName} | ${origin} -> ${destination} | ETA ${Math.max(
          0,
          diff
        )}m`
      );

      // ======================================================
      // UPCOMING LIST
      // ======================================================

      upcomingList.push({
        trainNo,
        name: trainName,

        origin,
        destination,

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
            live.platform ||
              stop.platform ||
              item.platform ||
              "1"
          )
      });
    }

    // ========================================================
    // IMPORTANT FIX
    //
    // ALWAYS SORT THE COMPLETE UPCOMING LIST BY ETA
    // BEFORE SELECTING LIVE VERIFICATION CANDIDATES.
    //
    // This guarantees:
    //
    // ETA 0m
    // ETA 13m
    // ETA 24m
    //
    // are checked in exactly that order.
    // ========================================================

    upcomingList.sort(
      (a, b) => {
        const etaA =
          Number.isFinite(
            Number(
              a.etaMinutes
            )
          )
            ? Number(
                a.etaMinutes
              )
            : 999999;

        const etaB =
          Number.isFinite(
            Number(
              b.etaMinutes
            )
          )
            ? Number(
                b.etaMinutes
              )
            : 999999;

        return etaA - etaB;
      }
    );

    // ========================================================
    // STAGE 2 — LIVE VERIFICATION
    // ========================================================

    const liveCandidates =
      upcomingList
        .filter(
          (candidate) =>
            Number(
              candidate.etaMinutes
            ) <=
            LIVE_VERIFY_ETA_MINUTES
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

    console.log(
      `\n[STAGE 2] Live verification candidates: ${liveCandidates.length}`
    );

    // --------------------------------------------------------
    // DEBUG: SHOW EXACT ORDER
    // --------------------------------------------------------

    if (
      liveCandidates.length >
      0
    ) {
      console.log(
        "[LIVE QUEUE ORDER]"
      );

      liveCandidates.forEach(
        (candidate, index) => {
          console.log(
            `  ${index + 1}. ${candidate.trainNo} ${candidate.name} | ${candidate.corridor} | ETA ${candidate.etaMinutes}m`
          );
        }
      );
    }

    // ========================================================
    // VERIFY ONLY THE CLOSEST 2
    // ========================================================

    const candidatesToVerify =
      liveCandidates.slice(
        0,
        MAX_LIVE_CALLS
      );

    for (
      const candidate of candidatesToVerify
    ) {
      console.log(
        `[LIVE] Checking train ${candidate.trainNo}...`
      );

      try {
        const liveRes =
          await fetchLiveTrain(
            candidate.trainNo
          );

        apiRequests++;

        const liveData =
          liveRes.data?.data || {};

        const currentLocation =
          liveData.currentLocation ||
          liveData.location ||
          null;

        const liveStatus =
          normalizeText(
            liveData.status ||
              currentLocation?.status ||
              ""
          );

        const coordinates =
          getLiveCoordinates(
            currentLocation
          );

        const actual =
          isActualPosition(
            currentLocation
          );

        // ----------------------------------------------------
        // Distance
        // ----------------------------------------------------

        let gateDistanceKm =
          null;

        if (
          coordinates
        ) {
          const gateLat =
            candidate.corridor ===
            "MAS"
              ? CHENNAI_GATE_LAT
              : TIRUPATI_GATE_LAT;

          const gateLng =
            candidate.corridor ===
            "MAS"
              ? CHENNAI_GATE_LNG
              : TIRUPATI_GATE_LNG;

          gateDistanceKm =
            calculateDistanceKm(
              coordinates.lat,
              coordinates.lng,
              gateLat,
              gateLng
            );
        }

        console.log(
          `[LIVE VERIFIED] ${candidate.trainNo} | ${candidate.corridor} | status=${liveStatus || "UNKNOWN"} | distance=${
            gateDistanceKm !== null
              ? gateDistanceKm.toFixed(
                  3
                ) +
                " km"
              : "unknown"
          } | actual=${actual}`
        );

        // ----------------------------------------------------
        // Determine if this is a usable live verification
        // ----------------------------------------------------

        const liveLooksValid =
          actual &&
          coordinates &&
          gateDistanceKm !== null;

        if (
          !liveLooksValid
        ) {
          console.log(
            `[LIVE NOT CLOSE] ${candidate.trainNo} - no usable actual GPS position near gate`
          );

          continue;
        }

        liveVerifiedCount++;

        // ----------------------------------------------------
        // CRITICAL:
        // CLOSE ONLY THE CORRESPONDING GATE.
        // ----------------------------------------------------

        if (
          gateDistanceKm <=
          GATE_TRIGGER_DISTANCE_KM
        ) {
          const waitMinutes =
            Math.max(
              1,
              Math.min(
                15,
                Number(
                  candidate.etaMinutes
                ) +
                  2
              )
            );

          const label =
            `${candidate.trainNo} ${candidate.name} (${liveStatus || "Running"})`;

          const payload = {
            status: "CLOSED",

            waitMinutes,

            activeTrain:
              label,

            direction:
              "TOWARD GUDUR",

            corridor:
              candidate.corridor,

            distanceKm:
              Number(
                gateDistanceKm.toFixed(
                  3
                )
              )
          };

          if (
            candidate.corridor ===
            "MAS"
          ) {
            masGate =
              payload;

            console.log(
              `🚨 [GATE CLOSED] CHENNAI / MAS GATE | ${label} | ${gateDistanceKm.toFixed(
                3
              )} km`
            );
          }

          if (
            candidate.corridor ===
            "TPTY"
          ) {
            tptyGate =
              payload;

            console.log(
              `🚨 [GATE CLOSED] TIRUPATI / TPTY GATE | ${label} | ${gateDistanceKm.toFixed(
                3
              )} km`
            );
          }
        }
      } catch (
        liveError
      ) {
        apiRequests++;

        if (
          liveError.response
        ) {
          console.error(
            `[LIVE ERROR] ${candidate.trainNo} | HTTP ${liveError.response.status}`
          );
        } else {
          console.error(
            `[LIVE ERROR] ${candidate.trainNo} | ${liveError.message}`
          );
        }
      }
    }

    // ========================================================
    // TOP 5 UPCOMING
    // ========================================================

    const topUpcoming =
      upcomingList
        .sort(
          (a, b) =>
            Number(
              a.etaMinutes
            ) -
            Number(
              b.etaMinutes
            )
        )
        .slice(
          0,
          UPCOMING_DISPLAY_LIMIT
        );

    // ========================================================
    // FIREBASE
    // ========================================================

    await gateRef.set({
      tirupatiGate:
        tptyGate,

      chennaiGate:
        masGate,

      upcomingTrains:
        topUpcoming,

      lastUpdated:
        getIndiaTimeString(),

      apiRequests,

      liveVerified:
        liveVerifiedCount
    });

    // ========================================================
    // SUCCESS
    // ========================================================

    console.log(
      "\n[SYNC SUCCESS] Firebase updated."
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
      `Live verified: ${liveVerifiedCount}`
    );

    console.log(
      `API requests: ${apiRequests}`
    );

    // ========================================================
    // UPCOMING DISPLAY
    // ========================================================

    if (
      topUpcoming.length >
      0
    ) {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR]"
      );

      topUpcoming.forEach(
        (train, index) => {
          console.log(
            `${index + 1}. ${train.trainNo} ${train.name} | ${train.corridor} LINE | ETA ${train.etaMinutes}m | PF ${train.platform} | ${train.origin} -> ${train.destination}`
          );
        }
      );
    } else {
      console.log(
        "\n[UPCOMING TRAINS TO GUDUR] None"
      );
    }
  } catch (
    error
  ) {
    console.error(
      "\n[MONITOR ERROR]"
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
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor Active "
);

console.log(
  " Chennai Gate:  14.1396639 N, 79.8441306 E "
);

console.log(
  " Tirupati Gate: 14.1402056 N, 79.8436000 E "
);

console.log(
  "=========================================="
);

console.log(
  "RailRadar API Key: Configured"
);

console.log(
  "Firebase: Configured"
);

console.log(
  "Direction: Southern side -> Gudur only"
);

console.log(
  `Live verification: ${LIVE_VERIFY_ETA_MINUTES} minutes`
);

console.log(
  `Maximum live calls: ${MAX_LIVE_CALLS}`
);

console.log(
  "Closest ETA is always checked first"
);

console.log(
  "=========================================="
);

// ============================================================
// RUN IMMEDIATELY
// ============================================================

updateGateSystem();

// ============================================================
// RUN EVERY 3 MINUTES
// ============================================================

setInterval(
  updateGateSystem,
  REFRESH_INTERVAL_MS
);
