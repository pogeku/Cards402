// @ts-check
// Environment variable validation
// Validates all required env vars at startup — fails fast with clear error messages.
//
// Adversarial audit 2026-04-16:
//
//   F1-env: Stellar strkey format validation. Pre-fix, STELLAR_USDC_ISSUER,
//     STELLAR_XLM_SECRET, and RECEIVER_CONTRACT_ID were validated only by
//     first character (`startsWith('G'/'S'/'C')`). A typo like
//     `STELLAR_XLM_SECRET=S` or `RECEIVER_CONTRACT_ID=Cwrong` passed boot
//     validation and blew up at first use with a cryptic libsodium /
//     Stellar SDK decode error. Real strkeys are exactly 56 characters
//     of base32 (RFC 4648, no padding) — the Stellar StrKey spec. Now
//     enforced via a shared regex.
//
//   F2-env: INTERNAL_EMAILS per-entry validation. The comma-separated
//     list was stored as an opaque string and only parsed at request
//     time in middleware/requireInternal. A typo like `ops@cards402com`
//     (missing dot) in the list would silently exclude that operator
//     from /internal/* routes with no boot-time signal — the operator
//     would get a 403 the first time they tried to use internal tools
//     and have no hint why. Now each entry is trimmed, normalised to
//     lowercase, and validated as an email shape at boot.
//
//   F3-env: CORS_ORIGINS per-entry validation. Same class as F2 — a
//     typo in the comma-separated origin list would silently block
//     legitimate dashboard browser traffic with no signal. Each entry
//     is now parsed as a URL origin at boot.
//
//   F4-env: URL scheme constraint. The `.url()` zod refinement accepts
//     ANY valid URL — ftp://, file://, javascript:, chrome-extension://.
//     CARDS402_BASE_URL, VCC_API_BASE, and SOROBAN_RPC_URL must be
//     http(s); anything else is a deploy mistake that would otherwise
//     surface as a cryptic fetch error at runtime.

const { z } = require('zod');

// F1-env: Stellar StrKey format. Per https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0023.md
// all strkeys (public key G..., secret key S..., contract C..., muxed M...)
// are 56 base32 characters. The first character identifies the type; the
// remaining 55 encode a 2-byte version + 32-byte payload + 2-byte checksum.
// This regex doesn't verify the checksum (that requires a full decode),
// but it catches 99% of real-world typos at boot.
const STELLAR_STRKEY_BASE = /^[A-Z2-7]{55}$/;
function stellarStrkey(prefix, fieldName) {
  return z
    .string()
    .refine(
      (v) =>
        typeof v === 'string' &&
        v.length === 56 &&
        v[0] === prefix &&
        STELLAR_STRKEY_BASE.test(v.slice(1)),
      {
        message: `${fieldName} must be a valid Stellar StrKey (56 chars, starts with '${prefix}', base32 body)`,
      },
    );
}

// F4-env: URL with http(s) scheme only. Rejects ftp://, file://,
// javascript:, chrome-extension://, etc. at boot.
function httpUrl(fieldName) {
  return z
    .string()
    .url(`${fieldName} must be a valid URL`)
    .refine((v) => /^https?:\/\//i.test(v), {
      message: `${fieldName} must use http:// or https:// scheme`,
    });
}

// F2-env: validator for a comma-separated email list. Trims each entry,
// normalises to lowercase, drops empties, and validates each remaining
// entry against a minimal email regex. The boot fails on ANY invalid
// entry so the typo is surfaced before it silently denies access.
function commaSeparatedEmails(fieldName) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      return v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    })
    .refine(
      (list) => {
        if (!list) return true;
        // Minimal RFC-5322-ish shape check; zod's .email() is stricter
        // but requires a ZodString, and we've already transformed to
        // an array. Duplicate the base check here.
        return list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      },
      { message: `${fieldName} contains an invalid email (check for typos)` },
    );
}

// F3-env: validator for a comma-separated URL origin list. Each entry
// must parse as a URL and produce a non-null origin.
function commaSeparatedOrigins(fieldName) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    })
    .refine(
      (list) => {
        if (!list) return true;
        return list.every((o) => {
          try {
            const u = new URL(o);
            return u.origin !== 'null' && /^https?:$/i.test(u.protocol);
          } catch {
            return false;
          }
        });
      },
      {
        message: `${fieldName} contains an invalid origin (must be http(s) URLs, comma-separated)`,
      },
    );
}

const EnvSchema = z
  .object({
    // Server. PORT validated as numeric so a typo ("abc") fails at
    // boot instead of silently picking a random port via parseInt(NaN).
    PORT: z
      .string()
      .regex(/^\d+$/, 'PORT must be a positive integer (e.g. "4000")')
      .default('4000'),
    // NODE_ENV is REQUIRED — no default. A missing NODE_ENV in
    // production silently runs in dev mode, which skips the
    // CARDS402_SECRET_BOX_KEY refinement below and lets the claim
    // endpoint persist raw api keys as plaintext. Forcing an
    // explicit value at boot makes that footgun impossible.
    // Tests and dev workflows already set NODE_ENV explicitly
    // (backend/test/helpers/env.js sets 'test'; dotenv + local
    // .env files set 'development').
    NODE_ENV: z.enum(['development', 'production', 'test'], {
      errorMap: () => ({
        message:
          'NODE_ENV must be explicitly set to one of: development | production | test. ' +
          'A production deploy with no NODE_ENV silently downgrades security — refusing to start.',
      }),
    }),

    // Database
    DB_PATH: z.string().default('./cards402.db'),

    // Stellar — treasury wallet used for USDC/XLM refunds to agents.
    // F1-env: full Stellar StrKey format validated (56 base32 chars,
    // not just first-char check). A typo like 'S' or 'Gbadkey' fails
    // at boot instead of at first xlm-sender call.
    STELLAR_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
    STELLAR_USDC_ISSUER: stellarStrkey('G', 'STELLAR_USDC_ISSUER').default(
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    ),
    STELLAR_XLM_SECRET: stellarStrkey('S', 'STELLAR_XLM_SECRET'),

    // Soroban receiver contract — agents pay this; the watcher detects events and triggers VCC
    RECEIVER_CONTRACT_ID: stellarStrkey('C', 'RECEIVER_CONTRACT_ID'),
    SOROBAN_RPC_URL: httpUrl('SOROBAN_RPC_URL').optional(),

    // VCC fulfillment service (vcc.ctx.com) — handles CTX ordering + card scraping
    // F4-env: http(s)-only, rejects ftp:// / file:// / javascript: etc.
    VCC_API_BASE: httpUrl('VCC_API_BASE'),
    // Public URL of this cards402 instance — VCC uses it to construct the callback URL
    CARDS402_BASE_URL: httpUrl('CARDS402_BASE_URL'),
    // Shared secret used to sign/verify HMAC callbacks from VCC. 32+ chars
    // recommended for HMAC-SHA256 — 16 was the historical floor but gives only
    // ~80 bits of strength. Audit finding C-13.
    VCC_CALLBACK_SECRET: z.string().min(32, 'VCC_CALLBACK_SECRET must be at least 32 characters'),

    // CORS — comma-separated list of allowed origins for the agent API.
    // F3-env: each entry is parsed as an http(s) URL origin at boot so
    // a typo doesn't silently block legitimate browser traffic.
    CORS_ORIGINS: commaSeparatedOrigins('CORS_ORIGINS'),

    // Bootstrap owner — if set, only this email can become the first owner account.
    OWNER_EMAIL: z
      .string()
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // Platform owner — the email that gets is_platform_owner=true on
    // /auth/me, which unlocks /dashboard/platform/* and the system-
    // level alert rule kinds. Used by lib/platform.js::isPlatformOwner.
    // Optional: if unset, no one is platform owner and the cross-tenant
    // surface is unreachable. Validated here so a typo (missing @,
    // trailing whitespace) fails at boot instead of silently locking
    // the platform owner out.
    CARDS402_PLATFORM_OWNER_EMAIL: z
      .string()
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // Internal dashboard access — comma-separated emails allowed to access /internal/* routes.
    // Emails ending in @cards402.com are always allowed regardless of this setting.
    // F2-env: each entry is trimmed, lowercased, and validated as an
    // email shape at boot so a typo doesn't silently exclude the
    // intended operator.
    INTERNAL_EMAILS: commaSeparatedEmails('INTERNAL_EMAILS'),

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
    ADMIN_SESSION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'ADMIN_SESSION_KEY must be 64 hex characters (32 bytes)')
      .optional(),

    // Secret-box key — AES-256-GCM key used to seal short-lived secrets
    // stored in the DB (agent claim payloads, etc). Required in production
    // so the claim endpoint never persists raw api keys as plaintext.
    // Adversarial audit finding F5.
    CARDS402_SECRET_BOX_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'CARDS402_SECRET_BOX_KEY must be 64 hex characters (32 bytes)')
      .optional(),
  })
  .superRefine((val, ctx) => {
    // Production must have a secret-box key set. Dev/test can skip it and
    // fall back to plaintext-with-warning so local workflows don't break.
    if (val.NODE_ENV === 'production' && !val.CARDS402_SECRET_BOX_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'CARDS402_SECRET_BOX_KEY is required in production. Generate one with ' +
          '`openssl rand -hex 32` and set it in the environment before restarting.',
        path: ['CARDS402_SECRET_BOX_KEY'],
      });
    }
  })
  .superRefine((val, ctx) => {
    // SMTP is all-or-nothing. If any SMTP_* var is set, they all must be set
    // (except SMTP_PORT which has a sensible default in email.js).
    const smtpKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
    const set = smtpKeys.filter((k) => val[k]);
    if (set.length > 0 && set.length < smtpKeys.length) {
      const missing = smtpKeys.filter((k) => !val[k]);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `SMTP is partially configured: missing ${missing.join(', ')}. Set all of SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM together or none of them.`,
        path: ['SMTP_HOST'],
      });
    }
  })
  .superRefine((val, ctx) => {
    // "Looks like production but NODE_ENV isn't" guard. If the public
    // base URL is HTTPS and points at a real (non-localhost) hostname,
    // the deploy is almost certainly a production one and should have
    // NODE_ENV=production set. Running in dev mode against a real
    // host silently disables the CARDS402_SECRET_BOX_KEY requirement
    // (so claim payloads get stored as plaintext) and loosens several
    // other defensive checks. Fail loudly.
    try {
      const url = new URL(val.CARDS402_BASE_URL);
      const isHttps = url.protocol === 'https:';
      // F5-env (2026-04-16): include the RFC 6761 reserved test TLDs
      // in the local-host list. Pre-fix, only `localhost`, `127.0.0.1`,
      // and `.local` (mDNS) were recognised — so the test harness's
      // `https://api.cards402.test` URL was mis-classified as a
      // production lookalike and tripped the NODE_ENV guard if anything
      // ever required src/env.js from a test. RFC 6761 reserves `.test`,
      // `.localhost`, `.invalid`, and `.example` for testing /
      // documentation; adding `.test` and `.localhost` as legitimate
      // local suffixes closes the misclassification.
      const isLocalHost =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        url.hostname === '::1' ||
        url.hostname.endsWith('.local') ||
        url.hostname.endsWith('.localhost') ||
        url.hostname.endsWith('.test');
      if (isHttps && !isLocalHost && val.NODE_ENV !== 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `NODE_ENV is '${val.NODE_ENV}' but CARDS402_BASE_URL points at a non-local HTTPS host ` +
            `(${url.hostname}). This looks like a production deploy with NODE_ENV misconfigured — ` +
            `dev mode skips the CARDS402_SECRET_BOX_KEY requirement and stores claim payloads as ` +
            `plaintext. Set NODE_ENV=production before restarting.`,
          path: ['NODE_ENV'],
        });
      }
    } catch {
      // URL parse already caught by the base schema — ignore.
    }
  });

const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  const missing = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`[env] Invalid environment variables:\n${missing}`);
  process.exit(1);
}

// Export the schema alongside the parsed result so unit tests can
// exercise validation rules without needing to mutate process.env and
// re-require the module (which would trip the process.exit boot
// behaviour above). Internal-use only — production callers should
// read `env` from this module.
module.exports = { env: result.data, _EnvSchema: EnvSchema };
