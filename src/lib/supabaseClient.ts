import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cachingFetch, clearReadCache } from './readCache.ts';

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
      // Identical reads within a session are answered once (src/lib/readCache.ts); any write or Refresh drops them.
      global: { fetch: cachingFetch((...args) => globalThis.fetch(...args)) },
    }))
  : null;

// A reader who signs out leaves nothing held behind (reads are also keyed by token, so another reader never shares them).
supabaseClient?.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') clearReadCache();
});
