import { useMemo, useState } from 'react';
import type { IntelligenceAnswer } from '@helm/intelligence-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import { useHelmStore } from '../../services/helmStore.ts';
import { cloudScope, demoScope } from '../../services/ontologyGraph.ts';
import { askHelm, resolveIntelligenceContext } from '../../services/intelligenceRuntime.ts';
import { Button } from '../ui/Button.tsx';
import { AnswerView } from './AnswerView.tsx';

/**
 * "Ask HELM": an open question, answered ONLY from what governed read-only tools return as the
 * person asking. It is one way in among several — HELM's intelligence mostly lives inside the
 * instruments — and not a chatbot: it cannot query a table, write anything, or say what the
 * kernel does not.
 */
export function AskHelm({ viewer }: { viewer: TwinViewer | null }) {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<{ answer: IntelligenceAnswer | null; error: string | null; busy: boolean } | null>(null);

  const ask = async () => {
    if (!scope || !viewer || question.trim().length < 4) return;
    setState({ answer: null, error: null, busy: true });
    try {
      const ctx = await resolveIntelligenceContext(mode ?? 'demo', scope);
      if (!ctx) throw new Error('The AI layer is unavailable in this mode.');
      setState({ answer: await askHelm(ctx, viewer, 'ASK_HELM', { question }), error: null, busy: false });
    } catch (e) {
      setState({ answer: null, error: e instanceof Error ? e.message : String(e), busy: false });
    }
  };

  return (
    <div>
      <label className="grid max-w-full grid-cols-[minmax(0,1fr)] gap-1">
        <span className="helm-label">Ask HELM</span>
        <input
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-ui"
          placeholder="What matters right now, and what do we believe about why?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
        />
      </label>
      <div className="mt-2 flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => void ask()} disabled={!viewer || state?.busy || question.trim().length < 4}>{state?.busy ? 'Reading the kernel…' : 'Ask'}</Button>
        <span className="text-meta text-ink-500">Answers only from governed, read-only tools, as you.</span>
      </div>
      {state?.error && <p role="alert" className="mt-2 text-dense text-red-700">{state.error}</p>}
      {state?.answer && <AnswerView answer={state.answer} />}
    </div>
  );
}
