// Runs after `vite build`. Vite hashes style.css/script.js/admin.css/admin.js
// into dist/assets/*.[hash].{css,js} on every build, but dist/sw.js still
// says to precache the old unhashed names ('./style.css', './script.js').
// This reads Vite's build manifest to find the real output filenames and
// rewrites SHELL_FILES in dist/sw.js to match, then bumps CACHE_VERSION
// (short hash of the manifest) so returning visitors bust their old cache.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const DIST = 'dist';
const manifestPath = `${DIST}/.vite/manifest.json`;

if (!existsSync(manifestPath)) {
  console.error(`[update-sw-precache] ${manifestPath} not found — did the build run with build.manifest:true?`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// style.css is shared across index.html/admin.html, so Vite may attach it to
// an imported chunk rather than directly on the index.html entry. Walk
// `imports` recursively to collect every css file pulled in transitively.
function collectCss(entryKey, seen = new Set()) {
  if (seen.has(entryKey)) return [];
  seen.add(entryKey);
  const entry = manifest[entryKey];
  if (!entry) return [];
  const css = [...(entry.css || [])];
  for (const imp of entry.imports || []) css.push(...collectCss(imp, seen));
  return css;
}

const mainEntry = manifest['index.html'];
const mainJs = mainEntry?.file;
const mainCss = collectCss('index.html')[0];

if (!mainCss || !mainJs) {
  console.error('[update-sw-precache] Could not find hashed index.html assets in manifest:', manifest);
  process.exit(1);
}

const swPath = `${DIST}/sw.js`;
let sw = readFileSync(swPath, 'utf8');

sw = sw.replace("'./style.css',", `'/${mainCss}',`);
sw = sw.replace("'./script.js',", `'/${mainJs}',`);

const versionHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 8);
sw = sw.replace(/const CACHE_VERSION = '.*?';.*/, `const CACHE_VERSION = '${versionHash}'; // auto-bumped by scripts/update-sw-precache.mjs on each build`);

writeFileSync(swPath, sw);
console.log(`[update-sw-precache] sw.js precache updated -> ${mainCss}, ${mainJs} (CACHE_VERSION=${versionHash})`);
