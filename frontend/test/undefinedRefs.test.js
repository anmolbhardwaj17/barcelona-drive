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
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  // REGEX LITERALS. `/^(INPUT|TEXTAREA|SELECT)$/` reads exactly like three ALL-CAPS identifiers to
  // the constant check below. Telling a regex from a division is the classic ambiguity, so this
  // takes the conservative half: a `/` is only treated as opening a regex when what precedes it
  // cannot end an expression — an operator, a bracket, a comma or `return`. Miss one and you get a
  // false positive, never a missed defect.
  .replace(/([(,=:[!&|?{};]|\breturn)(\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g,
           '$1$2/RE/');

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

  // EVERY declarator in a statement, not just the first. `const WALK_MIN = 0.9, WALK_MAX = 1.6;`
  // declares two names and the regex above sees one — which showed up as a false "WALK_MAX is never
  // declared". Split on commas at bracket depth 0 so `const a = f(1, 2), b = 3;` is not mangled.
  for (const m of src.matchAll(/(?:^|[\n;{])\s*(?:export\s+)?(?:const|let|var)\s+([\s\S]*?);/g)) {
    let depth = 0, start = 0;
    const decl = m[1];
    const parts = [];
    for (let i = 0; i < decl.length; i++) {
      const c = decl[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { parts.push(decl.slice(start, i)); start = i + 1; }
    }
    parts.push(decl.slice(start));
    for (const part of parts) {
      const name = part.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

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

/**
 * ── SECOND CHECK: a MODULE CONSTANT that was deleted out from under its readers ──────────────────
 *
 * Added 2026-08-27, after R-W1 deleted eleven duplicate road-width tables and left three live
 * references to one of them (`ROAD_RENDER_WIDTH[road.highwayType]` in `workers/vegetationWorker.js`).
 * Every one would have thrown `ReferenceError` the moment a tile with a bridge built. It passed
 * `node --check`, passed all 281 tests, and built cleanly — the same blindness this file was written
 * for, in a shape the first check cannot see: the name is INDEXED, not CALLED, and it was a local
 * const rather than another module's export, so neither half of the original rule applies.
 *
 * DELIBERATELY NARROW, for the same reason as above. Only SCREAMING_SNAKE_CASE names — the project's
 * module-constant convention — and only where the name is read or indexed while being neither
 * declared nor imported in that file. A lower-case identifier could be almost anything; an
 * ALL-CAPS one that is not in scope is a deleted constant with near-certainty.
 */
test('no file reads an ALL_CAPS module constant it never declared or imported', () => {
  const root = path.resolve('src');
  const files = walk(root);

  // ALL-CAPS names that legitimately come from somewhere other than a declaration in the file.
  const GLOBALS = new Set([
    'NaN', 'Infinity', 'JSON', 'Math', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Symbol',
    'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'TypeError',
    'Float32Array', 'Float64Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array',
    'Int16Array', 'Int32Array', 'Uint8ClampedArray', 'ArrayBuffer', 'DataView', 'TextDecoder',
    'TextEncoder', 'URL', 'Blob', 'Image', 'Worker', 'IDBKeyRange', 'AudioContext', 'THREE',
    'CANNON', 'RAPIER', 'CONFIG', 'QUALITY',
  ]);

  const problems = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const src = stripNonCode(raw);
    const scope = inScope(raw);
    const self = path.relative(root, f);

    // A read or an index — `NAME[`, `NAME.`, `NAME)` , `NAME,` , `NAME;` — but never `NAME:` (an
    // object key) and never after a dot (a property of something else).
    for (const m of src.matchAll(/(^|[^.\w$'"])([A-Z][A-Z0-9_]{2,})\s*(\[|\.|\)|,|;|\s[-+*/<>=!&|?])/gm)) {
      const name = m[2];
      if (GLOBALS.has(name)) continue;
      if (scope.has(name)) continue;
      problems.push(`${self} reads ${name} — never declared or imported there`);
    }
  }

  assert.deepEqual([...new Set(problems)], [],
    'A module constant is being read where it does not exist. Either it was deleted and these ' +
    'readers were missed, or it needs importing. Both are ReferenceErrors at runtime, on the ' +
    'first frame that reaches the line.');
});
