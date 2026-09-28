import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHelmStore } from '../services/helmStore.ts';
import { isSupabaseConfigured } from '../lib/supabaseClient.ts';
import { HelmLockup } from '../components/brand/HelmLogo.tsx';
import { Button } from '../components/ui/Button.tsx';
import { TextField } from '../components/ui/TextField.tsx';

/**
 * Sign in, or open the demo organization. The one product surface allowed the
 * brand graphics: the chart grid (paper at 4.5%, 96px) and a single brass
 * heading line at −12.5°.
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
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-navy px-10 py-12"
      style={{
        backgroundImage:
          'linear-gradient(rgb(243 241 235 / 0.045) 1px, transparent 1px), linear-gradient(90deg, rgb(243 241 235 / 0.045) 1px, transparent 1px)',
        backgroundSize: '96px 96px',
      }}
    >
      <div aria-hidden className="absolute -left-[10%] bottom-[14%] h-[2px] w-[130%] origin-left -rotate-[12.5deg] bg-brass-400 opacity-85" />
      <div className="relative flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-14">
        <div className="grid flex-[1_1_420px] gap-[22px] text-paper">
          <HelmLockup height={44} tone="dark" />
          <p className="mt-[18px] font-serif text-[56px] italic leading-[62px] tracking-[-0.012em]">Steer by what is true.</p>
          <p className="text-[18px] leading-7 text-chrome-muted">The Enterprise Management Infrastructure</p>
          <p className="mt-[26px] max-w-[440px] text-dense text-chrome-muted">
            HELM shares its database and identity with Memoire. Sign in with your Memoire account to work with live
            commercial data.
          </p>
        </div>
        <form onSubmit={submit} className="grid flex-[0_1_400px] gap-[14px] rounded-2xl bg-white p-8 shadow-overlay">
          <h1 className="mb-1 text-figure-sm">{signup ? 'Create an account' : 'Sign in'}</h1>
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
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !isSupabaseConfigured}
            className="mt-1 justify-center py-[11px] text-ui"
          >
            {busy ? 'Working…' : signup ? 'Create account' : 'Sign in'}
          </Button>
          <button type="button" onClick={() => setSignup(!signup)} className="text-dense font-medium text-accent-700 hover:underline">
            {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
          <div className="helm-label my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-ink-200" />
            or
            <span className="h-px flex-1 bg-ink-200" />
          </div>
          <Button
            onClick={() => {
              enterDemo();
              navigate('/');
            }}
            className="justify-center py-[10px] text-ui"
          >
            Explore the demo organization
          </Button>
          <p className="text-center text-meta text-ink-500">Meridian Life Sciences Vietnam — realistic data, nothing syncs.</p>
        </form>
      </div>
    </div>
  );
}
