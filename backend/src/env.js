// @ts-check
// Environment variable validation
// Validates all required env vars at startup — fails fast with clear error messages.

const { z } = require('zod');

const EnvSchema = z.object({
  // Server
  PORT: z.string().default('4000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DB_PATH: z.string().default('./cards402.db'),

  // Stellar — treasury wallet used for USDC/XLM refunds to agents
  STELLAR_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
  STELLAR_USDC_ISSUER: z.string().startsWith('G').default('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
  STELLAR_XLM_SECRET: z.string().startsWith('S', 'Must be a valid Stellar secret key'),

  // Soroban receiver contract — agents pay this; the watcher detects events and triggers VCC
  RECEIVER_CONTRACT_ID: z.string().startsWith('C'),
  SOROBAN_RPC_URL: z.string().url().optional(),

  // VCC fulfillment service (vcc.ctx.com) — handles CTX ordering + card scraping
  VCC_API_BASE: z.string().url(),
  // Public URL of this cards402 instance — VCC uses it to construct the callback URL
  CARDS402_BASE_URL: z.string().url(),
  // Shared secret used to sign/verify HMAC callbacks from VCC. 32+ chars
  // recommended for HMAC-SHA256 — 16 was the historical floor but gives only
  // ~80 bits of strength. Audit finding C-13.
  VCC_CALLBACK_SECRET: z.string().min(32, 'VCC_CALLBACK_SECRET must be at least 32 characters'),

  // CORS — comma-separated list of allowed origins for the agent API
  CORS_ORIGINS: z.string().optional(),

  // Bootstrap owner — if set, only this email can become the first owner account.
  OWNER_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),

  // Internal dashboard access — comma-separated emails allowed to access /internal/* routes.
  // Emails ending in @cards402.com are always allowed regardless of this setting.
  INTERNAL_EMAILS: z.string().optional(),

  // SMTP — email delivery for login OTPs, approval requests, spend alerts.
  // Optional (the transporter is lazily initialised and tests don't touch real SMTP)
  // but if one SMTP_* is set, all four connection vars and SMTP_FROM must be set
  // together. Audit finding A-2.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().regex(/^\d+$/, 'SMTP_PORT must be numeric').optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email('SMTP_FROM must be a valid email address').optional(),

  // Recovery-job knobs — exposed for ops tuning without a code change. Audit
  // finding A-21. Values are milliseconds; keep them in sync with the defaults
  // in jobs.js so the schema is the single source of truth.
  STUCK_RETRY_AFTER_MS: z.string().regex(/^\d+$/).optional(),
  STUCK_FAIL_AFTER_MS: z.string().regex(/^\d+$/).optional(),
  MAX_FULFILLMENT_ATTEMPTS: z.string().regex(/^\d+$/).optional(),

  // Admin UI session key — 32 bytes (64 hex) of entropy. Required if the
  // admin/ Next.js app is being served alongside the backend. Audit finding
  // A-6 is about documenting the generation script; this just forces the
  // value to be present and well-shaped when set.
  ADMIN_SESSION_KEY: z.string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ADMIN_SESSION_KEY must be 64 hex characters (32 bytes)')
    .optional(),
})
.superRefine((val, ctx) => {
  // SMTP is all-or-nothing. If any SMTP_* var is set, they all must be set
  // (except SMTP_PORT which has a sensible default in email.js).
  const smtpKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const set = smtpKeys.filter(k => val[k]);
  if (set.length > 0 && set.length < smtpKeys.length) {
    const missing = smtpKeys.filter(k => !val[k]);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `SMTP is partially configured: missing ${missing.join(', ')}. Set all of SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM together or none of them.`,
      path: ['SMTP_HOST'],
    });
  }
});

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  const missing = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`[env] Invalid environment variables:\n${missing}`);
  process.exit(1);
}

module.exports = { env: result.data };
