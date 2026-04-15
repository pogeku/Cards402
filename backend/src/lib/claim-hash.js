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
//
// Adversarial audit 2026-04-15:
//
//   F1-claim-hash: reject non-string inputs. Pre-fix `String(code)`
//     silently coerced null/undefined/objects to 'null'/'undefined'/
//     '[object Object]' and produced valid 64-char hex hashes. A buggy
//     caller passing a wrong field (e.g. `hashClaimCode(req.body.wrong)`
//     where the field is undefined) would collide with any other such
//     bug AND collide with an attacker who guessed to redeem the
//     literal string 'undefined'. The collision would surface as a
//     mystery UNIQUE constraint violation downstream, or worse, as a
//     successful redemption against the wrong row. Throw loud at the
//     boundary so caller bugs fail at the call site with a clear error.
//
//   F2-claim-hash: reject empty strings. `SHA256('')` is the well-known
//     constant `e3b0c44...`. A caller that accidentally passes '' would
//     store or lookup that fixed hash — the first to mint wins the row,
//     and every subsequent mint collides on the UNIQUE constraint with
//     a confusing error far from the root cause. Throw instead.

const crypto = require('crypto');

/**
 * Hash a claim code for storage / lookup. Returns a 64-char hex string.
 *
 * Throws TypeError if `code` is not a non-empty string. Callers MUST
 * validate / trim their input before calling — the hash function is
 * deliberately strict so caller bugs surface at the call site with a
 * clear error rather than producing a silent collision at the DB layer.
 *
 * @param {string} code
 * @returns {string} 64-char hex SHA256 digest
 */
function hashClaimCode(code) {
  if (typeof code !== 'string') {
    throw new TypeError(`hashClaimCode: code must be a string, got ${typeof code}`);
  }
  if (code.length === 0) {
    throw new TypeError('hashClaimCode: code must not be empty');
  }
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = { hashClaimCode };
