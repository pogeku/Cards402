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
import * as crypto from 'crypto';

// Adversarial audit F5-config: config files should be tiny. A 16 KB
// cap leaves plenty of room for a fat api_key + url + wallet_name
// while refusing a maliciously-enlarged file that would otherwise be
// parsed in full and flowed into request headers downstream.
const MAX_CONFIG_BYTES = 16 * 1024;

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
// F3-config (2026-04-16): validate the api_key shape before accepting
// it. A corrupt or tampered key containing CRLF, NUL, or other control
// chars would flow into the X-Api-Key HTTP header and trigger Node's
// ERR_INVALID_CHAR on every fetch call — same bug class as the backend's
// X-Request-ID audit (F1-app). Accept printable ASCII only (the backend
// mints keys as `cards402_<48 hex>`, which is pure ASCII alnum + underscore).
const API_KEY_SHAPE = /^[\x20-\x7e]+$/;

export function loadCards402Config(configPath?: string): Cards402Config | null {
  const p = configPath || defaultConfigPath();
  try {
    // F1-config (2026-04-16): platform-independent checks (symlink,
    // regular-file, size cap) are now run on ALL platforms including
    // Windows. Pre-fix the entire block was gated on
    // `process.platform !== 'win32'`, which meant Windows agents
    // skipped the size cap — a planted 1 GB config.json (or an NTFS
    // junction to a large file) would be fully loaded via readFileSync
    // and OOM the agent. NTFS supports symlinks and junctions, and
    // fs.lstatSync correctly reports them, so the symlink defense
    // is also meaningful on Windows. Only the Unix permission-bit
    // checks (chmod) are platform-gated now.
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(p);
    } catch (statErr: unknown) {
      if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw statErr;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `cards402 config at ${p} is a symbolic link. Refusing to load. ` +
          `Remove the link and re-run 'cards402 onboard --claim <code>' to create a real file.`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(
        `cards402 config at ${p} is not a regular file. ` +
          `Remove it and re-run 'cards402 onboard --claim <code>'.`,
      );
    }
    // F5-config: enforce a size cap BEFORE reading the file into
    // memory or doing any further work on it. Config files are
    // tiny; anything bigger than MAX_CONFIG_BYTES is either
    // corruption or an attempt to flood request headers.
    if (stat.size > MAX_CONFIG_BYTES) {
      throw new Error(
        `cards402 config at ${p} is ${stat.size} bytes (max ${MAX_CONFIG_BYTES}). ` +
          `Refusing to load — the file is either corrupted or has been tampered with. ` +
          `Rotate your api key via the dashboard and re-run 'cards402 onboard'.`,
      );
    }
    // Unix-only: tighten loose permission bits. chmod on a regular
    // file (we verified above that it's not a symlink) is safe and
    // only affects this file. Skipped on Windows where mode bits are
    // simulated and chmod can fail or no-op unpredictably.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
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

    const raw = fs.readFileSync(p, 'utf8');
    const config = JSON.parse(raw) as Cards402Config;

    // F3-config (2026-04-16): validate api_key shape before accepting.
    // A corrupt or tampered key with CRLF / NUL / non-printable bytes
    // would crash every HTTP request downstream via Node's
    // ERR_INVALID_CHAR header validation.
    if (typeof config.api_key === 'string' && !API_KEY_SHAPE.test(config.api_key)) {
      throw new Error(
        `cards402 config at ${p} contains an api_key with non-printable characters. ` +
          `The file may be corrupted or tampered with. Rotate your key and re-run 'cards402 onboard'.`,
      );
    }

    return config;
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
  // F4-config: reject embedded userinfo. `https://api.cards402.com/v1@evil.com/`
  // parses as username='api.cards402.com/v1', password='', hostname='evil.com'
  // — the whole string looks plausibly cards402-ish in log output, but every
  // request would go to evil.com carrying the user's api_key in the
  // Authorization header. There's no legitimate reason for a cards402 base
  // URL to include credentials, so refuse any URL with a non-empty username
  // or password.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `Refusing base URL ${JSON.stringify(url)} with embedded credentials. ` +
        `Use a bare https://host/path form — the api key is sent via the ` +
        `Authorization header, never in the URL.`,
    );
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
  // F2-config: mkdirSync's mode option only applies to directories
  // it actually CREATES. An existing ~/.cards402 directory at 0755
  // (from an older buggy SDK version, a package install, or a
  // manual mkdir) silently stays loose, and the config file sits
  // inside a world-traversable parent. Explicit chmod after mkdir
  // guarantees the directory ends up at 0700 regardless of its
  // pre-existing state. Skip on Windows — mode bits are simulated
  // and the chmod can fail or no-op unpredictably.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* non-fatal — best effort */
    }
  }

  // F3-config: crypto.randomBytes is strictly safer than Math.random
  // for a temp-file suffix. Collision is already near-zero in
  // practice but Math.random is seeded from the clock — two
  // containers starting in the same millisecond could in principle
  // produce the same sequence. Crypto random adds no meaningful
  // cost and eliminates the class of concern.
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(config, null, 2);
  let committed = false;
  try {
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
    committed = true;
  } finally {
    // F3-config: clean up the temp file on any failure before the
    // rename commits. A leaked ~/.cards402/config.json.tmp-* file
    // holding a fresh api_key would otherwise linger on disk with
    // the same 0600 permissions as the target but under a path no
    // one checks — easy to miss during credential rotation.
    if (!committed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* temp already gone or never created — fine */
      }
    }
  }
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
