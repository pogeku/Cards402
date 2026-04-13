// `cards402 purchase --amount 10 [--asset xlm|usdc]` — one-command
// card purchase. Loads creds from the on-disk config written by
// `cards402 onboard`, opens the order, pays the Soroban contract
// from the local OWS wallet, waits for the SSE stream to report
// the card ready, and prints the card details.
//
// Designed so the cautious-agent flow is a single shell invocation:
// the agent doesn't have to write any JavaScript or guess at the
// SDK surface area.

import { loadCards402Config } from '../config';
import { purchaseCardOWS } from '../ows';

interface PurchaseArgs {
  amount?: string;
  asset?: 'xlm' | 'usdc';
  walletName?: string;
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
  }
  return out;
}

function usage(): void {
  process.stderr.write(`Usage: cards402 purchase --amount <USDC> [--asset xlm|usdc]

Buys a virtual Visa card for the given USD value using the credentials
and wallet set up by 'cards402 onboard'. Reads ~/.cards402/config.json
for the api key and wallet name, so you don't need to pass either.

Options:
  -a, --amount <USDC>    Card value in USD (decimal string). Required.
  --asset xlm|usdc       Which asset to pay with. Default: xlm
  --wallet-name <name>   Override the wallet name from config.json
  -h, --help             Show this message

Example:
  cards402 purchase --amount 10          # $10 card paid in XLM
  cards402 purchase --amount 5 --asset usdc
`);
}

export async function purchaseCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (!args.amount) {
    process.stderr.write('error: --amount <USDC> is required\n\n');
    usage();
    return 2;
  }
  if (!/^\d+(\.\d+)?$/.test(args.amount) || parseFloat(args.amount) <= 0) {
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

  process.stdout.write(`→ Purchasing $${args.amount} card via ${paymentAsset.toUpperCase()}…\n`);

  try {
    const card = await purchaseCardOWS({
      apiKey: config.api_key,
      baseUrl: config.api_url,
      walletName,
      amountUsdc: args.amount,
      paymentAsset,
    });
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
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: purchase failed: ${msg}\n`);
    return 1;
  }
}
