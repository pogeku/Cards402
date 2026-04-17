// Unit tests for backend/src/payments/verify-stellar-payment.js
//
// The verifier is pure (no DB, no logging), so tests inject a fake
// rpc.Server and fake xdr.ContractEvent-shaped objects. We don't
// exercise the real Stellar SDK event decoding here — parsePaymentEvent
// has its own coverage in stellar-watcher.test.js.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { xdr, Address, nativeToScVal, Keypair, StrKey } = require('@stellar/stellar-sdk');

const {
  verifyStellarPayment,
  normalizeDecimal,
} = require('../../src/payments/verify-stellar-payment');

// Generate two valid contract StrKeys for the tests — any 32-byte buffer
// encodes into a valid contract address, and we only care about shape here.
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));

// Build a mock xdr.ContractEvent. The verifier calls:
//   evt.contractId() → Buffer
//   evt.body().v0() → { topics(), data() }
function makeContractEvent({
  contractId = CONTRACT_ID,
  symbol = 'pay_usdc',
  orderId = 'mpp_c_test',
  from = Keypair.random().publicKey(),
  amount = 1_000_000n, // 0.1 USDC
}) {
  const topics = [
    xdr.ScVal.scvSymbol(symbol),
    nativeToScVal(Buffer.from(orderId, 'utf-8'), { type: 'bytes' }),
    new Address(from).toScVal(),
  ];
  const data = nativeToScVal(amount, { type: 'i128' });

  const contractIdBuf = StrKey.decodeContract(contractId);

  return {
    contractId: () => contractIdBuf,
    body: () => ({
      v0: () => ({
        topics: () => topics,
        data: () => data,
      }),
    }),
  };
}

function makeRpcServer(txResponse) {
  return {
    getTransaction: async () => txResponse,
  };
}

describe('verifyStellarPayment — terminal tx states', () => {
  it('NOT_FOUND → pending (client can retry)', async () => {
    const rpcServer = makeRpcServer({ status: 'NOT_FOUND' });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'pending');
  });

  it('FAILED → failed', async () => {
    const rpcServer = makeRpcServer({
      status: 'FAILED',
      ledger: 1,
      events: { contractEventsXdr: [] },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'failed');
  });

  it('RPC throw → rpc_error (client should treat as pending and retry)', async () => {
    const rpcServer = {
      getTransaction: async () => {
        throw new Error('socket hang up');
      },
    };
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'rpc_error');
    assert.match(result.error, /socket hang up/);
  });
});

describe('verifyStellarPayment — SUCCESS path', () => {
  it('verifies a matching pay_usdc event', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1_234_567,
      createdAt: 1_700_000_000,
      events: {
        contractEventsXdr: [[makeContractEvent({ amount: 1_000_000n })]], // 0.1 USDC
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.payload.paymentAsset, 'usdc_soroban');
    assert.equal(result.payload.amountUsdc, '0.1000000');
    assert.equal(result.payload.orderId, 'mpp_c_test');
    assert.equal(result.tx.ledger, 1_234_567);
  });

  it('verifies a matching pay_xlm event', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1_234_567,
      createdAt: 1_700_000_000,
      events: {
        contractEventsXdr: [
          [makeContractEvent({ symbol: 'pay_xlm', amount: 50_000_000n })], // 5 XLM
        ],
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'xlm',
      expectedAmount: '5',
      rpcServer,
    });
    assert.equal(result.status, 'verified');
    assert.equal(result.payload.paymentAsset, 'xlm_soroban');
    assert.equal(result.payload.amountXlm, '5.0000000');
  });

  it('no matching contract events → not_our_contract', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1_234_567,
      createdAt: 1_700_000_000,
      events: {
        contractEventsXdr: [[makeContractEvent({ contractId: OTHER_CONTRACT_ID })]],
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'not_our_contract');
  });

  it('no events at all → not_our_contract', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1,
      createdAt: 1,
      events: { contractEventsXdr: [] },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'not_our_contract');
  });
});

describe('verifyStellarPayment — mismatch detection', () => {
  it('order id mismatch', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1,
      createdAt: 1,
      events: {
        contractEventsXdr: [[makeContractEvent({ orderId: 'wrong_id', amount: 1_000_000n })]],
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'expected_id',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'mismatch');
    assert.match(result.reason, /order_id_mismatch/);
  });

  it('asset mismatch: expected usdc, got xlm', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1,
      createdAt: 1,
      events: {
        contractEventsXdr: [[makeContractEvent({ symbol: 'pay_xlm', amount: 1_000_000n })]],
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '0.10',
      rpcServer,
    });
    assert.equal(result.status, 'mismatch');
    assert.match(result.reason, /asset_mismatch/);
  });

  it('amount mismatch: expected 10, got 5', async () => {
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1,
      createdAt: 1,
      events: {
        contractEventsXdr: [[makeContractEvent({ amount: 50_000_000n })]], // 5 USDC
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '10',
      rpcServer,
    });
    assert.equal(result.status, 'mismatch');
    assert.match(result.reason, /amount_mismatch/);
  });

  it('amount equality tolerates trailing-zero differences', async () => {
    // Challenge asked for "10.00", on-chain amount comes back as "10.0000000"
    const rpcServer = makeRpcServer({
      status: 'SUCCESS',
      ledger: 1,
      createdAt: 1,
      events: {
        contractEventsXdr: [[makeContractEvent({ amount: 100_000_000n })]], // 10 USDC
      },
    });
    const result = await verifyStellarPayment({
      txHash: 'ab'.repeat(32),
      expectedContractId: CONTRACT_ID,
      expectedOrderId: 'mpp_c_test',
      expectedAsset: 'usdc',
      expectedAmount: '10.00',
      rpcServer,
    });
    assert.equal(result.status, 'verified');
  });
});

describe('normalizeDecimal', () => {
  it('strips trailing zeros', () => {
    assert.equal(normalizeDecimal('10.00'), '10');
    assert.equal(normalizeDecimal('10.0000000'), '10');
    assert.equal(normalizeDecimal('10.5000000'), '10.5');
  });
  it('leaves integer-only unchanged', () => {
    assert.equal(normalizeDecimal('10'), '10');
  });
  it('rejects non-decimal strings by passing them through', () => {
    // Not meant to be a validator — just passes through so equality
    // comparison fails loudly for anything non-decimal.
    assert.equal(normalizeDecimal('abc'), 'abc');
  });
});
