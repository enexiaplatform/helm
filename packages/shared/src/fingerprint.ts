/**
 * Content fingerprints.
 *
 * A fingerprint detects that two things are the same or that one has changed.
 * It is not a security boundary, which is why a small dependency-free hash is
 * enough — and why it must be stable across runtimes (browser, Node, the test
 * runner), so it uses only integer arithmetic.
 *
 * 64-bit rather than the 32-bit hash step fingerprints use: a scenario
 * fingerprint is compared across every scenario an organization ever runs, and
 * at that population a 32-bit space gives an even chance of a collision after
 * roughly 77 000 entries.
 */

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a over the UTF-16 code units of `text`, as 16 lowercase hex digits. */
export function fnv1a64(text: string): string {
  let hash = FNV64_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * FNV64_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}
