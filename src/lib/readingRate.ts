/**
 * A reading rate (audit 2026-10-13, GM: "only SGD — the team and the customers work in VND"). HELM never converts its
 * own figures; a reader may set a rate to READ them in another currency. The rate is theirs, kept in this browser,
 * and every converted figure says which rate it used. Nothing converted is stored or summed back into HELM.
 */

import { useEffect, useState } from 'react';

export type ReadingRate = { readonly from: string; readonly to: string; readonly rate: number; readonly setAt: string };

const KEY = 'helm.readingRate';
const EVENT = 'helm:reading-rate';

export function readRate(): ReadingRate | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as ReadingRate;
    return typeof r.rate === 'number' && r.rate > 0 && r.from && r.to ? r : null;
  } catch {
    return null;
  }
}

export function writeRate(r: ReadingRate | null): void {
  try {
    if (r) globalThis.localStorage?.setItem(KEY, JSON.stringify(r));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // A private window keeps no rate; the figures stay in their own currency.
  }
  globalThis.dispatchEvent?.(new Event(EVENT));
}

export function useReadingRate(): ReadingRate | null {
  const [rate, setRate] = useState<ReadingRate | null>(() => readRate());
  useEffect(() => {
    const on = () => setRate(readRate());
    globalThis.addEventListener(EVENT, on);
    return () => globalThis.removeEventListener(EVENT, on);
  }, []);
  return rate;
}

/** The value in the reading currency, or null when the rate does not apply to this currency. */
export function converted(value: string | number | null, currency: string | null, r: ReadingRate | null): number | null {
  if (!r || value === null || currency === null || currency.toUpperCase() !== r.from) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n * r.rate : null;
}
