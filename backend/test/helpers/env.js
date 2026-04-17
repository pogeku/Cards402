// Must be required FIRST in every test file, before any app code.
// Sets the minimum env vars needed to pass Zod validation at module load.

const crypto = require('crypto');

// Fresh temp DB per test run (avoids cross-test bleed when running in parallel)
process.env.DB_PATH = `:memory:`;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // random port

// Stellar — fake but shape-valid strkeys. Each must be a 56-char
// base32 strkey starting with the type prefix (G / S / C). The env
// schema's F1-env hardening (adversarial audit 2026-04-16) enforces
// the full shape, so the historical 55-char XLM fake and the 58-char
// contract fake containing '0' (not in the base32 alphabet) no longer
// pass boot validation. These are NOT valid checksums — just shape-
// valid — and nothing in the test suite decodes them via the Stellar
// SDK at load time (every sender call site mocks xlm-sender via
// patchCache).
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_XLM_SECRET = 'S' + 'A'.repeat(55);
process.env.STELLAR_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.RECEIVER_CONTRACT_ID = 'C' + 'A'.repeat(55);

// VCC fulfillment service
process.env.VCC_API_BASE = 'https://vcc.ctx.com';
process.env.CARDS402_BASE_URL = 'https://api.cards402.test';
process.env.VCC_CALLBACK_SECRET = 'test-vcc-callback-secret-32chars!!';

// SMTP — fake values; email is not called in tests (createTestSession bypasses it)
process.env.SMTP_HOST = 'localhost';
process.env.SMTP_PORT = '25';
process.env.SMTP_USER = 'test';
process.env.SMTP_PASS = 'test';
process.env.SMTP_FROM = 'noreply@cards402.test';

// Zero out retry delays so failure-path tests don't take 10s+ each
process.env.RETRY_BACKOFF_MS = '0';

// Audit F1-auth (2026-04-15): the pre-auth failure rate limiter has a
// production default of 60 failures per 15 minutes per IP. The test
// suite makes hundreds of intentionally-failing auth requests across
// auth-middleware.test.js, orders.test.js, platform.test.js, etc. —
// all from 127.0.0.1 — so the prod default would trip mid-suite and
// cause downstream tests to see 429 instead of the expected 401/403.
// Raise the cap to 10_000 in test env so only the dedicated regression
// test for the limiter (which lowers it explicitly via its own
// helpers) exercises the cap.
process.env.AUTH_FAILURE_LIMIT_PER_WINDOW = '10000';

// Machine Payments Protocol — feature-flagged in production. Tests
// always exercise the flag-on path so the routes are mounted and
// reachable. A separate tiny unit test verifies the flag-off behavior.
process.env.MPP_ENABLED = 'true';
// Generous challenge rate limit in tests — the limiter has its own
// dedicated regression test that lowers it explicitly.
process.env.MPP_CHALLENGE_RATE_LIMIT = '10000';
