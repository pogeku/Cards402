// Unit tests for lib/email.js — nodemailer wrapper.
//
// Before the 2026-04-15 adversarial audit there were ZERO tests for
// the email module despite it being the send path for every login
// code, approval request, and spend alert. This file covers:
//
//   F1-email: sanitizeHeader strips CR/LF + C0 control chars from any
//             operator-controlled value that flows into an SMTP
//             header (primarily the `subject:` field).
//   F2-email: createTransport receives explicit timeout options so a
//             hung SMTP server can't block /auth/login for minutes.
//   F3-email: sendMailStrict throws on rejected recipient arrays —
//             the previous bare sendMail await would silently treat
//             a bounced recipient as delivered.
//
// The tests stub nodemailer.createTransport so no real SMTP server
// is touched. The fake transporter captures the options passed to
// createTransport() AND every sendMail() call for assertion.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const nodemailer = require('nodemailer');
const EMAIL_PATH = require.resolve('../../src/lib/email');

// ── Fake transporter harness ─────────────────────────────────────────

/**
 * Replace nodemailer.createTransport with a stub. Returns the spy
 * objects so tests can inspect createTransport options and captured
 * sendMail calls. Each test calls freshEmailModule() to get an
 * isolated instance.
 */
function installFakeTransport({ sendMailResult = { accepted: ['x'], rejected: [] } } = {}) {
  const state = {
    createTransportOpts: null,
    sendMailCalls: [],
    sendMailResult,
  };
  const fake = {
    async sendMail(opts) {
      state.sendMailCalls.push(opts);
      // The result can be a function for tests that need to return
      // different values per call.
      if (typeof state.sendMailResult === 'function') {
        return state.sendMailResult(opts);
      }
      return state.sendMailResult;
    },
  };
  const originalCreateTransport = nodemailer.createTransport;
  nodemailer.createTransport = (opts) => {
    state.createTransportOpts = opts;
    return /** @type {any} */ (fake);
  };
  state.restore = () => {
    nodemailer.createTransport = originalCreateTransport;
  };
  return state;
}

function freshEmailModule() {
  delete require.cache[EMAIL_PATH];
  return require('../../src/lib/email');
}

// ── Baseline happy paths ─────────────────────────────────────────────

describe('email — happy-path send for each variant', () => {
  let fake;
  beforeEach(() => {
    if (fake) fake.restore();
    fake = installFakeTransport();
  });

  it('sendLoginCode sends a mail with the code in both text and html bodies', async () => {
    const email = freshEmailModule();
    await email.sendLoginCode('user@example.com', '123456');
    assert.equal(fake.sendMailCalls.length, 1);
    const call = fake.sendMailCalls[0];
    assert.equal(call.to, 'user@example.com');
    assert.equal(call.subject, 'Your Cards402 login code');
    assert.match(call.text, /123456/);
    assert.match(call.html, /123456/);
  });

  it('sendApprovalEmail renders the expected context fields', async () => {
    const email = freshEmailModule();
    await email.sendApprovalEmail('owner@example.com', {
      approvalId: 'ap-1',
      orderId: 'o-1',
      amountUsdc: '25.00',
      keyLabel: 'agent-a',
      reason: 'spend over daily',
    });
    assert.equal(fake.sendMailCalls.length, 1);
    const call = fake.sendMailCalls[0];
    assert.equal(call.to, 'owner@example.com');
    assert.match(call.subject, /25\.00/);
    assert.match(call.text, /agent-a/);
    assert.match(call.text, /spend over daily/);
    assert.match(call.text, /ap-1/);
  });

  it('sendSpendAlertEmail renders the limit and percent', async () => {
    const email = freshEmailModule();
    await email.sendSpendAlertEmail('owner@example.com', {
      keyLabel: 'agent-b',
      pct: '80',
      spentUsdc: '400',
      limitUsdc: '500',
      limitType: 'daily',
    });
    assert.equal(fake.sendMailCalls.length, 1);
    const call = fake.sendMailCalls[0];
    assert.match(call.subject, /agent-b/);
    assert.match(call.subject, /80%/);
    assert.match(call.subject, /daily/);
  });

  it('sendAlertEmail uses the caller-supplied subject verbatim', async () => {
    const email = freshEmailModule();
    await email.sendAlertEmail({
      to: 'ops@example.com',
      subject: 'cards402 alert: CTX auth expired',
      body: 'refresh token missing',
    });
    assert.equal(fake.sendMailCalls.length, 1);
    assert.equal(fake.sendMailCalls[0].subject, 'cards402 alert: CTX auth expired');
  });
});

// ── F1-email: header injection defense via sanitizeHeader ────────────

describe('email — F1 sanitizeHeader strips CRLF from subject', () => {
  let fake;
  beforeEach(() => {
    if (fake) fake.restore();
    fake = installFakeTransport();
  });

  it('sendSpendAlertEmail strips CRLF from keyLabel before subject interpolation', async () => {
    const email = freshEmailModule();
    // Hostile keyLabel: an operator who set their own api_key label
    // to a CRLF-containing string. Nodemailer should strip this
    // too, but we don't rely on upstream defense — the subject
    // should not contain CR/LF when sendMail is invoked.
    await email.sendSpendAlertEmail('owner@example.com', {
      keyLabel: 'Evil\r\nBcc: attacker@evil.com',
      pct: '80',
      spentUsdc: '400',
      limitUsdc: '500',
      limitType: 'daily',
    });
    assert.equal(fake.sendMailCalls.length, 1);
    const { subject } = fake.sendMailCalls[0];
    assert.doesNotMatch(subject, /\r/);
    assert.doesNotMatch(subject, /\n/);
    // The CR/LF are replaced with spaces, so the label reads as
    // "Evil  Bcc: attacker@evil.com" rendered inside the subject.
    // It's still visible but cannot inject a header.
    assert.match(subject, /Evil/);
    // The critical property: no header injection shape. A
    // newline-delimited Bcc: line would be a real attack — assert
    // that the subject line is ONE line.
    assert.equal(subject.split('\n').length, 1);
    assert.equal(subject.split('\r').length, 1);
  });

  it('sendAlertEmail strips CRLF from the subject (alerts.js rule.name source)', async () => {
    const email = freshEmailModule();
    // The alert evaluator builds `cards402 alert: ${rule.name}` and
    // passes it through; a rule name with CRLF is the attack path.
    await email.sendAlertEmail({
      to: 'ops@example.com',
      subject: 'cards402 alert: injected\r\nX-Leak: pwned',
      body: 'body text',
    });
    const { subject } = fake.sendMailCalls[0];
    assert.doesNotMatch(subject, /\r/);
    assert.doesNotMatch(subject, /\n/);
    assert.equal(subject.split('\n').length, 1);
  });

  it('sanitizeHeader also strips C0 control chars (\\x01-\\x1f)', async () => {
    const email = freshEmailModule();
    await email.sendSpendAlertEmail('owner@example.com', {
      keyLabel: 'x\x01y\x1fz',
      pct: '80',
      spentUsdc: '400',
      limitUsdc: '500',
      limitType: 'daily',
    });
    const { subject } = fake.sendMailCalls[0];
    // Control chars replaced with spaces.
    assert.doesNotMatch(subject, /[\x01\x1f]/);
    assert.match(subject, /x y z/);
  });

  it('sanitizeHeader caps header length at 200 chars', async () => {
    const email = freshEmailModule();
    await email.sendSpendAlertEmail('owner@example.com', {
      keyLabel: 'A'.repeat(1000),
      pct: '80',
      spentUsdc: '400',
      limitUsdc: '500',
      limitType: 'daily',
    });
    const { subject } = fake.sendMailCalls[0];
    // keyLabel is sliced to 200 before interpolation — the full
    // subject is "Cards402 — <keyLabel> at 80% of daily limit"
    // which adds ~30 chars of chrome, so overall ≤ ~230.
    assert.ok(subject.length <= 250, `subject length ${subject.length} too long`);
    // And the label itself is no more than 200.
    const labelPortion = subject.match(/Cards402 — (.*) at 80/)?.[1] || '';
    assert.ok(labelPortion.length <= 200);
  });

  it('sanitizeHeader handles null/undefined gracefully', async () => {
    const email = freshEmailModule();
    // Shouldn't throw. Resulting subject will contain an empty
    // interpolation where keyLabel was.
    await email.sendSpendAlertEmail('owner@example.com', {
      keyLabel: null,
      pct: '80',
      spentUsdc: '400',
      limitUsdc: '500',
      limitType: 'daily',
    });
    const { subject } = fake.sendMailCalls[0];
    assert.match(subject, /at 80%/);
  });
});

// ── F2-email: bounded SMTP timeouts ──────────────────────────────────

describe('email — F2 SMTP timeouts', () => {
  let fake;
  beforeEach(() => {
    if (fake) fake.restore();
    fake = installFakeTransport();
  });

  it('createTransport is called with bounded connection/greeting/socket timeouts', async () => {
    const email = freshEmailModule();
    // Trigger lazy createTransport by firing any send.
    await email.sendLoginCode('user@example.com', '000000');
    const opts = fake.createTransportOpts;
    assert.ok(opts, 'createTransport should have been called');
    // Nodemailer defaults are 10 minutes each — anything under a
    // minute proves the fix is in place.
    assert.ok(
      typeof opts.connectionTimeout === 'number' && opts.connectionTimeout <= 60_000,
      `connectionTimeout missing or too large: ${opts.connectionTimeout}`,
    );
    assert.ok(
      typeof opts.greetingTimeout === 'number' && opts.greetingTimeout <= 60_000,
      `greetingTimeout missing or too large: ${opts.greetingTimeout}`,
    );
    assert.ok(
      typeof opts.socketTimeout === 'number' && opts.socketTimeout <= 60_000,
      `socketTimeout missing or too large: ${opts.socketTimeout}`,
    );
  });
});

// ── F3-email: sendMailStrict throws on rejected recipients ───────────

describe('email — F3 rejected-recipient validation', () => {
  it('throws when nodemailer returns a non-empty rejected array', async () => {
    const fake = installFakeTransport({
      sendMailResult: { accepted: [], rejected: ['bad@example.com'] },
    });
    try {
      const email = freshEmailModule();
      await assert.rejects(
        () => email.sendLoginCode('bad@example.com', '111111'),
        /SMTP rejected 1 recipient.*bad@example\.com/,
      );
    } finally {
      fake.restore();
    }
  });

  it('resolves normally when all recipients are accepted', async () => {
    const fake = installFakeTransport({
      sendMailResult: { accepted: ['ok@example.com'], rejected: [] },
    });
    try {
      const email = freshEmailModule();
      await email.sendLoginCode('ok@example.com', '222222');
      // No throw — happy path.
    } finally {
      fake.restore();
    }
  });

  it('resolves when info has no rejected array at all (defensive)', async () => {
    const fake = installFakeTransport({
      sendMailResult: { messageId: 'msg-1' /* no accepted/rejected */ },
    });
    try {
      const email = freshEmailModule();
      // Some SMTP providers return only a messageId. We don't want to
      // throw on those — only on an explicit non-empty rejected.
      await email.sendLoginCode('ok@example.com', '333333');
    } finally {
      fake.restore();
    }
  });

  it('throws on partial rejection when the message has multiple recipients', async () => {
    const fake = installFakeTransport({
      sendMailResult: {
        accepted: ['ok@example.com'],
        rejected: ['bad1@example.com', 'bad2@example.com'],
      },
    });
    try {
      const email = freshEmailModule();
      await assert.rejects(
        () => email.sendAlertEmail({ to: 'ok@example.com', subject: 's', body: 'b' }),
        /SMTP rejected 2 recipient/,
      );
    } finally {
      fake.restore();
    }
  });
});
