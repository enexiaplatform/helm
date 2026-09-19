import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Same guard as Memoire: `import.meta.env` only exists under Vite. A distinct
// auth storageKey keeps HELM's session separate from Memoire's in the browser
// even though both apps authenticate against the same Supabase project.
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env || {};
const supabaseUrl = viteEnv.VITE_SUPABASE_URL || '';
const supabaseAnonKey = viteEnv.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured =
  Boolean(supabaseUrl) &&
  Boolean(supabaseAnonKey) &&
  !supabaseUrl.includes('placeholder') &&
  !supabaseAnonKey.includes('placeholder');

declare global {
  var __helmSupabaseClient: SupabaseClient | null | undefined;
}

export const supabaseClient: SupabaseClient | null = isSupabaseConfigured
  ? (globalThis.__helmSupabaseClient ||= createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storageKey: 'helm.supabase.auth',
      },
    }))
  : null;
