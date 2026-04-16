// @ts-check
// Stellar payment helpers — sends USDC or XLM from the treasury wallet.
// Used for refunds to agents and for paying CTX.com gift card invoices.

const {
  Horizon,
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Memo,
  StrKey,
} = require('@stellar/stellar-sdk');
const { log, event: bizEvent } = require('../lib/logger');

// Memo.text's internal guard accepts 28 bytes (Stellar MEMO_TEXT limit).
// We check UTF-8 byte length ourselves before calling it so the error
// message points at the offending memo string rather than the deep SDK
// internals. Applied uniformly across sendXlm / sendUsdc / sendUsdcAsXlm
// so memo handling is consistent (adversarial audit F3-xlm-sender).
function safeMemoText(memo) {
  if (memo === null || memo === undefined || memo === '') return Memo.none();
  const s = String(memo);
  if (Buffer.byteLength(s, 'utf8') > 28) {
    throw new Error(`Memo exceeds 28-byte Stellar limit: ${s}`);
  }
  return Memo.text(s);
}

// Validate a decimal-string / number amount is finite, positive, and
// within the 7-decimal Stellar precision window. Callers pass amounts
// sourced from the payment URL (CTX / VCC) and from order rows — both
// of which could be corrupt. Without this validation a bad value would
// only surface as a cryptic Horizon result code after a full round-trip
// to the network.
function assertValidStellarAmount(amount, fieldName) {
  if (amount === null || amount === undefined || amount === '') {
    throw new Error(`${fieldName}: missing amount`);
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${fieldName}: invalid amount '${amount}'`);
  }
  // Stellar's max supported amount (max int64 / 10^7) is ~9.22e11. Reject
  // anything above a sane treasury-scale ceiling as a defense-in-depth
  // against a compromised upstream returning an astronomical value.
  if (n > 1_000_000) {
    throw new Error(`${fieldName}: amount '${amount}' exceeds treasury ceiling`);
  }
}

// Optional allowlist for CTX payment destinations. If
// CTX_DESTINATION_ALLOWLIST is set (comma-separated G-addresses), any
// payCtxOrder call whose parsed destination is not in the list is
// rejected before it reaches the Stellar submit path. This is the
// ops-level kill switch for "VCC is compromised and started issuing
// invoices pointing at an attacker wallet" — set the env var to the
// known-good CTX accounts to lock treasury outflows to those routes.
// Unset = no allowlist check; still falls back to the syntactic
// StrKey validation below.
function ctxDestinationAllowlist() {
  const raw = process.env.CTX_DESTINATION_ALLOWLIST;
  if (!raw) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const NETWORK = process.env.STELLAR_NETWORK || 'mainnet';
const HORIZON_URL =
  NETWORK === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

const server = new Horizon.Server(HORIZON_URL);

// Submit a Stellar transaction with two layers of safety:
//
//   1. Retry on tx_bad_seq up to `maxAttempts` times. Concurrent sends that
//      race on the treasury's sequence number resolve naturally: the losing
//      submit gets tx_bad_seq, reloads the account, and rebuilds with the
//      fresh seq. tx_bad_seq is definitive — stellar-core validated the
//      tx and rejected it, so the envelope is NOT on chain and retrying
//      with a new sequence is safe.
//
//   2. Network-error resolution (audit F1-xlm-sender, 2026-04-15).
//      `server.submitTransaction` throws for two very different failure
//      modes: Horizon rejected the tx (structured `result_codes`) OR the
//      HTTP call itself failed (fetch timeout, ECONNRESET, 5xx wrapped by
//      the SDK). The two cases look identical to the caller but mean
//      wildly different things: the rejection path is definitive, while
//      the network path means the tx MAY have been submitted and landed
//      before the response was lost.
//
//      Before this fix, a higher-level retry (fulfillment.js scheduling a
//      refund) after a lost-response submit could double-spend if the
//      original tx eventually landed. We now pre-compute the deterministic
//      envelope hash, and on a network-error catch we look the hash up on
//      Horizon:
//
//        - Found + successful      → return hash (tx did land, all good)
//        - Found + applied-failed  → throw with stellarStatus='applied_failed'
//        - Not found (404)         → throw with stellarStatus='not_landed'
//                                    (caller is free to retry — tx is dead)
//        - Lookup itself failed    → throw with stellarStatus='unknown'
//                                    (caller must hold off retry — we
//                                    genuinely don't know the state)
//
//      The `stellarStatus` marker lets callers differentiate safe-retry
//      from must-not-retry without parsing error strings.
async function submitWithRetry(buildTx, keypair, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const account = await server.loadAccount(keypair.publicKey());
    const tx = buildTx(account);
    tx.sign(keypair);
    // Compute the envelope hash BEFORE submission so we can look it up on
    // Horizon if the submit itself throws a network error. tx.hash() is a
    // Buffer; Horizon's /transactions/{hash} endpoint takes hex.
    const hashHex = tx.hash().toString('hex');

    try {
      const result = await server.submitTransaction(tx);
      return result.hash;
    } catch (err) {
      lastErr = err;
      const resultCodes = err?.response?.data?.extras?.result_codes;
      const txCode = resultCodes?.transaction;

      // tx_bad_seq: definitive rejection; safe to reload + retry.
      if (txCode === 'tx_bad_seq' && attempt < maxAttempts) {
        continue;
      }
      // Any other structured rejection (op_under_dest_min, tx_insufficient_
      // balance, etc.) is a definitive failure — propagate unchanged.
      if (resultCodes) {
        throw err;
      }
      // Network-error path: no structured result_codes. Ask Horizon what
      // actually happened to the hash we computed before submission.
      const resolution = await resolveNetworkErrorOutcome(hashHex);
      if (resolution.landed) {
        // The tx did make it to a ledger during the lost-response window.
        return hashHex;
      }
      // Re-throw with a clearer message and a machine-readable marker so
      // the caller can decide whether a retry is safe.
      throw annotateSubmitError(err, hashHex, resolution);
    }
  }
  // The for-loop either returns a hash or throws on every iteration. The
  // only way we land here is a logic bug where all iterations `continue`d
  // without setting lastErr, which is impossible. Surface it explicitly
  // so a future refactor can't silently fall through to `undefined`.
  throw lastErr ?? new Error('submitWithRetry: exhausted attempts without terminal result');
}

// Ask Horizon whether a tx with this hash made it onto a ledger. Called
// after a network-error throw from submitTransaction. Returns a three-way
// verdict: {landed:true} if it's on-chain and successful, {landed:false,
// reason:'not_landed'} if Horizon returned 404, {landed:false,
// reason:'applied_failed'} if it's on-chain but tx_failed, or {landed:false,
// reason:'unknown', lookupError} if Horizon is itself unreachable.
async function resolveNetworkErrorOutcome(hashHex) {
  try {
    const record = /** @type {any} */ (await server.transactions().transaction(hashHex).call());
    if (record?.successful === true) {
      return { landed: true };
    }
    return {
      landed: false,
      reason: 'applied_failed',
      resultCode: record?.result_codes?.transaction || null,
    };
  } catch (lookupErr) {
    const status =
      /** @type {any} */ (lookupErr)?.response?.status ??
      /** @type {any} */ (lookupErr)?.status ??
      null;
    if (status === 404 || /not.?found/i.test(/** @type {Error} */ (lookupErr)?.message || '')) {
      return { landed: false, reason: 'not_landed' };
    }
    return {
      landed: false,
      reason: 'unknown',
      lookupError: /** @type {Error} */ (lookupErr)?.message || String(lookupErr),
    };
  }
}

// Wrap a submitTransaction throw with the txHash and a stellarStatus marker
// so callers can tell whether it's safe to retry without regex-parsing the
// message string. Mirrors the sdk/src/soroban.ts pattern for the Soroban
// equivalent (stellarStatus='dropped' there, same concept).
function annotateSubmitError(originalErr, hashHex, resolution) {
  const status = resolution.reason; // 'not_landed' | 'applied_failed' | 'unknown'
  const baseMsg = /** @type {Error} */ (originalErr)?.message || String(originalErr);
  const msg =
    status === 'not_landed'
      ? `submit network error and tx ${hashHex} was not accepted by any ledger — safe to retry. (${baseMsg})`
      : status === 'applied_failed'
        ? `tx ${hashHex} applied on-chain but failed (${resolution.resultCode || 'unknown'})`
        : `submit network error and Horizon lookup also failed for ${hashHex}: ${resolution.lookupError || 'unknown'} (original: ${baseMsg})`;
  const wrapped = /** @type {Error & { stellarStatus?: string, txHash?: string }} */ (
    new Error(msg)
  );
  wrapped.stellarStatus = status;
  wrapped.txHash = hashHex;
  return wrapped;
}

// Send XLM from the treasury wallet (used for XLM refunds)
async function sendXlm({ destination, amount, memo }) {
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret) throw new Error('STELLAR_XLM_SECRET not set');
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error('sendXlm: invalid destination address');
  }
  assertValidStellarAmount(amount, 'sendXlm');

  const keypair = Keypair.fromSecret(secret);
  return submitWithRetry(
    (account) =>
      new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(
          Operation.payment({ destination, asset: Asset.native(), amount: String(amount) }),
        )
        .addMemo(safeMemoText(memo))
        .setTimeout(120)
        .build(),
    keypair,
  );
}

// Send USDC from the treasury wallet (used for USDC refunds)
async function sendUsdc({ destination, amount, memo }) {
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret) throw new Error('STELLAR_XLM_SECRET not set');
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error('sendUsdc: invalid destination address');
  }
  assertValidStellarAmount(amount, 'sendUsdc');

  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const keypair = Keypair.fromSecret(secret);
  return submitWithRetry(
    (account) =>
      new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(
          Operation.payment({
            destination,
            asset: new Asset('USDC', USDC_ISSUER),
            amount: String(amount),
          }),
        )
        .addMemo(safeMemoText(memo))
        .setTimeout(120)
        .build(),
    keypair,
  );
}

// Convert a Horizon asset record ({asset_type, asset_code, asset_issuer})
// into a stellar-sdk Asset. Used to rehydrate the path[] returned by the
// strict-receive probe so we can pin it on the actual submitted tx.
function hydrateAsset(rec) {
  if (!rec || rec.asset_type === 'native') return Asset.native();
  return new Asset(rec.asset_code, rec.asset_issuer);
}

// Probe Horizon for a USDC→XLM strict-receive path to see what the DEX
// would charge and whether a route exists. Returns the cheapest path's
// source amount (USDC needed to buy `destXlm` XLM), the intermediate
// assets, and an observability payload. The path is pinned on the real
// submission so Core doesn't silently pick a more expensive route at
// ledger-close time (audit: 2026-04-14 slippage bug where `path: []`
// drifted away from the probe and burned `op_over_source_max`).
async function probeUsdcToXlmPath(destXlm) {
  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const url =
    `${HORIZON_URL}/paths/strict-receive` +
    `?source_assets=USDC%3A${USDC_ISSUER}` +
    `&destination_asset_type=native` +
    `&destination_amount=${encodeURIComponent(String(destXlm))}`;
  try {
    // 5s timeout so a hanging Horizon doesn't stall the CTX payment path.
    // Pre-fix this was a bare fetch() with no timeout — a slow Horizon
    // could block sendUsdcAsXlm indefinitely.
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = await res.json();
    const records = body?._embedded?.records || [];
    if (!records.length) return { ok: false, reason: 'no_path' };
    // Horizon already returns records sorted by source_amount ascending.
    const best = records[0];
    // F2 audit (2026-04-15): reject records with a missing/malformed
    // source_amount. Previously we passed the raw value through and the
    // caller did `Number(undefined) / Number(destXlm)` which produces NaN,
    // and `NaN < x` is always false — so the early-abort check silently
    // passed and we'd submit a path_payment against a path we'd never
    // properly priced. Validating at the probe boundary means the caller
    // can trust sourceAmount is a usable positive number.
    const srcAmount = Number(best.source_amount);
    if (!Number.isFinite(srcAmount) || srcAmount <= 0) {
      return { ok: false, reason: 'invalid_source_amount' };
    }
    const pathAssets = (best.path || []).map(hydrateAsset);
    return {
      ok: true,
      sourceAmount: best.source_amount, // USDC required to buy destXlm
      path: pathAssets,
      pathLength: pathAssets.length,
      candidateCount: records.length,
    };
  } catch (err) {
    return { ok: false, reason: `probe_error: ${err.message}` };
  }
}

// Atomic USDC→XLM swap + CTX forward. One Stellar tx with TWO operations:
//
//   1. pathPaymentStrictSend(sendAmount=maxUsdc USDC, destMin=destXlm XLM,
//      destination=self) — swaps the agent's USDC into at least destXlm
//      XLM inside our own treasury account. Any surplus XLM beyond destXlm
//      stays in treasury as margin.
//
//   2. payment(amount=destXlm XLM, destination=CTX) — a plain Stellar
//      payment op delivering exactly the invoice amount to CTX with the
//      invoice memo. This is the critical bit: CTX's payment watcher
//      only registers direct `payment` operations and silently ignores
//      `path_payment_*` ops (the 2026-04-14 "pending/unpaid" bug), so the
//      swap has to land in a separate op from the CTX delivery.
//
// If the DEX can't deliver at least destXlm XLM for the agent's USDC the
// whole tx fails atomically with op_under_dest_min on op 1 — no spend,
// no partial state, and the order is refunded by the caller.
async function sendUsdcAsXlm({ destination, destXlm, maxUsdc, memo }) {
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret) throw new Error('STELLAR_XLM_SECRET not set');
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error('sendUsdcAsXlm: invalid destination address');
  }
  assertValidStellarAmount(destXlm, 'sendUsdcAsXlm.destXlm');
  assertValidStellarAmount(maxUsdc, 'sendUsdcAsXlm.maxUsdc');

  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const usdc = new Asset('USDC', USDC_ISSUER);
  const keypair = Keypair.fromSecret(secret);
  const treasuryAddress = keypair.publicKey();

  // Probe the DEX for book health AND the concrete path Horizon would use.
  // We pin the returned path on the actual submission so Core's in-core
  // pathfinder can't silently pick a more expensive route at ledger-close
  // time.
  const probe = await probeUsdcToXlmPath(destXlm);
  bizEvent('dex.usdc_xlm.probe', {
    dest_xlm: destXlm,
    path_ok: probe.ok,
    quoted_usdc: probe.ok ? probe.sourceAmount : null,
    path_length: probe.ok ? probe.pathLength : null,
    candidates: probe.ok ? probe.candidateCount : null,
    reason: probe.ok ? null : probe.reason,
    max_usdc: maxUsdc,
  });

  // Strict-send sendAmount is exactly the agent's face value; destMin is
  // the full invoice amount so op 2 is guaranteed a sufficient balance to
  // forward. Stellar 7-decimal precision.
  const sendAmount = Number(maxUsdc).toFixed(7);
  const destMin = Number(destXlm).toFixed(7);
  const forwardAmount = Number(destXlm).toFixed(7);

  // Early-abort check: if the probe already tells us that face-value USDC
  // can't buy destMin XLM at current market rates, the tx will fail with
  // op_under_dest_min. Abort now so we don't burn fees on a doomed submit.
  if (probe.ok) {
    const quoteUsdcPerXlm = Number(probe.sourceAmount) / Number(destXlm);
    const xlmAtSendAmount = Number(sendAmount) / quoteUsdcPerXlm;
    // Belt-and-braces after F2 probe validation: if the math somehow
    // produces a non-finite value (probe.sourceAmount now guarantees a
    // finite number, but destXlm comes from the caller and could be
    // malformed in a future refactor), abort with a clear error rather
    // than let a silent NaN slip past `<`-comparison.
    if (!Number.isFinite(quoteUsdcPerXlm) || !Number.isFinite(xlmAtSendAmount)) {
      throw new Error(
        `sendUsdcAsXlm: slippage math produced non-finite value ` +
          `(sourceAmount=${probe.sourceAmount}, destXlm=${destXlm}, sendAmount=${sendAmount})`,
      );
    }
    if (xlmAtSendAmount < Number(destMin)) {
      throw new Error(
        `DEX would only deliver ${xlmAtSendAmount.toFixed(7)} XLM for ${sendAmount} USDC, ` +
          `below invoice floor ${destMin} XLM. Aborting without burning fees.`,
      );
    }
  }

  // Pin the probe's path so the submission uses the same route the probe
  // priced. Empty path only if the probe failed or reported a direct swap.
  const path = probe.ok ? probe.path : [];

  return submitWithRetry(
    (account) =>
      new TransactionBuilder(account, { fee: '200000', networkPassphrase: NETWORK_PASSPHRASE })
        // Op 1: swap USDC → XLM into our own treasury.
        .addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset: usdc,
            sendAmount,
            destination: treasuryAddress,
            destAsset: Asset.native(),
            destMin,
            path,
          }),
        )
        // Op 2: direct XLM payment of exactly the invoice amount to CTX.
        // This is the op CTX's watcher sees and matches against the invoice.
        .addOperation(
          Operation.payment({
            destination,
            asset: Asset.native(),
            amount: forwardAmount,
          }),
        )
        .addMemo(safeMemoText(memo))
        .setTimeout(120)
        .build(),
    keypair,
  );
}

// Parse a SEP-0007 stellar pay URI into { destination, amount, memo }.
// Accepts both `web+stellar:pay?` and `stellar:pay?` — the vcc-client
// response-shape validator accepts both schemes, so the parser must too
// or a legitimate invoice URL using the bare scheme would crash here
// after passing upstream validation.
function parseStellarPayUri(uri) {
  if (typeof uri !== 'string') return { destination: null, amount: null, memo: null };
  const withoutScheme = uri.replace(/^(web\+)?stellar:pay\?/i, '');
  if (withoutScheme === uri) {
    // The replace was a no-op — the URI didn't start with a known
    // scheme prefix. Returning nulls makes the caller trip the
    // "Invalid CTX payment URL" branch rather than silently parsing
    // an unrelated query string.
    return { destination: null, amount: null, memo: null };
  }
  const params = new URLSearchParams(withoutScheme);
  return {
    destination: params.get('destination'),
    amount: params.get('amount'),
    memo: params.get('memo'),
  };
}

// Micro-order threshold, in USD. USDC-paid orders below this value are
// paid to CTX directly out of the treasury's XLM float, bypassing the
// DEX swap. Rationale: at $0.02 USDC the DEX rate drift between probe
// and execution time (~0.075%) is larger than the 7-decimal Stellar
// precision gives us room to absorb — the agent's USDC arrives in
// exactly-right units so there's no cushion for slippage, and
// sendUsdcAsXlm's early-abort rejects the tx rather than burning fees
// on a doomed path_payment. For these tiny orders the absolute cost of
// the slippage is a fraction of a cent, so we eat it from treasury
// reserves. The agent's USDC stays in the treasury and we reconcile
// USDC→XLM in bulk periodically (bulk swaps have much better execution
// quality than per-order micro swaps). Orders at or above this
// threshold still go through the DEX. Configurable via env so ops can
// tune it without a redeploy once we have volume data.
const MICRO_ORDER_USD_THRESHOLD = parseFloat(process.env.MICRO_ORDER_USD_THRESHOLD || '0.20');

// Pay a CTX gift card invoice.
//
// The CTX invoice is always quoted in XLM (via a SEP-0007 `web+stellar:pay?`
// URI). Branching:
//
//   - If the agent paid cards402 in XLM, we just forward XLM from the
//     treasury (the agent's payment already landed there).
//   - If the agent paid cards402 in USDC and the order is >= the micro
//     threshold, we do a single atomic `PathPaymentStrictSend`: USDC →
//     DEX → XLM → CTX wallet. The treasury holds USDC from the agent's
//     payment and converts it just-in-time. `sendMax` is capped at the
//     order's full USDC amount.
//   - If the agent paid cards402 in USDC but the order is below the
//     micro threshold, we skip the DEX entirely and send CTX the XLM
//     straight out of the treasury float. The agent's USDC piles up in
//     the treasury for bulk reconciliation later.
//
// Returns the Stellar transaction hash.
/**
 * @param {string} paymentUrl
 * @param {{ paymentAsset?: string, maxUsdc?: string|number }} [opts]
 */
async function payCtxOrder(paymentUrl, opts = {}) {
  const { paymentAsset, maxUsdc } = opts;
  const { destination, amount, memo } = parseStellarPayUri(paymentUrl);
  if (!destination || !amount || !memo) {
    // Don't echo the raw URL in the error — VCC is the upstream and an
    // attacker-controlled string shouldn't end up verbatim in logs or
    // the order error column. A short prefix is enough for ops.
    throw new Error(`Invalid CTX payment URL: ${String(paymentUrl).slice(0, 32)}…`);
  }
  // Syntactic G-address check — protects against a malformed or
  // hostile paymentUrl redirecting treasury funds to "ATTACKER" or
  // similar. The vcc-client scheme validator only checks the URI
  // prefix, so this is the first place a bad destination would be
  // caught without it. Adversarial audit F1-xlm-sender.
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    bizEvent('ctx.invalid_destination', {
      payment_url_prefix: String(paymentUrl).slice(0, 24),
    });
    throw new Error('payCtxOrder: invalid destination address');
  }
  // Optional allowlist enforcement (F2-xlm-sender). If ops has pinned
  // CTX_DESTINATION_ALLOWLIST, any destination outside that set is
  // rejected regardless of what VCC returned — the emergency lockdown
  // for "VCC is compromised and issuing invoices to an attacker wallet".
  const allowlist = ctxDestinationAllowlist();
  if (allowlist && !allowlist.has(destination)) {
    bizEvent('ctx.destination_not_allowlisted', {
      destination: maskStellarAddress(destination),
    });
    throw new Error('payCtxOrder: destination not in CTX_DESTINATION_ALLOWLIST');
  }
  // Reject obviously-wrong amounts before we burn submission fees.
  assertValidStellarAmount(amount, 'payCtxOrder.amount');

  // Accept anything that contains 'usdc' as the USDC branch (legacy rows
  // use literal 'usdc'; newer ones may use 'usdc_soroban' or similar).
  const isUsdc = typeof paymentAsset === 'string' && /usdc/i.test(paymentAsset);

  if (isUsdc) {
    if (!maxUsdc || Number(maxUsdc) <= 0) {
      throw new Error(`payCtxOrder: paymentAsset=usdc requires maxUsdc > 0 (got ${maxUsdc})`);
    }

    // Micro-order fast path: for orders below the threshold, pay CTX
    // directly out of treasury XLM and leave the agent's USDC in the
    // treasury. See the MICRO_ORDER_USD_THRESHOLD comment above for
    // the reasoning.
    if (Number(maxUsdc) < MICRO_ORDER_USD_THRESHOLD) {
      log(
        'info',
        'xlm-sender: paying CTX via direct XLM from treasury (micro order, DEX bypassed)',
        {
          dest_xlm: amount,
          max_usdc: maxUsdc,
          threshold_usd: MICRO_ORDER_USD_THRESHOLD,
          destination: maskStellarAddress(destination),
        },
      );
      const txHash = await sendXlm({ destination, amount, memo });
      bizEvent('ctx.paid', {
        path: 'xlm_from_treasury_micro',
        amount_xlm: amount,
        max_usdc: maxUsdc,
        threshold_usd: MICRO_ORDER_USD_THRESHOLD,
        destination: maskStellarAddress(destination),
        tx_hash: txHash,
        memo_len: memo.length,
      });
      return txHash;
    }

    log('info', 'xlm-sender: paying CTX via USDC→XLM path payment', {
      dest_xlm: amount,
      max_usdc: maxUsdc,
      destination: maskStellarAddress(destination),
    });
    const txHash = await sendUsdcAsXlm({
      destination,
      destXlm: amount,
      maxUsdc,
      memo,
    });
    bizEvent('ctx.paid', {
      path: 'usdc_to_xlm',
      amount_xlm: amount,
      max_usdc: maxUsdc,
      destination: maskStellarAddress(destination),
      tx_hash: txHash,
      memo_len: memo.length,
    });
    return txHash;
  }

  log('info', 'xlm-sender: paying CTX', { amount, destination: maskStellarAddress(destination) });
  const txHash = await sendXlm({ destination, amount, memo });
  bizEvent('ctx.paid', {
    path: 'xlm_direct',
    amount_xlm: amount,
    destination: maskStellarAddress(destination),
    tx_hash: txHash,
    memo_len: memo.length,
  });
  return txHash;
}

// Mask a Stellar G-address as `GABC...XYZ` for logging. Never logs the
// middle bytes so a compromised log stream can't reconstruct the account.
function maskStellarAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 10) return '<invalid>';
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

module.exports = {
  sendUsdc,
  sendXlm,
  sendUsdcAsXlm,
  probeUsdcToXlmPath,
  parseStellarPayUri,
  payCtxOrder,
  // Exposed for unit tests — production callers should use the send*
  // helpers above, which set up the treasury keypair and operation shape.
  submitWithRetry,
  resolveNetworkErrorOutcome,
};
