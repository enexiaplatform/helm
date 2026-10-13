import { useState } from 'react';
import type { EvidenceItem, GroundedStatement, IntelligenceAnswer } from '@helm/intelligence-runtime';
import { Pill } from '../ui/Pill.tsx';
import { PipelineAnswerTable } from './PipelineAnswerTable.tsx';
import { classLabel, classTone } from '../../services/intelligenceRuntime.ts';
import { cn } from '../../lib/cn.ts';
import { plurals, readable, readInstant } from '../../lib/format.ts';

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
        <span className={cn('text-dense text-ink-900', s.class === 'AI_INFERENCE' && 'italic')} title={readable(s.text) === s.text ? undefined : s.text}>{readable(s.text)}</span>
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
              {e.lens ? <> · as known on {readInstant(e.lens.recordedThrough)}</> : null}
              {e.status ? <> · {e.status}</> : null}
              <span className="block text-ink-800">{readable(`${e.label}${e.values.length > 0 ? ` — ${e.values.filter(Boolean).join('; ')}` : ''}`)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A long section shows its first statements; the rest are one click away — progressive disclosure, nothing dropped. */
const FIRST = 6;

function Section({ sec, statements, evidence }: { sec: string | null; statements: readonly GroundedStatement[]; evidence: ReadonlyMap<string, EvidenceItem> }) {
  const [all, setAll] = useState(false);
  const shown = all ? statements : statements.slice(0, FIRST);
  return (
    <div className="mb-3">
      {sec && <p className="helm-label mt-3">{sec}</p>}
      <ul>
        {shown.map((s, i) => <Statement key={`${sec}-${i}`} s={s} evidence={evidence} />)}
      </ul>
      {statements.length > FIRST && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 text-meta font-medium text-accent-700 hover:underline">
          {all ? 'Show fewer' : `Show all ${statements.length}`}
        </button>
      )}
    </div>
  );
}

export function AnswerView({ answer, question }: { answer: IntelligenceAnswer; question?: string }) {
  const evidence = new Map(answer.evidence.map((e) => [e.id, e]));
  const sections = [...new Set(answer.statements.map((s) => s.section))];
  const g = answer.grounding;
  // Deals the answer lists are shown as a table of the evidence itself; the statements that only repeat one row are not drawn twice.
  const dealRows = answer.evidence.filter((e) => e.tool === 'getPipelinePositions' && e.ref.kind === 'ENTITY');
  const asTable = dealRows.length >= 2;
  const rowIds = new Set(dealRows.map((e) => e.id));
  const onlyRows = (s: GroundedStatement) => s.evidenceIds.length > 0 && s.evidenceIds.every((id) => rowIds.has(id));
  return (
    <div className="mt-3">
      {/* The question this answers, so an answer is never read against another one (audit 2026-10-13). */}
      {question && <p className="mb-2 font-serif text-panel italic text-ink-800">“{question}”</p>}
      {/* What the reading comes to, before the statements it rests on. */}
      {answer.notes.length > 0 && <p className="mb-2 text-dense text-ink-900">{readable(answer.notes.join(' '))}</p>}
      {sections.map((sec) => {
        const statements = answer.statements.filter((s) => s.section === sec && !(asTable && onlyRows(s)));
        return statements.length > 0 ? <Section key={sec ?? '_'} sec={sec} statements={statements} evidence={evidence} /> : null;
      })}
      {asTable && <PipelineAnswerTable rows={dealRows} />}
      {answer.statements.length === 0 && <p className="text-dense text-ink-600">Nothing the kernel returned supports a statement.</p>}
      {answer.unknowns.length > 0 && (
        <div className="mt-3">
          <p className="helm-label">What is not known, or may not be shown</p>
          <ul className="mt-1 grid gap-1">
            {answer.unknowns.map((u, i) => <li key={i} className="text-dense text-red-700">{readable(u)}</li>)}
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
      <p className="mt-3 font-mono text-meta text-ink-500">
        {g.kept} kept · {g.reclassified} reclassified · {g.downgradedToInference} marked as inference · {g.removed} removed · {plurals(`${answer.toolCalls.length} governed tool call(s)`)} · {answer.provider.id} · run {answer.runId}
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
