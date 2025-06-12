// FILE: scripts/outbound-call-api.js
// DESCRIPTION: Module to make an outbound call via the Twilio API.

require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require("twilio")(accountSid, authToken);

/**
 * Makes an outbound call to a specified number.
 * @param {string} targetNumber The phone number to call.
 * @returns {Promise<string>} The SID of the created call.
 */
async function makeOutboundCall(targetNumber) {
  if (!targetNumber) {
    throw new Error("A target phone number is required.");
  }

  console.log(`[API-DIALER] Initiating call to ${targetNumber}`);

  try {
    const call = await client.calls.create({
      // The URL Twilio will request when the call connects.
      // This should point to your server's /incoming endpoint.
      url: `https://${process.env.SERVER}/incoming`,
      to: targetNumber,
      from: process.env.FROM_NUMBER,
    });
    console.log(`[API-DIALER] Call initiated with SID: ${call.sid}`.green);
    return call.sid;
  } catch (error) {
    console.error("[API-DIALER] Error creating call:".red, error);
    throw error;
  }
}

module.exports = { makeOutboundCall };
