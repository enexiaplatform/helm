import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHelmStore } from '../services/helmStore.ts';
import { HelmLockup } from '../components/brand/HelmLogo.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Field, controlClass } from '../components/ui/Field.tsx';
import { TextField } from '../components/ui/TextField.tsx';

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
    <div className="flex min-h-screen items-center justify-center px-10 py-12">
      <div className="grid w-full max-w-[440px] gap-6">
        <HelmLockup height={30} tone="light" />
        <header>
          <p className="helm-label">First run · Organization</p>
          <h1 className="mt-[10px] text-instrument">Set up your organization</h1>
          <p className="mt-3 text-read text-ink-600">
            The organization is HELM's tenant boundary: decisions, economics, and signals live inside it, and teammates
            you invite see only what their role allows.
          </p>
        </header>
        <form onSubmit={submit} className="grid gap-[14px] rounded-2xl border border-ink-200 bg-white p-8">
          <TextField label="Organization name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base currency" hint="ISO code, e.g. VND, USD, SGD">
              <input
                className={controlClass + ' font-mono uppercase'}
                required
                pattern="[A-Za-z]{3}"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Fiscal year starts">
              <select className={controlClass} value={fyStart} onChange={(e) => setFyStart(Number(e.target.value))}>
                {months.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {error && <p className="text-dense text-red-700">{error}</p>}
          <Button type="submit" variant="primary" disabled={busy} className="mt-1 justify-center py-[11px] text-ui">
            {busy ? 'Creating…' : 'Create organization'}
          </Button>
        </form>
        <button
          type="button"
          className="text-dense font-medium text-accent-700 hover:underline"
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
