import type { InputHTMLAttributes } from 'react';
import { controlClass } from './Field.tsx';

/* Uppercase 11px label over a 14px input (.field-label + .field-input). */
export function TextField({ label, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const fid = id ?? label.toLowerCase().replace(/\s+/g, '-');
  return (
    <label htmlFor={fid} className="block">
      <span className="mb-1 block helm-label">{label}</span>
      <input id={fid} className={controlClass} {...rest} />
    </label>
  );
}
