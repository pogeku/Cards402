// @ts-check
// SHA256 helper for agent_claims.code storage.
//
// Claim codes are short-lived (10 min TTL) bootstrap tokens that trade
// for the real api key on POST /v1/agent/claim. Storing the raw code
// in the DB would expose every live claim to anyone with read access
// to agent_claims during the TTL window — which the sealed_payload
// defence does not cover, because the payload decrypt only protects
// the api_key that the code unlocks, not the code itself.
//
// We hash the code before storing it, matching the pattern already
// used for auth_codes.code_hash and sessions.token_hash. The column
// still holds a string and the UNIQUE constraint still applies because
// both the mint path (dashboard.js) and the redeem path (app.js) hash
// identically before comparing.

const crypto = require('crypto');

/**
 * Hash a claim code for storage / lookup. Returns a 64-char hex string.
 * @param {string} code
 */
function hashClaimCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

module.exports = { hashClaimCode };
