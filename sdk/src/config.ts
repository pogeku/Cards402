// Agent-local config file. Persisted at ~/.cards402/config.json after
// a successful `cards402 onboard --claim` so the SDK can load the api
// key on subsequent runs without the agent having to re-paste secrets.
//
// The file lives on the agent's machine and is readable only by the
// agent's user (chmod 0600). It holds the raw api key — same secret
// the older env-var workflow stored in process.env, just written to
// disk in a well-known place so the SDK can find it automatically.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Cards402Config {
  api_key: string;
  api_url: string;
  webhook_secret?: string | null;
  wallet_name?: string;
  vault_path?: string;
  /**
   * Adversarial audit F12: the NAME of the environment variable that
   * holds the OWS wallet passphrase, NOT the passphrase value itself.
   * Subsequent CLI commands read this field, look up
   * `process.env[passphrase_env]` at call time, and pass the value to
   * the OWS layer. We never persist the passphrase value to disk —
   * a config dump alone gives an attacker the api key but not the
   * keys to the wallet vault.
   */
  passphrase_env?: string;
  created_at: string;
}

function defaultConfigDir(): string {
  return process.env.CARDS402_CONFIG_DIR || path.join(os.homedir(), '.cards402');
}

function defaultConfigPath(): string {
  return path.join(defaultConfigDir(), 'config.json');
}

/**
 * Load the agent's on-disk config, or return null if it doesn't exist.
 * Never throws on missing file — only on corrupt JSON.
 */
export function loadCards402Config(configPath?: string): Cards402Config | null {
  const p = configPath || defaultConfigPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as Cards402Config;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write the config file atomically with 0600 permissions so only the
 * owner can read it. Creates the parent directory on demand.
 *
 * Atomicity: write to `<path>.tmp-<pid>-<rand>` first, fsync, then
 * rename over the target. A mid-write crash (power loss, OOM, Ctrl-C
 * between write and flush) leaves the old file intact instead of a
 * truncated new one that loadCards402Config would explode on.
 *
 * Permission hardening: the `mode` option on writeFileSync only
 * applies when the file is being CREATED, so a stale 0644 file from
 * an earlier buggy version would retain its wide permissions forever.
 * We fsync+rename so the temp path is always freshly created with
 * 0600, then the rename replaces the target atomically.
 */
export function saveCards402Config(config: Cards402Config, configPath?: string): { path: string } {
  const p = configPath || defaultConfigPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const body = JSON.stringify(config, null, 2);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Atomic rename. POSIX guarantees this replaces an existing file
  // with the same semantics; on Windows rename-over-existing also
  // works from Node 10+.
  fs.renameSync(tmp, p);
  // Belt-and-braces: some filesystems (FAT on USB sticks) drop the
  // mode on rename. Force-tighten after.
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* non-fatal — best effort */
  }
  return { path: p };
}

/**
 * Resolve an api key + base URL at SDK call time, in priority order:
 *   1. Explicit `apiKey` / `baseUrl` passed to the call
 *   2. CARDS402_API_KEY / CARDS402_BASE_URL env vars
 *   3. ~/.cards402/config.json
 *
 * The two fields resolve independently — passing `apiKey` to a call
 * that needs its `baseUrl` to come from config.json used to silently
 * drop the config lookup because the early-return on `opts.apiKey`
 * was only consulting env vars for baseUrl. Now both fields walk the
 * full priority chain and only stop once each is filled.
 */
export function resolveCredentials(
  opts: {
    apiKey?: string;
    baseUrl?: string;
  } = {},
): { apiKey: string | undefined; baseUrl: string | undefined } {
  let apiKey: string | undefined = opts.apiKey;
  let baseUrl: string | undefined = opts.baseUrl;

  if (!apiKey && process.env.CARDS402_API_KEY) apiKey = process.env.CARDS402_API_KEY;
  if (!baseUrl && process.env.CARDS402_BASE_URL) baseUrl = process.env.CARDS402_BASE_URL;

  if (!apiKey || !baseUrl) {
    // Only load config if at least one field is still missing — saves
    // a filesystem read on the common case where env + opts fully cover it.
    const cfg = loadCards402Config();
    if (cfg) {
      if (!apiKey) apiKey = cfg.api_key;
      if (!baseUrl) baseUrl = cfg.api_url;
    }
  }

  return { apiKey, baseUrl };
}
