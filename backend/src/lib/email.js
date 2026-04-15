// @ts-check
// Email sender — thin wrapper around nodemailer using SMTP.
// Works with any SMTP provider: Resend, SES (via SMTP endpoint), etc.
// Transporter is created lazily so the module can be imported in test environments
// without SMTP credentials configured.
//
// Visual language (aligned with the Cards402 brand refresh):
//   - Darker canvas (#050505) and softer borders so the emails read
//     engineering-grade rather than marketing-flashy
//   - Cards402 wordmark pulled from https://cards402.com/logo.svg with a
//     serif text fallback for Outlook (which strips SVG)
//   - Muted green accent (#7cffb2) matching the dashboard + landing
//   - Georgia-first serif stack for headlines so editorial character
//     survives even where no custom fonts load; Fraunces would be
//     better but email clients strip @font-face reliably
//   - Table-based layout for maximum client compatibility. Explicit
//     background + text colors on every cell so Gmail/Outlook
//     dark-mode auto-invert leaves the dark palette alone.

const nodemailer = require('nodemailer');

let _transporter;

function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      requireTLS: process.env.SMTP_PORT !== '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

// Wrap the bare address in SMTP_FROM with a display name so inboxes show
// "Cards402" rather than the raw no-reply address. If the operator already
// set a display name in SMTP_FROM (e.g. "foo <bar@baz.com>"), keep it.
function from() {
  const raw = process.env.SMTP_FROM || '';
  if (raw.includes('<')) return raw;
  return `"Cards402" <${raw}>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const COLOR = {
  bg: '#050505',
  card: '#0c0c0c',
  inner: '#0a0a0a',
  border: '#1a1a1a',
  borderStrong: '#262626',
  text: '#f4f4f4',
  muted: '#a1a1a1',
  faint: '#6b6b6b',
  // Muted mint — matches the --green token in the new design system.
  green: '#7cffb2',
  greenInk: '#0a1a10', // dark foreground for use on the green CTA button
  orange: '#ffb57a',
};

// System sans for body copy — widely available, consistent weights.
const FONT_SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
// Serif for headlines. Georgia is installed on every major platform so
// the editorial character survives even when custom fonts are stripped.
const FONT_SERIF = "Georgia,'Times New Roman',Times,serif";
const FONT_MONO = "ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

// Email clients render the SVG raw (no CSS mask), so we serve a pre-tinted
// light variant. The web app uses /logo.svg as a mask-image (colour from
// currentColor), so we can't re-use it here — on a dark email background
// it comes out invisible black.
const LOGO_URL = 'https://cards402.com/logo-light.svg';
// Public URL for the dashboard CTAs. All transactional emails deep-link
// into the authenticated dashboard since operators need a session
// regardless of email content.
const DASHBOARD_URL = 'https://cards402.com/dashboard';

// ── Shared chrome ─────────────────────────────────────────────────────────────

// The header renders the Cards402 wordmark as an SVG <img> with a
// serif text fallback inside the alt attribute. Most modern clients
// (Gmail web + mobile, Apple Mail, iOS Mail) load the SVG; Outlook
// shows the alt text styled via inline CSS so it degrades to a
// readable "Cards402" in serif.
function header() {
  return `
    <tr>
      <td style="padding:32px 36px 0 36px;">
        <a href="https://cards402.com" style="text-decoration:none;color:${COLOR.text};" aria-label="Cards402">
          <img
            src="${LOGO_URL}"
            width="120"
            height="28"
            alt="Cards402"
            style="display:block;border:0;outline:none;text-decoration:none;height:28px;width:120px;max-width:120px;font-family:${FONT_SERIF};font-style:italic;font-size:22px;font-weight:600;color:${COLOR.text};letter-spacing:-0.01em;"
          />
        </a>
      </td>
    </tr>
  `;
}

function wrap(preheader, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>Cards402</title>
</head>
<body style="margin:0;padding:0;background-color:${COLOR.bg};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLOR.bg};opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.bg};">
  <tr>
    <td align="center" style="padding:48px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:14px;">
        ${header()}
        <tr>
          <td style="padding:24px 36px 36px 36px;font-family:${FONT_SANS};color:${COLOR.text};font-size:15px;line-height:1.65;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 36px;border-top:1px solid ${COLOR.border};font-family:${FONT_SANS};font-size:12px;color:${COLOR.faint};">
            <a href="https://cards402.com" style="color:${COLOR.faint};text-decoration:none;">cards402.com</a>
            &nbsp;·&nbsp;
            Transactional only — we don't send marketing.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// Shared button treatment — black ink on the muted green from the
// dashboard. Table-wrapped for Outlook; inline-block display on the
// anchor so padding renders in Gmail.
function button(href, label) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="background-color:${COLOR.green};border-radius:999px;">
          <a href="${href}" style="display:inline-block;padding:13px 26px;color:${COLOR.greenInk};font-family:${FONT_SANS};font-weight:600;font-size:14px;text-decoration:none;letter-spacing:-0.005em;">
            ${label}&nbsp;<span style="font-family:${FONT_MONO};font-weight:400;">↗</span>
          </a>
        </td>
      </tr>
    </table>
  `;
}

// Display headline — serif, tight leading, matches the landing page
// editorial voice.
function headline(text) {
  return `
    <h1 style="margin:0 0 10px 0;font-family:${FONT_SERIF};font-size:26px;font-weight:500;color:${COLOR.text};letter-spacing:-0.015em;line-height:1.15;">
      ${text}
    </h1>
  `;
}

function eyebrow(text) {
  return `
    <div style="font-family:${FONT_MONO};font-size:11px;font-weight:500;letter-spacing:0.14em;color:${COLOR.green};text-transform:uppercase;margin-bottom:14px;">
      ${text}
    </div>
  `;
}

// ── Templates ─────────────────────────────────────────────────────────────────

async function sendLoginCode(email, code) {
  const safeCode = escapeHtml(code);
  const body = `
    ${eyebrow('Sign in')}
    ${headline('Your Cards402 login code')}
    <p style="margin:0 0 26px 0;color:${COLOR.muted};font-size:14px;">Enter this code to finish signing in to your operator dashboard.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding:28px 0;background-color:${COLOR.inner};border:1px solid ${COLOR.borderStrong};border-radius:12px;">
          <span style="font-family:${FONT_MONO};font-size:36px;letter-spacing:0.35em;font-weight:600;color:${COLOR.text};">${safeCode}</span>
        </td>
      </tr>
    </table>
    <p style="margin:24px 0 0 0;color:${COLOR.faint};font-size:13px;line-height:1.55;">This code expires in 15 minutes. If you didn't request it, you can safely ignore this email — nobody is waiting on the other end.</p>
  `;
  // Subject AND preheader are deliberately code-less. Both surfaces
  // appear in upstream-visible places — provider logs, compliance
  // archives, spam-classification pipelines, and the email client
  // sidebar — long after the code has been used and invalidated.
  // Keeping the code in the HTML/text body ONLY shrinks the
  // accidental-exposure surface. A previous version of this file
  // claimed the preheader carried the code; the actual behaviour
  // was already code-free and that's the security-correct choice.
  // Adversarial audit F2-email.
  const subject = 'Your Cards402 login code';
  await getTransporter().sendMail({
    from: from(),
    to: email,
    subject,
    text: [
      `Your Cards402 login code:`,
      ``,
      `    ${code}`,
      ``,
      `Expires in 15 minutes. If you didn't request it, you can ignore this email.`,
      ``,
      `— cards402.com`,
    ].join('\n'),
    html: wrap(subject, body),
  });
}

async function sendApprovalEmail(
  ownerEmail,
  { approvalId, orderId, amountUsdc, keyLabel, reason },
) {
  const body = `
    ${eyebrow('Approval required')}
    ${headline('An agent is waiting on you')}
    <p style="margin:0 0 24px 0;color:${COLOR.muted};font-size:14px;">One of your agents hit a policy gate and is holding on your decision.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.inner};border:1px solid ${COLOR.borderStrong};border-radius:12px;margin-bottom:28px;">
      <tr>
        <td style="padding:22px 24px;font-family:${FONT_SANS};font-size:13px;">
          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Amount</div>
          <div style="color:${COLOR.text};font-family:${FONT_SERIF};font-size:30px;font-weight:500;letter-spacing:-0.015em;margin-bottom:20px;">$${escapeHtml(amountUsdc)} <span style="color:${COLOR.faint};font-size:14px;font-family:${FONT_MONO};font-weight:400;letter-spacing:0.04em;">USDC</span></div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Agent</div>
          <div style="color:${COLOR.text};font-size:14px;margin-bottom:16px;">${escapeHtml(keyLabel)}</div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Reason</div>
          <div style="color:${COLOR.text};font-size:14px;margin-bottom:16px;">${escapeHtml(reason)}</div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Order</div>
          <div style="font-family:${FONT_MONO};color:${COLOR.muted};font-size:12px;">${escapeHtml(orderId)}</div>
        </td>
      </tr>
    </table>
    ${button(DASHBOARD_URL, 'Review in dashboard')}
    <p style="margin:26px 0 0 0;color:${COLOR.faint};font-size:13px;">This request expires in 2 hours. Approval ID: <span style="font-family:${FONT_MONO};">${escapeHtml(approvalId)}</span></p>
  `;
  await getTransporter().sendMail({
    from: from(),
    to: ownerEmail,
    subject: `Cards402 — approval required for $${amountUsdc} USDC`,
    text: [
      `An agent is requesting approval for a $${amountUsdc} USDC transaction.`,
      ``,
      `Agent:    ${keyLabel}`,
      `Amount:   $${amountUsdc} USDC`,
      `Reason:   ${reason}`,
      `Order:    ${orderId}`,
      `Approval: ${approvalId}`,
      ``,
      `Review in dashboard: ${DASHBOARD_URL}`,
      `Expires in 2 hours.`,
      ``,
      `— cards402.com`,
    ].join('\n'),
    html: wrap(`An agent needs approval for $${amountUsdc} USDC`, body),
  });
}

async function sendSpendAlertEmail(ownerEmail, { keyLabel, pct, spentUsdc, limitUsdc, limitType }) {
  const body = `
    ${eyebrow('Spend alert')}
    ${headline(`${escapeHtml(keyLabel)} is approaching its limit`)}
    <p style="margin:0 0 24px 0;color:${COLOR.muted};font-size:14px;">Agent <strong style="color:${COLOR.text};">${escapeHtml(keyLabel)}</strong> has reached <strong style="color:${COLOR.orange};">${escapeHtml(pct)}%</strong> of its ${escapeHtml(limitType)} spend limit.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.inner};border:1px solid ${COLOR.borderStrong};border-radius:12px;margin-bottom:28px;">
      <tr>
        <td style="padding:22px 24px;font-family:${FONT_SANS};font-size:13px;">
          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Spent</div>
          <div style="color:${COLOR.text};font-family:${FONT_SERIF};font-size:28px;font-weight:500;letter-spacing:-0.015em;margin-bottom:18px;">$${escapeHtml(spentUsdc)} <span style="color:${COLOR.faint};font-size:13px;font-family:${FONT_MONO};font-weight:400;letter-spacing:0.04em;">USDC</span></div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Limit</div>
          <div style="color:${COLOR.text};font-size:14px;">$${escapeHtml(limitUsdc)} USDC</div>
        </td>
      </tr>
    </table>
    ${button(DASHBOARD_URL, 'Review in dashboard')}
  `;
  await getTransporter().sendMail({
    from: from(),
    to: ownerEmail,
    subject: `Cards402 — ${keyLabel} at ${pct}% of ${limitType} limit`,
    text: [
      `Agent "${keyLabel}" has reached ${pct}% of its ${limitType} spend limit.`,
      ``,
      `Spent: $${spentUsdc} USDC`,
      `Limit: $${limitUsdc} USDC`,
      ``,
      `Review in dashboard: ${DASHBOARD_URL}`,
      ``,
      `— cards402.com`,
    ].join('\n'),
    html: wrap(`${keyLabel} at ${pct}% of its ${limitType} spend limit`, body),
  });
}

// Generic alert dispatcher used by lib/alerts.js. Subject + body are
// pre-rendered by the alert evaluator so the template stays simple.
//
// Note: getTransporter() always returns a transporter — the previous
// `if (!transporter) return;` guard was dead code (F3-email).
async function sendAlertEmail({ to, subject, body }) {
  const transporter = getTransporter();
  const htmlBody = `
    ${eyebrow('Alert')}
    ${headline(escapeHtml(subject))}
    <p style="margin:0 0 24px 0;color:${COLOR.muted};font-size:14px;line-height:1.65;">${escapeHtml(body)}</p>
    ${button(DASHBOARD_URL, 'Open dashboard')}
  `;
  await transporter.sendMail({
    from: from(),
    to,
    subject,
    text: `${body}\n\n— cards402.com`,
    html: wrap(subject, htmlBody),
  });
}

module.exports = {
  sendLoginCode,
  sendApprovalEmail,
  sendSpendAlertEmail,
  sendAlertEmail,
};
