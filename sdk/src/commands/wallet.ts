// `cards402 wallet address` / `cards402 wallet balance` — read-only
// helpers that wrap the OWS SDK so agents don't have to spawn Node
// one-liners to find out their own Stellar address or check whether
// funding has landed.

import { loadCards402Config } from '../config';
import { getOWSPublicKey, getOWSBalance } from '../ows';

function usage(): void {
  process.stderr.write(`Usage: cards402 wallet <subcommand>

Subcommands:
  address              Print the Stellar address for this agent's wallet
  balance              Print the wallet's XLM and USDC balances from Horizon
  -h, --help           Show this message

Both subcommands read ~/.cards402/config.json for the wallet name, so
you don't need to pass anything after 'cards402 onboard'.
`);
}

export async function walletCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    usage();
    return sub ? 0 : 2;
  }

  const config = loadCards402Config();
  if (!config) {
    process.stderr.write(
      "error: no cards402 config found. Run 'cards402 onboard --claim <code>' first.\n",
    );
    return 1;
  }
  const walletName =
    rest.find((a) => a.startsWith('--name='))?.slice(7) || config.wallet_name || 'cards402-agent';

  if (sub === 'address') {
    try {
      const publicKey = getOWSPublicKey(walletName);
      process.stdout.write(`${publicKey}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(
        `error: wallet "${walletName}" not found: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return 1;
    }
  }

  if (sub === 'balance') {
    try {
      const publicKey = getOWSPublicKey(walletName);
      const bal = await getOWSBalance(walletName);
      process.stdout.write(`address: ${publicKey}\n`);
      process.stdout.write(`xlm:     ${bal.xlm}\n`);
      process.stdout.write(`usdc:    ${bal.usdc}\n`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Horizon 404 on a brand-new unactivated wallet — show zeros.
      if (msg.includes('Not Found') || msg.includes('404')) {
        try {
          const publicKey = getOWSPublicKey(walletName);
          process.stdout.write(`address: ${publicKey}\n`);
          process.stdout.write(`xlm:     0 (unactivated — send >= 1 XLM)\n`);
          process.stdout.write(`usdc:    0\n`);
          return 0;
        } catch {
          /* fall through to error */
        }
      }
      process.stderr.write(`error: ${msg}\n`);
      return 1;
    }
  }

  process.stderr.write(`error: unknown wallet subcommand '${sub}'\n`);
  usage();
  return 2;
}
