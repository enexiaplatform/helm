import { useState } from 'react';
import { useHelmStore } from '../services/helmStore.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { controlClass } from '../components/ui/Field.tsx';
import { orgRoles, orgUnitTypes, type OrgRole, type OrgUnitType } from '../domain/types.ts';
import { useLabs, writeLabs } from '../lib/labs.ts';

export function SettingsPage() {
  const org = useHelmStore((s) => s.activeOrg)();
  const mode = useHelmStore((s) => s.mode);
  const myRole = useHelmStore((s) => s.myRole)();
  const members = useHelmStore((s) => s.members);
  const units = useHelmStore((s) => s.units);
  const addMemberByEmail = useHelmStore((s) => s.addMemberByEmail);
  const addUnit = useHelmStore((s) => s.addUnit);
  const assignToUnit = useHelmStore((s) => s.assignToUnit);
  const placed = useHelmStore((s) => s.unitMemberships);
  const [unitName, setUnitName] = useState('');
  const [unitType, setUnitType] = useState<OrgUnitType>('team');
  const [unitParent, setUnitParent] = useState('');
  const [placeWho, setPlaceWho] = useState('');
  const [placeWhere, setPlaceWhere] = useState('');
  const [placeLeads, setPlaceLeads] = useState(false);
  const [unitMessage, setUnitMessage] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);

  const labs = useLabs();
  const isAdmin = myRole === 'admin';

  if (!org) return null;

  return (
    <>
      <PageHeader kicker="Organization · Settings" title={org.name} size="title" />
      <FactRow
        className="mt-5 border-b border-ink-200 pb-[22px]"
        facts={[
          { label: 'Base currency', value: org.baseCurrency, mono: true },
          { label: 'Your role', value: myRole },
          { label: 'Members', value: String(members.length), mono: true },
          { label: 'Mode', value: mode === 'demo' ? 'demo · local sample data' : 'cloud' },
        ]}
      />

      <div className="mt-10 flex flex-wrap items-start gap-10">
        <section className="min-w-0 flex-[1_1_460px]">
          <SectionHead title="Members" meta={String(members.length)} />
          {members.map((m) => (
            <div key={m.userId} className="flex items-center justify-between gap-3 border-b border-ink-200 py-3">
              <div className="min-w-0">
                <p className="truncate text-ui font-medium">{m.displayName}</p>
                <p className="helm-meta truncate">{m.email}</p>
              </div>
              <Pill tone="neutral">{m.role}</Pill>
            </div>
          ))}
          {/* The demo's membership is read-only: no form that looks live and does nothing (audit 2026-10-13). */}
          {isAdmin && mode !== 'demo' && (
            <form
              className="mt-4 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addMemberByEmail(inviteEmail, inviteRole).then((err) => {
                  setInviteMessage(err ?? `Added ${inviteEmail} as ${inviteRole}.`);
                  if (!err) setInviteEmail('');
                });
              }}
            >
              <input
                className={controlClass + ' min-w-[240px] flex-1'}
                type="email"
                required
                placeholder="teammate@company.com (must already have an account)"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <select className={controlClass + ' w-36'} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as OrgRole)}>
                {orgRoles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="primary">
                Add member
              </Button>
              {inviteMessage && <p className="w-full text-dense text-ink-600">{inviteMessage}</p>}
            </form>
          )}
          {mode === 'demo' && <p className="mt-3 text-meta text-ink-500">Demo mode — membership is read-only.</p>}
        </section>

        <section className="min-w-0 flex-[1_1_360px]">
          <SectionHead title="Organization units" meta={String(units.length)} />
          {units.length === 0 ? (
            <p className="mt-3 text-base text-ink-600">No units defined.</p>
          ) : (
            units
              .filter((u) => u.parentId === null)
              .map((root) => <UnitNode key={root.id} unitId={root.id} depth={0} />)
          )}
          {/* Units decide who reads which decisions and whose deals a unit's state holds; an admin sets them here (RLS: admins only). */}
          {isAdmin && mode !== 'demo' && (
            <div className="mt-4 grid gap-4">
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addUnit(unitName, unitType, unitParent || null).then((err) => {
                    setUnitMessage(err ?? `Added ${unitName.trim()}.`);
                    if (!err) setUnitName('');
                  });
                }}
              >
                <span className="helm-label">Add a unit</span>
                <input className={controlClass} required maxLength={200} placeholder="Vietnam Commercial" value={unitName} onChange={(e) => setUnitName(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <select className={controlClass + ' w-40'} value={unitType} onChange={(e) => setUnitType(e.target.value as OrgUnitType)}>
                    {orgUnitTypes.map((t) => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}
                  </select>
                  <select className={controlClass + ' min-w-0 flex-1'} value={unitParent} onChange={(e) => setUnitParent(e.target.value)}>
                    <option value="">at the top</option>
                    {units.map((u) => <option key={u.id} value={u.id}>under {u.name}</option>)}
                  </select>
                  <Button type="submit">Add unit</Button>
                </div>
              </form>
              {units.length > 0 && (
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const who = members.find((m) => m.userId === placeWho);
                    const where = units.find((u) => u.id === placeWhere);
                    void assignToUnit(placeWho, placeWhere, placeLeads).then((err) => setUnitMessage(err ?? `${who?.displayName ?? 'The member'} is in ${where?.name ?? 'the unit'}.`));
                  }}
                >
                  <span className="helm-label">Place a member in a unit</span>
                  <div className="flex flex-wrap gap-2">
                    <select className={controlClass + ' min-w-0 flex-1'} required value={placeWho} onChange={(e) => setPlaceWho(e.target.value)}>
                      <option value="">Member…</option>
                      {members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
                    </select>
                    <select className={controlClass + ' min-w-0 flex-1'} required value={placeWhere} onChange={(e) => setPlaceWhere(e.target.value)}>
                      <option value="">Unit…</option>
                      {units.filter((u) => !placed.some((p) => p.userId === placeWho && p.unitId === u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                  <label className="inline-flex items-center gap-2 text-dense text-ink-700">
                    <input type="checkbox" checked={placeLeads} onChange={(e) => setPlaceLeads(e.target.checked)} /> Leads the unit
                  </label>
                  <div><Button type="submit">Place</Button></div>
                </form>
              )}
              {unitMessage && <p className="text-dense text-ink-600">{unitMessage}</p>}
            </div>
          )}
        </section>
      </div>

      <section className="mt-11 max-w-[860px]">
        <SectionHead title="Labs" caveat="kept in this browser" />
        <label className="mt-3 flex items-start gap-3 text-base text-ink-700">
          <input type="checkbox" className="mt-1" checked={labs} onChange={(e) => writeLabs(e.target.checked)} />
          <span>
            Show the kernel instruments in the menu: Decision memory, Twin, Value Graph, Calculations, Causal,
            Counterfactuals, Genome and Ontology.
            <span className="mt-1 block text-meta text-ink-500">They read the same records; most need decisions, scenarios or sources HELM does not hold yet.</span>
          </span>
        </label>
      </section>

      <section className="mt-11 max-w-[860px]">
        <SectionHead title="Decision authority" caveat="judged apart from the commitment" />
        <p className="mt-3 text-base text-ink-700">
          A commitment is what management decided. Whether the person who committed was allowed to is a separate,
          recorded judgement: HELM evaluates it from the enterprise scope the commitment touches and the consequences the
          model computed for it, under the delegation-of-authority policy in force when it was made. The commitment itself
          never changes: its authority verdict is a separate record, made by HELM&rsquo;s trusted authority service.
        </p>
        <p className="mt-3 text-base text-ink-700">
          Roles, policy versions, rules, delegations, evaluations and approval acts are on the{' '}
          <a href="/governance" className="font-medium">Governance</a> instrument. The pre-kernel threshold rules that used
          to live here are retired: they compared a typed amount with an org rank, and conflated "this decision is large"
          with "this person may make it".
        </p>
      </section>

      <section className="mt-11 max-w-[860px]">
        <SectionHead title="Memoire connection" caveat="read-only, one way" />
        <p className="mt-3 text-base text-ink-700">
          HELM shares its database and identity with Memoire. When you sign in with your Memoire account, your
          opportunities are readable as decision context. The read is one-way: HELM writes nothing back into Memoire. A
          commitment instead produces action intents naming the system that should act, which a later phase can deliver
          to Memoire over an explicit contract. HELM never copies Memoire data — a decision stores a reference and its own
          immutable snapshot of what was true when it was made.
        </p>
        {mode === 'demo' && (
          <p className="mt-2 text-meta text-ink-500">In demo mode, sample opportunities stand in for the live Memoire workspace.</p>
        )}
      </section>
    </>
  );
}

function UnitNode({ unitId, depth }: { unitId: string; depth: number }) {
  const units = useHelmStore((s) => s.units);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) return null;
  const children = units.filter((u) => u.parentId === unitId);
  return (
    <>
      <div className="flex items-baseline gap-2 border-b border-ink-100 py-2" style={{ paddingLeft: depth * 20 }}>
        {depth > 0 && <span className="font-mono text-dense text-ink-400">└</span>}
        <span className="text-dense font-medium">{unit.name}</span>
        <span className="helm-meta">{unit.unitType.replace(/_/g, ' ')}</span>
      </div>
      {children.map((c) => (
        <UnitNode key={c.id} unitId={c.id} depth={depth + 1} />
      ))}
    </>
  );
}
