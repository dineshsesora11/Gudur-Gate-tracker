const axios = require("axios");

const RAILRADAR_API_KEY =
  process.env.RAILRADAR_API_KEY || "";

const RAILRADAR_BASE_URL =
  "https://api.railradar.in/v1";

async function test12734() {
  try {
    console.log("==========================================");
    console.log(" RAILRADAR LIVE TEST - TRAIN 12734");
    console.log("==========================================");

    const res = await axios.get(
      `${RAILRADAR_BASE_URL}/trains/12734/live`,
      {
        params: {
          authoritative: "true",
          haltsOnly: "false",
          geometry: "true",
          format: "geojson",
          includeCoordinates: "true"
        },
        headers: {
          Authorization:
            `Bearer ${RAILRADAR_API_KEY}`,
          Accept:
            "application/json"
        },
        timeout: 15000
      }
    );

    console.log(
      "\n========== RAW RAILRADAR RESPONSE ==========\n"
    );

    console.log(
      JSON.stringify(
        res.data,
        null,
        2
      )
    );

    console.log(
      "\n=========================================="
    );

    console.log(
      " TEST COMPLETED"
    );

    console.log(
      "=========================================="
    );

  } catch (err) {
    console.error(
      "\n❌ TEST FAILED"
    );

    if (err.response) {
      console.error(
        "HTTP:",
        err.response.status
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
  }
}

test12734();
