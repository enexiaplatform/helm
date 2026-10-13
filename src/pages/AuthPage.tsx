import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHelmStore } from '../services/helmStore.ts';
import { isSupabaseConfigured } from '../lib/supabaseClient.ts';
import { HelmLockup } from '../components/brand/HelmLogo.tsx';
import { Button } from '../components/ui/Button.tsx';
import { TextField } from '../components/ui/TextField.tsx';

/**
 * Sign in, or open the demo organization. The one navy "night bridge" surface:
 * flat navy, the lockup, and a white sheet with the overlay shadow.
 */
export function AuthPage() {
  const navigate = useNavigate();
  const signIn = useHelmStore((s) => s.signIn);
  const signUp = useHelmStore((s) => s.signUp);
  const enterDemo = useHelmStore((s) => s.enterDemo);
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await (signup ? signUp : signIn)(email, password);
    setBusy(false);
    if (err) setError(err);
    else navigate('/');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy p-6">
      <div className="w-full max-w-[384px]">
        <div className="mb-6"><HelmLockup height={40} tone="dark" subtitle="The system of decision for managers" /></div>
        <form onSubmit={submit} className="grid gap-3 rounded-xl bg-white p-5 shadow-overlay">
          <h1 className="text-figure-sm">{signup ? 'Create an account' : 'Sign in'}</h1>
          <TextField
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            required
            minLength={8}
            autoComplete={signup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-dense text-red-700">{error}</p>}
          {!isSupabaseConfigured && (
            <p className="text-dense text-amber-700">
              Cloud is not configured (set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). The demo below works without it.
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy || !isSupabaseConfigured} className="w-full justify-center">
            {busy ? 'Working…' : signup ? 'Create account' : 'Sign in'}
          </Button>
          <button type="button" onClick={() => setSignup(!signup)} className="text-dense text-ink-500 transition-colors ease-helm hover:text-accent-700">
            {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
          <div className="helm-label my-1 flex items-center gap-3 text-ink-400">
            <span className="h-px flex-1 bg-ink-200" />
            or
            <span className="h-px flex-1 bg-ink-200" />
          </div>
          <Button
            onClick={() => {
              enterDemo();
              navigate('/');
            }}
            className="w-full justify-center"
          >
            Explore the demo organization
          </Button>
          <p className="text-center text-meta text-ink-500">Meridian Life Sciences Vietnam — realistic data, nothing syncs.</p>
        </form>
        <p className="mt-4 text-center text-meta text-ink-400">
          HELM shares its database and identity with Memoire. Sign in with your Memoire account to work with live commercial
          data.
        </p>
      </div>
    </div>
  );
}
