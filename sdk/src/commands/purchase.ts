// `cards402 purchase --amount 10 [--asset xlm|usdc]` — one-command
// card purchase. Loads creds from the on-disk config written by
// `cards402 onboard`, opens the order, pays the Soroban contract
// from the local OWS wallet, waits for the SSE stream to report
// the card ready, and prints the card details.
//
// Designed so the cautious-agent flow is a single shell invocation:
// the agent doesn't have to write any JavaScript or guess at the
// SDK surface area.
//
// Resume: if a purchase fails mid-flight (Soroban RPC timeout, network
// blip, etc.), the order id is saved to ~/.cards402/last-order and the
// user can retry with `cards402 purchase --resume <order-id>`.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadCards402Config } from '../config';
import { purchaseCardOWS } from '../ows';
import { ResumableError, OrderFailedError } from '../errors';

interface PurchaseArgs {
  amount?: string;
  asset?: 'xlm' | 'usdc';
  walletName?: string;
  vaultPath?: string;
  passphraseEnv?: string;
  resume?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): PurchaseArgs {
  const out: PurchaseArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '-a' || arg === '--amount') out.amount = argv[++i];
    else if (arg.startsWith('--amount=')) out.amount = arg.slice('--amount='.length);
    else if (arg === '--asset') {
      const v = argv[++i];
      if (v === 'xlm' || v === 'usdc') out.asset = v;
    } else if (arg.startsWith('--asset=')) {
      const v = arg.slice('--asset='.length);
      if (v === 'xlm' || v === 'usdc') out.asset = v;
    } else if (arg === '--wallet-name') out.walletName = argv[++i];
    else if (arg.startsWith('--wallet-name=')) out.walletName = arg.slice('--wallet-name='.length);
    else if (arg === '--vault-path') out.vaultPath = argv[++i];
    else if (arg.startsWith('--vault-path=')) out.vaultPath = arg.slice('--vault-path='.length);
    else if (arg === '--passphrase-env') out.passphraseEnv = argv[++i];
    else if (arg.startsWith('--passphrase-env='))
      out.passphraseEnv = arg.slice('--passphrase-env='.length);
    else if (arg === '--resume') out.resume = argv[++i];
    else if (arg.startsWith('--resume=')) out.resume = arg.slice('--resume='.length);
  }
  return out;
}

function usage(): void {
  process.stderr.write(`Usage: cards402 purchase --amount <USDC> [--asset xlm|usdc]
       cards402 purchase --resume <order-id>

Buys a virtual Visa card for the given USD value using the credentials
and wallet set up by 'cards402 onboard'. Reads ~/.cards402/config.json
for the api key, wallet name, vault path, and passphrase env var.

Options:
  -a, --amount <USDC>        Card value in USD. Required for new purchases.
  --asset xlm|usdc           Which asset to pay with. Default: xlm
  --wallet-name <name>       Override the wallet name from config.json
  --vault-path <path>        Override the vault path from config.json
  --passphrase-env <ENVNAME> Override the passphrase env var from config.json.
                             The passphrase value is read from process.env at
                             call time and never logged.
  --resume <order-id>        Resume a purchase that failed mid-flight. Omit --amount.
  -h, --help                 Show this message

Examples:
  cards402 purchase --amount 10                 # $10 card paid in XLM
  cards402 purchase --amount 5 --asset usdc
  cards402 purchase --resume a94d18cc-...       # pick up an interrupted purchase
`);
}

function lastOrderFile(): string {
  const dir = process.env.CARDS402_CONFIG_DIR || path.join(os.homedir(), '.cards402');
  return path.join(dir, 'last-order');
}

function saveLastOrder(orderId: string): void {
  try {
    const p = lastOrderFile();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, orderId + '\n', { mode: 0o600 });
  } catch {
    /* non-fatal */
  }
}

function clearLastOrder(): void {
  try {
    fs.unlinkSync(lastOrderFile());
  } catch {
    /* non-fatal */
  }
}

function printCard(card: {
  number: string;
  cvv: string;
  expiry: string;
  brand: string | null;
  order_id: string;
}): void {
  process.stdout.write('\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(' Card delivered\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(`  Number: ${card.number}\n`);
  process.stdout.write(`  CVV:    ${card.cvv}\n`);
  process.stdout.write(`  Expiry: ${card.expiry}\n`);
  if (card.brand) process.stdout.write(`  Brand:  ${card.brand}\n`);
  process.stdout.write(`  Order:  ${card.order_id}\n`);
  process.stdout.write('\n');
  process.stdout.write(
    'The card details above are sensitive — save them to a secrets store immediately and do not log them.\n',
  );
}

export async function purchaseCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  // --resume and --amount are mutually exclusive; --resume doesn't need --amount.
  if (args.resume && args.amount) {
    process.stderr.write('error: --resume and --amount cannot be used together\n');
    return 2;
  }
  if (!args.resume && !args.amount) {
    process.stderr.write('error: --amount <USDC> is required (or --resume <order-id>)\n\n');
    usage();
    return 2;
  }
  if (args.amount && (!/^\d+(\.\d+)?$/.test(args.amount) || parseFloat(args.amount) <= 0)) {
    process.stderr.write(`error: --amount must be a positive decimal (got: ${args.amount})\n`);
    return 2;
  }

  const config = loadCards402Config();
  if (!config) {
    process.stderr.write(
      `error: no cards402 config found at ~/.cards402/config.json

Run 'cards402 onboard --claim <code>' first to set up credentials.
Your operator can mint a claim code from https://cards402.com/dashboard.
`,
    );
    return 1;
  }

  const walletName = args.walletName || config.wallet_name || 'cards402-agent';
  const paymentAsset = args.asset ?? 'xlm';

  // F12: vault_path and passphrase_env both come from config first, then
  // CLI overrides. The passphrase value is read from process.env at call
  // time; only the env var NAME is ever stored in config.
  const vaultPath = args.vaultPath ?? config.vault_path;
  const passphraseEnv = args.passphraseEnv ?? config.passphrase_env;
  const passphrase = passphraseEnv ? process.env[passphraseEnv] : undefined;
  if (passphraseEnv && !passphrase) {
    process.stderr.write(
      `error: --passphrase-env ${passphraseEnv} is set in config but the env var is empty.\n` +
        `Set ${passphraseEnv} to your wallet passphrase before running purchase.\n`,
    );
    return 2;
  }

  if (args.resume) {
    process.stdout.write(`→ Resuming order ${args.resume}…\n`);
  } else {
    process.stdout.write(`→ Purchasing $${args.amount} card via ${paymentAsset.toUpperCase()}…\n`);
  }

  try {
    const card = await purchaseCardOWS({
      apiKey: config.api_key,
      baseUrl: config.api_url,
      walletName,
      // amount is unused on resume but the type requires it; pass '0' safely.
      amountUsdc: args.amount ?? '0',
      paymentAsset,
      passphrase,
      vaultPath,
      ...(args.resume ? { resume: args.resume } : {}),
    });
    clearLastOrder();
    printCard(card);
    return 0;
  } catch (err) {
    if (err instanceof OrderFailedError) {
      process.stderr.write(`\nerror: ${err.message}\n`);
      clearLastOrder();
      return 1;
    }
    if (err instanceof ResumableError) {
      saveLastOrder(err.orderId);
      process.stderr.write(`\nerror: ${err.message}\n`);
      process.stderr.write(
        `\nYour payment may still be processing on-chain. The cards402 backend will\n` +
          `credit the order if the transaction finalizes. Resume with:\n\n` +
          `  cards402 purchase --resume ${err.orderId}\n\n` +
          `(saved to ~/.cards402/last-order)\n`,
      );
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: purchase failed: ${msg}\n`);
    return 1;
  }
}
