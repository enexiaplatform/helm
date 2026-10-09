/**
 * Who the page is read as. The demo has several fictional readers to switch between; a real organization has one —
 * the person signed in — and a select with a single option only invites a click that does nothing (audit 2026-10-09).
 */
export function ReaderSelect({
  viewers,
  value,
  onChange,
  className,
}: {
  viewers: readonly { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
  className: string;
}) {
  if (viewers.length <= 1) {
    return <span className="py-2 text-ui text-ink-800">{viewers[0]?.label ?? 'You'} — only what you may read is shown</span>;
  }
  return (
    <select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {viewers.map((v) => (
        <option key={v.key} value={v.key}>
          {v.label}
        </option>
      ))}
    </select>
  );
}
