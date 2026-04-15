// Unit tests for the request-id middleware in src/app.js.
//
// F1-app (2026-04-16): client-supplied X-Request-ID is now validated
// against a narrow charset before being accepted. Invalid or missing
// values fall back to a server-generated UUID. This file pins the
// validation helper and the end-to-end behaviour through supertest.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../../src/app');
const { request } = require('../helpers/app');
const { _validateRequestId, _resetReqIdWarnState, _REQ_ID_SHAPE } = app;

// ── Pure-function validation ───────────────────────────────────────────────

describe('F1-app: validateRequestId helper', () => {
  it('accepts a standard UUID', () => {
    assert.equal(
      _validateRequestId('1f7cba2e-4ba8-4f7e-a1fb-5b9d63a3c5d1'),
      '1f7cba2e-4ba8-4f7e-a1fb-5b9d63a3c5d1',
    );
  });

  it('accepts a 32-char hex OpenTelemetry trace id', () => {
    const traceId = 'a'.repeat(32);
    assert.equal(_validateRequestId(traceId), traceId);
  });

  it('accepts alphanumeric + dash + underscore + dot + colon', () => {
    assert.equal(_validateRequestId('req-abc_123.xyz:42'), 'req-abc_123.xyz:42');
  });

  it('accepts exactly 64 chars (length boundary)', () => {
    const id = 'a'.repeat(64);
    assert.equal(_validateRequestId(id), id);
  });

  it('rejects 65 chars (over length boundary)', () => {
    assert.equal(_validateRequestId('a'.repeat(65)), null);
  });

  it('rejects empty string', () => {
    assert.equal(_validateRequestId(''), null);
  });

  it('rejects undefined and null', () => {
    assert.equal(_validateRequestId(undefined), null);
    assert.equal(_validateRequestId(null), null);
  });

  it('rejects a non-string value', () => {
    assert.equal(_validateRequestId(42), null);
    assert.equal(_validateRequestId({ id: 'foo' }), null);
  });

  it('rejects CR/LF injection attempts', () => {
    assert.equal(_validateRequestId('foo\r\nBcc: attacker'), null);
    assert.equal(_validateRequestId('foo\nbar'), null);
    assert.equal(_validateRequestId('foo\rbar'), null);
  });

  it('rejects NUL bytes', () => {
    assert.equal(_validateRequestId('foo\x00bar'), null);
  });

  it('rejects spaces', () => {
    // Spaces aren't in the allowed charset — prevents
    // "req abc" style inputs from producing lookalike ids.
    assert.equal(_validateRequestId('foo bar'), null);
  });

  it('rejects slash and other path characters', () => {
    assert.equal(_validateRequestId('../../../etc/passwd'), null);
    assert.equal(_validateRequestId('foo/bar'), null);
    assert.equal(_validateRequestId('foo\\bar'), null);
    assert.equal(_validateRequestId('foo?bar'), null);
    assert.equal(_validateRequestId('foo#bar'), null);
  });

  it('rejects lowercase unicode (not ASCII alnum)', () => {
    assert.equal(_validateRequestId('fóo'), null);
    assert.equal(_validateRequestId('éclair'), null);
  });

  it('takes the first element of an array-valued header (defensive)', () => {
    // Node normally joins duplicate headers with ', ' for most header
    // names, but the helper defensively handles string[] too.
    assert.equal(_validateRequestId(['req-first', 'req-second']), 'req-first');
  });

  it('rejects an array where the first element is invalid', () => {
    assert.equal(_validateRequestId(['foo\r\nbad', 'req-second']), null);
  });
});

// ── Shape regex sanity check ────────────────────────────────────────────────

describe('F1-app: REQ_ID_SHAPE regex', () => {
  it('is anchored at both ends', () => {
    // Defensive check: the regex must reject partial matches.
    assert.equal(_REQ_ID_SHAPE.test('valid123\r\nsmuggled'), false);
  });

  it('rejects a zero-length match', () => {
    assert.equal(_REQ_ID_SHAPE.test(''), false);
  });
});

// ── End-to-end through supertest ───────────────────────────────────────────

describe('F1-app: X-Request-ID end-to-end', () => {
  beforeEach(() => {
    _resetReqIdWarnState();
  });

  it('echoes a valid client-supplied X-Request-ID on the response', async () => {
    const res = await request.get('/api/version').set('X-Request-ID', 'client-supplied-abc');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-request-id'], 'client-supplied-abc');
  });

  it('generates a UUID when no X-Request-ID header is sent', async () => {
    const res = await request.get('/api/version');
    assert.equal(res.status, 200);
    assert.match(
      res.headers['x-request-id'],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('replaces an invalid X-Request-ID with a server-generated UUID', async () => {
    // Spaces are disallowed.
    const res = await request.get('/api/version').set('X-Request-ID', 'has a space');
    assert.equal(res.status, 200);
    // The response header must be a freshly-generated UUID, not the
    // bad input and not a truncated version.
    assert.match(
      res.headers['x-request-id'],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.doesNotMatch(res.headers['x-request-id'], /space/);
  });

  it('does NOT 500 on an X-Request-ID containing CR/LF (pre-fix self-DoS)', async () => {
    // Pre-fix: this would reach res.setHeader() with the raw value,
    // Node's HTTP layer would throw ERR_INVALID_CHAR, and the
    // middleware would crash with a 500. Post-fix: validation
    // replaces it with a clean UUID before setHeader is called.
    //
    // supertest / superagent will reject us setting an obviously-bad
    // header at the CLIENT side, so simulate by sending a shape that
    // would have passed naive length-slicing but fails our shape check.
    // We can't easily inject a raw CR/LF via supertest, but we can
    // directly call the middleware via the exported helper.
    const injected = 'foo\r\nbad';
    assert.equal(_validateRequestId(injected), null);
    // Unit test above already covers the CR/LF case; this e2e test
    // just pins that a long garbage string doesn't crash.
    const res = await request.get('/api/version').set('X-Request-ID', 'a'.repeat(200));
    assert.equal(res.status, 200);
    assert.match(
      res.headers['x-request-id'],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('accepts an OpenTelemetry-style trace id', async () => {
    const traceId = 'a'.repeat(32);
    const res = await request.get('/api/version').set('X-Request-ID', traceId);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-request-id'], traceId);
  });
});
