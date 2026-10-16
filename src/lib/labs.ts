/**
 * Labs (Phase 1, 2026-10-16: "too hard to use, no visible value"). The kernel instruments — Twin, Value Graph,
 * Calculations, Causal, Counterfactuals, Genome, Ontology, Decision memory — stay built and reachable by address, but
 * leave the rail until a reader turns Labs on in Settings. The switch is the reader's own, kept in this browser.
 */

import { useEffect, useState } from 'react';

const KEY = 'helm.labs';
const EVENT = 'helm:labs';

export function readLabs(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeLabs(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(KEY, 'on');
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // A private window keeps no switch; the instruments stay off the rail.
  }
  globalThis.dispatchEvent?.(new Event(EVENT));
}

export function useLabs(): boolean {
  const [on, setOn] = useState<boolean>(() => readLabs());
  useEffect(() => {
    const read = () => setOn(readLabs());
    globalThis.addEventListener(EVENT, read);
    return () => globalThis.removeEventListener(EVENT, read);
  }, []);
  return on;
}
