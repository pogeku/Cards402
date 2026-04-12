// Ambient type declarations for the cards402 backend.
// Extends Express's Request type with custom properties set by our
// middleware, so @ts-check files can access req.user, req.apiKey, etc.
// without casting every handler.

import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by middleware/auth.js — the authenticated API key row */
      apiKey: import('better-sqlite3').RunResult & Record<string, any>;
      /** Set by middleware/requireAuth.js — the authenticated user row */
      user: { id: string; email: string; role: 'owner' | 'user'; dashboard_id?: string };
      /** Set by the request-id middleware in app.js */
      id: string;
      /** Set by express.json verify callback — raw string body for HMAC */
      rawBody: string;
      /** Set by middleware/requireDashboard.js */
      dashboard: { id: string; name: string; user_id: string; spend_limit_usdc?: string; frozen?: number; created_at?: string; [key: string]: any };
    }
  }
}

export {};
