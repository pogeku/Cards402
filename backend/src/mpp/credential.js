// @ts-check
// Parse the Authorization: Payment credential per the MPP spec.
//
// The credential is an RFC 7235-style auth header:
//   Authorization: Payment scheme="stellar", challenge="mpp_c_...", tx_hash="abc..."
//
// Parameters are comma-separated key=value pairs. Values may be quoted
// or bare. Whitespace around separators is tolerated. Unknown extra
// params are ignored (forward-compat for future MPP extensions).

/**
 * @typedef {object} ParsedCredential
 * @property {string} scheme - Payment method scheme (e.g. 'stellar')
 * @property {string} challenge - Challenge id the credential is paying against
 * @property {string} txHash - On-chain tx hash proving the payment
 */

/**
 * Parse an Authorization: Payment header value.
 * @param {string|undefined} header
 * @returns {{ok: true, credential: ParsedCredential} | {ok: false, reason: string}}
 */
function parsePaymentCredential(header) {
  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, reason: 'missing_header' };
  }
  // Scheme comparison is case-insensitive per HTTP spec (§4.2 of RFC 7235).
  // Strip leading 'Payment' token then parse params.
  const match = header.match(/^Payment\s+(.+)$/i);
  if (!match) return { ok: false, reason: 'not_payment_scheme' };
  const paramString = match[1].trim();
  if (paramString.length === 0) return { ok: false, reason: 'empty_params' };

  const params = /** @type {Record<string,string>} */ ({});
  // Split on commas that aren't inside quotes. Since quoted values can
  // technically contain commas (RFC 7235 quoted-string), we tokenise
  // char-by-char rather than naïvely splitting.
  for (const token of splitAuthParams(paramString)) {
    const eq = token.indexOf('=');
    if (eq < 0) return { ok: false, reason: 'malformed_param' };
    const key = token.slice(0, eq).trim().toLowerCase();
    let value = token.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (!key) return { ok: false, reason: 'empty_key' };
    // Reject duplicate params — ambiguous, and an attacker could smuggle
    // a second challenge= to override the first after partial parsing.
    if (key in params) return { ok: false, reason: `duplicate_param:${key}` };
    params[key] = value;
  }

  const scheme = params['scheme'];
  const challenge = params['challenge'];
  const txHash = params['tx_hash'];

  if (!scheme) return { ok: false, reason: 'missing_scheme' };
  if (!challenge) return { ok: false, reason: 'missing_challenge' };
  if (!txHash) return { ok: false, reason: 'missing_tx_hash' };

  // Sanity-check challenge id shape — we only emit mpp_c_... ids.
  if (!/^mpp_c_[A-Za-z0-9_-]+$/.test(challenge)) {
    return { ok: false, reason: 'malformed_challenge_id' };
  }
  // Stellar tx hashes are 64 hex chars. Reject anything else — a
  // wrongly-sized value can't identify a tx and might smuggle control
  // bytes into logs / RPC requests.
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, reason: 'malformed_tx_hash' };
  }
  if (scheme.toLowerCase() !== 'stellar') {
    return { ok: false, reason: `unsupported_scheme:${scheme}` };
  }

  return { ok: true, credential: { scheme: scheme.toLowerCase(), challenge, txHash } };
}

/**
 * Split an RFC 7235 auth parameter string on commas, respecting quoted
 * values. Returns an array of raw key=value tokens.
 * @param {string} s
 */
function splitAuthParams(s) {
  const out = [];
  let buf = '';
  let inQuote = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      buf += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      buf += ch;
      inQuote = !inQuote;
      continue;
    }
    if (ch === ',' && !inQuote) {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

module.exports = { parsePaymentCredential };
