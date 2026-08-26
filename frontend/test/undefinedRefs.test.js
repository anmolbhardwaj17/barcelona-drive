/**
 * Catch a call to a project function that was never imported.
 *
 * WHY. Three runtime breaks shipped in one session from edits that removed a declaration or skipped
 * an import — `_bikeLaneMaterial`, `setTreeCardNightMode`, `setFacadeArrayNightMode`. All three
 * passed `node --check`, passed the whole suite and built cleanly, because a reference inside a
 * function body is only resolved when that function RUNS. The game died on the first tile build.
 *
 * `node --check` parses, it does not resolve, and there is no linter here.
 *
 * DELIBERATELY NARROW. A first attempt flagged `this._sfxBus`, `setTimeout` and object-literal keys —
 * dozens of false positives, and a check that cries wolf gets switched off, at which point it catches
 * nothing. So this asks one precise question: is a name that ANOTHER module in this project exports
 * being CALLED here without being imported here? That is exactly the shape of all three breaks, and
 * a global or a property can never look like it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const stripNonCode = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:\\.|[^`\\])*`/g, '``')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""');

/** Names a file brings into scope: imports plus its own top-level declarations. */
function inScope(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s*['"]/g)) {
    for (const g of m[1].matchAll(/\{([^}]*)\}/g)) {
      for (const part of g[1].split(',')) {
        const alias = part.split(/\s+as\s+/).pop().trim();
        if (alias) names.add(alias);
      }
    }
    for (const b of m[1].replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+/, '').split(',')) {
      const t = b.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const re of [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  ]) for (const m of src.matchAll(re)) names.add(m[1]);

  // Bindings that are NOT declarations, and every one of these produced a false positive on the
  // first run — a check that flags working code gets switched off, so they have to be understood:
  //
  //   FUNCTION PARAMETERS. createTileManager(scene, createRoadMeshes, createSpatialIndex, ...) —
  //   dependency injection, so the name is a parameter and the import genuinely belongs elsewhere.
  //   DESTRUCTURING. `const { latLonToWorld, getCarPos } = deps` and
  //   `const { createRapierWorldAdapter } = await import(...)` — a dynamic import is still an import.
  for (const m of src.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*|=>\s*|\)\s*=>|\b(?:async\s+)?\()\s*\(?([^)]*)\)/g)) {
    for (const part of (m[1] || '').split(',')) {
      const bare = part.split('=')[0].replace(/[{}[\].]/g, ' ').trim();
      for (const tok of bare.split(/[\s:]+/)) {
        if (/^[A-Za-z_$][\w$]*$/.test(tok)) names.add(tok);
      }
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
    }
  }
  return names;
}

test('no file calls a project export it never imported', () => {
  const root = path.resolve('src');
  const files = walk(root);

  // Every function this project exports, and where from.
  const exportedFrom = new Map();
  for (const f of files) {
    const src = stripNonCode(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
      if (!exportedFrom.has(m[1])) exportedFrom.set(m[1], path.relative(root, f));
    }
  }

  const problems = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const src = stripNonCode(raw);
    const scope = inScope(raw);
    const self = path.relative(root, f);

    for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = m[2];
      if (!exportedFrom.has(name)) continue;      // not one of ours — no opinion
      if (exportedFrom.get(name) === self) continue;
      if (scope.has(name)) continue;              // imported or shadowed here
      problems.push(`${self} calls ${name}() — exported by ${exportedFrom.get(name)}, not imported here`);
    }
  }

  assert.deepEqual([...new Set(problems)], [],
    `\n  ${[...new Set(problems)].join('\n  ')}\n`);
});
