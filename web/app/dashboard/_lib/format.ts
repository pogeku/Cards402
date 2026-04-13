// Display formatters shared across pages. Kept stringly-typed because
// the backend returns money as decimal strings.

export function formatUsd(value: string | number, decimals = 2): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatAmountShort(value: string | number): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(2);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!isFinite(t)) return '—';
  const seconds = Math.floor((Date.now() - t) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function truncateAddress(addr: string | null | undefined, left = 4, right = 4): string {
  if (!addr) return '—';
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}…${addr.slice(-right)}`;
}

// Bucket orders by day into [{date, amount, count}] for the last `days`.
// Returns chronological ascending.
export function bucketSpendByDay(
  orders: Array<{ created_at: string; amount_usdc: string; status: string }>,
  days: number,
): Array<{ date: string; amount: number; count: number }> {
  const buckets: Array<{ date: string; amount: number; count: number }> = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.push({ date: d.toISOString().slice(0, 10), amount: 0, count: 0 });
  }
  const index = new Map(buckets.map((b, i) => [b.date, i]));
  for (const o of orders) {
    const date = o.created_at.slice(0, 10);
    const idx = index.get(date);
    if (idx === undefined) continue;
    if (o.status !== 'delivered') continue; // only count delivered revenue
    const bucket = buckets[idx];
    if (!bucket) continue;
    bucket.amount += parseFloat(o.amount_usdc) || 0;
    bucket.count += 1;
  }
  return buckets;
}
