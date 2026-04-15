// Unit tests for the shortString helper in dashboard.js.
//
// Free-form operator text (api_key label, approval/reject notes)
// flows through shortString at the dashboard POST boundary and
// then into email subjects, audit_log display, webhook_deliveries
// display, and the dashboard UI. Adversarial audit F1-email
// tightened it to strip control characters so none of those
// downstream consumers see visual garbage or get surprised by
// embedded CRLF.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const dashboardRouter = require('../../src/api/dashboard');

const { shortString } = dashboardRouter;

describe('shortString — basics', () => {
  it('returns null for non-strings', () => {
    assert.equal(shortString(null, 100), null);
    assert.equal(shortString(undefined, 100), null);
    assert.equal(shortString(42, 100), null);
    assert.equal(shortString({}, 100), null);
    assert.equal(shortString([], 100), null);
  });

  it('returns null for empty strings', () => {
    assert.equal(shortString('', 100), null);
  });

  it('returns null for whitespace-only after stripping', () => {
    assert.equal(shortString('   ', 100), null);
    assert.equal(shortString('\t\t', 100), null);
  });

  it('truncates to max length', () => {
    assert.equal(shortString('abcdefgh', 4), 'abcd');
    assert.equal(shortString('x'.repeat(1000), 100).length, 100);
  });

  it('preserves normal content unchanged', () => {
    assert.equal(shortString('my production agent', 100), 'my production agent');
  });

  it('preserves tabs (can appear in multi-line notes)', () => {
    assert.equal(shortString('col1\tcol2\tcol3', 100), 'col1\tcol2\tcol3');
  });
});

describe('shortString — control character stripping (F1-email)', () => {
  // All of these would visually garble email subjects, audit log
  // entries, and dashboard UI if passed through — and some could
  // be used as defence-in-depth injection vectors if any future
  // code path interpolates into an unencoded header.

  it('strips CRLF (header injection vector)', () => {
    const s = shortString('my agent\r\nBcc: attacker@evil.com', 100);
    assert.equal(s, 'my agentBcc: attacker@evil.com');
    assert.ok(!s.includes('\r'));
    assert.ok(!s.includes('\n'));
  });

  it('strips bare \\n (LF only)', () => {
    const s = shortString('line1\nline2', 100);
    assert.equal(s, 'line1line2');
  });

  it('strips NUL bytes', () => {
    const s = shortString('before\x00after', 100);
    assert.equal(s, 'beforeafter');
  });

  it('strips BEL / backspace / form feed / vertical tab', () => {
    const s = shortString('a\x07b\x08c\x0bd\x0ce', 100);
    assert.equal(s, 'abcde');
  });

  it('strips ANSI escape sequences (CSI introducer)', () => {
    // \x1b (ESC) gets stripped; the trailing "[31mred[0m" is bare
    // letters that survive as visible text — the important thing
    // is that the ESC byte (which would be interpreted as a
    // color-code introducer in an ANSI terminal) is gone.
    const s = shortString('\x1b[31mred\x1b[0m', 100);
    assert.ok(!s.includes('\x1b'));
  });

  it('strips DEL byte (0x7f)', () => {
    const s = shortString('a\x7fb', 100);
    assert.equal(s, 'ab');
  });

  it('returns null when the string is ONLY control characters', () => {
    assert.equal(shortString('\x00\x01\x02\x07', 100), null);
    assert.equal(shortString('\r\n\r\n', 100), null);
  });

  it('trims surrounding whitespace after stripping controls', () => {
    assert.equal(shortString('  \r\n  agent  \r\n  ', 100), 'agent');
  });

  it('truncates to max AFTER control-char stripping', () => {
    // Input is 100 chars with 10 control chars mixed in. After
    // stripping, length = 90. With max=50 we expect 50 chars of
    // the stripped-and-trimmed result.
    const mixed = 'a'.repeat(45) + '\r\n\r\n\r\n\r\n\r\n' + 'b'.repeat(45);
    const s = shortString(mixed, 50);
    assert.equal(s.length, 50);
    assert.ok(!s.includes('\r'));
    assert.ok(!s.includes('\n'));
  });
});
