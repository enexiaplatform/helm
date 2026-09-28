import { Pill, type PillTone } from '../ui/Pill.tsx';

export interface LineageNode {
  metricKey: string; value: string;
  /** COMPUTED, OVERRIDDEN, or the observation kind a stated fact carries (ACTUAL, FORECAST…). */
  kind?: string;
  foot: string;                   // "gross-margin-pct@1 · (a − b) ÷ a × 100" or "memoire · opportunity record"
  inputs?: LineageNode[];
}
const TONE: Record<string, PillTone> = {
  COMPUTED: 'computed', DERIVED: 'derived', ACTUAL: 'actual', FORECAST: 'forecast', TARGET: 'target',
  SCENARIO: 'scenario', ESTIMATE: 'estimate', ASSUMPTION: 'assumption', OVERRIDDEN: 'overridden',
};

/* "Where one number comes from". Rows over ink-100 hairlines; each depth indents 28px and starts with └
   (root starts with ■). Key mono 13/600 + kind pill; value mono 14/500 right; foot mono 12 ink-500. */
export function LineageTree({ node, depth = 0 }: { node: LineageNode; depth?: number }) {
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 gap-y-[2px] border-b border-ink-100 py-[10px]" style={{ paddingLeft: depth * 28 }}>
        <span className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
          <span className="font-mono text-dense text-ink-400">{depth === 0 ? '■' : '└'}</span>
          <span className="font-mono text-dense font-semibold">{node.metricKey}</span>
          {node.kind && <Pill tone={TONE[node.kind] ?? 'neutral'}>{node.kind}</Pill>}
        </span>
        <span className="text-right font-mono text-ui font-medium">{node.value}</span>
        <span className="helm-meta col-span-2 break-words pl-[22px]">{node.foot}</span>
      </div>
      {node.inputs?.map((c, i) => <LineageTree key={`${c.metricKey}-${i}`} node={c} depth={depth + 1} />)}
    </>
  );
}
