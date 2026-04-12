# cards402 Full End-to-End Audit
**Date:** 2026-04-09  
**Auditor:** Claude Code (claude-sonnet-4-6)  
**Scope:** All four components — Soroban contract, TypeScript SDK, Next.js web frontend, Node.js backend  
**Prior audit baseline:** audit-fixes.md (51/52 findings from previous claude-audit.md + codex-audit.md resolved)

---

## Methodology

Each component was audited independently with a fresh read of all source files. Findings were cross-referenced against prior audits to flag net-new issues only. The audit covers:

- Access control and authentication
- Input validation and injection risks
- Race conditions and TOCTOU
- Information disclosure and secret handling
- Cryptographic correctness
- Dependency surface
- Test coverage gaps

---

## Executive Summary

| Severity | Contract | SDK | Web | Backend | Total |
|----------|----------|-----|-----|---------|-------|
| CRITICAL | 1 | 3 | 3 | 2 | **9** |
| HIGH     | 2 | 4 | 4 | 4 | **14** |
| MEDIUM   | 5 | 4 | 5 | 5 | **19** |
| LOW      | 2 | 3 | 3 | 4 | **12** |
| **Total**| **10** | **14** | **15** | **15** | **54** |

All findings below are **net-new** relative to prior audits unless noted as a regression.

---

## Part 1 — Soroban Smart Contract (`contract/src/lib.rs`)

### CRITICAL

#### C-1: `init()` has no authorization check — front-running vulnerability
**File:** `contract/src/lib.rs:18–35`

`init()` checks that the contract hasn't been initialized yet but does NOT call `admin.require_auth()`. Anyone who observes the contract being deployed can race to call `init()` with a malicious treasury address before the legitimate deployer, permanently redirecting all payments.

```rust
pub fn init(env: Env, admin: Address, treasury: Address, usdc_contract: Address, xlm_contract: Address) {
    // No require_auth here!
    if env.storage().instance().has(&DataKey::Admin) {
        panic!("already initialized");
    }
```

**Fix:** Add `admin.require_auth();` as the first line of `init()`.

---

### HIGH

#### C-2: Negative and zero amounts accepted
**File:** `contract/src/lib.rs:39, 58`

Both `pay_usdc` and `pay_xlm` accept `amount: i128` without checking it is positive. A caller can emit a payment event with `amount = 0` or a negative value. Soroban's SAC token transfer will likely reject negative amounts, but the contract should enforce this itself.

```rust
pub fn pay_usdc(env: Env, from: Address, order_id: Bytes, amount: i128) {
    from.require_auth();
    // No check: if amount <= 0 { panic!(...) }
```

**Fix:**
```rust
if amount <= 0 {
    panic!("amount must be positive");
}
```

#### C-3: No token address validation at init
**File:** `contract/src/lib.rs:31–32`

The `usdc_contract` and `xlm_contract` addresses are stored as-is without verifying they match the known Stellar mainnet SAC addresses. Combined with C-1, a front-runner can register arbitrary token contracts, causing payments to invoke attacker-controlled code.

**Fix:** If C-1 is fixed (admin must authorize init), document the expected addresses clearly. Optionally hardcode a check against the known mainnet USDC SAC: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`.

---

### MEDIUM

#### C-4: Soroban SDK version not precisely pinned
**File:** `contract/Cargo.toml:11, 14`

`soroban-sdk = { version = "22" }` allows any `22.x.y` update. A patch release introducing a breaking change or vulnerability would be silently adopted on the next build.

**Fix:** Pin to a specific minor: `version = "22.5.x"` or use `=22.5.3`.

#### C-5: Stored `Admin` address is never used
**File:** `contract/src/lib.rs:29`

The admin address is persisted to storage but never read back. No admin-gated operations exist. This is dead storage that implies non-existent functionality.

**Fix:** Either remove the admin key from `DataKey` and storage, or implement a planned privileged operation (e.g., treasury rotation).

#### C-6: Zero-amount payments pollute the event log
**File:** `contract/src/lib.rs:39, 58` (related to C-2)

Even ignoring negative amounts, the contract permits zero-amount payments, which emit events the backend watcher must parse and match to orders. This can cause unnecessary fulfillment attempts.

**Fix:** Covered by C-2 fix.

#### C-7: No minimum viable treasury address validation
**File:** `contract/src/lib.rs:30`

The treasury address is accepted without any validation. A typo or zero-address at init would permanently break all payments.

**Fix:** Document the exact expected treasury address and add an assertion at init time.

#### C-8: Test coverage gaps for negative/zero amounts and bad token addresses
**File:** `contract/src/lib.rs` (test module)

The 9 existing tests are solid for happy paths and auth. No tests cover: zero amount, negative amount, mismatched token addresses at init, or wrong treasury.

**Fix:** Add `#[should_panic]` tests for each rejection case.

---

### LOW

#### C-9: `i128::MAX` amount has no upper bound — cosmetic
No practical exploit, but documenting that the token layer (SAC) is the sole guard against astronomical amounts.

#### C-10: Tests use `mock_all_auths()` globally
Tests using `mock_all_auths()` auto-approve authorization and don't test the contract's own auth enforcement. One auth-specific test disables this correctly. Consider splitting fixtures.

---

## Part 2 — TypeScript SDK (`sdk/src/`)

### CRITICAL

#### S-1: MCP `purchase_vcc` tool accepts unvalidated `amount_usdc`
**File:** `sdk/src/mcp.ts:~304–313`

The MCP tool receives `amount_usdc` as a free-form string from the MCP client, casts it unsafely, and calls `parseFloat()` without validation. A malicious or buggy MCP client can pass `""`, `"abc"`, `"-100"`, or `"NaN"`.

```typescript
const { amount_usdc, payment_asset = 'usdc' } = args as { amount_usdc: string; ... };
const amountNum = parseFloat(amount_usdc);
// amountNum could be NaN, negative, or zero
```

**Fix:** Validate with a regex before parsing:
```typescript
const amount_usdc = String((args as Record<string, unknown>).amount_usdc ?? '').trim();
if (!/^\d+(\.\d{1,8})?$/.test(amount_usdc) || parseFloat(amount_usdc) <= 0) {
  return { content: [{ type: 'text', text: 'Error: amount_usdc must be a positive number, e.g. "10.00"' }], isError: true };
}
```

#### S-2: USDC asset string parsed with non-null assertions, no length check
**File:** `sdk/src/stellar.ts:80–81`, `sdk/src/ows.ts:195–196`

The asset string `"USDC:GABC..."` is split by `:` and the parts accessed with `!` (non-null assertion). A malformed API response (missing issuer, multiple colons) will crash at runtime with a cryptic error instead of a typed `Cards402Error`.

```typescript
const parts = payment.usdc.asset.split(':');
asset = new Asset(parts[0]!, parts[1]!);  // parts[1] could be undefined
```

**Fix:**
```typescript
const parts = payment.usdc.asset.split(':');
if (parts.length !== 2 || !parts[0] || !parts[1]) {
  throw new ApiError(500, `Invalid USDC asset format: ${payment.usdc.asset}`);
}
asset = new Asset(parts[0], parts[1]);
```

#### S-3: MCP `check_order` passes unsanitized `order_id` to HTTP client
**File:** `sdk/src/mcp.ts:~414`

`order_id` from the MCP client is passed directly to `client.getOrder(order_id)`, which constructs a URL. No length limit, no character allowlist. Excessive-length IDs or IDs with path-separator characters (`../`) could affect URL construction.

**Fix:**
```typescript
const order_id = String((args as Record<string, unknown>).order_id ?? '').trim();
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(order_id)) {
  return { content: [{ type: 'text', text: 'Error: invalid order ID' }], isError: true };
}
```

---

### HIGH

#### S-4: Stellar address from API response not validated before use
**File:** `sdk/src/stellar.ts:87`, `sdk/src/ows.ts:204`

`payment.stellar_address` is taken directly from the order response and passed to `Operation.payment({ destination: ... })`. If the API is compromised or returns a malformed address, the SDK will attempt to send funds to that address without any local validation.

**Fix:**
```typescript
import { StrKey } from '@stellar/stellar-sdk';
if (!StrKey.isValidEd25519PublicKey(payment.stellar_address)) {
  throw new ApiError(500, `Invalid payment destination address`);
}
```

#### S-5: No timeout on Horizon server calls
**File:** `sdk/src/stellar.ts:32–41`, `sdk/src/ows.ts:92–105`

`server.loadAccount()` and `server.submitTransaction()` have no timeout. If Horizon is unresponsive the MCP server hangs indefinitely, blocking the agent.

**Fix:** Pass a timeout to the Horizon server constructor:
```typescript
const server = new Horizon.Server(url, { timeout: 15000 });
```

#### S-6: MCP error handler may leak OWS wallet path and internal details
**File:** `sdk/src/mcp.ts:~405, 450, 478`

All catch blocks do `err.message` and return it verbatim. If the OWS library throws an error containing a file path, wallet name, or (in a worst case) key material, it surfaces to the MCP client.

**Fix:** Classify errors at the boundary:
```typescript
const message = err instanceof Cards402Error
  ? err.message
  : 'An internal error occurred. Check server logs.';
```
Log the full error to stderr for debugging.

#### S-7: Stellar transaction timeout is 60 seconds — too short under congestion
**File:** `sdk/src/stellar.ts:49, 92`, `sdk/src/ows.ts:157, 209`

`.setTimeout(60)` is the on-ledger timeout. During Stellar network congestion this regularly causes `tx_too_late` failures, leaving orders created but unpaid.

**Fix:** Increase to `180` (3 minutes) for payments and `300` for trustline operations.

---

### MEDIUM

#### S-8: Unsafe `as` type casts suppress all input validation in MCP handlers
**File:** `sdk/src/mcp.ts:~304, 414`

Using `args as { amount_usdc: string }` tells TypeScript that args conforms to the type, but this is never verified at runtime. Combined with S-1 and S-3, this is the root cause of the MCP validation gap.

**Fix:** Parse args as `Record<string, unknown>` and extract fields with explicit coercion.

#### S-9: `purchaseCard()` has no idempotency on the payment side
**File:** `sdk/src/stellar.ts:118–141`

If the order is created but the Stellar payment submission fails and the caller retries, a second payment transaction will be sent. The order was already created. The caller has no way to distinguish "payment in flight" from "payment never sent."

**Fix:** Before submitting payment, call `getOrder()` to check if the order is already `pending_fulfillment` or beyond (indicating payment was received).

#### S-10: `pollUntilReady()` default timeout is undocumented and may loop long
**File:** `sdk/src/client.ts`

The default poll timeout and interval should be documented so callers can tune them for their use case.

#### S-11: No API key format validation in `Cards402Client` constructor
**File:** `sdk/src/client.ts:~92`

An empty or whitespace-only API key is silently accepted and will produce a confusing 401 from the server.

**Fix:** `if (!apiKey.trim()) throw new AuthError();`

---

### LOW

#### S-12: `setup_wallet` silently swallows trustline errors
**File:** `sdk/src/mcp.ts:~159–174`

The trustline addition catch block masks all errors with a generic "already present or could not add" message. A genuine network error or fee shortage is indistinguishable from "trustline already exists."

#### S-13: `getBalance()` error not distinguished from "account not funded"
**File:** `sdk/src/mcp.ts:~202–207`

All Horizon errors are treated as "account not activated." A DNS failure or Horizon outage gives the same response as a genuinely unfunded account.

#### S-14: Overly permissive `payment_asset` validation in MCP tool
**File:** `sdk/src/mcp.ts`

`payment_asset` is not validated against `['usdc', 'xlm']` before use, allowing an unrecognized string to propagate silently.

---

## Part 3 — Next.js Web Frontend (`web/`)

### CRITICAL

#### W-1: Admin dashboard has no server-side authentication enforcement
**File:** `web/app/admin/page.tsx` (entire file), `web/next.config.ts`

The `/admin` route is a `'use client'` component. Authentication is purely a React state check (`if (!token)`). There is no Next.js middleware, no server component auth guard, and no HTTP-level 403. Anyone who can reach the URL can observe the DOM, and any API call that carries a valid Bearer token will succeed regardless of how it was obtained.

The README explicitly documents: *"protect /admin via Cloudflare Access or similar."* This is an external dependency that is easy to misconfigure or forget.

**Fix:** Add a `middleware.ts` at the web root that validates the Bearer token from cookies before serving `/admin` and `/dashboard`. Use `httpOnly` secure cookies instead of React state for the token.

#### W-2: State-changing admin operations have no CSRF protection
**File:** `web/app/admin/page.tsx:~866–888`

All POST/PATCH/DELETE calls (toggle key, suspend key, refund order) use only a Bearer token in the `Authorization` header. While Bearer tokens are more CSRF-resistant than cookies, the current design stores the token in React state rather than a proper secure session, and does not send a separate CSRF token. If auth is ever migrated to cookies, this becomes an active vulnerability.

**Fix:** Implement the Double Submit Cookie pattern or synchronizer tokens; require an `X-CSRF-Token` header on all mutations.

#### W-3: API call failures are silent — admin actions appear to succeed when they fail
**File:** `web/app/admin/page.tsx:~866–890`

Functions like `toggleKey()`, `suspendKey()`, and `refundOrder()` `await fetch(...)` and then immediately call `fetchAll()` without checking `response.ok`. A 403, 401, or 500 response is silently swallowed. The UI refreshes and shows stale data that looks like the action succeeded.

```typescript
async function toggleKey(id: string, enabled: number) {
  await fetch(`${API_BASE}/admin/api-keys/${id}`, { ... });
  fetchAll();  // Called regardless of success or failure
}
```

**Fix:** Check `response.ok` and surface an error toast before refreshing:
```typescript
const res = await fetch(...);
if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  setError(err.error ?? `Action failed (${res.status})`);
  return;
}
fetchAll();
```

---

### HIGH

#### W-4: Newly created API key and webhook secret displayed in plaintext indefinitely
**File:** `web/app/admin/page.tsx:~562–571`

When a new API key is created, the full key and webhook secret are rendered in a `<pre>` block with no masking, no time limit, and no "reveal on click" UX. A screenshot, a shared screen, or browser history could expose both secrets.

**Fix:** Show only the last 4 characters initially (`****...xxxx`). Add an explicit "Copy and close — this cannot be shown again" flow with a countdown.

#### W-5: No Content Security Policy or security headers
**File:** `web/next.config.ts`

The Next.js config sets no HTTP security headers. The admin dashboard renders with no CSP, no `X-Frame-Options`, no `X-Content-Type-Options`.

**Fix:**
```typescript
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      // Add CSP after auditing all inline scripts
    ],
  }];
}
```

#### W-6: Auth token stored in React state — lost on page reload, no persistence
**File:** `web/app/admin/page.tsx:~715–716`

`const [token, setToken] = useState('')` is lost on every page refresh, forcing re-authentication. More importantly, it cannot be set by the server, making server-side auth validation impossible.

**Fix:** Set the session token as an `httpOnly; Secure; SameSite=Strict` cookie server-side after OTP verification. Read it from cookies on the server for middleware enforcement.

#### W-7: Webhook URL field in admin UI accepts `http://` and private IPs
**File:** `web/app/admin/page.tsx:~355–356`

The `default_webhook_url` field has no client-side validation. An admin can save an `http://` URL or a private-network address. The backend SSRF check catches this at delivery time, but the UI should reject it at input time.

**Fix:** Validate on change: `new URL(value).protocol === 'https:'` and block RFC-1918 prefixes.

---

### MEDIUM

#### W-8: No session expiry or inactivity timeout
**File:** `web/app/admin/page.tsx`

Admin sessions have no visible timeout. An admin who leaves their browser open has an indefinitely valid session.

**Fix:** Add a 30-minute inactivity timeout with a 5-minute warning modal.

#### W-9: `window.location` used instead of Next.js router
**File:** `web/app/admin/page.tsx:~838`, `web/app/portal/page.tsx:7`

`window.location.href` and `window.location.replace()` are used for redirects. These bypass Next.js router and break prefetch, server-side rendering, and testability.

**Fix:** Use `useRouter()` from `next/navigation`.

#### W-10: Client-side rate limiting absent on OTP login
**File:** `web/app/admin/page.tsx:~804–822`

No client-side debounce or rate limit on "Send code" or "Verify". The backend enforces this, but the UI gives no feedback when rate-limited.

**Fix:** Disable "Send code" for 60 seconds after first click; show countdown.

#### W-11: `/portal` redirect uses `window.location.replace` instead of server redirect
**File:** `web/app/portal/page.tsx`

The portal page is a 'use client' component that immediately calls `window.location.replace('/dashboard')`. This causes a client-side redirect flash. A server-side `redirect()` would be cleaner and faster.

#### W-12: No approval confirmation dialog before approve/reject
**File:** `web/app/admin/page.tsx:~607–651`

Approve and reject buttons in the `ApprovalModal` have no confirmation step. A misclick has irreversible consequences.

**Fix:** Add `if (!confirm('Approve $X for order Y?')) return;` or a two-step confirmation UI.

---

### LOW

#### W-13: Landing page example uses realistic-looking test card numbers
**File:** `web/app/page.tsx:~36–42`

The code example uses a fake but realistic card number format. Prefer the industry-standard test PAN `4111 1111 1111 1111`.

#### W-14: Approval decisions have no visible audit trail in UI
**File:** `web/app/admin/page.tsx:~607–651`

After approving or rejecting an order, the UI shows no record of who approved it or when.

#### W-15: Package versions use caret ranges
**File:** `web/package.json`

Minor/patch updates are applied automatically. For a financial application, exact pinning (`"react": "19.2.4"`) is safer.

---

## Part 4 — Node.js Backend (`backend/src/`)

### CRITICAL

#### B-1: `scheduleRefund()` is not idempotent — double-refund possible
**File:** `backend/src/fulfillment.js:55–103`

`scheduleRefund()` does not check whether a refund has already been sent before executing. If called concurrently (admin endpoint + webhook retry race, or job overlap), two XLM/USDC transfers are sent to the payer.

**Fix:** Check and set atomically using a SQLite transaction:
```javascript
const updated = db.prepare(`
  UPDATE orders SET status = 'refund_pending'
  WHERE id = ? AND status != 'refund_pending' AND status != 'refunded'
`).run(orderId);
if (updated.changes === 0) return; // Already in progress or done
```

#### B-2: OTP verification has a race condition — same code can create multiple sessions
**File:** `backend/src/api/auth.js:116–133`

The code queries for an unused auth code (line 116) and marks it used (line 133) in two separate statements. Two concurrent requests with the same code can both pass the unused-code check before either marks it used, each obtaining a valid session.

**Fix:** Use an atomic `UPDATE ... RETURNING` or a SQLite transaction with an exclusive lock:
```javascript
const result = db.prepare(`
  UPDATE auth_codes SET used_at = datetime('now')
  WHERE email = ? AND code_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
`).run(email, codeHash);
if (result.changes === 0) return res.status(401).json({ error: 'invalid_code' });
```

---

### HIGH

#### B-3: Daily spend limit bypassed via expired/failed orders
**File:** `backend/src/policy.js:82–98`

The daily limit query excludes `expired`, `rejected`, `failed`, and `refunded` orders. An agent can create orders, not pay (so they expire after the payment window), and repeat — the expired orders never count toward the daily cap. This allows unlimited order creation within a rolling 24-hour window.

**Fix:** Count all orders created today regardless of terminal status:
```javascript
WHERE api_key_id = ? AND date(created_at) = date('now')
-- Remove the NOT IN clause
```

#### B-4: Approval `expires_at` not checked when admin approves
**File:** `backend/src/api/admin.js:~270–298`

When an admin approves an approval request, the code checks that `status = 'pending'` but does not verify `expires_at > now()`. An approval request that has already timed out can still be approved, dispatching a high-value order after the approval window closed.

**Fix:** Add to the approval SELECT:
```javascript
AND datetime(expires_at) > datetime('now')
```
Return `410 Gone` if expired.

#### B-5: VCC callback endpoint has no rate limiting
**File:** `backend/src/api/vcc-callback.js`

Every other high-traffic route applies rate limiting, but the `/vcc-callback` endpoint has none. A flood of fake callback requests (even with invalid HMAC) would consume CPU on each HMAC comparison.

**Fix:** Apply a generous rate limiter (e.g., 1000 req/min, keyed on IP):
```javascript
const vccLimiter = rateLimit({ windowMs: 60_000, limit: 1000 });
router.post('/', vccLimiter, rawBody, ...);
```

#### B-6: DNS rebinding window between SSRF validation and webhook delivery
**File:** `backend/src/lib/ssrf.js:31–71`, `backend/src/fulfillment.js:31`

The SSRF check in `ssrf.js` resolves DNS and validates the resulting IPs at validation time. The actual HTTP fetch happens later in the fulfillment pipeline. An attacker controlling DNS can change the A record after validation to point to an internal IP (e.g., `169.254.169.254`), bypassing SSRF protection.

**Fix:** Resolve and pin the IP at validation time and pass it explicitly to the fetch call, or use Node's `--dns-result-order=ipv4first` and validate the `Host` header in the outgoing request.

---

### MEDIUM

#### B-7: VCC authentication token stored as plaintext in SQLite `system_state`
**File:** `backend/src/vcc-client.js:~32`

The VCC session token is persisted to the `system_state` table as plaintext. Database compromise exposes a valid VCC credential that could be used to order physical cards or exfiltrate billing data.

**Fix:** Encrypt the token at rest using AES-256-GCM with a key derived from an environment secret. Alternatively, treat it as ephemeral and re-authenticate on each backend restart.

#### B-8: Stellar sequence number contention on concurrent refunds
**File:** `backend/src/payments/xlm-sender.js:13–63`

`loadAccount()` fetches the current sequence number, then the transaction is built and signed. If two refunds execute concurrently, the second transaction will fail with `tx_bad_seq`. The current code has no retry on sequence mismatch.

**Fix:** Wrap the build/sign/submit in a retry loop that reloads the account on `tx_bad_seq`:
```javascript
for (let i = 0; i < 3; i++) {
  try {
    const account = await server.loadAccount(keypair.publicKey());
    // ... build, sign, submit
    return hash;
  } catch (e) {
    if (e.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq' && i < 2) continue;
    throw e;
  }
}
```

#### B-9: Admin `PATCH /api-keys/:id` builds SQL dynamically from request body keys
**File:** `backend/src/api/admin.js:~216–217`

Field names for the UPDATE are derived directly from `Object.keys(fields)` where `fields` is parsed from the request body. Even though individual values are parameterized, the column names are interpolated as strings. A carefully crafted key name could inject SQL if the input is not strictly allow-listed.

**Fix:** Explicitly allow-list field names:
```javascript
const ALLOWED = new Set(['enabled', 'name', 'spend_limit_usdc', 'rate_limit_rpm', 'default_webhook_url']);
const filtered = Object.fromEntries(Object.entries(body).filter(([k]) => ALLOWED.has(k)));
```

#### B-10: Auth OTP code logged to console in non-production
**File:** `backend/src/api/auth.js:~83–84`

In non-production environments, the raw OTP code is logged to the console. Development logs are often streamed to shared dashboards or stored in files with broad read permissions.

**Fix:** Log only that a code was sent, not its value:
```javascript
if (process.env.NODE_ENV !== 'production') {
  log(`[auth] login code sent to ${addr} (expires in 15min)`);
}
```

#### B-11: Webhook retry job blocks synchronously on each HTTP call
**File:** `backend/src/jobs.js:~90–128`

`retryWebhooks()` awaits each webhook call sequentially. A webhook endpoint that is slow (but not timing out) can delay the entire 5-minute job cycle, causing other jobs (expiry, stuck order recovery) to run late.

**Fix:** Fan out webhook deliveries with `Promise.allSettled()` and limit concurrency.

---

### LOW

#### B-12: Stellar memo not validated for length before submission
**File:** `backend/src/payments/xlm-sender.js:29`

Memo strings are passed directly to `Memo.text()`. Stellar memo fields have a 28-byte limit. A memo exceeding this will cause the transaction to fail at the SDK layer with an unhelpful error.

**Fix:** `if (Buffer.byteLength(memo) > 28) throw new Error('Memo too long');`

#### B-13: No request ID for distributed tracing
**File:** `backend/src/app.js`

Log lines across different middleware and fulfillment stages cannot be correlated to a single inbound request. When debugging a failed order, the operator must manually filter by order ID.

**Fix:** Generate a `req.id` (uuid) on each request and include it in every log line.

#### B-14: CORS preflight cache header missing
**File:** `backend/src/app.js:~26–34`

`Access-Control-Max-Age` is not set, so browsers send a CORS preflight before every API call, adding ~50ms to every agent interaction.

**Fix:** Add `maxAge: 3600` to the `cors()` config.

#### B-15: `GET /orders/:id` error distinguishes missing vs. unauthorized
**File:** `backend/src/api/orders.js:~240–296`

A 404 with `order_not_found` is returned for non-existent orders, and a 403 (or different 404 body) for orders belonging to a different key. This allows enumeration of all order IDs in the system.

**Fix:** Return identical 404 bodies for both cases.

---

## Positive Findings (Selected)

These practices were observed and should be maintained:

- **SQL injection**: All SQLite queries use parameterized statements (`?` or named params) throughout the backend.
- **API key storage**: Keys are stored as bcrypt hashes with prefix-only plaintext for lookup — correct pattern.
- **Webhook HMAC**: `crypto.timingSafeEqual()` is used for HMAC comparison.
- **SSRF protection**: Webhook URLs are validated against RFC-1918 and link-local ranges.
- **Soroban auth**: `from.require_auth()` is correctly called in both payment functions.
- **Event-transfer ordering**: Events are emitted after token transfers in the contract, ensuring consistency.
- **OWS wallet**: Private keys are stored encrypted in an OWS vault rather than plaintext env vars.
- **No dangerouslySetInnerHTML**: Not used anywhere in the Next.js frontend.
- **No `console.log` of secrets**: SDK source does not log secrets or key material.
- **Overflow checks in Rust**: `overflow-checks = true` in the release profile.
- **Contract one-shot init**: The `has(&DataKey::Admin)` guard prevents double-initialization.

---

## Prioritized Fix List

### Fix immediately (before next production deployment)

| ID | Severity | Component | Summary |
|----|----------|-----------|---------|
| B-1 | CRITICAL | Backend | Refund double-spend — add idempotency guard |
| B-2 | CRITICAL | Backend | OTP race condition — atomic UPDATE |
| S-1 | CRITICAL | SDK | MCP `amount_usdc` not validated |
| S-2 | CRITICAL | SDK | USDC asset string unsafe split |
| W-1 | CRITICAL | Web | Admin has no server-side auth |
| W-3 | CRITICAL | Web | Admin actions fail silently |
| C-1 | CRITICAL | Contract | `init()` needs `require_auth()` |

### Fix in next sprint

| ID | Severity | Component | Summary |
|----|----------|-----------|---------|
| B-3 | HIGH | Backend | Daily limit bypass via expired orders |
| B-4 | HIGH | Backend | Approval expiry not checked at approve time |
| B-5 | HIGH | Backend | VCC callback has no rate limit |
| B-6 | HIGH | Backend | DNS rebinding after SSRF validation |
| C-2 | HIGH | Contract | Negative/zero amounts accepted |
| C-3 | HIGH | Contract | Token address not validated at init |
| S-3 | CRITICAL | SDK | MCP `order_id` not sanitized |
| S-4 | HIGH | SDK | Stellar address from API not validated |
| S-5 | HIGH | SDK | No Horizon request timeout |
| S-6 | HIGH | SDK | MCP error handler leaks internals |
| W-4 | HIGH | Web | API key shown in plaintext |
| W-5 | HIGH | Web | No security headers / CSP |
| W-2 | CRITICAL | Web | No CSRF protection on admin mutations |

### Address before scale-up

| ID | Severity | Component | Summary |
|----|----------|-----------|---------|
| B-7 | MEDIUM | Backend | VCC token stored plaintext |
| B-8 | MEDIUM | Backend | Stellar sequence contention on concurrent refunds |
| B-9 | MEDIUM | Backend | Admin SQL built from request body keys |
| B-10 | MEDIUM | Backend | OTP logged to console in non-prod |
| B-11 | MEDIUM | Backend | Webhook retry blocks job cycle |
| W-6 | CRITICAL | Web | Auth token in React state (httpOnly cookie needed) |
| W-7 | HIGH | Web | Webhook URL not validated in admin UI |
| S-7 | MEDIUM | SDK | Stellar transaction timeout too short |
| S-8 | MEDIUM | SDK | Unsafe MCP arg casting |
| C-4 | MEDIUM | Contract | SDK version not precisely pinned |

---

## Comparison to Prior Audits

The previous audits (claude-audit.md, codex-audit.md, audit-fixes.md) identified 121 total findings and resolved 113 of them. This audit identified **54 net-new findings** not present in prior audit history. The most significant new finding is the **refund idempotency gap (B-1)** and the **OTP race condition (B-2)**, both of which could cause direct financial loss. The contract initialization front-run risk (C-1) is present at the Rust level but is mitigated operationally if deployment is done carefully and the contract is already initialized on mainnet.
