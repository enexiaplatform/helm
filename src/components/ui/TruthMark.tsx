import type { ReactNode } from 'react';
import { TruthShape, type TruthLayer } from './Pill.tsx';

const TEXT: Record<TruthLayer, string> = {
  actual: 'text-ink-950',
  modelled: 'font-mono text-truth-modelled',
  stated: 'font-mono text-truth-stated',
  scenario: 'font-mono text-truth-scenario',
};
const LABEL: Record<TruthLayer, string> = { actual: 'Actual', modelled: 'Modelled', stated: 'Stated', scenario: 'Scenario' };
const LABEL_TEXT: Record<TruthLayer, string> = { actual: 'text-ink-950', modelled: 'text-truth-modelled', stated: 'text-truth-stated', scenario: 'text-truth-scenario' };

/* Marks which kind of truth a value is — what is (actual ■), what the model computes (modelled ◆), what the business
   says (stated ○: forecast, target, policy), what might happen (scenario ⬚). Never merge two layers into one figure:
   show both, with the variance between them. An optional provenance line sits beneath in mono. */
export function TruthMark({ layer, value, label, source, showLabel = false }: { layer: TruthLayer; value?: ReactNode; label?: string; source?: ReactNode; showLabel?: boolean }) {
  return (
    <span className="inline-flex shrink-0 flex-col gap-px">
      <span className="inline-flex items-center gap-[6px]">
        <TruthShape layer={layer} />
        {value != null && <span className={'tabular ' + TEXT[layer]}>{value}</span>}
        {(showLabel || value == null) && <span className={'text-meta font-semibold ' + LABEL_TEXT[layer]}>{label ?? LABEL[layer]}</span>}
      </span>
      {source && <span className="helm-provenance pl-[13px]">{source}</span>}
    </span>
  );
}
