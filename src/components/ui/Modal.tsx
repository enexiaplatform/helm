import type { ReactNode } from 'react';

/* Top-aligned dialog at 8vh: a white 6px sheet with the overlay shadow on a navy/42% scrim.
   Header is the panel title over a hairline; the close control is a plain ✕. */
export function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy/[0.42] px-4 pb-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className={'w-full rounded-xl bg-white shadow-overlay ' + (wide ? 'max-w-[768px]' : 'max-w-[512px]')}>
        <header className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <h2 className="font-sans text-panel font-semibold text-ink-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-dense text-ink-600 transition-colors ease-helm hover:bg-ink-100 hover:text-ink-900">✕</button>
        </header>
        <div className="grid gap-3 p-4">{children}</div>
      </div>
    </div>
  );
}
