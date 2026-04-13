// @ts-check
// Email sender — thin wrapper around nodemailer using SMTP.
// Works with any SMTP provider: SES (via SMTP endpoint), Postmark, Resend, etc.
// Transporter is created lazily so the module can be imported in test environments
// without SMTP credentials configured.

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
// "cards402" rather than the raw no-reply address. If the operator already
// set a display name in SMTP_FROM (e.g. "foo <bar@baz.com>"), keep it.
function from() {
  const raw = process.env.SMTP_FROM || '';
  if (raw.includes('<')) return raw;
  return `"cards402" <${raw}>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Shared HTML chrome ────────────────────────────────────────────────────────
// Table-based layout for maximum client compatibility. Explicit background +
// text colors on every cell so Gmail/Outlook dark-mode auto-invert leaves the
// dark palette alone. No @font-face, no external images — resilient.

const COLOR = {
  bg: '#0a0a0a',
  card: '#111113',
  inner: '#0a0a0a',
  border: '#27272a',
  text: '#fafafa',
  muted: '#a1a1aa',
  faint: '#71717a',
  green: '#22c55e',
  orange: '#fb923c',
};

const FONT_SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const FONT_MONO = "ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

function wrap(preheader, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>cards402</title>
</head>
<body style="margin:0;padding:0;background-color:${COLOR.bg};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLOR.bg};opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.bg};">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:12px;">
        <tr>
          <td style="padding:28px 32px 0 32px;">
            <div style="font-family:${FONT_SANS};font-size:13px;font-weight:700;letter-spacing:0.12em;color:${COLOR.green};text-transform:lowercase;">cards402</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 32px 32px;font-family:${FONT_SANS};color:${COLOR.text};font-size:15px;line-height:1.6;">
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px;border-top:1px solid ${COLOR.border};font-family:${FONT_SANS};font-size:12px;color:${COLOR.faint};">
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

// ── Templates ─────────────────────────────────────────────────────────────────

async function sendLoginCode(email, code) {
  const safeCode = escapeHtml(code);
  const body = `
    <h1 style="margin:0 0 8px 0;font-family:${FONT_SANS};font-size:20px;font-weight:600;color:${COLOR.text};">Your login code</h1>
    <p style="margin:0 0 24px 0;color:${COLOR.muted};font-size:14px;">Enter this code to finish signing in.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="center" style="padding:26px 0;background-color:${COLOR.inner};border:1px solid ${COLOR.border};border-radius:10px;">
          <span style="font-family:${FONT_MONO};font-size:34px;letter-spacing:0.35em;font-weight:700;color:${COLOR.green};">${safeCode}</span>
        </td>
      </tr>
    </table>
    <p style="margin:22px 0 0 0;color:${COLOR.faint};font-size:13px;line-height:1.5;">This code expires in 15 minutes. If you didn't request it, you can safely ignore this email.</p>
  `;
  await getTransporter().sendMail({
    from: from(),
    to: email,
    subject: `${code} is your cards402 login code`,
    text: [
      `Your cards402 login code:`,
      ``,
      `    ${code}`,
      ``,
      `Expires in 15 minutes. If you didn't request it, you can ignore this email.`,
      ``,
      `— cards402.com`,
    ].join('\n'),
    html: wrap(`${code} is your cards402 login code`, body),
  });
}

async function sendApprovalEmail(
  ownerEmail,
  { approvalId, orderId, amountUsdc, keyLabel, reason },
) {
  const body = `
    <h1 style="margin:0 0 8px 0;font-family:${FONT_SANS};font-size:20px;font-weight:600;color:${COLOR.text};">Approval required</h1>
    <p style="margin:0 0 20px 0;color:${COLOR.muted};font-size:14px;">An agent is requesting your approval for a purchase.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.inner};border:1px solid ${COLOR.border};border-radius:10px;margin-bottom:24px;">
      <tr>
        <td style="padding:18px 20px;font-family:${FONT_SANS};font-size:13px;">
          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Amount</div>
          <div style="color:${COLOR.green};font-size:26px;font-weight:700;margin-bottom:18px;">$${escapeHtml(amountUsdc)} USDC</div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Agent</div>
          <div style="color:${COLOR.text};font-size:14px;margin-bottom:14px;">${escapeHtml(keyLabel)}</div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Reason</div>
          <div style="color:${COLOR.text};font-size:14px;margin-bottom:14px;">${escapeHtml(reason)}</div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Order</div>
          <div style="font-family:${FONT_MONO};color:${COLOR.muted};font-size:12px;">${escapeHtml(orderId)}</div>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="background-color:${COLOR.green};border-radius:8px;">
          <a href="https://cards402.com/dashboard" style="display:inline-block;padding:12px 24px;color:#000000;font-family:${FONT_SANS};font-weight:700;font-size:14px;text-decoration:none;">Review in dashboard →</a>
        </td>
      </tr>
    </table>
    <p style="margin:22px 0 0 0;color:${COLOR.faint};font-size:13px;">This request expires in 2 hours. Approval ID: <span style="font-family:${FONT_MONO};">${escapeHtml(approvalId)}</span></p>
  `;
  await getTransporter().sendMail({
    from: from(),
    to: ownerEmail,
    subject: `Approval required — $${amountUsdc} USDC`,
    text: [
      `An agent is requesting approval for a $${amountUsdc} USDC transaction.`,
      ``,
      `Agent:    ${keyLabel}`,
      `Amount:   $${amountUsdc} USDC`,
      `Reason:   ${reason}`,
      `Order:    ${orderId}`,
      `Approval: ${approvalId}`,
      ``,
      `Review in dashboard: https://cards402.com/dashboard`,
      `Expires in 2 hours.`,
      ``,
      `— cards402.com`,
    ].join('\n'),
    html: wrap(`An agent needs approval for $${amountUsdc} USDC`, body),
  });
}

async function sendSpendAlertEmail(ownerEmail, { keyLabel, pct, spentUsdc, limitUsdc, limitType }) {
  const body = `
    <h1 style="margin:0 0 8px 0;font-family:${FONT_SANS};font-size:20px;font-weight:600;color:${COLOR.text};">Spend alert</h1>
    <p style="margin:0 0 20px 0;color:${COLOR.muted};font-size:14px;">Agent <strong style="color:${COLOR.text};">${escapeHtml(keyLabel)}</strong> has reached <strong style="color:${COLOR.orange};">${escapeHtml(pct)}%</strong> of its ${escapeHtml(limitType)} spend limit.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.inner};border:1px solid ${COLOR.border};border-radius:10px;margin-bottom:24px;">
      <tr>
        <td style="padding:18px 20px;font-family:${FONT_SANS};font-size:13px;">
          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Spent</div>
          <div style="color:${COLOR.orange};font-size:24px;font-weight:700;margin-bottom:16px;">$${escapeHtml(spentUsdc)} USDC</div>

          <div style="color:${COLOR.faint};font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Limit</div>
          <div style="color:${COLOR.text};font-size:14px;">$${escapeHtml(limitUsdc)} USDC</div>
        </td>
      </tr>
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="background-color:${COLOR.card};border:1px solid ${COLOR.border};border-radius:8px;">
          <a href="https://cards402.com/dashboard" style="display:inline-block;padding:11px 22px;color:${COLOR.text};font-family:${FONT_SANS};font-weight:600;font-size:14px;text-decoration:none;">Review in dashboard →</a>
        </td>
      </tr>
    </table>
  `;
  await getTransporter().sendMail({
    from: from(),
    to: ownerEmail,
    subject: `Spend alert — ${keyLabel} at ${pct}% of ${limitType} limit`,
    text: [
      `Agent "${keyLabel}" has reached ${pct}% of its ${limitType} spend limit.`,
      ``,
      `Spent: $${spentUsdc} USDC`,
      `Limit: $${limitUsdc} USDC`,
      ``,
      `Review in dashboard: https://cards402.com/dashboard`,
      ``,
      `— cards402.com`,
    ].join('\n'),
    html: wrap(`${keyLabel} at ${pct}% of its ${limitType} spend limit`, body),
  });
}

// Generic alert dispatcher used by lib/alerts.js. Subject + body are
// pre-rendered by the alert evaluator so the template stays simple.
async function sendAlertEmail({ to, subject, body }) {
  const transporter = getTransporter();
  if (!transporter) return;
  await transporter.sendMail({
    from: from(),
    to,
    subject,
    text: `${body}\n\n— cards402.com`,
    html: wrap(subject, `<p>${escapeHtml(body)}</p>`),
  });
}

module.exports = {
  sendLoginCode,
  sendApprovalEmail,
  sendSpendAlertEmail,
  sendAlertEmail,
};
