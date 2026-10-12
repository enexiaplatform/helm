/** Per-browser memory of the Getting started guide: dismissed, and whether Ask HELM has been tried. Never shared, never required. */

export const DISMISSED_KEY = 'helm:getting-started:dismissed';
export const ASKED_KEY = 'helm:getting-started:asked';

export const read = (key: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
};
export const write = (key: string, v: boolean) => {
  try {
    if (v) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    /* a private window keeps the guide; nothing depends on it */
  }
};

/** Called by Ask HELM after an answer, so "Ask HELM a question" checks itself off. */
export const GUIDE_EVENT = 'helm:getting-started';
export const markAsked = () => {
  write(ASKED_KEY, true);
  globalThis.dispatchEvent?.(new Event(GUIDE_EVENT));
};
export const showGettingStarted = () => write(DISMISSED_KEY, false);
