// @ts-check
// VCC client — dispatches fulfillment jobs to the VCC service (vcc.ctx.com).
// Auto-registers with VCC on first use — no manual secret sharing needed.

const crypto = require('crypto');
const db = require('./db');
const { event: bizEvent } = require('./lib/logger');

const VCC_API_BASE = process.env.VCC_API_BASE;

if (!process.env.VCC_TOKEN_KEY && process.env.NODE_ENV !== 'test') {
  console.warn('[vcc-client] WARNING: VCC_TOKEN_KEY not set — VCC API token stored in plaintext');
}

// Audit C-7: simple circuit breaker on the cards402 → vcc path. If vcc is
// unhealthy (3+ consecutive errors in the last 60s), trip the breaker for
// 30s so the watcher doesn't hammer a known-down vcc and stall every
// payment event. Restarts reset state; this is intentionally in-memory.
let _vccCircuit = { failures: 0, openedUntil: 0 };
const VCC_CIRCUIT_THRESHOLD = 3;
const VCC_CIRCUIT_COOLDOWN_MS = 30_000;

function vccCircuitGuard() {
  if (Date.now() < _vccCircuit.openedUntil) {
    throw new Error('vcc circuit open — backing off after recent failures');
  }
}
function recordVccFailure() {
  _vccCircuit.failures++;
  if (_vccCircuit.failures >= VCC_CIRCUIT_THRESHOLD) {
    _vccCircuit.openedUntil = Date.now() + VCC_CIRCUIT_COOLDOWN_MS;
    _vccCircuit.failures = 0;
    bizEvent('vcc.circuit_opened', { reopen_at: new Date(_vccCircuit.openedUntil).toISOString() });
  }
}
function recordVccSuccess() {
  _vccCircuit = { failures: 0, openedUntil: 0 };
}

// ── Token encryption (B-7) ────────────────────────────────────────────────────
// VCC token is encrypted at rest with AES-256-GCM using VCC_TOKEN_KEY (32-byte hex env var).
// Stored format: "enc:iv_hex:tag_hex:ciphertext_hex"
// Falls back to treating stored value as plaintext for backwards-compatibility on first upgrade.

function getEncryptionKey() {
  const hex = process.env.VCC_TOKEN_KEY;
  if (!hex || hex.length !== 64) return null; // key not configured — store plaintext
  return Buffer.from(hex, 'hex');
}

function encryptToken(plaintext) {
  const key = getEncryptionKey();
  if (!key) return plaintext; // no key configured — store as-is
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decryptToken(stored) {
  if (!stored.startsWith('enc:')) return stored; // plaintext (pre-encryption or no key)
  const key = getEncryptionKey();
  if (!key) return stored; // can't decrypt without key — let caller handle the error
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('stored token has invalid enc: format');
  const [, ivHex, tagHex, ctHex] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'), {
      authTagLength: 16,
    });
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex')) + decipher.final('utf8');
  } catch (err) {
    // Wrap the raw crypto message so it doesn't leak tag/iv internals into
    // the order error column. The ops signal stays intact via bizEvent at
    // the call site (getVccToken) which handles the re-registration fallback.
    throw new Error(`vcc_token_decrypt_failed: ${err.code || err.name || 'crypto'}`);
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

// Returns the stored VCC token, registering with VCC if not yet done.
//
// F3 fix: if the stored token fails to decrypt (wrong key after rotation,
// corrupted ciphertext, truncated enc: envelope), drop the row and fall
// through to auto-registration. Without this the instance wedges forever
// with raw crypto error strings surfacing through every order's error
// column on the next getInvoice attempt.
async function getVccToken() {
  const stored = /** @type {{ value: string } | undefined} */ (
    db.prepare(`SELECT value FROM system_state WHERE key = 'vcc_token'`).get()
  )?.value;
  if (stored) {
    try {
      return decryptToken(stored);
    } catch (err) {
      bizEvent('vcc.token_decrypt_failed', { error: err.message });
      db.prepare(`DELETE FROM system_state WHERE key = 'vcc_token'`).run();
      // fall through to re-register
    }
  }

  // F4 fix: registration shares the circuit breaker with invoice/paid/status.
  // If vcc is down, repeated first-call registration attempts would otherwise
  // bypass the breaker and hammer the endpoint on every order event.
  vccCircuitGuard();

  // First time — auto-register
  const label = process.env.VCC_INSTANCE_LABEL || `cards402-${process.env.NODE_ENV || 'prod'}`;
  let res;
  try {
    res = await fetch(`${VCC_API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // Network-level failure (timeout, DNS, ECONNREFUSED). Count it against
    // the breaker so a black-holed vcc doesn't soak up the watcher budget.
    recordVccFailure();
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status >= 500) recordVccFailure();
    throw new Error(`VCC registration failed: HTTP ${res.status} ${text}`.trim());
  }

  const body = await res.json();
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new Error('VCC registration response missing token field');
  }
  db.prepare(`INSERT OR REPLACE INTO system_state (key, value) VALUES ('vcc_token', ?)`).run(
    encryptToken(body.token),
  );
  bizEvent('vcc.registered', { label });
  return body.token;
}

// ── Invoice + payment notification ───────────────────────────────────────────

// Asks VCC to create a CTX gift card order. Returns { vccJobId, paymentUrl }
// where paymentUrl is a web+stellar:pay URI that cards402 must pay directly.
//
// Audit C-1: the caller's `requestId` (from the original POST /v1/orders)
// flows to vcc as `X-Request-ID` so every log line and callback can be
// joined back to the same trace. It's optional — background jobs without a
// request ID pass null and vcc will synthesize its own.
async function getInvoice(orderId, amountUsdc, requestId = null, callbackNonce = null) {
  vccCircuitGuard();
  const token = await getVccToken();

  const callbackBase =
    process.env.CARDS402_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  const callbackUrl = `${callbackBase}/vcc-callback`;

  // Audit F2: per-order callback secret. The historical model used a single
  // shared VCC_CALLBACK_SECRET for every job, which meant one leak forged
  // callbacks for every past and future order. We now mint a fresh 32-byte
  // random secret per order, seal it via secret-box (so a DB dump alone
  // doesn't grant forge ability), and ship it to vcc as the per-job
  // callback_secret. The vcc-callback handler reads this column for the
  // matching order before verifying signatures.
  //
  // If a row already has a sealed callback_secret (idempotent retry of
  // getInvoice for the same order), reuse it so vcc doesn't see a fresh
  // secret on the second invoice request.
  const { seal, open } = require('./lib/secret-box');
  /** @type {any} */
  const existingRow = db.prepare(`SELECT callback_secret FROM orders WHERE id = ?`).get(orderId);
  let callbackSecret;
  if (existingRow?.callback_secret) {
    try {
      callbackSecret = open(existingRow.callback_secret);
    } catch (err) {
      console.warn(
        `[vcc-client] failed to open existing callback_secret for ${orderId}: ${err.message}`,
      );
      callbackSecret = crypto.randomBytes(32).toString('hex');
      db.prepare(`UPDATE orders SET callback_secret = ? WHERE id = ?`).run(
        seal(callbackSecret),
        orderId,
      );
    }
  } else {
    callbackSecret = crypto.randomBytes(32).toString('hex');
    db.prepare(`UPDATE orders SET callback_secret = ? WHERE id = ?`).run(
      seal(callbackSecret),
      orderId,
    );
  }

  // Audit C-3: per-job nonce. Generated by cards402 at invoice time, stored
  // on the order, and sent to vcc. vcc includes it in the HMAC payload so a
  // leaked shared secret alone can't forge a callback for any specific order.
  const nonce = callbackNonce || crypto.randomUUID();

  const headers = {
    'Content-Type': 'application/json',
    'X-VCC-Token': token,
  };
  if (requestId) headers['X-Request-ID'] = requestId;

  const res = await fetch(`${VCC_API_BASE}/api/jobs/invoice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      order_id: orderId,
      amount_usdc: amountUsdc,
      callback_url: callbackUrl,
      callback_secret: callbackSecret,
      callback_nonce: nonce,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      bizEvent('vcc.token_rotated', {
        reason: 'invoice_401',
        order_id: orderId,
        response_snippet: text.slice(0, 120),
      });
      db.prepare(`DELETE FROM system_state WHERE key = 'vcc_token'`).run();
    }
    if (res.status >= 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      recordVccFailure();
    }
    throw new Error(`VCC invoice failed: HTTP ${res.status} ${text}`.trim());
  }

  recordVccSuccess();
  const body = await res.json();

  // F1 + F2: validate the invoice response shape before we trust the fields.
  // job_id ends up in orders.vcc_job_id (used to poll/reconcile), and
  // payment_url is the Stellar URI that cards402 pays next — a malformed
  // or hostile value here would silently redirect funds or corrupt the
  // order row. VCC is trusted in the normal flow, but a compromised/broken
  // VCC deployment or a MITM with token is exactly the failure mode this
  // defence is for. Reject any response that doesn't match the shape we
  // expect, and require payment_url to be a stellar: / web+stellar: URI
  // so an attacker can't swap the scheme to something the wallet layer
  // would redirect to a different destination.
  if (!body || typeof body !== 'object') {
    throw new Error('VCC invoice response was not a JSON object');
  }
  if (typeof body.job_id !== 'string' || body.job_id.length === 0) {
    throw new Error('VCC invoice response missing job_id');
  }
  if (typeof body.payment_url !== 'string' || body.payment_url.length === 0) {
    throw new Error('VCC invoice response missing payment_url');
  }
  if (!/^(web\+)?stellar:/i.test(body.payment_url)) {
    // Don't echo the raw URL into the exception — an attacker-controlled
    // string shouldn't end up verbatim in orders.error.
    throw new Error('VCC invoice response has invalid payment_url scheme');
  }

  bizEvent('vcc.invoice', { order_id: orderId, amount_usdc: amountUsdc, vcc_job_id: body.job_id });

  return { vccJobId: body.job_id, paymentUrl: body.payment_url, callbackNonce: nonce };
}

// Tells VCC that cards402 has paid CTX. VCC transitions the job to queued and
// begins scraping for the card details.
async function notifyPaid(vccJobId) {
  // F4: share the breaker with getInvoice. A dead VCC must not drain the
  // watcher budget via notifyPaid retries while the breaker is keeping
  // getInvoice calls cheap.
  vccCircuitGuard();
  const token = await getVccToken();

  const res = await fetch(`${VCC_API_BASE}/api/jobs/${vccJobId}/paid`, {
    method: 'POST',
    headers: { 'X-VCC-Token': token },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      bizEvent('vcc.token_rotated', {
        reason: 'notify_paid_401',
        vcc_job_id: vccJobId,
        response_snippet: text.slice(0, 120),
      });
      db.prepare(`DELETE FROM system_state WHERE key = 'vcc_token'`).run();
    }
    if (res.status >= 500) recordVccFailure();
    throw new Error(`VCC notifyPaid failed: HTTP ${res.status} ${text}`.trim());
  }
  recordVccSuccess();
}

// ── Job status polling ────────────────────────────────────────────────────────

// Polls VCC for current job status — used as a fallback when the callback fails to deliver.
async function getVccJobStatus(vccJobId) {
  // F4: status polling is called from the recovery job on a timer. Without
  // the breaker a dead VCC would burn every polling tick on failed fetches.
  vccCircuitGuard();
  const token = await getVccToken();

  const res = await fetch(`${VCC_API_BASE}/api/jobs/${vccJobId}`, {
    headers: { 'X-VCC-Token': token },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      bizEvent('vcc.token_rotated', {
        reason: 'job_status_401',
        vcc_job_id: vccJobId,
        response_snippet: text.slice(0, 120),
      });
      db.prepare(`DELETE FROM system_state WHERE key = 'vcc_token'`).run();
    }
    if (res.status >= 500) recordVccFailure();
    throw new Error(`VCC job status failed: HTTP ${res.status} ${text}`.trim());
  }

  recordVccSuccess();
  return res.json();
}

// ── Callback verification ─────────────────────────────────────────────────────

// Verify an incoming VCC callback HMAC signature. VCC signs with the
// shared callback_secret. See lib/hmac.js for the wire format.
//
// Returns a rich result object so callers can log/metric the rejection
// reason instead of the old boolean-blind failure.
const { verifyCallback } = require('./lib/hmac');

function verifyVccSignature(rawBody, signature, timestamp, orderId, nonce, secret = null) {
  // Audit F2: callers (vcc-callback handler) look up the per-order
  // callback_secret first and pass it in here. Falls back to the global
  // VCC_CALLBACK_SECRET only when the per-order secret is unavailable
  // (legacy orders pre-F2, or first-receipt race where the order row
  // hasn't been flushed yet).
  return verifyCallback({
    secret: secret || process.env.VCC_CALLBACK_SECRET,
    signatureHeader: signature,
    timestamp,
    orderId,
    nonce: nonce || undefined,
    rawBody,
  });
}

module.exports = { getInvoice, notifyPaid, getVccJobStatus, verifyVccSignature };
