// `cards402 wallet address` / `cards402 wallet balance` — read-only
// helpers that wrap the OWS SDK so agents don't have to spawn Node
// one-liners to find out their own Stellar address or check whether
// funding has landed.

import { loadCards402Config } from '../config';
import { getOWSPublicKey, getOWSBalance, addUsdcTrustlineOWS } from '../ows';

function usage(): void {
  process.stderr
    .write(`Usage: cards402 wallet <subcommand> [--vault-path <path>] [--name <walletname>]

Subcommands:
  address              Print the Stellar address for this agent's wallet
  balance              Print the wallet's XLM and USDC balances from Horizon
  trustline            Open a USDC trustline on this wallet's Stellar account.
                       Required before the wallet can receive USDC from the
                       operator. Costs ~0.0000100 XLM in network fees and
                       raises the account's min reserve by 0.5 XLM.
  -h, --help           Show this message

Standard onboarding flow:
  1. cards402 onboard --claim <code>
  2. Operator sends at least 2.5 XLM to the wallet's Stellar address
  3. cards402 wallet trustline    (opens the USDC trustline)
  4. Operator sends USDC
  5. cards402 purchase --amount <USD>

Both subcommands read ~/.cards402/config.json for the wallet name and
vault path so you don't need to pass anything after 'cards402 onboard'.
Override either with --name=<walletname> / --vault-path=<path>.
`);
}

function parseFlag(rest: string[], short: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg === short) return rest[i + 1];
    if (arg.startsWith(`${short}=`)) return arg.slice(short.length + 1);
  }
  return undefined;
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

  // Resolve wallet name. Onboard writes a unique wallet_name per claim
  // to prevent cross-agent collision; a static fallback here would
  // reintroduce that bug (see onboard.ts:deriveDefaultWalletName). If
  // neither config nor --name provides one, refuse to guess.
  const walletName = parseFlag(rest, '--name') || config.wallet_name;
  if (!walletName) {
    process.stderr.write(
      'error: no wallet_name in ~/.cards402/config.json and no --name passed.\n' +
        "Either pass --name <walletname>, or re-run 'cards402 onboard --claim <code>'\n" +
        'to write a fresh config with a unique wallet name.\n',
    );
    return 1;
  }
  // F12: vault_path comes from config first, CLI flag overrides.
  const vaultPath = parseFlag(rest, '--vault-path') || config.vault_path;

  if (sub === 'address') {
    try {
      const publicKey = getOWSPublicKey(walletName, vaultPath);
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
      const publicKey = getOWSPublicKey(walletName, vaultPath);
      const bal = await getOWSBalance(walletName, vaultPath);
      process.stdout.write(`address: ${publicKey}\n`);
      process.stdout.write(`xlm:     ${bal.xlm}\n`);
      process.stdout.write(`usdc:    ${bal.usdc}\n`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Horizon 404 on a brand-new unactivated wallet — show zeros.
      if (msg.includes('Not Found') || msg.includes('404')) {
        try {
          const publicKey = getOWSPublicKey(walletName, vaultPath);
          process.stdout.write(`address: ${publicKey}\n`);
          // Send at least 2 XLM — 1 for the Stellar base reserve plus
          // 1 for a future USDC trustline entry. Matches the onboard
          // command's funding instructions, the MCP setup_wallet tool,
          // and the quickstart docs on cards402.com.
          process.stdout.write(`xlm:     0 (unactivated — send at least 2 XLM to activate)\n`);
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

  if (sub === 'trustline') {
    // `cards402 wallet trustline` — opens a USDC trustline on the
    // agent's Stellar account. The operator's typical onboarding flow
    // is: fund with XLM → agent runs this → operator sends USDC →
    // agent runs `purchase`. Without the trustline, any USDC payment
    // sent to the agent address bounces — USDC is an issued asset on
    // Stellar and every holder account must authorise the issuer
    // before it can hold the balance.
    //
    // The trustline operation costs one base fee (~0.00001 XLM) and
    // bumps the account's minimum reserve by 0.5 XLM, so the wallet
    // needs ~2 XLM already landed for this to succeed. We let the
    // underlying op surface the real Stellar error on insufficient
    // balance rather than pre-checking — the error message is more
    // useful than a synthetic one.
    try {
      const publicKey = getOWSPublicKey(walletName, vaultPath);
      process.stdout.write(`→ Opening USDC trustline for ${publicKey}…\n`);
      const txHash = await addUsdcTrustlineOWS({ walletName, vaultPath });
      if (txHash === null) {
        process.stdout.write(`✓ USDC trustline already exists on this wallet — nothing to do.\n`);
        return 0;
      }
      process.stdout.write(`✓ USDC trustline opened (txid: ${txHash})\n`);
      process.stdout.write(
        `\nThe wallet can now receive USDC from your operator. Run 'cards402 wallet balance'\n` +
          `to confirm the USDC line appears (shown as '0.0000000' when open and empty).\n`,
      );
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect the most common "why did this fail" cases and turn
      // them into actionable messages instead of the bare Horizon
      // response body.
      if (/not found/i.test(msg) || /404/.test(msg)) {
        process.stderr.write(
          `error: wallet is not activated on mainnet yet. Ask your operator to send\n` +
            `at least 2.5 XLM to the address printed by 'cards402 wallet address',\n` +
            `then re-run 'cards402 wallet trustline'.\n`,
        );
        return 1;
      }
      if (/already exists/i.test(msg) || /op_already_exists/.test(msg)) {
        process.stdout.write(`✓ USDC trustline already exists on this wallet — nothing to do.\n`);
        return 0;
      }
      if (/insufficient/i.test(msg) || /op_low_reserve/.test(msg)) {
        process.stderr.write(
          `error: insufficient XLM to open the trustline. A trustline subentry\n` +
            `requires +0.5 XLM of account reserve on top of the 1 XLM base. Ask\n` +
            `your operator to top up the wallet with at least 2.5 XLM total.\n`,
        );
        return 1;
      }
      process.stderr.write(`error: ${msg}\n`);
      return 1;
    }
  }

  process.stderr.write(`error: unknown wallet subcommand '${sub}'\n`);
  usage();
  return 2;
}
