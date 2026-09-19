/** Deterministic display formatting. All engines return raw numbers; only the
 * presentation layer goes through here. */

const compactUnits: [number, string][] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

export function formatMoney(amount: number, currency: string): string {
  const abs = Math.abs(amount);
  // VND-scale currencies read better compact; small currencies keep decimals.
  for (const [scale, suffix] of compactUnits) {
    if (abs >= scale) {
      const scaled = amount / scale;
      const digits = Math.abs(scaled) >= 100 ? 0 : 1;
      return `${scaled.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      })}${suffix} ${currency}`;
    }
  }
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${currency}`;
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })}%`;
}

export function formatDelta(amount: number, currency: string): string {
  const sign = amount > 0 ? '+' : '';
  return `${sign}${formatMoney(amount, currency)}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
