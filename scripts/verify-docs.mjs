/**
 * verify:docs — every relative link in the documentation resolves.
 *
 * Documentation that points at a file which no longer exists is worse than
 * missing documentation: a reader follows it, finds nothing, and stops trusting
 * the rest. Cheap to check, so it is checked on every build.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const root = process.cwd();
const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.md')) files.push(path);
  }
})(root);

const broken = [];
let checked = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const match of src.matchAll(/\[[^\]]*\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
    const target = match[1].trim();
    // External links and anchors within the same file are out of scope.
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    checked += 1;
    const resolved = resolve(dirname(file), target);
    // A relative link that climbs out of the repository resolves only on a
    // machine that happens to have the same sibling folders. The README's link
    // to ../Memoire passed this check because Memoire sits next to HELM on the
    // development machine, and was broken for every other reader. Such a link is never verifiable, so
    // it is a failure regardless of whether the target exists locally.
    const insideRepo = !relative(root, resolved).startsWith('..');
    if (!insideRepo) {
      broken.push({
        from: relative(root, file).replaceAll('\\', '/'),
        target: `${target}  (leaves the repository — link a URL or an in-repo document)`,
      });
    } else if (!existsSync(resolved)) {
      broken.push({ from: relative(root, file).replaceAll('\\', '/'), target });
    }
  }
}

if (broken.length === 0) {
  console.log(`verify:docs — ok (${files.length} files, ${checked} relative links, all resolve)`);
  process.exit(0);
}

console.error(`verify:docs — ${broken.length} broken link(s):\n`);
for (const b of broken) console.error(`  [broken-link] ${b.from} -> ${b.target}`);
process.exit(1);
