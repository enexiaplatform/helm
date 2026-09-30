import { useState } from 'react';
import type { EvidenceItem, GroundedStatement, IntelligenceAnswer } from '@helm/intelligence-runtime';
import { Pill } from '../ui/Pill.tsx';
import { classLabel, classTone } from '../../services/intelligenceRuntime.ts';
import { cn } from '../../lib/cn.ts';

/**
 * A grounded AI answer. Every statement wears what it IS (a source fact, a model
 * result, a causal claim…) and points at the kernel evidence it rests on; an
 * inference is drawn dashed and says so; what is unknown is said in red. The AI's
 * reading is never presented as enterprise truth.
 */

function Citation({ e }: { e: EvidenceItem }) {
  return (
    <span className="rounded border border-ink-200 bg-white px-[6px] font-mono text-tag text-ink-600" title={`${e.tool} · ${e.ref.kind} ${e.ref.id}`}>
      {e.ref.kind.toLowerCase().replaceAll('_', ' ')}
    </span>
  );
}

function Statement({ s, evidence }: { s: GroundedStatement; evidence: ReadonlyMap<string, EvidenceItem> }) {
  const [open, setOpen] = useState(false);
  const cited = s.evidenceIds.map((id) => evidence.get(id)).filter((e): e is EvidenceItem => !!e);
  return (
    <li className="border-b border-ink-200 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <Pill tone={classTone(s.class)}>{classLabel(s.class)}</Pill>
        <span className={cn('text-dense text-ink-900', s.class === 'AI_INFERENCE' && 'italic')}>{s.text}</span>
      </div>
      {(cited.length > 0 || s.note) && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {cited.slice(0, 3).map((e) => <Citation key={e.id} e={e} />)}
          {cited.length > 3 && <span className="font-mono text-tag text-ink-500">+{cited.length - 3}</span>}
          {cited.length > 0 && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="font-mono text-meta text-accent-700 hover:underline">
              {open ? 'hide evidence' : 'show evidence'}
            </button>
          )}
          {s.note && <span className="text-meta text-ink-500">{s.note}</span>}
        </div>
      )}
      {open && (
        <ul className="mt-2 grid gap-1 border-l border-ink-200 pl-3">
          {cited.map((e) => (
            <li key={e.id} className="font-mono text-meta text-ink-600">
              {e.kind.toLowerCase().replaceAll('_', ' ')} · {e.ref.kind} <span className="text-ink-500">{e.ref.id}</span>
              {e.lens ? <> · as known through {e.lens.recordedThrough.slice(0, 16).replace('T', ' ')}</> : null}
              {e.status ? <> · {e.status}</> : null}
              <span className="block text-ink-800">{e.label}{e.values.length > 0 ? ` — ${e.values.join('; ')}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function AnswerView({ answer }: { answer: IntelligenceAnswer }) {
  const evidence = new Map(answer.evidence.map((e) => [e.id, e]));
  const sections = [...new Set(answer.statements.map((s) => s.section))];
  const g = answer.grounding;
  return (
    <div className="mt-3">
      {sections.map((sec) => (
        <div key={sec ?? '_'} className="mb-3">
          {sec && <p className="helm-label mt-3">{sec}</p>}
          <ul>
            {answer.statements.filter((s) => s.section === sec).map((s, i) => <Statement key={`${sec}-${i}`} s={s} evidence={evidence} />)}
          </ul>
        </div>
      ))}
      {answer.statements.length === 0 && <p className="text-dense text-ink-600">Nothing the kernel returned supports a statement.</p>}
      {answer.unknowns.length > 0 && (
        <div className="mt-3">
          <p className="helm-label">What is not known, or may not be shown</p>
          <ul className="mt-1 grid gap-1">
            {answer.unknowns.map((u, i) => <li key={i} className="text-dense text-red-700">{u}</li>)}
          </ul>
        </div>
      )}
      {answer.questions.length > 0 && (
        <div className="mt-3">
          <p className="helm-label">Questions this raises</p>
          <ul className="mt-1 grid gap-1">
            {answer.questions.map((q, i) => <li key={i} className="font-serif text-panel italic text-ink-800">{q}</li>)}
          </ul>
        </div>
      )}
      {answer.notes.length > 0 && <p className="helm-caveat mt-3">{answer.notes.join(' ')}</p>}
      <p className="mt-3 font-mono text-meta text-ink-500">
        {g.kept} kept · {g.reclassified} reclassified · {g.downgradedToInference} marked as inference · {g.removed} removed · {answer.toolCalls.length} governed tool call(s) · {answer.provider.id} · run {answer.runId}
      </p>
      {g.removals.length > 0 && (
        <ul className="mt-1 grid gap-1">
          {g.removals.map((r, i) => <li key={i} className="text-meta text-ink-500">Removed: “{r.text.slice(0, 80)}” — {r.reason}</li>)}
        </ul>
      )}
      <p className="helm-caveat mt-2">{answer.notice}</p>
    </div>
  );
}
