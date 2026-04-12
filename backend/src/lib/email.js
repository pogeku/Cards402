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
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

async function sendLoginCode(email, code) {
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: 'Your cards402 login code',
    text: [
      `Your login code is: ${code}`,
      '',
      'This code expires in 15 minutes. If you did not request this, you can safely ignore this email.',
    ].join('\n'),
    html: [
      `<p style="font-family:monospace;font-size:2rem;letter-spacing:0.2em;font-weight:700">${code}</p>`,
      `<p>This code expires in 15 minutes.</p>`,
      `<p style="color:#888;font-size:0.875rem">If you did not request this, you can safely ignore this email.</p>`,
    ].join('\n'),
  });
}

async function sendApprovalEmail(
  ownerEmail,
  { approvalId, orderId, amountUsdc, keyLabel, reason },
) {
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM,
    to: ownerEmail,
    subject: `Approval required — $${amountUsdc} USDC`,
    text: [
      `An agent is requesting approval for a $${amountUsdc} USDC transaction.`,
      '',
      `Agent: ${keyLabel}`,
      `Amount: $${amountUsdc} USDC`,
      `Reason: ${reason}`,
      `Order: ${orderId}`,
      `Approval ID: ${approvalId}`,
      '',
      'Sign in to your cards402 dashboard to approve or reject.',
      'This request expires in 2 hours.',
    ].join('\n'),
    html: [
      `<h2 style="color:#a78bfa;font-family:monospace">⏳ Approval required — $${amountUsdc} USDC</h2>`,
      `<table style="border-collapse:collapse;margin:1rem 0;font-family:sans-serif">`,
      `<tr><td style="padding:0.25rem 1rem 0.25rem 0;color:#888;font-size:0.875rem">Agent</td><td style="font-weight:600">${keyLabel}</td></tr>`,
      `<tr><td style="padding:0.25rem 1rem 0.25rem 0;color:#888;font-size:0.875rem">Amount</td><td style="font-weight:700;color:#a78bfa;font-size:1.25rem">$${amountUsdc} USDC</td></tr>`,
      `<tr><td style="padding:0.25rem 1rem 0.25rem 0;color:#888;font-size:0.875rem">Reason</td><td>${reason}</td></tr>`,
      `<tr><td style="padding:0.25rem 1rem 0.25rem 0;color:#888;font-size:0.875rem">Order</td><td style="font-family:monospace;font-size:0.8rem">${orderId.slice(0, 16)}…</td></tr>`,
      `</table>`,
      `<p style="color:#888;font-size:0.875rem">Sign in to your dashboard to approve or reject. Expires in 2 hours.</p>`,
    ].join('\n'),
  });
}

async function sendSpendAlertEmail(ownerEmail, { keyLabel, pct, spentUsdc, limitUsdc, limitType }) {
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM,
    to: ownerEmail,
    subject: `Spend alert — ${keyLabel} at ${pct}% of ${limitType} limit`,
    text: [
      `Agent "${keyLabel}" has reached ${pct}% of its ${limitType} spend limit.`,
      '',
      `Spent: $${spentUsdc} USDC`,
      `Limit: $${limitUsdc} USDC`,
      '',
      'Sign in to your cards402 dashboard to review.',
    ].join('\n'),
    html: [
      `<h2 style="color:#fb923c;font-family:monospace">⚠️ Spend alert — ${pct}% of ${limitType} limit</h2>`,
      `<p style="font-family:sans-serif">Agent <strong>${keyLabel}</strong> has reached ${pct}% of its ${limitType} spend limit.</p>`,
      `<table style="border-collapse:collapse;margin:1rem 0;font-family:sans-serif">`,
      `<tr><td style="padding:0.25rem 1rem 0.25rem 0;color:#888;font-size:0.875rem">Spent</td><td style="font-weight:700;color:#fb923c">$${spentUsdc} USDC</td></tr>`,
      `<tr><td style="padding:0.25rem 1rem 0.25rem 0;color:#888;font-size:0.875rem">Limit</td><td>$${limitUsdc} USDC</td></tr>`,
      `</table>`,
      `<p style="color:#888;font-size:0.875rem">Sign in to your dashboard to review or adjust limits.</p>`,
    ].join('\n'),
  });
}

module.exports = { sendLoginCode, sendApprovalEmail, sendSpendAlertEmail };
