import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Ship } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { isSupabaseConfigured } from '../lib/supabaseClient.ts';
import { Field } from '../components/ui.tsx';

export function AuthPage() {
  const navigate = useNavigate();
  const signIn = useHelmStore((s) => s.signIn);
  const signUp = useHelmStore((s) => s.signUp);
  const enterDemo = useHelmStore((s) => s.enterDemo);
  const [emailMode, setEmailMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fn = emailMode === 'signin' ? signIn : signUp;
    const err = await fn(email, password);
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      navigate('/');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink-800">
            <Ship size={20} className="text-accent-400" />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-white">HELM</h1>
            <p className="text-xs text-ink-400">The system of decision for managers</p>
          </div>
        </div>

        <div className="rounded-lg bg-white p-5 shadow-overlay">
          <form onSubmit={submit} className="space-y-3">
            <Field label="Email">
              <input
                className="field-input"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                className="field-input"
                type="password"
                required
                minLength={8}
                autoComplete={emailMode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <p className="text-xs text-red-600">{error}</p>}
            {!isSupabaseConfigured && (
              <p className="text-xs text-amber-700">
                Cloud is not configured (set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). The demo below works
                without it.
              </p>
            )}
            <button className="btn-primary w-full justify-center" disabled={busy || !isSupabaseConfigured}>
              {busy ? 'Working…' : emailMode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <button
            className="mt-2 w-full text-center text-xs text-ink-500 hover:text-ink-800"
            onClick={() => setEmailMode(emailMode === 'signin' ? 'signup' : 'signin')}
          >
            {emailMode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>

          <div className="my-4 flex items-center gap-3 text-2xs uppercase tracking-wide text-ink-400">
            <span className="h-px flex-1 bg-ink-200" />
            or
            <span className="h-px flex-1 bg-ink-200" />
          </div>

          <button
            className="btn-secondary w-full justify-center"
            onClick={() => {
              enterDemo();
              navigate('/');
            }}
          >
            Explore the demo organization
          </button>
          <p className="mt-2 text-center text-2xs text-ink-400">
            Meridian Life Sciences Vietnam — realistic data, nothing syncs.
          </p>
        </div>

        <p className="mt-4 text-center text-2xs text-ink-500">
          HELM shares its database and identity with Memoire. Sign in with your Memoire account to analyze live
          commercial data.
        </p>
      </div>
    </div>
  );
}
