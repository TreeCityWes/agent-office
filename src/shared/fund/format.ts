// Money and percentages in words, the same in the risk engine's reasons, the dashboards and what the
// agents read.

/** $1,234,567 — or, compact, $1.23M. Negative amounts get a minus sign in front of the $. */
export function usd(n: number, opts: { compact?: boolean; cents?: boolean } = {}): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '-∞' : '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (opts.compact && a >= 1000) {
    const [div, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
    const v = a / div;
    return `${sign}$${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)}${unit}`;
  }
  const digits = opts.cents ? 2 : 0;
  return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** A price: more places the smaller it is. */
export function price(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 12.3% — `signed` puts a + on gains. */
export function pct(n: number, digits = 1, signed = false): string {
  if (!Number.isFinite(n)) return '—';
  const s = n.toFixed(digits);
  return `${signed && n > 0 ? '+' : ''}${s}%`;
}

/** +$1,234 / -$1,234. */
export function signedUsd(n: number, opts: { compact?: boolean } = {}): string {
  return `${n > 0 ? '+' : ''}${usd(n, opts)}`;
}
