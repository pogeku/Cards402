// Unit tests for backend/src/mpp/credential.js — Authorization: Payment parser.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parsePaymentCredential } = require('../../src/mpp/credential');

const VALID_CHALLENGE = 'mpp_c_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const VALID_TX_HASH = 'ab'.repeat(32);

describe('parsePaymentCredential — happy path', () => {
  it('parses a well-formed header', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="${VALID_CHALLENGE}", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, true);
    assert.equal(r.credential.scheme, 'stellar');
    assert.equal(r.credential.challenge, VALID_CHALLENGE);
    assert.equal(r.credential.txHash, VALID_TX_HASH);
  });

  it('accepts unquoted values', () => {
    const r = parsePaymentCredential(
      `Payment scheme=stellar, challenge=${VALID_CHALLENGE}, tx_hash=${VALID_TX_HASH}`,
    );
    assert.equal(r.ok, true);
    assert.equal(r.credential.txHash, VALID_TX_HASH);
  });

  it('is case-insensitive on the scheme token', () => {
    const r = parsePaymentCredential(
      `PAYMENT scheme="stellar", challenge="${VALID_CHALLENGE}", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, true);
  });

  it('normalises scheme value to lowercase', () => {
    const r = parsePaymentCredential(
      `Payment scheme="STELLAR", challenge="${VALID_CHALLENGE}", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, true);
    assert.equal(r.credential.scheme, 'stellar');
  });

  it('tolerates extra whitespace around separators', () => {
    const r = parsePaymentCredential(
      `Payment   scheme="stellar" ,  challenge="${VALID_CHALLENGE}"  ,  tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, true);
  });

  it('ignores unknown extra params (forward-compat)', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="${VALID_CHALLENGE}", tx_hash="${VALID_TX_HASH}", future_extension="foo"`,
    );
    assert.equal(r.ok, true);
  });
});

describe('parsePaymentCredential — rejections', () => {
  it('rejects missing header', () => {
    assert.equal(parsePaymentCredential(undefined).reason, 'missing_header');
    assert.equal(parsePaymentCredential('').reason, 'missing_header');
  });

  it('rejects non-Payment schemes', () => {
    const r = parsePaymentCredential('Bearer abc123');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_payment_scheme');
  });

  it('rejects empty param list', () => {
    const r = parsePaymentCredential('Payment ');
    assert.equal(r.ok, false);
    // could be empty_params or not_payment_scheme depending on whitespace
  });

  it('rejects malformed key=value pairs', () => {
    const r = parsePaymentCredential('Payment scheme stellar');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_param');
  });

  it('rejects duplicate params', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="${VALID_CHALLENGE}", challenge="other", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /duplicate_param/);
  });

  it('rejects missing required params', () => {
    const missingScheme = parsePaymentCredential(
      `Payment challenge="${VALID_CHALLENGE}", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(missingScheme.reason, 'missing_scheme');

    const missingChallenge = parsePaymentCredential(
      `Payment scheme="stellar", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(missingChallenge.reason, 'missing_challenge');

    const missingTx = parsePaymentCredential(
      `Payment scheme="stellar", challenge="${VALID_CHALLENGE}"`,
    );
    assert.equal(missingTx.reason, 'missing_tx_hash');
  });

  it('rejects malformed challenge id', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="not_an_mpp_id", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_challenge_id');
  });

  it('rejects malformed tx hash (wrong length)', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="${VALID_CHALLENGE}", tx_hash="abc"`,
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_tx_hash');
  });

  it('rejects malformed tx hash (non-hex)', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="${VALID_CHALLENGE}", tx_hash="${'z'.repeat(64)}"`,
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_tx_hash');
  });

  it('rejects unsupported scheme', () => {
    const r = parsePaymentCredential(
      `Payment scheme="ethereum", challenge="${VALID_CHALLENGE}", tx_hash="${VALID_TX_HASH}"`,
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /unsupported_scheme/);
  });
});

describe('parsePaymentCredential — security', () => {
  it('does not allow control bytes in values', () => {
    const r = parsePaymentCredential(
      `Payment scheme="stellar", challenge="mpp_c_\x00evil", tx_hash="${VALID_TX_HASH}"`,
    );
    // Rejected at the challenge-id shape check since \x00 isn't in [A-Za-z0-9_-]
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed_challenge_id');
  });
});
