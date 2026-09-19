import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHelmStore } from '../services/helmStore.ts';
import { Field } from '../components/ui.tsx';

/**
 * First-run for a signed-in user with no organization yet: create the org
 * (they become its admin) and set the two financial assumptions everything
 * else reads — base currency and fiscal-year start.
 */
export function OnboardingPage() {
  const navigate = useNavigate();
  const createOrganization = useHelmStore((s) => s.createOrganization);
  const enterDemo = useHelmStore((s) => s.enterDemo);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [fyStart, setFyStart] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await createOrganization(name, currency, fyStart);
    setBusy(false);
    if (err) setError(err);
    else navigate('/');
  };

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 p-6">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-lg font-semibold">Set up your organization</h1>
        <p className="mb-5 text-sm text-ink-500">
          The organization is HELM's tenant boundary: decisions, economics, and signals live inside it, and
          teammates you invite see only what their role allows.
        </p>
        <form onSubmit={submit} className="space-y-4 rounded-lg border border-ink-200 bg-white p-5 shadow-panel">
          <Field label="Organization name">
            <input className="field-input" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base currency" hint="ISO code, e.g. VND, USD, SGD">
              <input
                className="field-input uppercase"
                required
                pattern="[A-Za-z]{3}"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Fiscal year starts">
              <select className="field-input" value={fyStart} onChange={(e) => setFyStart(Number(e.target.value))}>
                {months.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button className="btn-primary w-full justify-center" disabled={busy}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
        </form>
        <button
          className="mt-3 w-full text-center text-xs text-ink-500 hover:text-ink-800"
          onClick={() => {
            enterDemo();
            navigate('/');
          }}
        >
          Not ready? Explore the demo organization first
        </button>
      </div>
    </div>
  );
}
