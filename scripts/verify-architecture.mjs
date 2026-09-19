/**
 * verify:architecture — makes the layering rules executable.
 *
 * Architecture that is only prose erodes. These are the invariants from
 * docs/architecture/repository-structure.md §3, asserted so a violation fails
 * the build instead of surviving review.
 *
 *   1. Dependency direction: apps -> packages -> shared, never the reverse.
 *   2. Kernel purity: no I/O, no ambient clock, no randomness.
 *   3. No AI in the kernel.
 *   4. No framework (React/Vite/Supabase) inside a kernel package.
 *   5. No deep imports past a package's declared exports.
 *   6. Business logic stays out of React components.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const failures = [];
const fail = (rule, file, detail) =>
  failures.push({ rule, file: relative(root, file).split(sep).join('/'), detail });

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'coverage'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const importsOf = (src) => {
  const specs = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
};

// ---------------------------------------------------------------- packages

const packagesDir = join(root, 'packages');
const pkgNames = new Map(); // dirName -> package.json name
const pkgMeta = new Map();

if (existsSync(packagesDir)) {
  for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const manifestPath = join(packagesDir, e.name, 'package.json');
    if (!existsSync(manifestPath)) {
      failures.push({
        rule: 'package-manifest',
        file: `packages/${e.name}`,
        detail: 'every package needs a package.json declaring its name, exports and dependencies',
      });
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    pkgNames.set(e.name, manifest.name);
    pkgMeta.set(manifest.name, { dir: e.name, manifest });

    if (!manifest.exports) {
      failures.push({
        rule: 'explicit-exports',
        file: `packages/${e.name}/package.json`,
        detail: 'a package must declare an explicit "exports" surface',
      });
    }
  }
}

const KERNEL_FORBIDDEN_IMPORTS = [
  { pattern: /^react($|\/)/, why: 'React' },
  { pattern: /^react-dom($|\/)/, why: 'react-dom' },
  { pattern: /^vite($|\/)/, why: 'Vite' },
  { pattern: /^@vitejs\//, why: 'Vite plugin' },
  { pattern: /^zustand($|\/)/, why: 'Zustand' },
  { pattern: /^react-router/, why: 'React Router' },
  { pattern: /^@supabase\//, why: 'a Supabase client' },
  { pattern: /^node:fs/, why: 'the filesystem' },
  { pattern: /^node:http/, why: 'HTTP' },
  { pattern: /^node:net/, why: 'the network' },
  { pattern: /^node:child_process/, why: 'child processes' },
  { pattern: /^(openai|@anthropic-ai|@google\/gener|cohere|@mistralai|ollama|langchain)/, why: 'an LLM client' },
];

// Impurity markers. The kernel takes time and identity through ports so tests
// are deterministic — see @helm/shared temporal.ts.
const IMPURITY = [
  { re: /\bDate\.now\s*\(/, why: 'Date.now() — inject a Clock instead' },
  { re: /\bMath\.random\s*\(/, why: 'Math.random() — inject an IdGen instead' },
  { re: /\bcrypto\.randomUUID\s*\(/, why: 'crypto.randomUUID() — inject an IdGen instead' },
  { re: /\bfetch\s*\(/, why: 'fetch() — I/O belongs in an adapter' },
  { re: /\bprocess\.env\b/, why: 'process.env — configuration belongs to the caller' },
];

for (const [dirName, pkgName] of pkgNames) {
  const meta = pkgMeta.get(pkgName);
  const isKernel = meta.manifest.helm?.layer === 'kernel';
  const ioBoundary = meta.manifest.helm?.ioBoundary ?? null;
  const declaredDeps = Object.keys(meta.manifest.dependencies ?? {});

  for (const file of walk(join(packagesDir, dirName, 'src'))) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(join(packagesDir, dirName), file).split(sep).join('/');
    const isIoBoundary = ioBoundary !== null && rel === ioBoundary;

    for (const spec of importsOf(src)) {
      // (1) never import an app
      if (spec.includes('/src/') && spec.includes('apps')) {
        fail('dependency-direction', file, `imports an app: ${spec}`);
      }
      // (5) no deep imports into another package's internals
      const deep = /^@helm\/([a-z-]+)\/(.+)$/.exec(spec);
      if (deep && !['conformance', 'postgres'].includes(deep[2])) {
        fail('deep-import', file, `reaches past @helm/${deep[1]}'s exports: ${spec}`);
      }
      // declared dependencies only
      const wsDep = /^(@helm\/[a-z-]+)/.exec(spec);
      if (wsDep && wsDep[1] !== pkgName && !declaredDeps.includes(wsDep[1])) {
        fail('undeclared-dependency', file, `imports ${wsDep[1]} without declaring it`);
      }
      // (3)(4) kernel forbidden imports — the I/O boundary file is exempt for
      // the database client only
      if (isKernel) {
        for (const f of KERNEL_FORBIDDEN_IMPORTS) {
          if (!f.pattern.test(spec)) continue;
          const dbExempt = isIoBoundary && f.why === 'a Supabase client';
          if (dbExempt) continue;
          fail('kernel-purity', file, `kernel package imports ${f.why}: ${spec}`);
        }
      }
    }

    // (2) impurity markers
    if (isKernel && !isIoBoundary) {
      for (const { re, why } of IMPURITY) {
        if (!re.test(src)) continue;
        // uuidIdGen and systemClock are the sanctioned adapters of these
        // primitives and live in shared/src/temporal.ts by design.
        if (pkgName === '@helm/shared' && rel === 'src/temporal.ts') continue;
        fail('kernel-purity', file, `uses ${why}`);
      }
    }
  }
}

// -------------------------------------------------------------------- app

// (6) business logic must not live in React components.
const LOGIC_IN_COMPONENT = [
  { re: /\b(?:const|let)\s+\w*(?:[Tt]hreshold|THRESHOLD)\w*\s*=\s*[\d.]/, why: 'a numeric threshold' },
  { re: /\.status\s*=\s*['"](?:approved|executing|monitoring|closed|pending_approval)['"]/, why: 'a direct decision status assignment' },
];

for (const file of walk(join(root, 'src'))) {
  if (!/\.tsx$/.test(file)) continue;
  const src = readFileSync(file, 'utf8');
  for (const { re, why } of LOGIC_IN_COMPONENT) {
    if (re.test(src)) fail('no-logic-in-components', file, `contains ${why}`);
  }
}

// ------------------------------------------------------------------ report

if (failures.length === 0) {
  const n = pkgNames.size;
  console.log(`verify:architecture — ok (${n} package${n === 1 ? '' : 's'}, all invariants hold)`);
  process.exit(0);
}

console.error(`verify:architecture — ${failures.length} violation(s):\n`);
for (const f of failures) {
  console.error(`  [${f.rule}] ${f.file}`);
  console.error(`      ${f.detail}`);
}
process.exit(1);
