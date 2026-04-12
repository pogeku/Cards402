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
  const [, ivHex, tagHex, ctHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex')) + decipher.final('utf8');
}

// ── Registration ──────────────────────────────────────────────────────────────

// Returns the stored VCC token, registering with VCC if not yet done.
async function getVccToken() {
  const stored = /** @type {{ value: string } | undefined} */ (db.prepare(`SELECT value FROM system_state WHERE key = 'vcc_token'`).get())?.value;
  if (stored) return decryptToken(stored);

  // First time — auto-register
  const label = process.env.VCC_INSTANCE_LABEL || `cards402-${process.env.NODE_ENV || 'prod'}`;
  const res = await fetch(`${VCC_API_BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`VCC registration failed: HTTP ${res.status} ${text}`.trim());
  }

  const { token } = await res.json();
  db.prepare(`INSERT OR REPLACE INTO system_state (key, value) VALUES ('vcc_token', ?)`).run(encryptToken(token));
  bizEvent('vcc.registered', { label });
  return token;
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

  const callbackBase = process.env.CARDS402_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  const callbackUrl = `${callbackBase}/vcc-callback`;
  const callbackSecret = process.env.VCC_CALLBACK_SECRET;

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
  bizEvent('vcc.invoice', { order_id: orderId, amount_usdc: amountUsdc, vcc_job_id: body.job_id });

  return { vccJobId: body.job_id, paymentUrl: body.payment_url, callbackNonce: nonce };
}

// Tells VCC that cards402 has paid CTX. VCC transitions the job to queued and
// begins scraping for the card details.
async function notifyPaid(vccJobId) {
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
    throw new Error(`VCC notifyPaid failed: HTTP ${res.status} ${text}`.trim());
  }
}

// ── Job status polling ────────────────────────────────────────────────────────

// Polls VCC for current job status — used as a fallback when the callback fails to deliver.
async function getVccJobStatus(vccJobId) {
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
    throw new Error(`VCC job status failed: HTTP ${res.status} ${text}`.trim());
  }

  return res.json();
}

// ── Callback verification ─────────────────────────────────────────────────────

// Verify an incoming VCC callback HMAC signature. VCC signs with the
// shared callback_secret. See lib/hmac.js for the wire format.
//
// Returns a rich result object so callers can log/metric the rejection
// reason instead of the old boolean-blind failure.
const { verifyCallback } = require('./lib/hmac');

function verifyVccSignature(rawBody, signature, timestamp, orderId, nonce) {
  return verifyCallback({
    secret: process.env.VCC_CALLBACK_SECRET,
    signatureHeader: signature,
    timestamp,
    orderId,
    nonce: nonce || undefined,
    rawBody,
  });
}

module.exports = { getInvoice, notifyPaid, getVccJobStatus, verifyVccSignature };
