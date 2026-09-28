import { Button } from '../ui/Button.tsx';
import type { SignalView } from './SignalArticle.tsx';

interface Props { signal: SignalView; expanded: boolean; onToggle: () => void; onFrame: () => void; onAcknowledge?: () => void; onDismiss?: () => void }

/* Warning / watch signal — one scannable line. Whole row toggles.
   [title 15/600 ............ measuredShort mono ochre]
   [ruleCode · status mono 12]
   expanded → reason, inline evidence facts, secondary "Frame a decision". */
export function SignalLine({ signal: s, expanded, onToggle, onFrame, onAcknowledge, onDismiss }: Props) {
  return (
    <div className="border-b border-ink-200">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-5 gap-y-1 py-[14px] text-left">
        <span className="text-read font-semibold leading-[22px]">{s.title}</span>
        <span className="text-right font-mono text-dense font-medium leading-[22px] text-amber-700">{s.measuredShort ?? s.measuredLabel}</span>
        <span className="helm-meta">{s.ruleCode} · {s.status}</span>
      </button>
      {expanded && (
        <div className="grid gap-3 pb-[18px]">
          <p className="max-w-reading text-base text-ink-700">{s.reason}</p>
          <dl className="flex flex-wrap gap-x-7 gap-y-2">
            {s.evidence.map((e) => (
              <div key={e.label} className="grid">
                <dt className="text-meta text-ink-500">{e.label}</dt>
                <dd className="font-mono text-dense font-medium">{e.value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onFrame}>Frame a decision</Button>
            {onAcknowledge && <Button size="sm" variant="ghost" onClick={onAcknowledge}>Acknowledge</Button>}
            {onDismiss && <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
          </div>
        </div>
      )}
    </div>
  );
}
