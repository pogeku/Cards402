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
} = require('@stellar/stellar-sdk');
const { log, event: bizEvent } = require('../lib/logger');

const NETWORK = process.env.STELLAR_NETWORK || 'mainnet';
const HORIZON_URL =
  NETWORK === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

const server = new Horizon.Server(HORIZON_URL);

// Retry a Stellar transaction on sequence number mismatch (concurrent sends).
async function submitWithRetry(buildTx, keypair, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const account = await server.loadAccount(keypair.publicKey());
    const tx = buildTx(account);
    tx.sign(keypair);
    try {
      const result = await server.submitTransaction(tx);
      return result.hash;
    } catch (err) {
      const code = err?.response?.data?.extras?.result_codes?.transaction;
      if (code === 'tx_bad_seq' && attempt < maxAttempts) {
        // Sequence was stale — reload account and retry
        continue;
      }
      throw err;
    }
  }
}

// Send XLM from the treasury wallet (used for XLM refunds)
async function sendXlm({ destination, amount, memo }) {
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret) throw new Error('STELLAR_XLM_SECRET not set');

  if (memo && Buffer.byteLength(memo, 'utf8') > 28) {
    throw new Error(`Memo exceeds 28-byte Stellar limit: ${memo}`);
  }

  const keypair = Keypair.fromSecret(secret);
  return submitWithRetry(
    (account) =>
      new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(
          Operation.payment({ destination, asset: Asset.native(), amount: String(amount) }),
        )
        .addMemo(Memo.text(memo))
        .setTimeout(120)
        .build(),
    keypair,
  );
}

// Send USDC from the treasury wallet (used for USDC refunds)
async function sendUsdc({ destination, amount, memo }) {
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret) throw new Error('STELLAR_XLM_SECRET not set');

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
        .addMemo(memo ? Memo.text(String(memo).slice(0, 28)) : Memo.none())
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
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const body = await res.json();
    const records = body?._embedded?.records || [];
    if (!records.length) return { ok: false, reason: 'no_path' };
    // Horizon already returns records sorted by source_amount ascending.
    const best = records[0];
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

// Atomic USDC→XLM swap + send to a specific XLM destination. One Stellar
// tx: PathPaymentStrictReceive pulls USDC from the treasury, routes
// through the DEX, and delivers exactly `destXlm` XLM to `destination`.
// Caps the USDC spent at `maxUsdc` — if slippage would push the cost
// past that, the tx fails atomically (no partial spend, no stuck state).
async function sendUsdcAsXlm({ destination, destXlm, maxUsdc, memo }) {
  const secret = process.env.STELLAR_XLM_SECRET;
  if (!secret) throw new Error('STELLAR_XLM_SECRET not set');

  if (memo && Buffer.byteLength(memo, 'utf8') > 28) {
    throw new Error(`Memo exceeds 28-byte Stellar limit: ${memo}`);
  }

  const USDC_ISSUER =
    process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const usdc = new Asset('USDC', USDC_ISSUER);
  const keypair = Keypair.fromSecret(secret);

  // Probe the DEX for book health AND the concrete path Horizon would use.
  // We pin the returned path on the actual submission so Core's in-core
  // pathfinder can't silently pick a more expensive route at ledger-close
  // time (root cause of the 2026-04-14 op_over_source_max failures).
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

  // Business rule: accept up to 1% slippage above the order's face value.
  // sendMax is the absolute ceiling on USDC spent by the treasury for this
  // path payment, expressed in Stellar's 7-decimal precision.
  const SLIPPAGE_FACTOR = 1.01;
  const sendMaxLimit = (Number(maxUsdc) * SLIPPAGE_FACTOR).toFixed(7);
  if (probe.ok && Number(probe.sourceAmount) > Number(sendMaxLimit)) {
    throw new Error(
      `DEX quote ${probe.sourceAmount} USDC exceeds 1% slippage budget ${sendMaxLimit} ` +
        `(face value ${maxUsdc}) — path payment would fail. Aborting without burning fees.`,
    );
  }

  // Pin the probe's path on the operation so the submission uses the same
  // route the probe priced. Empty path only if the probe failed or reported
  // a direct swap (no intermediate hops).
  const path = probe.ok ? probe.path : [];

  return submitWithRetry(
    (account) =>
      new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: usdc,
            sendMax: sendMaxLimit,
            destination,
            destAsset: Asset.native(),
            destAmount: String(destXlm),
            path,
          }),
        )
        .addMemo(Memo.text(memo))
        .setTimeout(120)
        .build(),
    keypair,
  );
}

// Parse a web+stellar:pay URI (SEP-0007) into { destination, amount, memo }
function parseStellarPayUri(uri) {
  const raw = uri.replace('web+stellar:pay?', '');
  const params = new URLSearchParams(raw);
  return {
    destination: params.get('destination'),
    amount: params.get('amount'),
    memo: params.get('memo'),
  };
}

// Pay a CTX gift card invoice.
//
// The CTX invoice is always quoted in XLM (via a SEP-0007 `web+stellar:pay?`
// URI). Branching:
//
//   - If the agent paid cards402 in XLM, we just forward XLM from the
//     treasury (the agent's payment already landed there).
//   - If the agent paid cards402 in USDC, we do a single atomic
//     `PathPaymentStrictReceive`: USDC → DEX → XLM → CTX wallet. The
//     treasury holds USDC from the agent's payment and converts it
//     just-in-time. `sendMax` is capped at the order's full USDC amount,
//     since CTX prices include a ~4.5% merchant discount that comfortably
//     absorbs DEX slippage + fees.
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
    throw new Error(`Invalid CTX payment URL: ${paymentUrl}`);
  }

  // Accept anything that contains 'usdc' as the USDC branch (legacy rows
  // use literal 'usdc'; newer ones may use 'usdc_soroban' or similar).
  const isUsdc = typeof paymentAsset === 'string' && /usdc/i.test(paymentAsset);

  if (isUsdc) {
    if (!maxUsdc || Number(maxUsdc) <= 0) {
      throw new Error(`payCtxOrder: paymentAsset=usdc requires maxUsdc > 0 (got ${maxUsdc})`);
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
};
