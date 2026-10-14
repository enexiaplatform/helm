import { useState } from 'react';
import { parseBrandMargins, type BrandMargin } from '../../services/brandMargins.ts';
import { Button } from '../ui/Button.tsx';

/** Paste or type "brand, margin %" per line; each line becomes an assumption on record (src/services/brandMargins.ts). */
export function MarginEditor({ brands, margins, onSave }: { brands: readonly string[]; margins: ReadonlyMap<string, BrandMargin>; onSave: (rows: { brand: string; pct: number }[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => brands.map((b) => `${b}, ${margins.get(b)?.pct ?? ''}`).join('\n'));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const parsed = parseBrandMargins(text);

  if (!open) {
    return (
      <button type="button" className="mt-2 text-meta font-medium text-accent-700 hover:underline print:hidden" onClick={() => setOpen(true)}>
        {margins.size > 0 ? 'Change the assumed margins' : 'State an assumed margin % per brand'}
      </button>
    );
  }
  return (
    <div className="mt-3 max-w-reading print:hidden">
      <p className="text-dense text-ink-700">One brand per line: “Tailin, 32”. A pasted CSV works. Each line is recorded as an assumption, with you and today’s date — not as a measured margin.</p>
      <textarea className="mt-2 h-32 w-full rounded-md border border-ink-200 bg-white px-2 py-1 font-mono text-dense" value={text} onChange={(e) => setText(e.target.value)} />
      {parsed.errors.length > 0 && <ul className="mt-1 grid gap-1">{parsed.errors.map((e) => <li key={e} className="text-meta text-red-700">{e}</li>)}</ul>}
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || parsed.rows.length === 0 || parsed.errors.length > 0}
          onClick={async () => {
            setBusy(true);
            setMessage(null);
            try {
              await onSave(parsed.rows);
              setMessage({ text: `${parsed.rows.length} assumed ${parsed.rows.length === 1 ? 'margin' : 'margins'} recorded.`, failed: false });
              setOpen(false);
            } catch (e) {
              setMessage({ text: e instanceof Error ? e.message : String(e), failed: true });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Recording…' : `Record ${parsed.rows.length}`}
        </Button>
        <button type="button" className="text-meta text-ink-500 hover:text-ink-900" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {message && <p className={message.failed ? 'mt-1 text-meta text-red-700' : 'mt-1 text-meta text-ink-700'}>{message.text}</p>}
    </div>
  );
}
