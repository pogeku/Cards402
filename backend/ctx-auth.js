// CTX authentication helper.
// Bootstraps JWT tokens for CTX.com and saves them to the system_state DB table.
// Run this once before starting the backend, and again if tokens expire.
//
// Step 1 — request OTP:   node ctx-auth.js
// Step 2 — verify OTP:    node ctx-auth.js <OTP>
require('dotenv').config();
const { login, verifyEmail } = require('./src/ctx/client');

async function main() {
  const otp = process.argv[2];

  if (!otp) {
    await login();
    console.log('OTP sent — run: node ctx-auth.js <OTP>');
  } else {
    await verifyEmail(otp.trim());
    console.log('Done — tokens saved to system_state DB table');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
