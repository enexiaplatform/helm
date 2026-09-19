import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard, EmptyState, Modal, Field } from '../components/ui.tsx';
import { evaluateScenario } from '../domain/engines/scenario.ts';
import { formatMoney, formatDate } from '../domain/format.ts';

export function ScenariosPage() {
  const navigate = useNavigate();
  const scenarios = useHelmStore((s) => s.scenarios);
  const decisions = useHelmStore((s) => s.decisions);
  const currency = useHelmStore((s) => s.currency)();
  const createScenario = useHelmStore((s) => s.createScenario);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = await createScenario({
      name: name || 'New scenario',
      baseline: {
        label: 'Baseline',
        currency,
        unitPrice: 0,
        unitsPerPeriod: 0,
        variableCostPerUnit: 0,
        fixedCostsPerPeriod: 0,
      },
    });
    setCreating(false);
    if (id) navigate(`/scenarios/${id}`);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Scenarios</h1>
          <p className="text-sm text-ink-500">What happens under different assumptions — without a spreadsheet.</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> New scenario
        </button>
      </header>

      <PanelCard>
        {scenarios.length === 0 ? (
          <EmptyState title="No scenarios yet" detail="Model a P&L baseline, then perturb price, volume, and costs." />
        ) : (
          <ul className="divide-y divide-ink-50">
            {scenarios.map((sc) => {
              const base = evaluateScenario(sc.baseline);
              const decision = decisions.find((d) => d.id === sc.decisionId);
              return (
                <li key={sc.id} className="py-2.5 first:pt-0 last:pb-0">
                  <Link to={`/scenarios/${sc.id}`} className="flex items-center justify-between gap-4 hover:text-accent-700">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{sc.name}</p>
                      <p className="text-2xs text-ink-500">
                        {sc.variants.length} variant{sc.variants.length === 1 ? '' : 's'}
                        {decision && <> · attached to “{decision.title}”</>} · updated {formatDate(sc.updatedAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums">{formatMoney(base.operatingProfit, sc.baseline.currency)}</p>
                      <p className="text-2xs text-ink-400">baseline profit / period</p>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </PanelCard>

      {creating && (
        <Modal title="New scenario" onClose={() => setCreating(false)}>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Name">
              <input className="field-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn-primary">Create</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
