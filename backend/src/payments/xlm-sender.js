// @ts-check
// Stellar payment helpers — sends USDC or XLM from the treasury wallet.
// Used for refunds to agents and for paying CTX.com gift card invoices.

const { Horizon, Keypair, TransactionBuilder, Networks, Operation, Asset, Memo } = require('@stellar/stellar-sdk');
const { log, event: bizEvent } = require('../lib/logger');

const NETWORK = process.env.STELLAR_NETWORK || 'mainnet';
const HORIZON_URL = NETWORK === 'mainnet' ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
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
  return submitWithRetry((account) =>
    new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: String(amount) }))
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

  const USDC_ISSUER = process.env.STELLAR_USDC_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const keypair = Keypair.fromSecret(secret);
  return submitWithRetry((account) =>
    new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.payment({ destination, asset: new Asset('USDC', USDC_ISSUER), amount: String(amount) }))
      .addMemo(memo ? Memo.text(String(memo).slice(0, 28)) : Memo.none())
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

// Pay a CTX gift card invoice by parsing the web+stellar:pay URI and sending XLM.
// Returns the Stellar transaction hash.
//
// Audit A-3: previously used unredacted `console.log` for both the outbound
// details and the landed txhash. Now emits a structured `ctx.paid` event
// so log aggregators can trace the payment without slurping free-text lines,
// and the destination is masked to its prefix + suffix so logs don't leak
// full CTX receiving accounts to third-party ingesters.
async function payCtxOrder(paymentUrl) {
  const { destination, amount, memo } = parseStellarPayUri(paymentUrl);
  if (!destination || !amount || !memo) {
    throw new Error(`Invalid CTX payment URL: ${paymentUrl}`);
  }
  log('info', 'xlm-sender: paying CTX', { amount, destination: maskStellarAddress(destination) });
  const txHash = await sendXlm({ destination, amount, memo });
  bizEvent('ctx.paid', {
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

module.exports = { sendUsdc, sendXlm, parseStellarPayUri, payCtxOrder };
