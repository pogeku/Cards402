#!/usr/bin/env node
// Generates a 32-byte hex key suitable for ADMIN_SESSION_KEY / VCC_ADMIN_SESSION_KEY
// and any other 64-hex-char secret used by cards402 or vcc admin UIs.
//
// Audit finding A-6.
//
// Usage:
//   node scripts/generate-admin-key.js
//
// Pipe the output straight into your .env:
//   echo "ADMIN_SESSION_KEY=$(node scripts/generate-admin-key.js)" >> web/.env.local

import crypto from 'node:crypto';

const key = crypto.randomBytes(32).toString('hex');
process.stdout.write(key + '\n');
