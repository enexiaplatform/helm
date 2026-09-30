import { useMemo, useState } from 'react';
import type { CouncilRequest, CouncilResult, OutputSection, PerspectiveOutput } from '@helm/agent-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import { useHelmStore } from '../../services/helmStore.ts';
import { cloudScope, demoScope } from '../../services/ontologyGraph.ts';
import { classLabel, classTone, conveneCouncil, resolveIntelligenceContext } from '../../services/intelligenceRuntime.ts';
import { Button } from '../ui/Button.tsx';
import { Pill } from '../ui/Pill.tsx';
import { SectionHead } from '../ui/SectionHead.tsx';
import { cn } from '../../lib/cn.ts';

const SECTION_LABEL: Record<OutputSection, string> = {
  OBSERVATIONS: 'Observations',
  CONCERNS: 'Concerns',
  CHALLENGED_ASSUMPTIONS: 'Challenged assumptions',
  TRADE_OFFS: 'Trade-offs',
};

/** One management perspective, opened on demand: what it observes, what concerns it, what it challenges, what it would ask. */
function Perspective({ p }: { p: PerspectiveOutput }) {
  const [open, setOpen] = useState(false);
  const count = Object.values(p.sections).reduce((n, xs) => n + xs.length, 0);
  return (
    <li className="border-b border-ink-200 py-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full flex-wrap items-baseline gap-3 text-left">
        <span className="font-serif text-panel">{p.name}</span>
        <span className="helm-meta">{count} statement(s) · {p.supportingEvidence.length} piece(s) of evidence · {p.questions.length} question(s)</span>
        <span className="ml-auto font-mono text-meta text-accent-700">{open ? 'close' : 'open'}</span>
      </button>
      {open && (
        <div className="mt-3 grid gap-4">
          {(Object.keys(SECTION_LABEL) as OutputSection[]).map((sec) => (
            <div key={sec}>
              <p className="helm-label">{SECTION_LABEL[sec]}</p>
              {p.sections[sec].length === 0 ? (
                <p className="mt-1 text-dense text-ink-500">None from this perspective in this question.</p>
              ) : (
                <ul className="mt-1 grid gap-1">
                  {p.sections[sec].map((s, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-2">
                      <Pill tone={classTone(s.class)}>{classLabel(s.class)}</Pill>
                      <span className={cn('text-dense text-ink-900', s.class === 'AI_INFERENCE' && 'italic')}>{s.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {p.unknowns.length > 0 && (
            <div>
              <p className="helm-label">Unknowns</p>
              <ul className="mt-1 grid gap-1">{p.unknowns.map((u, i) => <li key={i} className="text-dense text-red-700">{u}</li>)}</ul>
            </div>
          )}
          {p.questions.length > 0 && (
            <div>
              <p className="helm-label">Questions</p>
              <ul className="mt-1 grid gap-1">{p.questions.map((q, i) => <li key={i} className="font-serif text-panel italic text-ink-800">{q}</li>)}</ul>
            </div>
          )}
          <p className="font-mono text-meta text-ink-500">{p.grounding.kept} kept · {p.grounding.removed} removed · run {p.runId}</p>
        </div>
      )}
    </li>
  );
}

/**
 * The management council: several perspectives over the SAME evidence, opened on demand.
 * Disagreement is shown as it is. There is no vote, no ranking and no recommendation, and
 * nothing here can approve, commit or execute — human management stays accountable.
 */
export function CouncilPanel({ question, request, viewer }: { question: string; request: Omit<CouncilRequest, 'question'>; viewer: TwinViewer | null }) {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [state, setState] = useState<{ result: CouncilResult | null; error: string | null; busy: boolean } | null>(null);

  const convene = async () => {
    if (!scope || !viewer) return;
    setState({ result: null, error: null, busy: true });
    try {
      const ctx = await resolveIntelligenceContext(mode ?? 'demo', scope);
      if (!ctx) throw new Error('The council is unavailable in this mode.');
      setState({ result: await conveneCouncil(ctx, viewer, { question, ...request }), error: null, busy: false });
    } catch (e) {
      setState({ result: null, error: e instanceof Error ? e.message : String(e), busy: false });
    }
  };

  const r = state?.result ?? null;
  return (
    <section className="mt-8">
      <SectionHead title="Management council" meta="perspectives over one truth" caveat="it does not vote, rank or choose" />
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="max-w-reading text-dense text-ink-600">Open the perspectives HELM has data for on this question. Each reads the same evidence as you, through the same access; where they differ, the difference is shown, not settled.</p>
        <Button variant="secondary" onClick={() => void convene()} disabled={!viewer || state?.busy}>{state?.busy ? 'Convening…' : r ? 'Convene again' : 'Open the council'}</Button>
      </div>
      {state?.error && <p role="alert" className="mt-3 text-dense text-red-700">{state.error}</p>}
      {r && (
        <div className="mt-4">
          <ul>{r.perspectives.map((p) => <Perspective key={p.perspective} p={p} />)}</ul>
          {r.tensions.length > 0 && (
            <div className="mt-6">
              <p className="helm-label">Where perspectives pull apart</p>
              <ul className="mt-2 grid gap-3">
                {r.tensions.map((t, i) => (
                  <li key={i} className="border-l-2 border-amber-500 pl-3">
                    <p className="text-dense text-ink-900">{t.statement}</p>
                    <div className="mt-1 grid gap-1 font-mono text-meta text-ink-600 sm:grid-cols-2">
                      <div>{t.gains.map((g, j) => <span key={j} className="block">{g.name}: {g.line}</span>)}</div>
                      <div>{t.concessions.map((g, j) => <span key={j} className="block">{g.name}: {g.line}</span>)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.sharedEvidence.length > 0 && <p className="mt-4 font-mono text-meta text-ink-500">{r.sharedEvidence.length} fact(s) more than one perspective rests on — reported once, as shared.</p>}
          {r.notInstantiated.length > 0 && (
            <div className="mt-4">
              <p className="helm-label">No perspective, because HELM holds no data</p>
              <ul className="mt-1 grid gap-1">{r.notInstantiated.map((n) => <li key={n.perspective} className="text-dense text-red-700"><span className="font-medium">{n.name}</span> — {n.reason}</li>)}</ul>
            </div>
          )}
          {r.silent.length > 0 && <p className="mt-3 text-dense text-ink-600">Nothing to say on this question: {r.silent.map((s) => s.name).join(', ')}.</p>}
          {r.questions.length > 0 && (
            <div className="mt-4">
              <p className="helm-label">Questions across the perspectives</p>
              <ul className="mt-1 grid gap-1">{r.questions.map((q, i) => <li key={i} className="font-serif text-panel italic text-ink-800">{q}</li>)}</ul>
            </div>
          )}
          <p className="helm-caveat mt-4">{r.notice}</p>
        </div>
      )}
    </section>
  );
}
