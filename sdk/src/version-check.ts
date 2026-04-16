// Background version check — warns the operator on stderr if their
// locally-installed cards402 is older than the current `latest` tag on
// the npm registry.
//
// Design constraints (all of these matter for a CLI that agents run
// inside an LLM loop):
//
//   - Fire-and-forget. Never blocks the command. The check runs in
//     parallel with whatever `main()` dispatched to; if the command
//     exits first, we let the check drop. If the check finishes first,
//     the warning prints before the command result.
//   - Short timeout. 2s on the registry fetch so a slow network never
//     measurably affects agent throughput.
//   - Cached. We write the last-check timestamp + seen-latest-version
//     to `~/.cards402/version-check.json` and skip the registry entirely
//     if we checked within the last 24h. That's fine because once an
//     operator has seen the warning they know to upgrade, and repeating
//     the same warning every second is noise.
//   - Non-fatal on every failure path. Network down, missing file,
//     permission denied, JSON parse error, semver comparison throws —
//     any of those silently no-op. A broken update check must never
//     break an actual purchase.
//   - stderr only. Never pollutes stdout so scripts parsing CLI output
//     aren't affected.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const REGISTRY_URL = 'https://registry.npmjs.org/cards402/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 2_000;
const STATE_FILE = path.join(os.homedir(), '.cards402', 'version-check.json');
// F1-version-check (2026-04-16): cap on local state file. Matches the
// 16 KB pattern from config.ts and purchase.ts. The state file is
// normally <200 bytes; anything larger is corruption or tampering.
const MAX_STATE_BYTES = 16 * 1024;
// F2-version-check (2026-04-16): cap on the npm registry response body.
// The /latest endpoint returns a package manifest — normally ~2 KB for
// cards402. A hostile server (DNS hijack, MITM, compromised CDN) could
// push megabytes within the 2s abort window. 64 KB is generous for any
// legitimate manifest and bounds memory consumption.
const MAX_REGISTRY_BODY_BYTES = 64 * 1024;

interface CheckState {
  last_checked_at: string; // ISO
  latest_seen: string; // semver string
}

function readLocalVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return null;
  }
}

function readState(): CheckState | null {
  try {
    // F1-version-check: size cap before readFileSync. A multi-GB state
    // file (corruption, symlink) would OOM the process on every CLI
    // invocation since checkForUpdates fires at startup for every command.
    const stat = fs.statSync(STATE_FILE);
    if (stat.size > MAX_STATE_BYTES) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw) as CheckState;
  } catch {
    return null;
  }
}

function writeState(state: CheckState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Returns >0 if a > b, <0 if a < b, 0 if equal. Handles plain semver
 *  triples; pre-release tags (e.g. 0.4.6-beta.1) fall back to string
 *  compare which is accurate enough for our gating. */
function compareVersions(a: string, b: string): number {
  const stripped = (s: string) => s.split('-')[0] ?? s;
  const pa = stripped(a)
    .split('.')
    .map((n) => parseInt(n, 10));
  const pb = stripped(b)
    .split('.')
    .map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return a.localeCompare(b);
}

function printWarning(local: string, latest: string): void {
  // Write to stderr so scripts piping stdout aren't affected. The
  // warning is ≤ 3 lines and mentions the exact upgrade command so
  // an LLM operator can act on it without extra prompting.
  const msg = [
    '',
    `⚠  cards402 ${local} is out of date — ${latest} is available on npm.`,
    `   Upgrade: npx -y cards402@latest <command>  |  npm i -g cards402@latest`,
    `   Release notes: https://cards402.com/changelog`,
    '',
  ].join('\n');
  try {
    process.stderr.write(msg);
  } catch {
    /* stderr closed — ignore */
  }
}

/** Fire-and-forget update check. Returns immediately; the check runs
 *  in the background. Safe to call at CLI startup regardless of which
 *  subcommand is about to run. */
export function checkForUpdates(): void {
  const local = readLocalVersion();
  if (!local) return;

  // Throttle: skip if we've checked in the last 24h.
  const state = readState();
  if (state?.last_checked_at) {
    const age = Date.now() - Date.parse(state.last_checked_at);
    if (age < CHECK_INTERVAL_MS && state.latest_seen) {
      // Re-use the cached result so a stale install still nags.
      if (compareVersions(local, state.latest_seen) < 0) {
        printWarning(local, state.latest_seen);
      }
      return;
    }
  }

  // Fetch the registry in the background. `void` the promise so Node
  // doesn't treat it as unhandled. We use AbortController to cap the
  // fetch wall time independent of the socket timeouts.
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(REGISTRY_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      // F2-version-check: read the body as text with a length cap
      // before JSON.parse. The 2s abort limits wall time but NOT data
      // volume — a fast hostile server can push ~200 MB through a
      // gigabit link in 2 seconds. res.json() loads the entire body
      // into a string before parsing, so a multi-MB response fills
      // memory. Cap at MAX_REGISTRY_BODY_BYTES and discard anything
      // larger — a legitimate npm /latest manifest is ~2 KB.
      const text = await res.text();
      if (text.length > MAX_REGISTRY_BODY_BYTES) return;
      const body = JSON.parse(text) as { version?: string };
      const latest = body?.version;
      if (!latest) return;
      writeState({ last_checked_at: new Date().toISOString(), latest_seen: latest });
      if (compareVersions(local, latest) < 0) {
        printWarning(local, latest);
      }
    } catch {
      /* network / parse / abort — silent no-op */
    }
  })();
}
