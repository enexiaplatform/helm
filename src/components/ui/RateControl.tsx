import { useState } from 'react';
import { useReadingRate, writeRate } from '../../lib/readingRate.ts';

/** "Read in VND at 1 SGD = …": the reader's own rate, said beside every figure it converts (src/lib/readingRate.ts). */
export function RateControl({ from }: { from: string | null }) {
  const rate = useReadingRate();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(rate?.to ?? 'VND');
  const [value, setValue] = useState(rate ? String(rate.rate) : '');
  if (!from) return null;
  const n = Number(value.replace(/[\s,]/g, ''));
  const control = 'rounded-md border border-ink-200 bg-white px-2 py-[2px] font-mono text-meta';

  if (!open) {
    return (
      <button type="button" className="text-meta font-medium text-accent-700 hover:underline print:hidden" onClick={() => setOpen(true)}>
        {rate && rate.from === from ? `Reading in ${rate.to} at 1 ${rate.from} = ${rate.rate.toLocaleString('en-US')} ${rate.to}` : `Read in another currency`}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-meta text-ink-700 print:hidden">
      1 {from} =
      <input className={`${control} w-24`} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="19500" />
      <input className={`${control} w-14 uppercase`} value={to} onChange={(e) => setTo(e.target.value)} maxLength={3} />
      <button
        type="button"
        className="font-medium text-accent-700 hover:underline disabled:opacity-50"
        disabled={!(n > 0) || to.trim().length !== 3}
        onClick={() => {
          writeRate({ from, to: to.trim().toUpperCase(), rate: n, setAt: new Date().toISOString() });
          setOpen(false);
        }}
      >
        Apply
      </button>
      {rate && (
        <button type="button" className="text-ink-500 hover:text-ink-900" onClick={() => { writeRate(null); setOpen(false); }}>
          Stop converting
        </button>
      )}
      <span className="text-ink-500">· your rate, kept in this browser; HELM's figures stay in {from}</span>
    </span>
  );
}
