import { Fragment } from 'react';
import { Pill, type PillTone } from '../ui/Pill.tsx';

export interface DecisionRowView {
  id: string; question: string; line: string; meta: string;
  state: string; tone: PillTone;
  dates: { label: string; value: string }[];
  note?: { text: string; alarm?: boolean };
}

/* One decision on the list. Whole row is the link. Left: serif question 22/29 → chosen line 14/500 → mono meta.
   Right (240px): state pill → two dates (label/mono) → one note line (brick if it needs a person). */
export function DecisionRow({ d, onOpen }: { d: DecisionRowView; onOpen: (id: string) => void }) {
  return (
    <a href={'/decisions/' + d.id} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onOpen(d.id); }}
      className="flex flex-wrap gap-x-10 gap-y-4 border-b border-ink-200 py-[22px] text-ink-950 no-underline hover:bg-white/45 hover:text-ink-950 hover:no-underline">
      <div className="grid min-w-0 flex-[1_1_520px] gap-[6px]">
        <span className="font-serif text-[22px] font-medium leading-[29px] tracking-[-0.01em]">{d.question}</span>
        <span className="text-ui font-medium text-ink-700">{d.line}</span>
        <span className="helm-meta">{d.meta}</span>
      </div>
      <div className="grid flex-[0_0_240px] content-start gap-[10px]">
        <Pill tone={d.tone} className="justify-self-start">{d.state}</Pill>
        <dl className="grid grid-cols-[auto_1fr] gap-x-[14px] gap-y-1">
          {d.dates.map((x) => (<Fragment key={x.label}><dt className="text-meta text-ink-500">{x.label}</dt><dd className="font-mono text-dense font-medium leading-[18px]">{x.value}</dd></Fragment>))}
        </dl>
        {d.note && <span className={'text-meta ' + (d.note.alarm ? 'text-red-700' : 'text-ink-500')}>{d.note.text}</span>}
      </div>
    </a>
  );
}
