// MCP server entry. Exposed via `cards402` or `cards402 mcp` and
// dispatched through ./cli. Not intended to be imported as a module
// from anywhere else — the top-level Server setup registers handlers
// eagerly so any import runs the full initialisation path.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createOWSWallet,
  getOWSPublicKey,
  getOWSBalance,
  addUsdcTrustlineOWS,
  purchaseCardOWS,
} from './ows';
import { Cards402Client } from './client';
// Audit A-38: version string imported from package.json instead of hardcoded.
// The `with { type: 'json' }` import lets tsc emit a real assertion and
// bun/node24 load it as JSON.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION = require('../package.json').version as string;

const API_KEY = process.env.CARDS402_API_KEY ?? '';
const BASE_URL = process.env.CARDS402_BASE_URL ?? 'https://api.cards402.com/v1';
const OWS_WALLET_NAME = process.env.OWS_WALLET_NAME ?? '';
const OWS_WALLET_PASSPHRASE = process.env.OWS_WALLET_PASSPHRASE ?? undefined;
const OWS_VAULT_PATH = process.env.OWS_VAULT_PATH ?? undefined;

if (!API_KEY) {
  process.stderr.write('Warning: CARDS402_API_KEY is not set. Get one at https://cards402.com\n');
}

if (!OWS_WALLET_NAME) {
  process.stderr.write('Warning: OWS_WALLET_NAME is not set. Run setup_wallet for instructions.\n');
}

const server = new Server(
  { name: 'cards402', version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'purchase_vcc',
      description:
        'Purchase a prepaid Visa virtual card. Pay with USDC or XLM on Stellar. Returns card number, CVV, and expiry. Requires OWS_WALLET_NAME — run setup_wallet to configure.',
      inputSchema: {
        type: 'object',
        properties: {
          amount_usdc: {
            type: 'string',
            description: "Card value in USD, e.g. '10.00'",
          },
          payment_asset: {
            type: 'string',
            enum: ['usdc', 'xlm'],
            description: "Payment asset: 'usdc' (default) or 'xlm'",
          },
        },
        required: ['amount_usdc'],
      },
    },
    {
      name: 'setup_wallet',
      description:
        'Set up or inspect the OWS encrypted wallet used to pay cards402. Creates the wallet on first run. Shows public key and balances.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'check_order',
      description: 'Check the status of a cards402 order',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The cards402 order ID',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'check_budget',
      description:
        "Check this agent's spend summary — how much has been spent, the configured limit, and how much budget remains. Use this to report spending to your owner or to decide whether you can afford a card.",
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'setup_wallet') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: [
              'OWS_WALLET_NAME is not set.',
              '',
              'To configure your wallet:',
              '  1. Set OWS_WALLET_NAME=<name> in your MCP server environment',
              '  2. Optionally set OWS_WALLET_PASSPHRASE=<passphrase> for extra encryption',
              '  3. Optionally set OWS_VAULT_PATH=<path> to store the vault file at a custom location',
              '  4. Run setup_wallet to create the wallet and get your public key',
              '',
              'Also set CARDS402_API_KEY=<your key> (get one at cards402.com)',
            ].join('\n'),
          },
        ],
      };
    }

    try {
      let publicKey: string;
      let created = false;
      try {
        publicKey = getOWSPublicKey(OWS_WALLET_NAME, OWS_VAULT_PATH);
      } catch {
        const result = createOWSWallet(OWS_WALLET_NAME, OWS_WALLET_PASSPHRASE, OWS_VAULT_PATH);
        publicKey = result.publicKey;
        created = true;
      }

      const lines: string[] = [
        created ? 'OWS Wallet Created' : 'OWS Wallet',
        '',
        `Wallet name: ${OWS_WALLET_NAME}`,
        `Public key:  ${publicKey}`,
      ];

      let accountStatus = 'unknown';
      try {
        const bal = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
        const xlmNum = parseFloat(bal.xlm);
        const usdcNum = parseFloat(bal.usdc);

        if (xlmNum >= 2 && usdcNum === 0) {
          // Wallet is funded but no USDC trustline yet — add it automatically
          lines.push('');
          lines.push('USDC trustline: adding…');
          try {
            const txHash = await addUsdcTrustlineOWS({
              walletName: OWS_WALLET_NAME,
              passphrase: OWS_WALLET_PASSPHRASE,
              vaultPath: OWS_VAULT_PATH,
            });
            lines.push(`USDC trustline: added (txid: ${txHash})`);
            accountStatus = 'ready_no_usdc';
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            lines.push(`USDC trustline: could not add (${errMsg.slice(0, 120)})`);
            lines.push(
              '  This may mean the trustline already exists, or XLM balance is too low for fees.',
            );
            accountStatus = usdcNum > 0 ? 'ready' : 'funded_no_trustline';
          }
          // Re-fetch balance after trustline op
          try {
            const bal2 = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
            lines.push('');
            lines.push(`XLM balance:  ${bal2.xlm}`);
            lines.push(`USDC balance: ${bal2.usdc}`);
            lines.push('');
            lines.push('Status: Wallet ready. Fund with USDC to purchase cards with USDC,');
            lines.push('        or top up XLM to purchase with native XLM (no USDC needed).');
          } catch {
            lines.push('');
            lines.push(`XLM balance:  ${bal.xlm}`);
            lines.push(`USDC balance: ${bal.usdc}`);
          }
        } else if (xlmNum >= 2 && usdcNum > 0) {
          accountStatus = 'ready';
          lines.push('');
          lines.push(`XLM balance:  ${bal.xlm}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Ready to purchase cards.');
        } else if (xlmNum > 0 && xlmNum < 2) {
          accountStatus = 'low_xlm';
          lines.push('');
          lines.push(`XLM balance:  ${bal.xlm}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Account active but XLM balance is low.');
          lines.push('        Send at least 2 XLM total to cover reserves and fees.');
        } else {
          accountStatus = 'unfunded';
          lines.push('');
          lines.push(`XLM balance:  ${bal.xlm}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Account not yet funded. Send at least 2 XLM to activate.');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes('404') ||
          errMsg.toLowerCase().includes('not found') ||
          errMsg.includes('request failed')
        ) {
          // Account does not exist on-chain yet (not activated)
          accountStatus = 'not_activated';
          lines.push('');
          lines.push('Status: Account not activated (no on-chain balance).');
        } else {
          // Network error or Horizon outage — don't guess account state
          lines.push('');
          lines.push(`Status: Could not fetch balance (${errMsg.slice(0, 120)})`);
          lines.push('Check your network connection and try again.');
        }
      }

      lines.push('');
      lines.push('Environment variables:');
      lines.push(`  OWS_WALLET_NAME       — wallet identifier (set: "${OWS_WALLET_NAME}")`);
      lines.push(
        `  OWS_WALLET_PASSPHRASE — encryption passphrase (${OWS_WALLET_PASSPHRASE ? 'set' : 'not set'})`,
      );
      lines.push(
        `  OWS_VAULT_PATH        — vault file path (${OWS_VAULT_PATH ?? 'default: ~/.ows/vault'})`,
      );
      lines.push('  CARDS402_API_KEY      — your cards402 API key');

      if (accountStatus === 'not_activated' || accountStatus === 'unfunded') {
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('ACTION REQUIRED — copy this block and send it to your human operator');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push('Your AI agent has a Stellar wallet that needs funding before it can');
        lines.push('purchase cards. Please send XLM to the address below.');
        lines.push('');
        lines.push(`  Wallet address:  ${publicKey}`);
        lines.push('  (copy the G... address exactly — it is case-sensitive)');
        lines.push('');
        lines.push('  How much to send:');
        lines.push('    Recommended (for a $10 card, XLM payment):  ~72 XLM');
        lines.push('      ↳ 2 XLM  — activates the account (required minimum)');
        lines.push('      ↳ ~70 XLM — covers a $10 card at current rates (~$0.14/XLM)');
        lines.push('    Recommended (for a $10 card, USDC payment): 2 XLM + $10 USDC');
        lines.push('      ↳ Send 2 XLM first to activate, then send USDC separately');
        lines.push('');
        lines.push('  Where to get XLM:');
        lines.push('    Coinbase: coinbase.com → Buy XLM → Send → paste address above');
        lines.push('    Lobstr:   lobstr.co → Buy XLM → Send → paste address above');
        lines.push('    Kraken:   kraken.com → Buy XLM → Withdraw (Stellar) → paste address');
        lines.push('');
        lines.push('  After sending: tell your agent to run setup_wallet again to confirm.');
        lines.push('──────────────────────────────────────────────────────────────────');
      } else if (accountStatus === 'low_xlm') {
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('ACTION REQUIRED — wallet needs more XLM');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push(`  Wallet address:  ${publicKey}`);
        lines.push('');
        lines.push('  Send at least 2 XLM total to cover Stellar reserves and fees.');
        lines.push('  For a $10 card with XLM payment, send ~72 XLM total.');
        lines.push('──────────────────────────────────────────────────────────────────');
      } else if (accountStatus === 'ready_no_usdc') {
        lines.push('');
        lines.push('Next steps:');
        lines.push(`  Wallet address: ${publicKey}`);
        lines.push('');
        lines.push('  To pay with XLM (recommended):');
        lines.push('    Send more XLM to the address above, then call:');
        lines.push('    purchase_vcc { amount_usdc: "10.00", payment_asset: "xlm" }');
        lines.push('');
        lines.push('  To pay with USDC:');
        lines.push('    Send USDC to the address above (trustline is already set up), then call:');
        lines.push('    purchase_vcc { amount_usdc: "10.00", payment_asset: "usdc" }');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error in setup_wallet: ${message}` }],
        isError: true,
      };
    }
  }

  if (!API_KEY) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: CARDS402_API_KEY environment variable is not set. Get your API key at https://cards402.com',
        },
      ],
      isError: true,
    };
  }

  if (name === 'purchase_vcc') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: OWS_WALLET_NAME is not set. Run setup_wallet for configuration instructions.',
          },
        ],
        isError: true,
      };
    }

    // Validate and extract args explicitly — never trust MCP client types
    const rawArgs = args as Record<string, unknown>;
    const amount_usdc = String(rawArgs.amount_usdc ?? '').trim();
    const raw_asset = String(rawArgs.payment_asset ?? 'usdc').toLowerCase();

    if (!/^\d+(\.\d{1,8})?$/.test(amount_usdc) || parseFloat(amount_usdc) <= 0) {
      return {
        content: [
          { type: 'text', text: 'Error: amount_usdc must be a positive number, e.g. "10.00"' },
        ],
        isError: true,
      };
    }
    if (raw_asset !== 'usdc' && raw_asset !== 'xlm') {
      return {
        content: [{ type: 'text', text: 'Error: payment_asset must be "usdc" or "xlm"' }],
        isError: true,
      };
    }
    const payment_asset = raw_asset as 'usdc' | 'xlm';

    // Pre-purchase balance check — give a specific, actionable error before
    // attempting the payment so the agent isn't left guessing.
    try {
      const balance = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
      const publicKey = getOWSPublicKey(OWS_WALLET_NAME, OWS_VAULT_PATH);
      const xlmNum = parseFloat(balance.xlm);
      const usdcNum = parseFloat(balance.usdc);
      const amountNum = parseFloat(amount_usdc);

      if (payment_asset === 'usdc') {
        if (usdcNum < amountNum) {
          const shortfall = (amountNum - usdcNum).toFixed(2);
          return {
            content: [
              {
                type: 'text',
                text: [
                  'Insufficient USDC balance.',
                  '',
                  `  You have:    ${balance.usdc} USDC`,
                  `  You need:    ${amount_usdc} USDC`,
                  `  Shortfall:   ${shortfall} USDC`,
                  '',
                  `Send USDC to your wallet address:`,
                  `  ${publicKey}`,
                  '',
                  'After funding, run purchase_vcc again.',
                  'Or switch to XLM payment: purchase_vcc { payment_asset: "xlm" }',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }
      } else {
        // XLM: we do not know the exact rate yet (quote comes from the order),
        // but we can gate on a hard floor of 3 XLM (2 reserve + 1 margin) to
        // catch obviously-unfunded wallets before hitting the API.
        if (xlmNum < 3) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  'XLM balance is too low to purchase a card.',
                  '',
                  `  You have:  ${balance.xlm} XLM`,
                  `  Minimum:   3 XLM (for Stellar reserves and fees alone)`,
                  `  Typical:   ~${Math.ceil(amountNum / 0.14 + 2)} XLM for a $${amount_usdc} card at ~$0.14/XLM`,
                  '',
                  'The exact XLM amount is quoted when the order is created.',
                  '',
                  `Send XLM to your wallet address:`,
                  `  ${publicKey}`,
                  '',
                  'Where to get XLM:',
                  '  Coinbase:  coinbase.com → Buy XLM → Send',
                  '  Lobstr:    lobstr.co → Buy XLM → Send',
                  '',
                  'After funding, run purchase_vcc again.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }
      }
    } catch {
      // Could not fetch balance (wallet not activated, network error, etc.) —
      // let purchaseCardOWS proceed and surface the error with full context.
    }

    try {
      const card = await purchaseCardOWS({
        apiKey: API_KEY,
        walletName: OWS_WALLET_NAME,
        amountUsdc: amount_usdc,
        paymentAsset: payment_asset,
        passphrase: OWS_WALLET_PASSPHRASE,
        vaultPath: OWS_VAULT_PATH,
        baseUrl: BASE_URL,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              'Virtual Visa Card Ready',
              '',
              `Number: ${card.number}`,
              `CVV:    ${card.cvv}`,
              `Expiry: ${card.expiry}`,
              `Brand:  ${card.brand ?? 'Visa'}`,
              '',
              `Order ID: ${card.order_id}`,
              '',
              'This is a one-time use virtual card. Keep these details safe.',
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      // Only expose typed API errors — other errors may contain internal details
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Purchase failed';
      return {
        content: [{ type: 'text', text: `Error purchasing card: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_order') {
    // Validate order_id before using it in a URL path
    const rawOrderId = String((args as Record<string, unknown>).order_id ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawOrderId)) {
      return {
        content: [{ type: 'text', text: 'Error: invalid order ID format' }],
        isError: true,
      };
    }
    const order_id = rawOrderId;

    try {
      const client = new Cards402Client({ apiKey: API_KEY, baseUrl: BASE_URL });
      const order = await client.getOrder(order_id);

      const lines = [
        `Order: ${order.order_id}`,
        `Status: ${order.status} (phase: ${order.phase})`,
        `Amount: $${order.amount_usdc} USDC`,
        `Asset: ${order.payment_asset}`,
        `Created: ${order.created_at}`,
        `Updated: ${order.updated_at}`,
      ];
      if (order.phase === 'ready' && order.card) {
        lines.push('');
        lines.push('Card details:');
        lines.push(`  Number: ${order.card.number}`);
        lines.push(`  CVV:    ${order.card.cvv}`);
        lines.push(`  Expiry: ${order.card.expiry}`);
        lines.push(`  Brand:  ${order.card.brand ?? 'Visa'}`);
      }
      if (order.error) {
        lines.push('');
        lines.push(`Error: ${order.error}`);
      }
      if (order.refund) {
        lines.push(`Refund txid: ${order.refund.stellar_txid}`);
      }
      if (order.note) {
        lines.push(`Note: ${order.note}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error checking order: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_budget') {
    try {
      const client = new Cards402Client({ apiKey: API_KEY, baseUrl: BASE_URL });
      const usage = await client.getUsage();
      const { budget, orders, label } = usage;
      const lines = [
        `Budget summary${label ? ` for "${label}"` : ''}`,
        '',
        `Spent:     $${budget.spent_usdc} USDC`,
        budget.limit_usdc ? `Limit:     $${budget.limit_usdc} USDC` : 'Limit:     unlimited',
        budget.remaining_usdc !== null
          ? `Remaining: $${budget.remaining_usdc} USDC`
          : 'Remaining: unlimited',
        '',
        `Orders — total: ${orders.total}, delivered: ${orders.delivered}, failed: ${orders.failed}, refunded: ${orders.refunded}, in progress: ${orders.in_progress}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error checking budget: ${message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
