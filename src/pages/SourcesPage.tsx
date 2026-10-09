/**
 * Connected sources — the integration fabric.
 *
 *     SOURCE SYSTEM OWNS THE FACT. HELM REFERENCES, CANONICALIZES, MODELS AND INTERPRETS IT.
 *
 * Memoire is the first rich source: HELM reads it (as you, and only read), canonicalizes an
 * opportunity into the ontology by Memoire's own id — never its name — and records its value and
 * probability as SOURCE observations naming Memoire, beside whatever the model estimates and never
 * over it. A changed source schema stops ingestion; a repeated sync changes nothing; and a governed
 * writeback back to Memoire is a DRY RUN in v1 — it says what it would have written and sends nothing.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SourceAndModel, SyncRecord, WritebackRequest } from '@helm/integration-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { useMemoireLive, wakeMemoireLiveSync } from '../services/memoireLiveSync.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { resolveIntegrationContext, syncHistory, syncNow, writebackHistory, type IntegrationContext } from '../services/integrationRuntime.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { Button } from '../components/ui/Button.tsx';

const stamp = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function SyncRow({ s }: { s: SyncRecord }) {
  const c = s.counts;
  const drift = s.drift.map((d) => `${d.objectType}: ${d.status}`).join(', ');
  return (
    <li className="border-b border-ink-200 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Pill tone={s.outcome === 'SUCCEEDED' ? 'committed' : s.outcome === 'PARTIAL' ? 'accepted' : 'blocked'}>{s.outcome.replaceAll('_', ' ')}</Pill>
        <span className="font-mono text-meta text-ink-500">{stamp(s.recordedAt)} · {s.connector}</span>
      </div>
      <p className="mt-1 font-mono text-meta text-ink-700">
        {c.records} record(s) · {c.entitiesCreated} entities created · {c.entitiesUnchanged} unchanged · {c.aliasesRegistered} identities · {c.observationsRecorded} observations recorded · {c.observationsUnchanged} unchanged · {c.quarantined} quarantined
      </p>
      <p className="mt-1 font-mono text-meta text-ink-500">checkpoint {s.cursorBefore ?? '—'} → {s.cursorAfter ?? '—'}{drift ? ` · schema ${drift}` : ''}</p>
      {s.drift.flatMap((d) => d.breaking).map((f, i) => <p key={i} className="mt-1 text-dense text-red-700">Blocked: {f.detail} ({f.records} record(s)) — HELM does not guess at a changed source.</p>)}
      {s.drift.flatMap((d) => d.additive).map((f, i) => <p key={i} className="mt-1 text-meta text-ink-600">Reported, not ingested: {f.detail}</p>)}
      {s.quarantined.map((q) => <p key={q.externalId} className="mt-1 text-dense text-red-700">{q.externalId}: {q.reason}</p>)}
    </li>
  );
}

function Truth({ sv, label }: { sv: SourceAndModel; label: string }) {
  const read = (xs: SourceAndModel['source']) => (xs.length === 0 ? [<p key="none" className="text-dense text-ink-500">Nothing stated.</p>] : xs.map((x) => (
    <p key={x.observationId} className="text-dense text-ink-900"><span className="font-mono text-meta text-ink-500">{x.type} · {x.sourceSystem}{x.sourceField ? ` · ${x.sourceField}` : ''}</span><span className="block font-serif text-figure-sm tabular">{x.value} <span className="font-mono text-meta text-ink-500">{x.unit}</span></span></p>
  )));
  return (
    <div>
      <p className="text-dense text-ink-700">{label}</p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-ink-200 bg-white px-4 py-3"><p className="helm-label">Source truth — what Memoire says</p><div className="mt-2 grid gap-2">{read(sv.source)}</div></div>
        <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/60 px-4 py-3"><p className="helm-label">Model truth — what HELM estimates</p><div className="mt-2 grid gap-2">{read(sv.model)}</div></div>
      </div>
      <p className="helm-caveat mt-2">{sv.statement}</p>
    </div>
  );
}

function WritebackRow({ w, replayed }: { w: WritebackRequest; replayed?: boolean }) {
  const r = w.receipt as { endpoint?: string; method?: string; note?: string; body?: Record<string, unknown> };
  return (
    <li className="border-b border-ink-200 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Pill tone={w.outcome === 'WOULD_WRITE' ? 'scenario' : 'blocked'}>{w.outcome.replaceAll('_', ' ')}</Pill>
        <Pill tone="neutral">{w.mode}</Pill>
        {replayed && <span className="font-mono text-meta text-ink-500">replayed — the same request</span>}
        <span className="text-dense text-ink-900">{w.targetSystem} · {w.operation}</span>
      </div>
      {w.outcome === 'REFUSED' ? <p className="mt-1 text-dense text-red-700">{w.refusalReason}</p> : (
        <p className="mt-1 font-mono text-meta text-ink-700">would {r.method} into {r.endpoint}: {JSON.stringify(r.body ?? {}).slice(0, 220)}</p>
      )}
      <p className="mt-1 font-mono text-meta text-ink-500">governance {w.governanceState} · idempotency {w.idempotencyKey} · from intent {w.actionIntentId.slice(0, 12)}</p>
      {r.note && <p className="helm-caveat mt-1">{r.note}</p>}
    </li>
  );
}

export function SourcesPage() {
  const mode = useHelmStore((st) => st.mode);
  const activeOrgId = useHelmStore((st) => st.activeOrgId);
  const userId = useHelmStore((st) => st.userId);
  const myRole = useHelmStore((st) => st.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [ctx, setCtx] = useState<IntegrationContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [syncs, setSyncs] = useState<readonly SyncRecord[]>([]);
  const [writebacks, setWritebacks] = useState<readonly WritebackRequest[]>([]);
  const [busy, setBusy] = useState(false);
  // In the cloud HELM keeps Memoire current by itself (ADR-0034): every pass it makes is a reason to re-read the history.
  const livePhase = useMemoireLive((st) => st.phase);
  const liveListening = useMemoireLive((st) => st.listening);
  const liveSync = useMemoireLive((st) => st.lastSync);

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const c = await resolveIntegrationContext(mode ?? 'demo', scope);
        if (!c) throw new Error('The integration fabric is unavailable in this mode.');
        if (live) setCtx(c);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  useEffect(() => {
    let live = true;
    if (!ctx) return;
    void (async () => {
      try {
        const [s, w] = await Promise.all([syncHistory(ctx), writebackHistory(ctx)]);
        if (live) {
          setSyncs(s);
          setWritebacks(w);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx, tick, liveSync]);

  if (error) return <EmptyState title="Connected sources could not be opened" detail={error} />;
  if (!ctx) return <p className="text-ui text-ink-500">Reading the connected sources…</p>;
  const proof = ctx.proof;
  const contract = ctx.adapter.contracts[0];

  const sync = async () => {
    // The live sync runs the same pipeline and also composes the new current state; ask it rather than run beside it.
    if (wakeMemoireLiveSync()) return;
    setBusy(true);
    try {
      await syncNow(ctx);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        kicker="Kernel instrument · Integration fabric"
        size="instrument"
        title="Connected sources"
        lede="The source system owns the fact; HELM references, canonicalizes, models and interprets it. What Memoire already knows is never typed in again, a model estimate never overwrites a source value, and anything HELM would write back is a governed dry run."
      />
      {ctx.mode === 'demo' && (
        <Notice tone="neutral" label="Demo source" className="mt-6">
          The Memoire below is a fixture with a handful of opportunities; nothing is read from or written to a real system. The proof shown is real code running against it.
        </Notice>
      )}

      <div className="mt-9 flex flex-wrap gap-10">
        <div className="min-w-0 flex-[1_1_560px]">
          <section>
            <SectionHead title="Memoire — commercial execution" meta={ctx.adapter.connector} caveat="read-only; HELM never writes into Memoire" />
            <FactRow
              className="mt-4"
              facts={[
                { label: 'Reads', value: `${contract?.objectType ?? '—'} (contract ${contract?.version ?? '—'})`, mono: true },
                { label: 'Identity', value: 'Memoire id → canonical key; a name is never an identity' },
                { label: 'Becomes', value: 'Opportunity, held by a Customer; value and probability as source observations' },
                { label: 'Writeback', value: 'DRY_RUN only — nothing is sent', mono: true },
              ]}
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {ctx.mode === 'cloud' && (
                <Button variant="secondary" onClick={() => void sync()} disabled={busy || livePhase === 'reading' || livePhase === 'composing'}>
                  {busy || livePhase === 'reading' ? 'Syncing…' : livePhase === 'composing' ? 'Composing…' : 'Sync now'}
                </Button>
              )}
              <span className="text-meta text-ink-500">
                {ctx.mode === 'cloud'
                  ? `Live: HELM re-reads your own Memoire opportunities under your access whenever one changes${liveListening ? '' : ' (change notices are not reaching HELM right now; it re-reads every minute instead)'}, from the last checkpoint, and composes a new current state when what it holds changed.`
                  : 'The proof below ran once when the demo was built.'}
              </span>
            </div>
          </section>

          <section className="mt-10">
            <SectionHead title="Sync history" meta={String(syncs.length)} caveat="the checkpoint never moves past a record HELM could not take" />
            {syncs.length === 0 && <p className="mt-3 text-ui text-ink-500">Nothing has been synced yet.</p>}
            <ul>{syncs.map((s) => <SyncRow key={s.id} s={s} />)}</ul>
          </section>

          {proof && (
            <section className="mt-10">
              <SectionHead title="Source truth beside model truth" caveat="neither overwrites the other" />
              <div className="mt-4">{proof.sourceVsModel ? <Truth sv={proof.sourceVsModel} label={proof.sourceVsModelLabel} /> : <p className="text-ui text-ink-500">No comparison is available.</p>}</div>
            </section>
          )}

          <section className="mt-10">
            <SectionHead title="Governed writeback to Memoire" meta={String(writebacks.length)} caveat="commitment → action intent → dry run" />
            <p className="mt-3 max-w-reading text-dense text-ink-600">A request can only derive from an explicit action intent of a committed decision, and only while governance permits execution. It carries an idempotency key, so dispatching twice is one request. Nothing is ever sent.</p>
            {writebacks.length === 0 && <p className="mt-3 text-ui text-ink-500">No writeback has been dispatched.</p>}
            <ul>{writebacks.map((w) => <WritebackRow key={w.id} w={w} replayed={proof?.replayed.some((x) => x.id === w.id)} />)}</ul>
          </section>
        </div>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title="What this removes" size="section-sm" />
          <ul className="mt-3 grid gap-3 text-dense text-ink-700">
            <li>An opportunity Memoire already holds is not entered again in HELM: it arrives as an entity, an identity and observations, with the source system, field and ingestion on record.</li>
            <li>A fact that exists in an authoritative source is integrated. HELM asks a person only for management judgement — an assumption, a decision, a reading of a counterfactual.</li>
            <li>The same identifier is one alias; one identifier naming two entities is a conflict, reported and never merged.</li>
          </ul>
          {proof && (
            <div className="mt-8">
              <SectionHead title="The proof, in four steps" size="section-sm" />
              <ol className="mt-3 grid gap-3 text-dense text-ink-700">
                <li><span className="font-medium text-ink-900">Ingest.</span> {proof.firstSync.counts.entitiesCreated} entities, {proof.firstSync.counts.aliasesRegistered} identities and {proof.firstSync.counts.observationsRecorded} observations from Memoire alone; the Rohto tender it already held changed nothing.</li>
                <li><span className="font-medium text-ink-900">Repeat.</span> The same sync again wrote {proof.repeatSync.counts.entitiesCreated + proof.repeatSync.counts.observationsRecorded + proof.repeatSync.counts.aliasesRegistered} records.</li>
                <li><span className="font-medium text-ink-900">Change and drift.</span> A probability moved ({proof.changedSync.counts.observationsRecorded} new observation); a source that lost a required field was <span className="font-mono">{proof.driftBlocked.outcome}</span>.</li>
                <li><span className="font-medium text-ink-900">Write back.</span> {proof.writebacks.length} request(s) as a dry run; dispatched again, {proof.replayed.filter((r) => r.replayed).length} replayed.</li>
              </ol>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
