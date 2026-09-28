import type { InputHTMLAttributes } from 'react';

/* Label 12/500 ink-600 over a 14px input. Border ink-300, radius 8, padding 10 × 12, focus halo. */
export function TextField({ label, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const fid = id ?? label.toLowerCase().replace(/\s+/g, '-');
  return (
    <label htmlFor={fid} className="grid gap-[6px]">
      <span className="text-meta font-medium text-ink-600">{label}</span>
      <input id={fid} className="rounded-lg border border-ink-300 bg-white px-3 py-[10px] text-ui text-ink-950 placeholder:text-ink-400 focus-visible:border-accent-500" {...rest} />
    </label>
  );
}
