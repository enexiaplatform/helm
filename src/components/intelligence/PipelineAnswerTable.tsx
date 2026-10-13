import type { EvidenceItem } from '@helm/intelligence-runtime';
import { displayValue } from '../../services/scenarioRuntime.ts';

/**
 * A pipeline answer as a table (audit 2026-10-13: "22 long paragraphs in a narrow column, not sortable, not clickable").
 * Rows are the evidence the answer cites — the same deals, in the order the tool returned them. Each cell is read back
 * from the evidence's own values; nothing is computed here.
 */
const pick = (values: readonly string[], prefix: string): string | null => {
  const v = values.find((x) => x.startsWith(prefix));
  return v ? v.slice(prefix.length).trim() : null;
};

const money = (v: string | null): string => {
  if (!v) return '—';
  const [n, currency] = v.split(' ');
  return Number.isFinite(Number(n)) ? displayValue(n!, 'currency', currency ?? null) : v;
};

export function PipelineAnswerTable({ rows }: { rows: readonly EvidenceItem[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse">
        <thead>
          <tr>
            <th className="ledger-th">Deal</th>
            <th className="ledger-th">Stage</th>
            <th className="ledger-th">Close</th>
            <th className="ledger-th text-right">Value</th>
            <th className="ledger-th text-right">Prob.</th>
            <th className="ledger-th text-right">Weighted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const closed = e.values.find((v) => v === 'won' || v === 'lost' || v === 'on hold') ?? null;
            return (
              <tr key={e.id} className="border-b border-ink-200 align-top">
                <td className="max-w-[260px] px-3 py-2 text-dense text-ink-900">{e.label}</td>
                <td className="whitespace-nowrap px-3 py-2 text-dense text-ink-700">
                  {pick(e.values, 'stage ') ?? '—'}
                  {closed && <span className={closed === 'lost' ? 'ml-1 font-mono text-tag text-red-700' : 'ml-1 font-mono text-tag text-ink-950'}>{closed.toUpperCase()}</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-dense text-ink-700">
                  {pick(e.values, 'expected to close ') ?? <span className="text-red-700">none</span>}
                  {e.status === 'year not stated' && <span className="ml-1 text-tag text-amber-700">no year</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense">{e.values.includes('no value stated') ? <span className="text-red-700">none</span> : money(pick(e.values, 'value '))}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense">{e.values.includes('no probability stated') ? <span className="text-red-700">none</span> : pick(e.values, 'probability ') ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-dense text-ink-700">{money(pick(e.values, 'weighted '))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
