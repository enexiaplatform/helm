import { useState } from 'react';
import { useHelmStore } from '../services/helmStore.ts';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { SectionHead } from '../components/ui/SectionHead.tsx';
import { FactRow } from '../components/ui/FactRow.tsx';
import { Button } from '../components/ui/Button.tsx';
import { Pill } from '../components/ui/Pill.tsx';
import { controlClass } from '../components/ui/Field.tsx';
import { orgRoles, type OrgRole } from '../domain/types.ts';

export function SettingsPage() {
  const org = useHelmStore((s) => s.activeOrg)();
  const mode = useHelmStore((s) => s.mode);
  const myRole = useHelmStore((s) => s.myRole)();
  const members = useHelmStore((s) => s.members);
  const units = useHelmStore((s) => s.units);
  const addMemberByEmail = useHelmStore((s) => s.addMemberByEmail);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);

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
          {isAdmin && (
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
        </section>
      </div>

      <section className="mt-11 max-w-[860px]">
        <SectionHead title="Decision authority" caveat="judged apart from the commitment" />
        <p className="mt-3 text-base text-ink-700">
          A commitment is what management decided. Whether the person who committed was allowed to is a separate,
          recorded judgement: HELM evaluates it from the enterprise scope the commitment touches and the consequences the
          model computed for it, under the delegation-of-authority policy in force when it was made. The commitment itself
          still carries <span className="font-mono text-meta">authorityStatus: NOT_EVALUATED</span> and never changes.
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
