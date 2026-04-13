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
 * Write the config file with 0600 permissions so only the owner can
 * read it. Creates the parent directory on demand.
 */
export function saveCards402Config(config: Cards402Config, configPath?: string): { path: string } {
  const p = configPath || defaultConfigPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { path: p };
}

/**
 * Resolve an api key + base URL at SDK call time, in priority order:
 *   1. Explicit `apiKey` / `baseUrl` passed to the call
 *   2. CARDS402_API_KEY / CARDS402_BASE_URL env vars
 *   3. ~/.cards402/config.json
 */
export function resolveCredentials(
  opts: {
    apiKey?: string;
    baseUrl?: string;
  } = {},
): { apiKey: string | undefined; baseUrl: string | undefined } {
  if (opts.apiKey) {
    return { apiKey: opts.apiKey, baseUrl: opts.baseUrl || process.env.CARDS402_BASE_URL };
  }
  if (process.env.CARDS402_API_KEY) {
    return {
      apiKey: process.env.CARDS402_API_KEY,
      baseUrl: opts.baseUrl || process.env.CARDS402_BASE_URL,
    };
  }
  const cfg = loadCards402Config();
  if (cfg) {
    return { apiKey: cfg.api_key, baseUrl: opts.baseUrl || cfg.api_url };
  }
  return { apiKey: undefined, baseUrl: opts.baseUrl };
}
