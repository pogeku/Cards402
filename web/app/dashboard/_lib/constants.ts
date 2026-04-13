// Shared lookup tables for agent states and order statuses. Having a
// single source of truth means new states/statuses ripple through every
// page that renders them, and an auditor won't find four copies of the
// same map drifting out of sync.

import type { PillTone } from '../_ui/Pill';
import type { AgentStateName } from './types';

export const AGENT_STATE_TONE: Record<AgentStateName, PillTone> = {
  minted: 'neutral',
  initializing: 'yellow',
  awaiting_funding: 'yellow',
  funded: 'blue',
  active: 'green',
};

export const AGENT_STATE_LABEL: Record<AgentStateName, string> = {
  minted: 'Minted',
  initializing: 'Setting up',
  awaiting_funding: 'Awaiting deposit',
  funded: 'Funded',
  active: 'Active',
};

// Agent states that merit a pulsing dot because they're transient.
export const AGENT_STATE_PULSING: ReadonlySet<AgentStateName> = new Set([
  'initializing',
  'awaiting_funding',
]);

// Order status → pill tone. Anything unmapped falls back to purple so
// new backend statuses still render without a PR to the frontend.
export const ORDER_STATUS_TONE: Record<string, PillTone> = {
  delivered: 'green',
  failed: 'red',
  refunded: 'blue',
  refund_pending: 'yellow',
  pending_payment: 'yellow',
  payment_confirmed: 'blue',
  ordering: 'purple',
  claim_received: 'purple',
  stage1_done: 'purple',
  rejected: 'red',
  expired: 'red',
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  delivered: 'Delivered',
  failed: 'Failed',
  refunded: 'Refunded',
  refund_pending: 'Refunding',
  pending_payment: 'Pending payment',
  payment_confirmed: 'Payment confirmed',
  ordering: 'Ordering',
  claim_received: 'Claim received',
  stage1_done: 'Stage 1 done',
  rejected: 'Rejected',
  expired: 'Expired',
};

// Statuses that should render with a pulsing dot in the pill.
export const ORDER_STATUS_PULSING: ReadonlySet<string> = new Set([
  'pending_payment',
  'ordering',
  'claim_received',
  'stage1_done',
]);

// Statuses that count as "in flight" for KPI calculations.
export const IN_FLIGHT_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'pending_payment',
  'payment_confirmed',
  'ordering',
  'claim_received',
  'stage1_done',
]);

// Statuses that are terminal — the order won't change after this.
export const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'delivered',
  'failed',
  'refunded',
  'rejected',
  'expired',
]);

export function getOrderStatusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

export function getOrderStatusTone(status: string): PillTone {
  return ORDER_STATUS_TONE[status] ?? 'purple';
}
