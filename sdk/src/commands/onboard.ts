// `cards402 onboard --claim <code>` — one-shot agent setup.
//
// 1. Trade the one-time claim code for the real api key via
//    POST /v1/agent/claim. The raw api key is returned over HTTPS, not
//    pasted into the agent's conversation transcript.
// 2. Persist the api key + api_url in ~/.cards402/config.json (0600)
//    so the SDK can load it automatically on future runs.
// 3. Create (or fetch) the OWS wallet under a default name. Private
//    keys never leave the local OWS vault.
// 4. Report the wallet address to the backend so the operator sees
//    "Awaiting deposit" in their dashboard immediately.
// 5. Print the Stellar address + next steps.

import { loadCards402Config, saveCards402Config } from '../config';
import { createOWSWallet, getOWSBalance } from '../ows';
import { Cards402Client } from '../client';

// Exported for tests — see src/commands/onboard.test.ts
export { deriveDefaultWalletName as _deriveDefaultWalletName };

interface OnboardArgs {
  claim?: string;
  walletName?: string;
  apiBase?: string;
  vaultPath?: string;
  passphraseEnv?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): OnboardArgs {
  const out: OnboardArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--claim') out.claim = argv[++i];
    else if (arg.startsWith('--claim=')) out.claim = arg.slice('--claim='.length);
    else if (arg === '--wallet-name') out.walletName = argv[++i];
    else if (arg.startsWith('--wallet-name=')) out.walletName = arg.slice('--wallet-name='.length);
    else if (arg === '--api-base') out.apiBase = argv[++i];
    else if (arg.startsWith('--api-base=')) out.apiBase = arg.slice('--api-base='.length);
    else if (arg === '--vault-path') out.vaultPath = argv[++i];
    else if (arg.startsWith('--vault-path=')) out.vaultPath = arg.slice('--vault-path='.length);
    else if (arg === '--passphrase-env') out.passphraseEnv = argv[++i];
    else if (arg.startsWith('--passphrase-env='))
      out.passphraseEnv = arg.slice('--passphrase-env='.length);
  }
  return out;
}

function usage(): void {
  process.stderr
    .write(`Usage: cards402 onboard --claim <code> [--wallet-name <name>] [--vault-path <path>] [--passphrase-env <ENVNAME>] [--api-base <url>]

Exchanges a one-time claim code (from the cards402 dashboard) for an
api key, creates an OWS Stellar wallet, and registers its address with
the backend so your operator sees live setup progress.

The raw api key is stored at ~/.cards402/config.json (chmod 0600) and
is auto-loaded by the SDK on subsequent runs. You do NOT need to paste
the api key into any env var yourself.

Options:
  --claim <code>             One-time claim code from the dashboard. Required.
  --wallet-name <name>       Name for the OWS wallet. If omitted, a unique
                             name is derived from the agent label + the
                             claim code so two separate agents on the same
                             machine can't accidentally share a wallet.
  --vault-path <path>        Override the default ~/.ows/wallets vault location.
                             USE THIS if you're running on ephemeral storage
                             (Lambda, Cloud Run, scratch containers) — point
                             it at a persistent volume. Lost vault = lost funds.
                             Persisted to config so subsequent purchase/wallet
                             commands use the same vault automatically.
  --passphrase-env <ENVNAME> Name of the environment variable that holds the
                             OWS passphrase (e.g. CARDS402_OWS_PASSPHRASE). The
                             passphrase value is read from process.env at call
                             time; only the variable NAME is persisted to
                             ~/.cards402/config.json, never the value itself.
  --api-base <url>           Override the default https://api.cards402.com/v1
  -h, --help                 Show this message
`);
}

/**
 * Derive a unique, deterministic wallet name from the agent label and
 * claim code. Two different claims always produce different names, so
 * running `cards402 onboard` multiple times on the same machine gives
 * each agent its own OWS wallet file instead of silently reusing the
 * previous agent's private keys. The claim-code suffix is what makes
 * it unique; the label is just there to make the vault file readable
 * on disk.
 */
function deriveDefaultWalletName(claim: string, label: string | null): string {
  // Strip the `c402_` prefix (if present), take the first 8 hex chars
  // for a short-but-unique suffix. The claim code is cryptographically
  // random — 8 hex chars = 32 bits, collision probability negligible
  // at any realistic fleet size.
  const raw = claim.replace(/^c402_/i, '');
  const suffix = raw.slice(0, 8).toLowerCase();
  // Slugify label: lowercase, replace non-alnum with -, collapse
  // repeats, trim hyphens, cap length. Falls back to `agent` if empty.
  const slug =
    (label ?? 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent';
  return `cards402-${slug}-${suffix}`;
}

export async function onboardCommand(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  if (!args.claim) {
    process.stderr.write('error: --claim <code> is required\n\n');
    usage();
    return 2;
  }

  // Local format check — fail fast on obvious typos (missing prefix,
  // whitespace in the middle, truncated hex) before hitting the backend.
  // Backend mint format is `c402_` + 48 hex chars (24 random bytes hex);
  // accept anything at least 16 hex chars after the prefix to stay
  // forward-compatible with future entropy bumps.
  const claim = args.claim.trim();
  if (!/^c402_[a-f0-9]{16,}$/i.test(claim)) {
    process.stderr.write(
      `error: '${claim.slice(0, 12)}…' does not look like a valid claim code.\n` +
        'Expected format: c402_<hex>. Ask your operator to copy the code from\n' +
        'the Agents tab of the dashboard — it is shown once and starts with c402_.\n',
    );
    return 2;
  }

  const apiBase = args.apiBase || process.env.CARDS402_BASE_URL || 'https://api.cards402.com/v1';

  // If the machine already has a Cards402 config, warn before
  // overwriting. A re-onboard is legitimate (rotated key, replaced
  // agent) but silently stomping the old file orphans the previous
  // OWS wallet and locks the operator out of any funds sitting in it.
  const existing = loadCards402Config();
  if (existing) {
    process.stderr.write(
      '⚠ An existing cards402 config was found at ~/.cards402/config.json\n' +
        `   previous wallet: ${existing.wallet_name ?? '(unknown)'}\n` +
        `   created_at:      ${existing.created_at ?? '(unknown)'}\n` +
        '   The old OWS wallet file (if present) is NOT deleted — keep it\n' +
        '   safe if there are residual funds. Proceeding with the new claim.\n\n',
    );
  }

  // We can't derive the default wallet name until AFTER the claim is
  // redeemed (we need the label). So we start with the explicit
  // --wallet-name override, and if it wasn't passed we compute a
  // unique default after step 1.

  // Step 1 — trade claim code for api key.
  process.stdout.write('→ Claiming agent credentials…\n');
  let claimResponse: {
    api_key: string;
    webhook_secret: string | null;
    api_key_id: string;
    label: string | null;
    api_url: string;
  };
  try {
    const res = await fetch(`${apiBase}/agent/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: claim }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      process.stderr.write(
        `error: claim failed (HTTP ${res.status}): ${
          (data.message as string) || (data.error as string) || 'unknown'
        }\n`,
      );
      process.stderr.write(
        'If the code is expired, ask your operator to mint a new one in the cards402 dashboard.\n',
      );
      return 1;
    }
    // Validate the response shape before we persist anything. If the
    // backend returned something unexpected we'd rather fail loudly
    // here than write a half-populated config and break the next
    // command with an obscure undefined error.
    if (typeof data.api_key !== 'string' || !data.api_key) {
      process.stderr.write(
        'error: claim succeeded but the response is missing api_key — aborting.\n' +
          'This is a backend bug. Report it to api@cards402.com with the response.\n',
      );
      return 1;
    }
    if (typeof data.api_key_id !== 'string' || !data.api_key_id) {
      process.stderr.write(
        'error: claim response missing api_key_id — aborting. Report to api@cards402.com.\n',
      );
      return 1;
    }
    claimResponse = data as unknown as typeof claimResponse;
  } catch (err) {
    // Surface a short message — full err.toString() may include cause
    // chains with internal URLs or stack frames. Keep stderr clean.
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'unknown network error';
    process.stderr.write(`error: network failure during claim: ${msg}\n`);
    return 1;
  }

  // Resolve wallet name: explicit override wins, otherwise derive from
  // the agent label + the claim code so every onboarding run produces
  // a distinct wallet. This closes the "second agent inherited the
  // first agent's wallet" bug where both claims used the static
  // default 'cards402-agent' name.
  const walletName = args.walletName || deriveDefaultWalletName(args.claim, claimResponse.label);

  // F12: resolve passphrase from the named env var. Only the var NAME
  // is persisted to config; the value never touches disk in cards402.
  let passphrase: string | undefined;
  if (args.passphraseEnv) {
    passphrase = process.env[args.passphraseEnv];
    if (!passphrase) {
      process.stderr.write(
        `error: --passphrase-env ${args.passphraseEnv} is set but the env var is empty.\n` +
          `Set ${args.passphraseEnv} to your chosen passphrase before running onboard.\n`,
      );
      return 2;
    }
  }

  // Step 2 — persist config so the SDK finds it on next run.
  const { path: configPath } = saveCards402Config({
    api_key: claimResponse.api_key,
    api_url: claimResponse.api_url || apiBase,
    webhook_secret: claimResponse.webhook_secret,
    wallet_name: walletName,
    vault_path: args.vaultPath,
    passphrase_env: args.passphraseEnv,
    created_at: new Date().toISOString(),
  });
  process.stdout.write(`✓ Credentials saved to ${configPath} (chmod 0600)\n`);

  // Step 3 — create or fetch the OWS wallet.
  process.stdout.write('→ Setting up OWS wallet…\n');
  const client = new Cards402Client({
    apiKey: claimResponse.api_key,
    baseUrl: claimResponse.api_url || apiBase,
  });
  await client.reportStatus('initializing', { detail: 'creating wallet' }).catch(() => {});

  let publicKey: string;
  try {
    const created = createOWSWallet(walletName, passphrase, args.vaultPath);
    publicKey = created.publicKey;
  } catch (err) {
    process.stderr.write(
      `error: wallet creation failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  process.stdout.write(`✓ Wallet "${walletName}" ready\n`);
  if (args.vaultPath) process.stdout.write(`  vault: ${args.vaultPath}\n`);
  if (args.passphraseEnv) process.stdout.write(`  passphrase: read from $${args.passphraseEnv}\n`);

  // Step 4 — check balance (may 404 on an unactivated account; that's fine).
  let balance = { xlm: '0', usdc: '0' };
  try {
    balance = await getOWSBalance(walletName, args.vaultPath);
  } catch {
    /* account not yet activated on-chain — normal on first run */
  }

  // Step 5 — report wallet address so the dashboard pill flips to "Awaiting deposit".
  await client
    .reportStatus('awaiting_funding', {
      wallet_public_key: publicKey,
      detail: `xlm=${balance.xlm} usdc=${balance.usdc}`,
    })
    .catch(() => {});

  // Step 6 — print status + next steps. The wording branches on
  // whether the wallet is already funded (possible on re-onboard) or
  // still needs a deposit.
  const xlmNum = parseFloat(balance.xlm);
  const usdcNum = parseFloat(balance.usdc);
  const isFunded = xlmNum >= 2;

  process.stdout.write('\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(' cards402 agent ready\n');
  process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.stdout.write(`  Label:           ${claimResponse.label ?? '(none)'}\n`);
  process.stdout.write(`  Stellar address: ${publicKey}\n`);
  process.stdout.write(`  XLM balance:     ${balance.xlm}\n`);
  process.stdout.write(`  USDC balance:    ${balance.usdc}\n`);
  process.stdout.write('\n');

  if (isFunded) {
    // Wallet is already activated + has enough XLM for the base
    // reserve (possible on re-onboard, or on a bootstrapped-by-hand
    // account). Skip the "ask your operator to send" line and jump
    // straight to the purchase command.
    process.stdout.write('The wallet is funded and ready to buy cards.\n');
    process.stdout.write('\n');
    process.stdout.write('  Try a test purchase:\n');
    process.stdout.write('    npx -y cards402@latest purchase --amount 0.01\n');
    if (usdcNum > 0) {
      process.stdout.write('\n');
      process.stdout.write(`  (USDC balance ${balance.usdc} will be auto-picked for USDC-paid\n`);
      process.stdout.write('   purchases up to that amount; XLM for anything larger.)\n');
    }
  } else {
    process.stdout.write('Next step: fund the wallet.\n');
    process.stdout.write('\n');
    process.stdout.write('  Send to the Stellar address above:\n');
    process.stdout.write('    • At least 2 XLM to activate the account and cover reserves.\n');
    process.stdout.write('    • For XLM-paid purchases: enough XLM to cover the card face\n');
    process.stdout.write('      value at the current XLM/USD rate, plus a safety margin.\n');
    process.stdout.write('    • For USDC-paid purchases: 2 XLM + the USDC face value.\n');
    process.stdout.write('\n');
    process.stdout.write('  Once funded, run:\n');
    process.stdout.write('    npx -y cards402@latest purchase --amount <USD>\n');
  }
  process.stdout.write('\n');
  process.stdout.write('Your operator sees setup progress live in the cards402 dashboard.\n');
  process.stdout.write('\n');
  return 0;
}
