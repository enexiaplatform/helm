import { Button } from '../ui/Button.tsx';
import { EvidenceGrid } from './EvidenceGrid.tsx';
import type { Fact } from '../ui/FactRow.tsx';

export interface SignalView {
  id: string;
  severity: 'critical' | 'warning' | 'watch' | 'info';
  ruleCode: string;            // INV-STOCKOUT
  status: 'open' | 'acknowledged' | 'dismissed';
  title: string;
  reason: string;
  thresholdLabel: string;
  measuredLabel: string;
  measuredShort?: string;      // compact figure for SignalLine
  evidence: Fact[];
}

interface Props { signal: SignalView; expanded: boolean; onToggle: () => void; onFrame: () => void; onAcknowledge?: () => void; onDismiss: () => void }

/* Critical signal — full editorial treatment. No card around it: a row on a hairline.
   rule code (mono, brick) · status (mono) · Show evidence (link, right)
   → serif 24px title → 15/24 reason (max 680px) → [expanded] EvidenceGrid + actions. */
export function SignalArticle({ signal: s, expanded, onToggle, onFrame, onAcknowledge, onDismiss }: Props) {
  return (
    <article className="border-b border-ink-200 py-[22px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-meta font-medium text-red-700">{s.ruleCode}</span>
        <span className="helm-meta">{s.status}</span>
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="ml-auto text-meta font-medium text-accent-700 hover:underline">
          {expanded ? 'Hide evidence' : 'Show evidence'}
        </button>
      </div>
      <h3 className="mt-[6px] text-signal">{s.title}</h3>
      <p className="mt-2 max-w-reading text-read text-ink-700">{s.reason}</p>
      {expanded && (
        <>
          <EvidenceGrid measured={s.measuredLabel} rule={s.thresholdLabel} evidence={s.evidence} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={onFrame}>Frame a decision →</Button>
            {onAcknowledge && <Button onClick={onAcknowledge}>Acknowledge</Button>}
            <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
          </div>
        </>
      )}
    </article>
  );
}
