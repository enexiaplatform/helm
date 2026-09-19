import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useHelmStore } from '../services/helmStore.ts';
import { PanelCard } from '../components/ui.tsx';
import { formatMoney } from '../domain/format.ts';
import {
  decisionTypeLabels,
  decisionTypes,
  orgRoleRank,
  orgRoles,
  type DecisionType,
  type OrgRole,
} from '../domain/types.ts';

export function SettingsPage() {
  const org = useHelmStore((s) => s.activeOrg)();
  const mode = useHelmStore((s) => s.mode);
  const myRole = useHelmStore((s) => s.myRole)();
  const members = useHelmStore((s) => s.members);
  const units = useHelmStore((s) => s.units);
  const approvalRules = useHelmStore((s) => s.approvalRules);
  const saveApprovalRule = useHelmStore((s) => s.saveApprovalRule);
  const removeApprovalRule = useHelmStore((s) => s.removeApprovalRule);
  const addMemberByEmail = useHelmStore((s) => s.addMemberByEmail);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('member');
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [newRule, setNewRule] = useState<{ type: DecisionType | ''; threshold: string; role: 'manager' | 'admin' }>({
    type: '',
    threshold: '',
    role: 'manager',
  });

  const isManager = orgRoleRank[myRole] >= orgRoleRank.manager;
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
        title="Approval rules"
        action={<span className="text-2xs text-ink-400">decisions at or above a threshold require the stated role</span>}
      >
        <ul className="divide-y divide-ink-50">
          {approvalRules.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
              <span className="text-ink-700">
                {r.decisionType ? decisionTypeLabels[r.decisionType] : 'Any decision type'} ·{' '}
                <span className="tabular-nums">≥ {formatMoney(r.thresholdAmount, org.baseCurrency)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-2xs font-semibold text-ink-600">
                  requires {r.requiredRole}
                </span>
                {isManager && (
                  <button className="text-ink-300 hover:text-red-600" onClick={() => void removeApprovalRule(r.id)} aria-label="Remove rule">
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            </li>
          ))}
          {approvalRules.length === 0 && <p className="text-xs text-ink-400">No rules — every owner decides autonomously.</p>}
        </ul>
        {isManager && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveApprovalRule({
                decisionType: newRule.type === '' ? null : newRule.type,
                thresholdAmount: Number(newRule.threshold) || 0,
                requiredRole: newRule.role,
                active: true,
              });
              setNewRule({ type: '', threshold: '', role: 'manager' });
            }}
          >
            <select
              className="field-input w-44"
              value={newRule.type}
              onChange={(e) => setNewRule({ ...newRule, type: e.target.value as DecisionType | '' })}
            >
              <option value="">Any decision type</option>
              {decisionTypes.map((t) => (
                <option key={t} value={t}>
                  {decisionTypeLabels[t]}
                </option>
              ))}
            </select>
            <input
              className="field-input w-44 tabular-nums"
              type="number"
              min={0}
              required
              placeholder={`Threshold (${org.baseCurrency})`}
              value={newRule.threshold}
              onChange={(e) => setNewRule({ ...newRule, threshold: e.target.value })}
            />
            <select
              className="field-input w-32"
              value={newRule.role}
              onChange={(e) => setNewRule({ ...newRule, role: e.target.value as 'manager' | 'admin' })}
            >
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
            <button className="btn-primary">
              <Plus size={14} /> Add rule
            </button>
          </form>
        )}
      </PanelCard>

      <PanelCard title="Memoire connection">
        <p className="text-xs text-ink-600">
          HELM shares its database and identity with Memoire. When you sign in with your Memoire account, your
          opportunities are available as decision context ("Pull context from Memoire" when creating a decision), and
          approved decisions append their execution record to the Memoire timeline with full provenance. HELM never
          copies Memoire data — decisions store a reference plus an immutable snapshot of what you saw when deciding.
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
