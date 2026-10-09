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

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
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
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { Notice } from '../components/ui/Notice.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { controlSmClass } from '../components/ui/Field.tsx';
import { cn } from '../lib/cn.ts';

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

/** Label over value, two columns: the instrument's definition list. */
function Facts({ rows }: { rows: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="mt-2 grid grid-cols-[180px_minmax(0,1fr)] gap-x-4">
      {rows.map(([label, value, mono]) => (
        <Fragment key={label}>
          <dt className="border-b border-ink-100 py-[7px] text-meta text-ink-500">{label}</dt>
          <dd className={cn('min-w-0 break-all border-b border-ink-100 py-[7px] text-dense', mono && 'font-mono')}>{value}</dd>
        </Fragment>
      ))}
    </dl>
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

  // Who holds each opportunity. "Canister / Tailin / Cons" exists four times; the customer is what tells them apart.
  const [holders, setHolders] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      const [rels, customers] = await Promise.all([
        loaded.store.findRelationships(loaded.scope, { relationshipTypeKeys: ['HELD_BY'] }),
        loaded.store.findEntities(loaded.scope, { entityTypeKeys: ['Customer'], limit: 1000 }),
      ]);
      if (cancelled || !rels.ok || !customers.ok) return;
      const names = new Map(customers.value.map((c) => [String(c.id), c.name]));
      setHolders(new Map(rels.value.map((r) => [String(r.sourceEntityId), names.get(String(r.targetEntityId)) ?? ''])));
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

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
    const groups = new Map<string, Entity[]>();
    for (const e of entities) {
      const cat = registry.categoryOf(e.entityTypeKey) ?? 'unknown';
      groups.set(cat, [...(groups.get(cat) ?? []), e]);
    }
    return groups;
  }, [entities]);

  const typesInUse = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entities) counts.set(e.entityTypeKey, (counts.get(e.entityTypeKey) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entities]);

  const categories = [...categoryOrder.filter((c) => byCategory.has(c)), ...(byCategory.has('unknown') ? ['unknown'] : [])];

  return (
    <>
      <PageHeader kicker="Kernel instrument · Ontology" title="The enterprise, as the kernel knows it" size="instrument" />
      <p className="mt-2 max-w-[720px] text-read text-ink-600">
        Read-only. {registry.allEntityTypes().length} entity types and {registry.allRelationshipTypes().length} relationship
        types registered; every entity carries its provenance and its two clocks.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or canonical key…"
          className={cn(controlSmClass, 'w-64')}
        />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className={controlSmClass}
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
        <span className="helm-meta ml-1">
          {entities.length} entities · {categories.map((c) => `${c} ${byCategory.get(c)?.length}`).join(' · ')}
        </span>
      </div>
      {typesInUse.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {typesInUse.map(([key, n]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTypeFilter(typeFilter === key ? '' : key)}
              aria-pressed={typeFilter === key}
              className={cn(
                'rounded-md px-2 py-[2px] font-mono text-meta',
                typeFilter === key ? 'bg-accent-800 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
              )}
            >
              {key} {n}
            </button>
          ))}
        </div>
      )}

      {error && (
        <Notice tone="error" className="mt-5">
          {error}
        </Notice>
      )}

      <div className="mt-7 flex flex-wrap items-start gap-10">
        {/* ---------------- entity index ---------------- */}
        <nav className="grid min-w-[240px] flex-[0_1_320px] gap-[18px]">
          {categories.map((cat) => (
            <div key={cat}>
              <p className="helm-label mb-[6px]">{cat}</p>
              {byCategory.get(cat)!.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedId(e.id)}
                  className={cn(
                    'grid w-full rounded-lg px-[10px] py-[7px] text-left hover:bg-ink-100',
                    e.id === selectedId ? 'bg-accent-50' : '',
                  )}
                >
                  <span className={cn('truncate text-dense leading-[19px]', e.id === selectedId ? 'font-semibold text-accent-800' : 'text-ink-800')}>
                    {e.name}
                  </span>
                  {holders.get(String(e.id)) && <span className="truncate text-meta text-ink-600">held by {holders.get(String(e.id))}</span>}
                  <span className="truncate font-mono text-meta text-ink-500">
                    {e.entityTypeKey} · {e.canonicalKey}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {entities.length === 0 && !error && <p className="text-dense text-ink-500">No entities in this organization yet.</p>}
        </nav>

        {/* ---------------- detail ---------------- */}
        <div className="min-w-0 flex-[1_1_560px]">
          {!selected ? (
            <p className="text-base text-ink-600">
              Select an entity to inspect its attributes, provenance, validity and neighbours.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Pill tone="neutral">{selected.entityTypeKey}</Pill>
                <span className="helm-meta font-medium">{selected.canonicalKey}</span>
              </div>
              <h2 className="mt-2 text-[26px] leading-[33px] tracking-[-0.01em]">{selected.name}</h2>
              <Facts
                rows={[
                  ['Entity id', selected.id, true],
                  ['Type category', registry.categoryOf(selected.entityTypeKey) ?? '—'],
                  ['Type ancestry', registry.ancestry(selected.entityTypeKey).join(' → '), true],
                  ['Status', selected.status, true],
                  ['Confidence', selected.confidence === null ? '—' : String(selected.confidence), true],
                ]}
              />

              <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-x-10 gap-y-8">
                <div>
                  <SectionHead title="Where it came from" size="section-sm" caveat="inline provenance" className="pb-2" />
                  <Facts
                    rows={[
                      ['Source system', selected.sourceSystem, true],
                      ['Source object', selected.sourceEntityType ?? '—', true],
                      ['Source id', selected.sourceEntityId ?? '—', true],
                    ]}
                  />
                </div>
                <div>
                  <SectionHead title="When it was true, and known" size="section-sm" className="pb-2" />
                  <Facts
                    rows={[
                      ['Valid from', selected.validFrom, true],
                      ['Valid to', selected.validTo ?? 'null (current)', true],
                      ['Observed at (source)', selected.observedAt ?? '—', true],
                      ['Ingested at (HELM)', selected.ingestedAt, true],
                      ['Updated at (HELM)', selected.updatedAt, true],
                      ['Version', String(selected.version), true],
                    ]}
                  />
                </div>
              </div>

              <div className="mt-8">
                <SectionHead title="Attributes" size="section-sm" className="pb-2" />
                <pre className="mt-3 max-h-48 overflow-auto rounded-xl border border-ink-200 bg-ink-50 px-4 py-3 font-mono text-meta text-ink-700">
                  {JSON.stringify(selected.attributes, null, 2)}
                </pre>
              </div>

              {aliases.length > 0 && (
                <div className="mt-8">
                  <SectionHead title="External identifiers" size="section-sm" meta={String(aliases.length)} className="pb-2" />
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        {['System', 'Kind', 'Value', 'Match'].map((h, i) => (
                          <th key={h} className={cn('helm-label pb-2 pt-[10px] text-left', i > 0 && 'pl-3')}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {aliases.map((a) => (
                        <tr key={a.id} className="border-t border-ink-200">
                          <td className="py-2 font-mono text-meta">{a.system}</td>
                          <td className="py-2 pl-3 font-mono text-meta text-ink-600">{a.aliasKind}</td>
                          <td className="py-2 pl-3 font-mono text-dense font-medium">{a.aliasValue}</td>
                          <td className="py-2 pl-3 font-mono text-meta text-ink-600">{a.matchMethod}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-meta text-ink-500">
                    The same management entity as named by each source system. Resolution is structural in Phase 1 — see
                    docs/architecture/identity-resolution.md.
                  </p>
                </div>
              )}

              <div className="mt-8">
                <SectionHead title="Provenance records" size="section-sm" meta={String(provenance.length)} className="pb-2" />
                {provenance.length === 0 && <p className="mt-3 text-dense text-ink-500">No provenance recorded.</p>}
                {provenance.map((p) => (
                  <div key={p.id} className="border-b border-ink-200 py-3">
                    <p className="flex flex-wrap items-center gap-2">
                      <Pill tone="forecast">{p.method}</Pill>
                      <span className="text-dense font-medium">{p.system}</span>
                      {p.connector && <span className="helm-meta">{p.connector}</span>}
                    </p>
                    <p className="helm-meta mt-1 break-all">
                      {[
                        p.sourceField && `field ${p.sourceField}`,
                        p.sourceObjectId && `${p.sourceObjectType ?? '?'} / ${p.sourceObjectId}`,
                        p.transformation && `transformation ${p.transformation}`,
                        `observed ${p.observedAt ?? '—'}`,
                        `recorded ${p.recordedAt}`,
                        p.ingestionEventId && `ingestion ${p.ingestionEventId}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-8">
                <SectionHead title="Relationships" size="section-sm" meta={String(neighbors.length)} className="pb-2" />
                {neighbors.map((n) => (
                  <button
                    key={n.via.id}
                    type="button"
                    onClick={() => setSelectedId(n.entity.id)}
                    className="grid w-full gap-[2px] border-b border-ink-200 py-[10px] text-left text-ink-950 hover:text-accent-800"
                  >
                    <span className="text-ui font-medium">{n.entity.name}</span>
                    <span className="helm-meta">
                      {n.direction === 'out' ? '→' : '←'} {n.via.relationshipTypeKey}
                      {n.via.weight !== null && ` · weight ${n.via.weight}`}
                      {n.via.confidence !== null && ` · confidence ${n.via.confidence}`}
                    </span>
                  </button>
                ))}
                {neighbors.length === 0 && <p className="mt-3 text-dense text-ink-500">No relationships.</p>}
              </div>

              <div className="mt-8">
                <SectionHead
                  title="Traversal from here"
                  size="section-sm"
                  meta={walk ? `${walk.nodes.length} entities · ${walk.relationships.length} relationships${walk.truncated ? ' · truncated' : ''}` : undefined}
                  caveat={
                    <span className="flex gap-1 not-italic">
                      {[1, 2, 3, 4].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setDepth(d)}
                          aria-pressed={depth === d}
                          className={cn('rounded-md px-2 font-mono text-meta', depth === d ? 'bg-accent-800 text-white' : 'bg-ink-100 text-ink-700 hover:bg-ink-200')}
                        >
                          {d}
                        </button>
                      ))}
                    </span>
                  }
                  className="pb-2"
                />
                {!walk && <p className="mt-3 text-dense text-ink-500">No traversal result.</p>}
                {walk && (
                  <>
                    <div className="max-h-80 overflow-auto">
                      {walk.nodes.map((n) => (
                        <div
                          key={n.entity.id}
                          className="flex items-baseline gap-2 border-b border-ink-100 py-[7px]"
                          style={{ paddingLeft: n.depth * 20 }}
                        >
                          <span className="font-mono text-dense text-ink-400">{n.depth === 0 ? '■' : '└'}</span>
                          <button type="button" onClick={() => setSelectedId(n.entity.id)} className="truncate text-left text-dense font-medium text-accent-700 hover:underline">
                            {n.entity.name}
                          </button>
                          <span className="helm-meta">{n.entity.entityTypeKey}</span>
                          <span className="helm-meta ml-auto">conf {n.pathConfidence.toFixed(3)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-meta text-ink-500">
                      Path confidence is the product of the edge confidences along the route, so a long chain is never
                      reported as more certain than its weakest link.
                    </p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
