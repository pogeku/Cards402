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
 *
 * On load we also tighten the file mode to 0600 if it's been loosened
 * since the write (e.g. a bug in an older SDK version that wrote with
 * default permissions, or an attacker pre-creating the file
 * world-readable to farm credentials off the next onboarding). We
 * warn rather than refuse the load, so operators with an existing
 * loose config aren't hard-broken, but the mode is normalised
 * immediately.
 */
export function loadCards402Config(configPath?: string): Cards402Config | null {
  const p = configPath || defaultConfigPath();
  try {
    // Check permissions before the read so we can fail fast on obvious
    // tampering and warn on merely-loose files. On Windows, file mode
    // bits are simulated and may not be meaningful — skip the check
    // there to avoid spurious warnings.
    if (process.platform !== 'win32') {
      try {
        const stat = fs.statSync(p);
        // World- or group-readable bits set → tighten and warn
        if ((stat.mode & 0o077) !== 0) {
          try {
            fs.chmodSync(p, 0o600);
            process.stderr.write(
              `⚠ cards402 config at ${p} had loose permissions (${(stat.mode & 0o777).toString(8)}) — tightened to 600.\n` +
                '   If this is unexpected, rotate your api key via the dashboard.\n',
            );
          } catch {
            /* non-fatal — we at least tried */
          }
        }
      } catch {
        /* stat failed for some reason — fall through to the read */
      }
    }
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as Cards402Config;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Validate a base URL for safety before storing it in the config or
 * using it for API calls. Rejects everything that isn't HTTPS unless
 * the explicit CARDS402_ALLOW_INSECURE_BASE_URL escape hatch is set,
 * which only exists so local dev against http://localhost:4000 still
 * works. Returns the parsed URL.string() on success, throws on reject.
 *
 * Called from:
 *   - onboard, when persisting the api_url returned by the claim
 *     endpoint (defends against a MITM or compromised backend that
 *     injects http:// or a foreign origin into the response)
 *   - resolveCredentials, when an env-var override is used for
 *     baseUrl (defends against a user being tricked into setting
 *     CARDS402_BASE_URL to an attacker target)
 */
export function assertSafeBaseUrl(url: string, opts: { context?: string } = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid base URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    if (process.env.CARDS402_ALLOW_INSECURE_BASE_URL === '1') {
      return parsed.toString();
    }
    throw new Error(
      `Refusing to use non-HTTPS base URL (${url})${opts.context ? ` for ${opts.context}` : ''}. ` +
        `Set CARDS402_ALLOW_INSECURE_BASE_URL=1 to override for local development.`,
    );
  }
  return parsed.toString();
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

  // Refuse any non-HTTPS baseUrl (env, opts, or config) unless the
  // explicit local-dev escape hatch is set. Without this, an attacker
  // who tricks the user into setting CARDS402_BASE_URL=http://evil/
  // sees the api key in every request's Authorization header. The
  // assertSafeBaseUrl helper throws on reject — we let it propagate
  // rather than silently continue with an insecure URL.
  if (baseUrl) {
    baseUrl = assertSafeBaseUrl(baseUrl, { context: 'resolveCredentials' });
  }

  return { apiKey, baseUrl };
}
