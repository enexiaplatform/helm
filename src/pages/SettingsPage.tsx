import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard } from '../components/ui.tsx';
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
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-500">
          {org.name} · base currency {org.baseCurrency} · your role: <span className="font-medium">{myRole}</span>
        </p>
      </header>

      <PanelCard title="Members">
        <ul className="divide-y divide-ink-50">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{m.displayName}</p>
                <p className="truncate text-2xs text-ink-400">{m.email}</p>
              </div>
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-2xs font-semibold text-ink-600">{m.role}</span>
            </li>
          ))}
        </ul>
        {isAdmin && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addMemberByEmail(inviteEmail, inviteRole).then((err) => {
                setInviteMessage(err ?? `Added ${inviteEmail} as ${inviteRole}.`);
                if (!err) setInviteEmail('');
              });
            }}
          >
            <input
              className="field-input flex-1"
              type="email"
              required
              placeholder="teammate@company.com (must already have an account)"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <select className="field-input w-32" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as OrgRole)}>
              {orgRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button className="btn-primary">
              <Plus size={14} /> Add member
            </button>
            {inviteMessage && <p className="w-full text-xs text-ink-500">{inviteMessage}</p>}
          </form>
        )}
        {mode === 'demo' && <p className="mt-2 text-2xs text-ink-400">Demo mode — membership is read-only.</p>}
      </PanelCard>

      <PanelCard title="Organization units">
        {units.length === 0 ? (
          <p className="text-xs text-ink-400">No units defined.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {units
              .filter((u) => u.parentId === null)
              .map((root) => (
                <UnitNode key={root.id} unitId={root.id} depth={0} />
              ))}
          </ul>
        )}
      </PanelCard>

      <PanelCard
        title="Decision authority"
        action={<span className="text-2xs text-ink-400">not evaluated in this phase</span>}
      >
        <p className="text-xs text-ink-600">
          HELM records what management decided and on what grounds. It does not yet decide who is permitted to decide.
          Every commitment carries <span className="font-mono text-2xs">authorityStatus: NOT_EVALUATED</span> — in the
          runtime and in the database — so a later authority model can be added without rewriting the commitments made
          before it existed, and so nothing here can be mistaken for an approval that was never granted.
        </p>
        <p className="mt-2 text-xs text-ink-600">
          The pre-kernel threshold rules that used to live here have been retired rather than carried forward: they
          conflated "this decision is large" with "this person may make it". Decision rights, approval authority,
          thresholds and escalation belong to the authority model (see{' '}
          <span className="font-mono text-2xs">docs/architecture/decision-engine-assessment.md</span>).
        </p>
      </PanelCard>

      <PanelCard title="Memoire connection">
        <p className="text-xs text-ink-600">
          HELM shares its database and identity with Memoire. When you sign in with your Memoire account, your
          opportunities are readable as decision context. The read is one-way: HELM writes nothing back into Memoire.
          A commitment instead produces action intents naming the system that should act, which a later phase can
          deliver to Memoire over an explicit contract. HELM never copies Memoire data — a decision stores a reference
          and its own immutable snapshot of what was true when it was made.
        </p>
        {mode === 'demo' && (
          <p className="mt-2 text-2xs text-ink-400">
            In demo mode, sample opportunities stand in for the live Memoire workspace.
          </p>
        )}
      </PanelCard>
    </div>
  );
}

function UnitNode({ unitId, depth }: { unitId: string; depth: number }) {
  const units = useHelmStore((s) => s.units);
  const unit = units.find((u) => u.id === unitId);
  if (!unit) return null;
  const children = units.filter((u) => u.parentId === unitId);
  return (
    <li>
      <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 16 }}>
        <span className="font-medium">{unit.name}</span>
        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-2xs text-ink-500">{unit.unitType.replace(/_/g, ' ')}</span>
      </div>
      {children.length > 0 && (
        <ul>
          {children.map((c) => (
            <UnitNode key={c.id} unitId={c.id} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
