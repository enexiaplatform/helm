import { useState } from 'react';
import { closesIn, type PipelinePosition } from '@helm/twin-runtime';
import type { ScenarioWorkspace } from '../../services/scenarioRuntime.ts';
import { displayValue } from '../../services/scenarioRuntime.ts';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/Button.tsx';

/**
 * "What if…" in three plain steps (audit 2026-10-13: revisions, seals, rebases and overrides were too much for a first
 * scenario; "reduce by 20%" was entered as "set to 0.05"). What changes, for which deals, by how much. The wizard turns
 * the answer into ordinary overrides — one per deal, each the NEW value computed from the deal's own current value, so
 * the change is exact and readable — then simulates it. The full scenario is there to inspect like any other.
 */

type What = 'probability' | 'value';
type Which = 'quarter' | 'brand' | 'customer' | 'all';

export function WhatIfWizard({ ws, rows, quarter, onClose, onDone }: { ws: ScenarioWorkspace; rows: readonly PipelinePosition[]; quarter: string; onClose: () => void; onDone: (scenarioId: string) => void }) {
  const [step, setStep] = useState(1);
  const [what, setWhat] = useState<What>('probability');
  const [which, setWhich] = useState<Which>('quarter');
  const [brand, setBrand] = useState('');
  const [customer, setCustomer] = useState('');
  const [pct, setPct] = useState('-20');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = rows.filter((r) => r.state === 'OPEN');
  const brands = [...new Set(open.map((r) => r.brand).filter((b): b is string => b !== null))].sort();
  // A hundred deals at most: read on every render, no memo needed.
  const base = open.filter((r) => (what === 'probability' ? r.probability !== null : r.value !== null));
  const chosen =
    which === 'quarter'
      ? base.filter((r) => closesIn(r.expectedClosePeriod, quarter) !== 'NO')
      : which === 'brand'
        ? base.filter((r) => brand !== '' && r.brand === brand)
        : which === 'customer'
          ? base.filter((r) => customer.trim().length >= 2 && (r.customer ?? '').toLowerCase().includes(customer.trim().toLowerCase()))
          : base;
  const n = Number(pct.replace(',', '.'));
  const factor = 1 + n / 100;
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  const whichText = which === 'quarter' ? `deals due in ${quarter}` : which === 'brand' ? `${brand} deals` : which === 'customer' ? `deals with “${customer.trim()}”` : 'all open deals';
  const name = `${what === 'probability' ? 'Probability' : 'Value'} ${sign}${Math.abs(n)}% · ${whichText}`;
  const newOf = (r: PipelinePosition): number => {
    const cur = Number(what === 'probability' ? r.probability : r.value);
    const next = cur * factor;
    return what === 'probability' ? Math.min(1, Math.max(0, Math.round(next * 10000) / 10000)) : Math.round(next * 100) / 100;
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const metricKey = what === 'probability' ? 'OpportunityProbability' : 'OpportunityValue';
      const nodes = await ws.graphs.valueGraph.findValueNodes(ws.scope, { metricKeys: [metricKey], limit: 1000 });
      if (!nodes.ok) throw new Error(nodes.error.message);
      const nodeOf = new Map(nodes.value.filter((v) => v.subjectEntityId).map((v) => [String(v.subjectEntityId), v.id]));
      const missing = chosen.filter((r) => !nodeOf.has(r.opportunityId));
      if (missing.length === chosen.length) throw new Error('None of these deals has a position HELM can change.');
      const created = await ws.runtime.createScenario(ws.scope, {
        // Inside the click handler, not render: a scenario key must be unique per creation.
        // eslint-disable-next-line react-hooks/purity
        key: `what-if-${Date.now().toString(36)}`,
        name,
        description: `Made with “What if…”: ${what} of ${whichText}, ${sign}${Math.abs(n)}% from each deal's own current ${what}.`,
        periods: ws.periodChoices.slice(0, 1),
      });
      if (!created.ok) throw new Error(created.error.message);
      for (const r of chosen) {
        const nodeId = nodeOf.get(r.opportunityId);
        if (!nodeId) continue;
        const added = await ws.runtime.addOverride(ws.scope, created.value.revision.id, {
          overrideType: 'ASSUMPTION_OVERRIDE',
          targetNodeId: nodeId,
          operation: 'SET',
          value: String(newOf(r)),
          unit: what === 'probability' ? 'ratio' : 'currency',
          currency: what === 'value' ? r.currency : null,
          period: null,
          provenanceKind: 'MANAGEMENT_ASSUMPTION',
          rationale: `${sign}${Math.abs(n)}% of the deal's current ${what} (${what === 'probability' ? `${Math.round(Number(r.probability) * 100)}%` : `${r.value} ${r.currency ?? ''}`.trim()}).`,
        });
        if (!added.ok) throw new Error(`${r.opportunity}: ${added.error.message}`);
      }
      const executed = await ws.runtime.execute(ws.scope, created.value.scenario.id);
      if (!executed.ok) throw new Error(executed.error.message);
      onDone(created.value.scenario.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const radio = (checked: boolean, label: string, onPick: () => void, detail?: string) => (
    <label className="flex cursor-pointer items-baseline gap-2 border-b border-ink-200 py-2 text-ui">
      <input type="radio" checked={checked} onChange={onPick} />
      <span>{label}{detail && <span className="ml-2 text-meta text-ink-500">{detail}</span>}</span>
    </label>
  );
  const control = 'rounded-md border border-ink-200 bg-white px-2 py-[6px] text-dense';

  return (
    <Modal title="What if…" onClose={onClose}>
      <p className="font-mono text-meta text-ink-500">Step {step} of 3</p>
      {step === 1 && (
        <div className="mt-2">
          <p className="font-serif text-panel text-ink-950">What changes?</p>
          {radio(what === 'probability', 'The probability of deals', () => setWhat('probability'), 'e.g. a principal’s price rise makes deals less likely')}
          {radio(what === 'value', 'The value of deals', () => setWhat('value'), 'e.g. a discount, a currency move')}
        </div>
      )}
      {step === 2 && (
        <div className="mt-2">
          <p className="font-serif text-panel text-ink-950">For which deals?</p>
          {radio(which === 'quarter', `Open deals due in ${quarter}`, () => setWhich('quarter'))}
          {brands.length > 0 && radio(which === 'brand', 'One brand’s deals', () => setWhich('brand'))}
          {which === 'brand' && (
            <select className={`${control} ml-6 mt-1`} value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">Choose a brand…</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          {radio(which === 'customer', 'One customer’s deals', () => setWhich('customer'))}
          {which === 'customer' && <input className={`${control} ml-6 mt-1`} value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Part of the customer’s name" />}
          {radio(which === 'all', 'All open deals', () => setWhich('all'))}
          <p className="mt-2 font-mono text-meta text-ink-600">{chosen.length} {chosen.length === 1 ? 'deal' : 'deals'} with a {what} to change.</p>
        </div>
      )}
      {step === 3 && (
        <div className="mt-2">
          <p className="font-serif text-panel text-ink-950">By how much?</p>
          <p className="mt-2 flex items-center gap-2 text-ui">
            <input className={`${control} w-24 font-mono`} value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" />
            <span>% of each deal’s current {what} (negative to reduce)</span>
          </p>
          {chosen.slice(0, 3).map((r) => (
            <p key={r.opportunityId} className="mt-1 font-mono text-meta text-ink-600">
              {r.opportunity}: {what === 'probability' ? `${Math.round(Number(r.probability) * 100)}% → ${Math.round(newOf(r) * 1000) / 10}%` : `${displayValue(String(r.value), 'currency', r.currency)} → ${displayValue(String(newOf(r)), 'currency', r.currency)}`}
            </p>
          ))}
          {chosen.length > 3 && <p className="font-mono text-meta text-ink-500">… and {chosen.length - 3} more, each from its own value.</p>}
          <p className="mt-3 text-dense text-ink-700">It will be saved as “{name}” and simulated against the baseline.</p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-dense text-red-700">{error}</p>}
      <div className="mt-5 flex items-center justify-between">
        <button type="button" className="text-dense text-ink-600 hover:text-ink-900" onClick={() => (step === 1 ? onClose() : setStep(step - 1))}>{step === 1 ? 'Cancel' : 'Back'}</button>
        {step < 3 ? (
          <Button variant="primary" size="sm" onClick={() => setStep(step + 1)} disabled={step === 2 && chosen.length === 0}>Next</Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => void run()} disabled={busy || !Number.isFinite(n) || n === 0 || n < -100 || chosen.length === 0}>{busy ? 'Simulating…' : 'Simulate'}</Button>
        )}
      </div>
    </Modal>
  );
}
