// Tests for sdk/src/mpp.ts — MPP client helper.
//
// Injects stub fetch + stub payViaContractOWS so the test doesn't
// need a real server or OWS wallet. Verifies the wire sequence:
// 402 → pay → retry with Authorization: Payment → 200 or 202+poll.

import { describe, it, expect } from 'vitest';
import { mppCharge, type MppChargeOpts } from '../mpp';

type Body = Record<string, unknown>;

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function buildFetchStub(
  steps: Array<() => { status: number; body: Body; headers?: Record<string, string> }>,
): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let stepIdx = 0;
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const step = steps[Math.min(stepIdx, steps.length - 1)];
    stepIdx += 1;
    const { status, body, headers = {} } = step();
    return {
      status,
      headers: new Headers(headers),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: stub, calls };
}

function mockChallengeBody(overrides: Partial<Body> = {}): Body {
  return {
    error: 'payment_required',
    protocol: 'mpp/1.0',
    challenge_id: 'mpp_c_test123',
    amount: { value: '10.00', currency: 'USD' },
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    methods: [
      {
        scheme: 'stellar',
        kind: 'soroban_contract',
        contract_id: 'CAFEBABEDEADBEEF',
        function: 'pay_usdc',
        asset: 'USDC:GA5...',
        amount: '10.00',
        amount_stroops: '100000000',
        memo_field: 'order_id',
        memo_value: 'mpp_c_test123',
      },
    ],
    retry_url: '/v1/cards/visa/10.00',
    ...overrides,
  };
}

describe('mppCharge — happy path', () => {
  it('runs the 402 → pay → 200 sequence and returns card details', async () => {
    const { fetch: fetchStub, calls } = buildFetchStub([
      // First call: 402 with challenge
      () => ({
        status: 402,
        body: mockChallengeBody(),
      }),
      // Second call: 200 with card
      () => ({
        status: 200,
        body: {
          state: 'delivered',
          order_id: 'order-uuid-1',
          challenge_id: 'mpp_c_test123',
          tx_hash: 'ab'.repeat(32),
          card: {
            number: '4111111111110000',
            cvv: '123',
            expiry: '12/27',
            brand: 'USD Visa Card',
          },
        },
      }),
    ]);

    const payCalls: unknown[] = [];
    const stubPay = async (opts: unknown) => {
      payCalls.push(opts);
      return 'ab'.repeat(32); // fake tx hash
    };

    const result = await mppCharge({
      url: 'https://api.cards402.test/v1/cards/visa/10.00',
      walletName: 'test-wallet',
      _deps: {
        fetch: fetchStub,
        payViaContractOWS: stubPay as never,
      },
    });

    expect(result.delivery).toBe('sync');
    expect(result.orderId).toBe('order-uuid-1');
    expect(result.card.number).toBe('4111111111110000');
    expect(result.txHash).toBe('ab'.repeat(32));

    // Two fetches: challenge + credentialed retry.
    expect(calls.length).toBe(2);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[1].headers.Authorization).toMatch(/^Payment scheme="stellar"/);
    expect(calls[1].headers.Authorization).toContain('tx_hash="' + 'ab'.repeat(32) + '"');
  });

  it('passes paymentAsset through to payViaContractOWS', async () => {
    const { fetch: fetchStub } = buildFetchStub([
      () => ({
        status: 402,
        body: mockChallengeBody({
          methods: [
            {
              scheme: 'stellar',
              kind: 'soroban_contract',
              contract_id: 'CAFEBABE',
              function: 'pay_usdc',
              asset: 'USDC:G...',
              amount: '10.00',
            },
            {
              scheme: 'stellar',
              kind: 'soroban_contract',
              contract_id: 'CAFEBABE',
              function: 'pay_xlm',
              asset: 'native',
              amount: '33.3333',
            },
          ],
        }),
      }),
      () => ({
        status: 200,
        body: {
          order_id: 'o1',
          challenge_id: 'mpp_c_test123',
          tx_hash: 'aa'.repeat(32),
          card: { number: '4', cvv: '1', expiry: '1/1', brand: 'Visa' },
        },
      }),
    ]);

    let seenAsset: string | undefined;
    const stubPay = async (opts: { paymentAsset?: string }) => {
      seenAsset = opts.paymentAsset;
      return 'aa'.repeat(32);
    };

    await mppCharge({
      url: 'https://x/v1/cards/visa/10.00',
      walletName: 'w',
      paymentAsset: 'xlm',
      _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never },
    });

    expect(seenAsset).toBe('xlm');
  });
});

describe('mppCharge — async 202 path', () => {
  it('polls the receipt URL until 200', async () => {
    const { fetch: fetchStub } = buildFetchStub([
      // 402 challenge
      () => ({ status: 402, body: mockChallengeBody() }),
      // retry → 202 + Location
      () => ({
        status: 202,
        body: {
          state: 'fulfilling',
          receipt_id: 'mpp_r_abc',
          order_id: 'o1',
          poll_url: '/v1/mpp/receipts/mpp_r_abc',
        },
      }),
      // first poll → still fulfilling
      () => ({
        status: 202,
        body: { state: 'fulfilling', receipt_id: 'mpp_r_abc', order_id: 'o1' },
      }),
      // second poll → delivered
      () => ({
        status: 200,
        body: {
          state: 'delivered',
          receipt_id: 'mpp_r_abc',
          order_id: 'o1',
          card: { number: '4', cvv: '1', expiry: '1/1', brand: 'Visa' },
        },
      }),
    ]);

    const stubPay = async () => 'cc'.repeat(32);
    const sleep = async (_ms: number) => {};

    const result = await mppCharge({
      url: 'https://api.cards402.test/v1/cards/visa/10.00',
      walletName: 'w',
      _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never, sleep },
    });

    expect(result.delivery).toBe('async');
    expect(result.card.number).toBe('4');
    expect(result.receiptUrl).toBe('https://api.cards402.test/v1/mpp/receipts/mpp_r_abc');
  });

  it('throws on 502 from receipt endpoint', async () => {
    const { fetch: fetchStub } = buildFetchStub([
      () => ({ status: 402, body: mockChallengeBody() }),
      () => ({
        status: 202,
        body: { receipt_id: 'mpp_r_x', order_id: 'o', poll_url: '/r/x' },
      }),
      () => ({
        status: 502,
        body: { state: 'failed', message: 'CTX timed out' },
      }),
    ]);
    const stubPay = async () => 'dd'.repeat(32);
    await expect(
      mppCharge({
        url: 'https://x/v1/cards/visa/1.00',
        walletName: 'w',
        _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never, sleep: async () => {} },
      }),
    ).rejects.toThrow(/CTX timed out/);
  });
});

describe('mppCharge — errors', () => {
  it('rejects non-402 challenge response', async () => {
    const { fetch: fetchStub } = buildFetchStub([() => ({ status: 500, body: { oops: 1 } })]);
    const stubPay = async () => 'ee'.repeat(32);
    await expect(
      mppCharge({
        url: 'https://x/v1/cards/visa/1.00',
        walletName: 'w',
        _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never },
      }),
    ).rejects.toThrow(/expected 402 challenge/);
  });

  it('rejects unsupported protocol version', async () => {
    const { fetch: fetchStub } = buildFetchStub([
      () => ({ status: 402, body: mockChallengeBody({ protocol: 'mpp/999' }) }),
    ]);
    const stubPay = async () => 'ff'.repeat(32);
    await expect(
      mppCharge({
        url: 'https://x/v1/cards/visa/1.00',
        walletName: 'w',
        _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never },
      }),
    ).rejects.toThrow(/unsupported MPP protocol/);
  });

  it('rejects non-soroban methods', async () => {
    const { fetch: fetchStub } = buildFetchStub([
      () => ({
        status: 402,
        body: mockChallengeBody({
          methods: [
            {
              scheme: 'stellar',
              kind: 'classic_payment',
              contract_id: '',
              function: 'pay_usdc',
              asset: 'USDC',
              amount: '10.00',
            },
          ],
        }),
      }),
    ]);
    const stubPay = async () => 'aa'.repeat(32);
    await expect(
      mppCharge({
        url: 'https://x/v1/cards/visa/10.00',
        walletName: 'w',
        _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never },
      }),
    ).rejects.toThrow(/only soroban_contract stellar methods supported/);
  });

  it('requires either url or baseUrl+amountUsdc', async () => {
    await expect(mppCharge({ walletName: 'w' } as MppChargeOpts)).rejects.toThrow(
      /either `url`, or both/,
    );
  });
});

describe('mppCharge — url resolution', () => {
  it('builds the URL from baseUrl + amountUsdc', async () => {
    const { fetch: fetchStub, calls } = buildFetchStub([
      () => ({ status: 402, body: mockChallengeBody() }),
      () => ({
        status: 200,
        body: {
          order_id: 'o',
          challenge_id: 'mpp_c_test123',
          tx_hash: 'aa'.repeat(32),
          card: { number: '4', cvv: '1', expiry: '1/1', brand: 'Visa' },
        },
      }),
    ]);
    const stubPay = async () => 'aa'.repeat(32);

    await mppCharge({
      baseUrl: 'https://api.cards402.test/v1/',
      amountUsdc: '10.00',
      walletName: 'w',
      _deps: { fetch: fetchStub, payViaContractOWS: stubPay as never },
    });

    expect(calls[0].url).toBe('https://api.cards402.test/v1/cards/visa/10.00');
  });
});
