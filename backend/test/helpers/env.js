// Must be required FIRST in every test file, before any app code.
// Sets the minimum env vars needed to pass Zod validation at module load.

const crypto = require('crypto');

// Fresh temp DB per test run (avoids cross-test bleed when running in parallel)
process.env.DB_PATH = `:memory:`;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // random port

// Stellar — fake but structurally valid keys
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_XLM_SECRET = 'SCZANGBA5RLKPMDUHXOL2BO76RDCGCR7ZA7OMO6TUZBIRGQCQX2LZME';
process.env.STELLAR_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// Soroban receiver contract (fake but valid C... prefix)
process.env.RECEIVER_CONTRACT_ID = 'CCWTEST000000000000000000000000000000000000000000000000003';

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
