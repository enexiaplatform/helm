import { useState } from 'react';
import type { QuarterReading } from '@helm/twin-runtime';
import type { QuarterTarget } from '../../services/quarterTargets.ts';
import { displayValue } from '../../services/scenarioRuntime.ts';
import { Button } from '../ui/Button.tsx';

/**
 * The quarter against its target (audit 2026-10-13, GM: "where will the quarter land against target, and how much is
 * missing"). Won so far plus the weighted open deals due in the quarter, beside the target someone set; the gap is the
 * arithmetic of the two, in one currency. Without a target, the line says so and offers to record one.
 */
export function TargetLine({ q, label, target, onSet }: { q: QuarterReading; label: string; target: QuarterTarget | null; onSet: ((amount: number, currency: string) => Promise<void>) | null }) {
  const currency = q.open.value.currency ?? q.won.inQuarterValue.currency ?? 'SGD';
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const won = q.won.inQuarterValue.value === null ? 0 : Number(q.won.inQuarterValue.value);
  const weighted = q.inQuarter.weighted.value === null ? 0 : Number(q.inQuarter.weighted.value);
  const sameCurrency = target !== null && (target.currency ?? currency) === currency && q.won.inQuarterValue.mixed.length === 0 && q.inQuarter.weighted.mixed.length === 0;
  const projected = won + weighted;
  const gap = target ? projected - Number(target.value) : null;
  const money = (n: number, c: string | null) => displayValue(String(n), 'currency', c);

  const save = async () => {
    if (!onSet) return;
    setBusy(true);
    setError(null);
    try {
      await onSet(Number(amount.replace(/[\s,]/g, '')), cur);
      setEditing(false);
      setAmount('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <span className="inline-flex flex-wrap items-center gap-2">
      <input className="w-36 rounded-md border border-ink-200 bg-white px-2 py-1 font-mono text-dense" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" inputMode="decimal" />
      <input className="w-16 rounded-md border border-ink-200 bg-white px-2 py-1 font-mono text-dense uppercase" value={cur} onChange={(e) => setCur(e.target.value)} maxLength={3} />
      <Button variant="secondary" size="sm" onClick={() => void save()} disabled={busy || !(Number(amount.replace(/[\s,]/g, '')) > 0) || cur.trim().length !== 3}>{busy ? 'Recording…' : 'Record target'}</Button>
      <button type="button" className="text-meta text-ink-500 hover:text-ink-900" onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );

  return (
    <div className="mt-5 border-t border-ink-200 pt-3 text-dense text-ink-800">
      {target === null ? (
        editing ? (
          <p className="flex flex-wrap items-center gap-2"><span>Revenue target for {label}:</span>{form}</p>
        ) : (
          <p>
            No revenue target is recorded for {label}, so HELM cannot say how far the quarter is from it.{' '}
            {onSet && <button type="button" className="font-medium text-accent-700 hover:underline" onClick={() => setEditing(true)}>Set a target</button>}
          </p>
        )
      ) : (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-serif text-panel text-ink-950">
            {sameCurrency
              ? `Won ${money(won, currency)} + weighted ${money(weighted, currency)} = ${money(projected, currency)} against a ${money(Number(target.value), target.currency)} target`
              : `Target ${money(Number(target.value), target.currency)}`}
          </span>
          {sameCurrency && gap !== null && (
            <span className={gap < 0 ? 'font-mono text-dense text-red-700' : 'font-mono text-dense text-ink-700'}>
              {gap < 0 ? `${money(-gap, currency)} short` : `${money(gap, currency)} above`}
            </span>
          )}
          {!sameCurrency && <span className="text-meta text-ink-600">The target and the deals are in different currencies; HELM does not convert, so no gap is shown.</span>}
          <span className="font-mono text-meta text-ink-500">set {target.recordedAt.slice(0, 10)}</span>
          {onSet && !editing && <button type="button" className="text-meta font-medium text-accent-700 hover:underline" onClick={() => setEditing(true)}>Change</button>}
          {editing && form}
        </p>
      )}
      {error && <p role="alert" className="mt-1 text-dense text-red-700">{error}</p>}
      <p className="mt-1 text-meta text-ink-500">Weighted is a probability-weighted expectation, not a commitment; it is set beside the target, not judged against it.</p>
    </div>
  );
}
