/**
 * The organization, as management reads it (step 4, 2026-10-17): who is in it, in which units, whose commercial
 * truth HELM reads, and who stands behind which decisions — the open ones, the committed ones, and the commitments
 * past the day they named to look again.
 *
 * HELM is multi-person where Memoire is single-user: each person signs in to Memoire and sees only their own deals, so
 * the commercial truth HELM holds is exactly the people whose Memoire has been read. This page says whose has and whose
 * has not, so a manager knows what the state leaves out. It is a record of accountability, never a rating: there are no
 * sales figures per person, nothing is scored, ranked or totalled per person, and people are listed by name.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SyncRecord } from '@helm/integration-runtime';
import { useHelmStore } from '../services/helmStore.ts';
import { cloudScope, demoScope } from '../services/ontologyGraph.ts';
import { resolveDecisionContext } from '../services/decisionRuntime.ts';
import { loadDecisionSummaries, type DecisionSummary } from '../services/decisionWorkspace.ts';
import { resolveIntegrationContext, syncHistory } from '../services/integrationRuntime.ts';
import { listSnapshots, resolveTwinContext } from '../services/twinRuntime.ts';
import { readInstant } from '../lib/format.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { cn } from '../lib/cn.ts';
import type { OrgMember, OrgUnit } from '../domain/types.ts';

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const word = (n: number) => NUM[n] ?? String(n);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

type Loaded = { readonly decisions: readonly DecisionSummary[]; readonly syncs: readonly SyncRecord[]; readonly today: string };

type Line = {
  readonly member: OrgMember;
  readonly units: readonly OrgUnit[];
  readonly lastRead: string | null;
  readonly open: readonly DecisionSummary[];
  readonly committed: readonly DecisionSummary[];
  readonly lookAgainDue: readonly DecisionSummary[];
};

/** A committed decision whose look-again day has come, with no outcome review since it was committed. */
const isDue = (d: DecisionSummary, today: string): boolean =>
  d.committed && d.lookAgainOn !== null && d.lookAgainOn <= today && (d.reviewedAt === null || (d.committedAt !== null && d.reviewedAt < d.committedAt));

export function OrganizationPage() {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const members = useHelmStore((s) => s.members);
  const units = useHelmStore((s) => s.units);
  const placed = useHelmStore((s) => s.unitMemberships);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo(
    () => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null),
    [mode, activeOrgId, userId, myRole],
  );

  useEffect(() => {
    let live = true;
    if (!scope) return;
    void (async () => {
      try {
        const ctx = await resolveDecisionContext(mode ?? 'demo', scope);
        const decisions = ctx ? await loadDecisionSummaries(ctx) : [];
        const integration = await resolveIntegrationContext(mode ?? 'demo', scope).catch(() => null);
        const syncs = integration ? await syncHistory(integration).catch(() => []) : [];
        // The demo keeps its own clock: "today" is the day its current state was composed for.
        let today = new Date().toISOString().slice(0, 10);
        if (mode === 'demo') {
          const twin = await resolveTwinContext('demo', scope);
          const current = twin ? [...(await listSnapshots(twin))].filter((s) => s.spec.kind === 'CURRENT').at(-1) : undefined;
          if (current) today = current.spec.lens.effectiveAsOf.slice(0, 10);
        }
        if (live) setLoaded({ decisions, syncs, today });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope]);

  if (error) return <EmptyState title="The organization could not be read" detail={error} />;

  const unitById = new Map(units.map((u) => [u.id, u] as const));
  const lines: Line[] = [...members]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((member) => {
      const owned = (loaded?.decisions ?? []).filter((d) => d.decision.owner?.userId === member.userId && d.decision.state !== 'CANCELLED');
      const reads = (loaded?.syncs ?? []).filter((s) => s.startedBy === member.userId);
      return {
        member,
        units: placed.filter((p) => p.userId === member.userId).map((p) => unitById.get(p.unitId)).filter((u): u is OrgUnit => u !== undefined),
        lastRead: reads.map((s) => s.recordedAt).sort().at(-1) ?? null,
        open: owned.filter((d) => !d.committed),
        committed: owned.filter((d) => d.committed),
        lookAgainDue: owned.filter((d) => isDue(d, loaded?.today ?? '')),
      };
    });
  const memberIds = new Set(members.map((m) => m.userId));
  const live = (loaded?.decisions ?? []).filter((d) => d.decision.state !== 'CANCELLED');
  // A decision owned by a role or a function is owned: who holds the role is Governance's record, not guessed here.
  const byRole = new Map<string, number>();
  for (const d of live) if (d.decision.owner && d.decision.owner.kind !== 'PERSON') byRole.set(d.decision.owner.label, (byRole.get(d.decision.owner.label) ?? 0) + 1);
  const ownedByNoMember = live.filter((d) => !d.decision.owner || (d.decision.owner.kind === 'PERSON' && !memberIds.has(d.decision.owner.userId ?? '')));
  const read = lines.filter((l) => l.lastRead !== null).length;
  const notRead = lines.length - read;
  const unplaced = lines.filter((l) => l.units.length === 0).length;
  const due = lines.reduce((n, l) => n + l.lookAgainDue.length, 0);

  const headline = !loaded
    ? 'Reading the organization…'
    : [
        `${word(lines.length)} ${lines.length === 1 ? 'person' : 'people'} in ${lower(word(units.length))} ${units.length === 1 ? 'unit' : 'units'}.`,
        notRead === 0
          ? `HELM reads the Memoire of every one of them.`
          : read === 0
            ? `HELM reads nobody's Memoire yet, so no deal is in the state it reads.`
            : `HELM reads the Memoire of ${lower(word(read))}; ${lower(word(notRead))} ${notRead === 1 ? 'is' : 'are'} not read, so ${notRead === 1 ? 'their deals are' : 'their deals are'} not in the state.`,
        due > 0 ? `${word(due)} ${due === 1 ? 'commitment is' : 'commitments are'} past the day set to look again.` : '',
      ]
        .filter(Boolean)
        .join(' ');

  return (
    <>
      <PageHeader
        kicker="Management · Organization"
        title={headline}
        lede="Who is in the organization, whose commercial truth HELM reads, and who stands behind which decisions."
      />

      <div className="mt-2 flex flex-wrap gap-10">
        <section className="min-w-0 flex-[1_1_640px]">
          <SectionHead title="Who stands behind what" meta={String(lines.length)} caveat="by name · a record, never a rating of a person" className="mt-8" />
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <th className="ledger-th">Person</th>
                  <th className="ledger-th">Memoire read</th>
                  <th className="ledger-th text-right">Open decisions</th>
                  <th className="ledger-th text-right">Committed</th>
                  <th className="ledger-th text-right">Look again due</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.member.userId}>
                    <td className="ledger-td">
                      <span className="block text-ui font-medium text-ink-950">{l.member.displayName}</span>
                      <span className="helm-meta">
                        {l.member.role}
                        {l.units.length > 0 ? ` · ${l.units.map((u) => u.name).join(', ')}` : ' · in no unit'}
                      </span>
                    </td>
                    <td className="ledger-td text-dense">
                      {!loaded ? '…' : l.lastRead ? <span className="text-ink-800">{readInstant(l.lastRead)}</span> : <span className="text-red-700">not read</span>}
                    </td>
                    <td className="ledger-td text-right font-mono text-dense tabular text-ink-800">{loaded ? l.open.length : '…'}</td>
                    <td className="ledger-td text-right font-mono text-dense tabular text-ink-800">{loaded ? l.committed.length : '…'}</td>
                    <td className={cn('ledger-td text-right font-mono text-dense tabular', l.lookAgainDue.length > 0 ? 'text-amber-700' : 'text-ink-500')}>
                      {!loaded ? '…' : l.lookAgainDue.length === 0 ? '—' : l.lookAgainDue.map((d, i) => (
                        <Link key={d.decision.id} to={`/decisions/${d.decision.id}`} className="hover:text-accent-700 hover:underline" title={d.decision.title}>
                          {i > 0 ? ', ' : ''}
                          {d.lookAgainOn}
                        </Link>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loaded && byRole.size > 0 && (
            <p className="mt-3 max-w-reading text-dense text-ink-700">
              Owned by a role, not a named person: {[...byRole.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, n]) => `${role} (${n})`).join(', ')}. Who holds each role, and from when, is on{' '}
              <Link to="/governance" className="font-medium text-accent-700 hover:underline">Governance</Link>.
            </p>
          )}
          {loaded && ownedByNoMember.length > 0 && (
            <p className="mt-3 max-w-reading text-dense text-ink-700">
              {word(ownedByNoMember.length)} {ownedByNoMember.length === 1 ? 'decision names a person' : 'decisions name a person'} who is not a member of the organization, or no owner at all: <span className="text-red-700">nobody here stands behind {ownedByNoMember.length === 1 ? 'it' : 'them'}</span>.{' '}
              <Link to="/decisions" className="font-medium text-accent-700 hover:underline">Decisions →</Link>
            </p>
          )}
          <p className="mt-3 max-w-reading text-meta text-ink-500">
            Memoire read: the last time HELM read that person&rsquo;s opportunities, as them. Memoire shows each person only their own deals, so someone not read is someone whose deals the state does not hold. Sales figures per person are Memoire&rsquo;s, and HELM does not total them.
          </p>
        </section>

        <aside className="w-full max-w-[360px] flex-[0_1_360px]">
          <SectionHead title="Units" meta={String(units.length)} caveat={unplaced > 0 ? `${unplaced} in no unit` : undefined} className="mt-8" size="section-sm" />
          {units.length === 0 ? (
            <p className="mt-3 text-dense text-ink-600">
              No unit is defined, so every decision is visible to the whole organization and nobody reads by unit.{' '}
              {mode === 'cloud' && myRole() === 'admin' && <Link to="/settings" className="font-medium text-accent-700 hover:underline">Define units in Settings →</Link>}
            </p>
          ) : (
            units.filter((u) => u.parentId === null).map((u) => <UnitBranch key={u.id} unit={u} depth={0} units={units} lines={lines} />)
          )}
        </aside>
      </div>
    </>
  );
}

function UnitBranch({ unit, depth, units, lines }: { unit: OrgUnit; depth: number; units: readonly OrgUnit[]; lines: readonly Line[] }) {
  const people = lines.filter((l) => l.units.some((u) => u.id === unit.id));
  return (
    <>
      <div className="border-b border-ink-100 py-2" style={{ paddingLeft: depth * 16 }}>
        <p className="flex items-baseline gap-2">
          {depth > 0 && <span className="font-mono text-dense text-ink-400">└</span>}
          <span className="text-dense font-medium text-ink-900">{unit.name}</span>
          <span className="helm-meta">{unit.unitType.replaceAll('_', ' ')}</span>
        </p>
        {people.map((l) => (
          <p key={l.member.userId} className="text-meta text-ink-600" style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
            {l.member.displayName.split(' — ')[0]}
          </p>
        ))}
      </div>
      {units.filter((u) => u.parentId === unit.id).map((c) => <UnitBranch key={c.id} unit={c} depth={depth + 1} units={units} lines={lines} />)}
    </>
  );
}
