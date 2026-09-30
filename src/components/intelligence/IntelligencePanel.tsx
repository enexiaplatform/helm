import { useMemo, useState } from 'react';
import type { IntelligenceAnswer, TaskName, TaskParams } from '@helm/intelligence-runtime';
import type { TwinViewer } from '@helm/twin-runtime';
import { useHelmStore } from '../../services/helmStore.ts';
import { cloudScope, demoScope } from '../../services/ontologyGraph.ts';
import { askHelm, resolveIntelligenceContext } from '../../services/intelligenceRuntime.ts';
import { Button } from '../ui/Button.tsx';
import { AnswerView } from './AnswerView.tsx';

/**
 * Contextual AI: one governed task, asked from where the work is — inside the Twin
 * "what changed", inside a Decision "which assumptions are unresolved", inside
 * Causal "what is the evidence for and against". It reads as the person asking and
 * says what it rests on. It is a reading of the kernel, not a chatbot and not the
 * source of any figure.
 */
export function IntelligencePanel({
  task,
  params,
  viewer,
  label,
  detail,
  disabled,
}: {
  task: TaskName;
  params: TaskParams;
  viewer: TwinViewer | null;
  label: string;
  detail?: string;
  disabled?: boolean;
}) {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [state, setState] = useState<{ key: string; answer: IntelligenceAnswer | null; error: string | null; busy: boolean } | null>(null);
  const key = `${task}|${JSON.stringify(params)}|${viewer?.userId ?? ''}`;

  const run = async () => {
    if (!scope || !viewer) return;
    setState({ key, answer: null, error: null, busy: true });
    try {
      const ctx = await resolveIntelligenceContext(mode ?? 'demo', scope);
      if (!ctx) throw new Error('The AI layer is unavailable in this mode.');
      const answer = await askHelm(ctx, viewer, task, params);
      setState({ key, answer, error: null, busy: false });
    } catch (e) {
      setState({ key, answer: null, error: e instanceof Error ? e.message : String(e), busy: false });
    }
  };
  const mine = state && state.key === key ? state : null;
  return (
    <div className="mt-6 rounded-xl border border-ink-200 bg-white px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="helm-label">HELM intelligence · governed, read-only</p>
          {detail && <p className="mt-1 max-w-reading text-dense text-ink-600">{detail}</p>}
        </div>
        <Button variant="secondary" onClick={() => void run()} disabled={disabled || !viewer || mine?.busy}>
          {mine?.busy ? 'Reading the kernel…' : label}
        </Button>
      </div>
      {mine?.error && <p role="alert" className="mt-3 text-dense text-red-700">{mine.error}</p>}
      {mine?.answer && <AnswerView answer={mine.answer} />}
    </div>
  );
}
