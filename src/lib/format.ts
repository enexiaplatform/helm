/**
 * Reading figures and kernel sentences on a management surface.
 *
 * The kernel states values exactly ("32.3878", "-1755720000", "2027-04-15T09:00:01.000Z") and its sentences are
 * fingerprinted into snapshots, so they are never rewritten at the source. A page shows them for reading: a long
 * decimal is rounded, a large amount is compacted, a minus is a true minus and an instant reads as a date. The exact
 * text stays one hover away (`title`), and nothing here changes what a value is (audit 2026-10-13).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A true minus for a negative figure: "−1.76B", never "-1.76B". */
export const trueMinus = (s: string): string => s.replace(/^-/, '−');

/** A number for reading: two decimals at most, an amount of a million or more compacted ("1.76B"). */
export function readNumber(n: number, opts: { compactFrom?: number } = {}): string {
  if (!Number.isFinite(n)) return String(n);
  const from = opts.compactFrom ?? 1_000_000;
  return trueMinus(Math.abs(n) >= from ? compact.format(n) : plain.format(n));
}

/** "2027-04-15T09:00:01.000Z" → "15 Apr 2027, 09:00 UTC"; a midnight instant reads as its day. */
export function readInstant(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z?)?$/);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const day = `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
  return hh && !(hh === '00' && mm === '00') ? `${day}, ${hh}:${mm} UTC` : day;
}

const CAMEL: Record<string, string> = { holderUserId: 'holder', personLabel: 'person', validFrom: 'valid from', validTo: 'valid to' };

/**
 * A kernel sentence for reading. Instants become dates; identifiers no manager reads (a user id changing to another
 * user id) are dropped where a named field says the same thing; long decimals are rounded; large integers compacted;
 * a minus before a figure is a true minus; doubled punctuation from joined sentences is collapsed.
 */
export function tidyText(text: string): string {
  return (
    text
      // Instants, alone or as a range ("…Z..…Z").
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g, (iso) => readInstant(iso))
      .replace(/(\d{4}) ?\.\. ?(\d{1,2} [A-Z][a-z]{2} \d{4})/g, '$1 to $2')
      // "holderUserId <uuid> → <uuid>; " says nothing the person's name beside it does not.
      .replace(/\b\w+UserId [0-9a-f]{8}-[0-9a-f-]{27} → [0-9a-f]{8}-[0-9a-f-]{27};\s*/g, '')
      .replace(/\b(holderUserId|personLabel|validFrom|validTo)\b/g, (k) => CAMEL[k] ?? k)
      // An engine error code before its own sentence ("calculation.divide_by_zero: Cannot compute…") says it twice.
      .replace(/\b[a-z]+(?:\.[a-z_]+)+: (?=[A-Z"])/g, '')
      // Long decimals and large integers, never inside an identifier or a date.
      .replace(/(?<![\w./-])([-−]?)(\d+\.\d{3,})(?![\w.-])/g, (_, sign: string, n: string) => (sign ? '−' : '') + readNumber(Number(n)))
      .replace(/(?<![\w./-])([-−]?)(\d{7,})(?![\w.-])/g, (_, sign: string, n: string) => (sign ? '−' : '') + readNumber(Number(n)))
      // A hyphen used as a minus.
      .replace(/(^|[\s(→:;,])-(?=\d)/g, '$1−')
      // Sentences joined by the kernel: '".".' and '.:' and '..' and '.;'
      .replace(/\."\./g, '."')
      .replace(/\.([:;])/g, '$1')
      .replace(/(?<!\.)\.\.(?!\.)/g, '.')
  );
}

/** "1 item(s)" → "1 item"; "3 item(s)" → "3 items" — for sentences the kernel writes with a "(s)". */
export function plurals(text: string): string {
  return text.replace(/\b(\d+|one|One) ([a-z][a-z ]*?)\(s\)/g, (_, n: string, noun: string) => {
    const one = n === '1' || n.toLowerCase() === 'one';
    const w = noun.trimEnd();
    if (one) return `${n} ${w}`;
    return `${n} ${/(s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`}`;
  }).replace(/\b1 more entries are\b/g, '1 more entry is').replace(/\b1 more entries\b/g, '1 more entry');
}

/** Both: what a management page shows of a kernel sentence. */
export const readable = (text: string): string => plurals(tidyText(text));
