import type { ReactNode } from 'react';

/* Top-aligned dialog: white, radius 16, shadow-overlay, on a navy/45% scrim.
   Serif title; the close control is a plain ✕. */
export function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy/45 p-4 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className={'w-full rounded-2xl bg-white shadow-overlay ' + (wide ? 'max-w-[800px]' : 'max-w-[520px]')}>
        <header className="flex items-center justify-between gap-3 border-b border-ink-200 py-4 pl-7 pr-4">
          <h2 className="text-figure-sm">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-ui text-ink-500 hover:bg-ink-100 hover:text-ink-950">✕</button>
        </header>
        <div className="grid gap-4 px-7 pb-7 pt-5">{children}</div>
      </div>
    </div>
  );
}
