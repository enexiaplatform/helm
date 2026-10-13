/**
 * HELM's reads of its own records, held for the session (2026-10-13).
 *
 * Opening the Cockpit asked Supabase for the same rows many times: each runtime (reviews, genome, counterfactuals,
 * causal, twin) reads its tables whole, and every projection read them again — one load was ~300 requests, the
 * genome tables 15 times each. This fetch wrapper answers an identical REST read from what it already holds, and
 * shares one request between callers asking at the same moment.
 *
 * What is held is never older than HELM's own last act: ANY write (POST, PATCH, DELETE, an RPC) drops everything,
 * and a read that was in flight across a write is not kept. Rows other people change reach this reader when they
 * press Refresh, which drops everything too (clearReadCache). The key includes the bearer token, so one reader's
 * rows are never served to another.
 */

type Held = { readonly status: number; readonly statusText: string; readonly headers: [string, string][]; readonly body: string };

const held = new Map<string, Promise<Held | null>>();
/** Bumped by every write and every clear: a read that started before it is not kept. */
let generation = 0;

/** Drop everything held. Called by Refresh, sign-out and every write. */
export function clearReadCache(): void {
  generation += 1;
  held.clear();
}

const headerOf = (init: RequestInit | undefined, name: string): string => {
  const h = init?.headers;
  if (!h) return '';
  if (h instanceof Headers) return h.get(name) ?? '';
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1] ?? '';
  const rec = h as Record<string, string>;
  return Object.entries(rec).find(([k]) => k.toLowerCase() === name)?.[1] ?? '';
};

const replay = (h: Held): Response => new Response(h.body, { status: h.status, statusText: h.statusText, headers: h.headers });

export function cachingFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      // A write: whatever was held may now be wrong. Drop it before and after, so a read racing the write is not kept.
      clearReadCache();
      try {
        return await base(input, init);
      } finally {
        clearReadCache();
      }
    }
    // Only HELM's table reads are held; auth, storage, functions and realtime always go to the network.
    if (method !== 'GET' || !url.includes('/rest/v1/') || input instanceof Request) return base(input, init);
    const key = [url, headerOf(init, 'authorization'), headerOf(init, 'accept'), headerOf(init, 'prefer'), headerOf(init, 'range'), headerOf(init, 'accept-profile')].join('\n');
    const known = held.get(key);
    if (known) {
      const h = await known;
      if (h) return replay(h);
    }
    const startedAt = generation;
    const pending = base(input, init).then(
      async (res): Promise<Held> => ({ status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body: await res.text() }),
    );
    // Callers that join a failed request read the network themselves.
    const entry = pending.catch(() => null);
    held.set(key, entry);
    const forget = () => {
      if (held.get(key) === entry) held.delete(key);
    };
    let h: Held;
    try {
      h = await pending;
    } catch (e) {
      forget();
      throw e;
    }
    // Only a clean answer, read after HELM's last write, is held; an error is read again next time.
    if (h.status < 200 || h.status >= 300 || generation !== startedAt) forget();
    return replay(h);
  };
}
