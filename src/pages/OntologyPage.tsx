/**
 * The Ontology Explorer — an engineering instrument, not a management surface.
 *
 * Its only job is to let a reviewer confirm the Phase 1 kernel is real: that
 * entities carry provenance and temporal state, that relationships connect the
 * enterprise, and that traversal works. Deliberately plain, deliberately
 * read-only, and deliberately without a single chart.
 *
 * Management surfaces begin at Phase 14, after Phase 6's authority and
 * visibility rules exist.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Database, GitBranch, Info, Layers } from 'lucide-react';
import type { Entity, EntityAlias } from '@helm/ontology';
import type { GraphStore, Neighbor, TraversalResult } from '@helm/graph-store';
import type { ProvenanceRecord, Scope } from '@helm/shared';
import { useHelmStore } from '../services/helmStore.ts';
import {
  cloudScope,
  demoScope,
  registry,
  resolveGraphStore,
} from '../services/ontologyGraph.ts';
import { PanelCard } from '../components/ui.tsx';

type Loaded = {
  store: GraphStore;
  scope: Scope;
};

type Detail = {
  forId: string;
  atDepth: number;
  neighbors: Neighbor[];
  provenance: ProvenanceRecord[];
  aliases: EntityAlias[];
  walk: TraversalResult | null;
};

const categoryOrder = [
  'organization',
  'commercial',
  'market',
  'operations',
  'resource',
  'finance',
  'management',
  'risk',
  'value',
] as const;

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-40 shrink-0 text-2xs uppercase tracking-wide text-ink-400">{label}</span>
      <span className={`text-xs text-ink-800 ${mono ? 'font-mono break-all' : ''}`}>{value}</span>
    </div>
  );
}

export function OntologyPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One state object, keyed by the entity it describes. Keying lets a stale
  // detail be derived away rather than cleared with a synchronous setState,
  // which would cascade renders.
  const [detail, setDetail] = useState<Detail | null>(null);
  const [depth, setDepth] = useState(2);

  // --- open the right store for the current mode ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await resolveGraphStore(mode === 'demo' ? 'demo' : 'cloud');
        if (cancelled) return;
        if (!store) {
          setError('No graph store available. Check the Supabase configuration.');
          return;
        }
        const scope =
          mode === 'demo'
            ? demoScope()
            : cloudScope(activeOrgId ?? '', userId ?? '', myRole());
        setLoaded({ store, scope });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, activeOrgId, userId, myRole]);

  // --- list entities ---
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      const r = await loaded.store.findEntities(loaded.scope, {
        entityTypeKeys: typeFilter ? [typeFilter] : undefined,
        search: search || undefined,
        limit: 300,
      });
      if (cancelled) return;
      if (!r.ok) {
        setError(`${r.error.code}: ${r.error.message}`);
        return;
      }
      setError(null);
      setEntities(r.value as Entity[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, typeFilter, search]);

  const selected = useMemo(
    () => entities.find((e) => e.id === selectedId) ?? null,
    [entities, selectedId],
  );

  // --- detail: neighbours, provenance, aliases, traversal ---
  useEffect(() => {
    if (!loaded || !selectedId) return;
    let cancelled = false;
    (async () => {
      const [n, p, a, t] = await Promise.all([
        loaded.store.getNeighbors(loaded.scope, {
          entityId: selectedId as Entity['id'],
          direction: 'both',
        }),
        loaded.store.getProvenance(loaded.scope, 'entity', selectedId),
        loaded.store.getAliases(loaded.scope, selectedId as Entity['id']),
        loaded.store.traverse(loaded.scope, {
          start: [selectedId as Entity['id']],
          maxDepth: depth,
          direction: 'both',
        }),
      ]);
      if (cancelled) return;
      setDetail({
        forId: selectedId,
        atDepth: depth,
        neighbors: n.ok ? (n.value as Neighbor[]) : [],
        provenance: p.ok ? (p.value as ProvenanceRecord[]) : [],
        aliases: a.ok ? (a.value as EntityAlias[]) : [],
        walk: t.ok ? t.value : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, selectedId, depth]);

  const current = detail && detail.forId === selectedId ? detail : null;
  const neighbors = current?.neighbors ?? [];
  const provenance = current?.provenance ?? [];
  const aliases = current?.aliases ?? [];
  const walk = current?.walk ?? null;

  const byCategory = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entities) {
      const cat = registry.categoryOf(e.entityTypeKey) ?? 'unknown';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return counts;
  }, [entities]);

  const typesInUse = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entities) counts.set(e.entityTypeKey, (counts.get(e.entityTypeKey) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entities]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Ontology Explorer</h1>
          <p className="text-xs text-ink-500">
            Read-only kernel instrument. {registry.allEntityTypes().length} entity types,{' '}
            {registry.allRelationshipTypes().length} relationship types registered.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or canonical key…"
            className="w-56 rounded border border-ink-200 px-2 py-1 text-xs"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded border border-ink-200 px-2 py-1 text-xs"
            aria-label="Filter by entity type"
          >
            <option value="">All types</option>
            {categoryOrder.map((cat) => (
              <optgroup key={cat} label={cat}>
                {registry
                  .allEntityTypes()
                  .filter((t) => t.category === cat)
                  .map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.key}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2 text-2xs">
        {categoryOrder
          .filter((c) => byCategory.has(c))
          .map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-ink-600"
            >
              <Layers className="h-3 w-3" /> {c}: {byCategory.get(c)}
            </span>
          ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* ---------------- entity list ---------------- */}
        <PanelCard title={`Entities (${entities.length})`}>
          <div className="mb-2 flex flex-wrap gap-1">
            {typesInUse.map(([key, n]) => (
              <button
                key={key}
                onClick={() => setTypeFilter(typeFilter === key ? '' : key)}
                className={`rounded px-1.5 py-0.5 text-2xs ${
                  typeFilter === key
                    ? 'bg-accent-600 text-white'
                    : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                }`}
              >
                {key} {n}
              </button>
            ))}
          </div>
          <ul className="max-h-[32rem] divide-y divide-ink-100 overflow-auto">
            {entities.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setSelectedId(e.id)}
                  className={`flex w-full items-center gap-2 px-1 py-1.5 text-left hover:bg-ink-50 ${
                    selectedId === e.id ? 'bg-accent-50' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink-900">{e.name}</span>
                    <span className="block truncate font-mono text-2xs text-ink-400">
                      {e.canonicalKey}
                    </span>
                  </span>
                  <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-2xs text-ink-600">
                    {e.entityTypeKey}
                  </span>
                  <ChevronRight className="h-3 w-3 shrink-0 text-ink-300" />
                </button>
              </li>
            ))}
            {entities.length === 0 && !error && (
              <li className="py-6 text-center text-xs text-ink-400">
                No entities in this organization yet.
              </li>
            )}
          </ul>
        </PanelCard>

        {/* ---------------- detail ---------------- */}
        <div className="space-y-4">
          {!selected && (
            <PanelCard title="Entity detail">
              <p className="py-8 text-center text-xs text-ink-400">
                Select an entity to inspect its attributes, provenance, validity and neighbours.
              </p>
            </PanelCard>
          )}

          {selected && (
            <>
              <PanelCard
                title={
                  <span className="flex items-center gap-2">
                    {selected.name}
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-2xs font-normal text-ink-600">
                      {selected.entityTypeKey}
                    </span>
                  </span>
                }
              >
                <Field label="Canonical key" value={selected.canonicalKey} mono />
                <Field label="Entity id" value={selected.id} mono />
                <Field
                  label="Type category"
                  value={registry.categoryOf(selected.entityTypeKey) ?? '—'}
                />
                <Field
                  label="Type ancestry"
                  value={registry.ancestry(selected.entityTypeKey).join(' → ')}
                />
                <Field label="Status" value={selected.status} />
                <Field
                  label="Confidence"
                  value={selected.confidence === null ? '—' : String(selected.confidence)}
                />
                <div className="my-2 border-t border-ink-100" />
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                  Provenance (inline)
                </p>
                <Field label="Source system" value={selected.sourceSystem} />
                <Field label="Source object" value={selected.sourceEntityType ?? '—'} />
                <Field label="Source id" value={selected.sourceEntityId ?? '—'} mono />
                <div className="my-2 border-t border-ink-100" />
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                  Temporal state
                </p>
                <Field label="Valid from" value={selected.validFrom} mono />
                <Field label="Valid to" value={selected.validTo ?? 'null (current)'} mono />
                <Field
                  label="Observed at (source)"
                  value={selected.observedAt ?? '—'}
                  mono
                />
                <Field label="Ingested at (HELM)" value={selected.ingestedAt} mono />
                <Field label="Updated at (HELM)" value={selected.updatedAt} mono />
                <Field label="Version" value={String(selected.version)} />
                <div className="my-2 border-t border-ink-100" />
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                  Attributes
                </p>
                <pre className="max-h-40 overflow-auto rounded bg-ink-50 p-2 font-mono text-2xs text-ink-700">
                  {JSON.stringify(selected.attributes, null, 2)}
                </pre>
              </PanelCard>

              {aliases.length > 0 && (
                <PanelCard
                  title={
                    <span className="flex items-center gap-1.5">
                      <Database className="h-3.5 w-3.5" /> External identifiers ({aliases.length})
                    </span>
                  }
                >
                  <table className="w-full text-2xs">
                    <thead>
                      <tr className="text-left text-ink-400">
                        <th className="pb-1 font-medium">System</th>
                        <th className="pb-1 font-medium">Kind</th>
                        <th className="pb-1 font-medium">Value</th>
                        <th className="pb-1 font-medium">Match</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {aliases.map((a) => (
                        <tr key={a.id}>
                          <td className="py-1 text-ink-700">{a.system}</td>
                          <td className="py-1 text-ink-500">{a.aliasKind}</td>
                          <td className="py-1 font-mono text-ink-800">{a.aliasValue}</td>
                          <td className="py-1 text-ink-500">{a.matchMethod}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-2xs text-ink-400">
                    The same management entity as named by each source system. Resolution is
                    structural in Phase 1 — see docs/architecture/identity-resolution.md.
                  </p>
                </PanelCard>
              )}

              <PanelCard
                title={
                  <span className="flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5" /> Provenance records ({provenance.length})
                  </span>
                }
              >
                {provenance.length === 0 && (
                  <p className="text-xs text-ink-400">No provenance recorded.</p>
                )}
                <ul className="space-y-2">
                  {provenance.map((p) => (
                    <li key={p.id} className="rounded border border-ink-100 p-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-accent-50 px-1.5 py-0.5 text-2xs font-semibold text-accent-800">
                          {p.method}
                        </span>
                        <span className="text-2xs text-ink-600">{p.system}</span>
                        {p.connector && (
                          <span className="font-mono text-2xs text-ink-400">{p.connector}</span>
                        )}
                      </div>
                      {p.sourceField && <Field label="Field" value={p.sourceField} />}
                      {p.sourceObjectId && (
                        <Field label="Source object" value={`${p.sourceObjectType ?? '?'} / ${p.sourceObjectId}`} mono />
                      )}
                      {p.transformation && <Field label="Transformation" value={p.transformation} />}
                      <Field label="Observed at" value={p.observedAt ?? '—'} mono />
                      <Field label="Recorded at" value={p.recordedAt} mono />
                      {p.ingestionEventId && (
                        <Field label="Ingestion event" value={p.ingestionEventId} mono />
                      )}
                    </li>
                  ))}
                </ul>
              </PanelCard>

              <PanelCard
                title={
                  <span className="flex items-center gap-1.5">
                    <GitBranch className="h-3.5 w-3.5" /> Relationships ({neighbors.length})
                  </span>
                }
              >
                <ul className="divide-y divide-ink-100">
                  {neighbors.map((n) => (
                    <li key={n.via.id} className="flex items-center gap-2 py-1.5">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-semibold ${
                          n.direction === 'out'
                            ? 'bg-emerald-50 text-emerald-800'
                            : 'bg-violet-50 text-violet-800'
                        }`}
                      >
                        {n.direction === 'out' ? '→' : '←'} {n.via.relationshipTypeKey}
                      </span>
                      <button
                        onClick={() => setSelectedId(n.entity.id)}
                        className="min-w-0 flex-1 truncate text-left text-xs text-accent-700 hover:underline"
                      >
                        {n.entity.name}
                      </button>
                      <span className="shrink-0 text-2xs text-ink-400">
                        {n.via.weight !== null && `w=${n.via.weight} `}
                        {n.via.confidence !== null && `c=${n.via.confidence}`}
                      </span>
                    </li>
                  ))}
                  {neighbors.length === 0 && (
                    <li className="py-3 text-xs text-ink-400">No relationships.</li>
                  )}
                </ul>
              </PanelCard>

              <PanelCard
                title={`Traversal from here (depth ${depth})`}
                action={
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map((d) => (
                      <button
                        key={d}
                        onClick={() => setDepth(d)}
                        className={`rounded px-1.5 py-0.5 text-2xs ${
                          depth === d ? 'bg-accent-600 text-white' : 'bg-ink-100 text-ink-600'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                }
              >
                {!walk && <p className="text-xs text-ink-400">No traversal result.</p>}
                {walk && (
                  <>
                    <p className="mb-2 text-2xs text-ink-500">
                      {walk.nodes.length} entities, {walk.relationships.length} relationships
                      {walk.truncated && ' (truncated)'}
                    </p>
                    <ul className="max-h-64 space-y-0.5 overflow-auto">
                      {walk.nodes.map((n) => (
                        <li key={n.entity.id} className="flex items-center gap-2 text-2xs">
                          <span
                            className="shrink-0 text-ink-300"
                            style={{ paddingLeft: `${n.depth * 12}px` }}
                          >
                            {n.depth === 0 ? '●' : '└'}
                          </span>
                          <button
                            onClick={() => setSelectedId(n.entity.id)}
                            className="truncate text-accent-700 hover:underline"
                          >
                            {n.entity.name}
                          </button>
                          <span className="shrink-0 rounded bg-ink-100 px-1 text-ink-500">
                            {n.entity.entityTypeKey}
                          </span>
                          <span className="shrink-0 text-ink-400">
                            conf {n.pathConfidence.toFixed(3)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-2xs text-ink-400">
                      Path confidence is the product of the edge confidences along the route, so a
                      long chain is never reported as more certain than its weakest link.
                    </p>
                  </>
                )}
              </PanelCard>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
