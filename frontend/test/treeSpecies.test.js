/**
 * v3 P3-10(a) species-by-context classifier and (c) billboard collapse.
 *
 * The classifier's failure mode is not a crash — it is palms in courtyards and bitter oranges down
 * Gran Via, which looks like a content problem rather than a bug. These assert the distributions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpecies, SPECIES_SETS, _setTreeVariantCountForTest } from '../src/workers/vegetationWorker.js';
import { TREE_CARD_SPECIES } from '../src/map/treeCards.js';

const NAME = TREE_CARD_SPECIES.map((s) => s.name);

/** Distribution of species names over N synthetic trees in one context. */
function distribution(ctx, n = 4000) {
  _setTreeVariantCountForTest(6);
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const vi = classifySpecies({ ctx }, i, 12345, 0);
    assert.ok(vi >= 0 && vi < 6, `${ctx}: index in range`);
    counts.set(NAME[vi], (counts.get(NAME[vi]) || 0) + 1);
  }
  return counts;
}

test('each context plants the species that belongs there', () => {
  const avenue = distribution('avenue');
  // The pollarded plane is THE Barcelona avenue tree and must dominate Gran Via / Diagonal.
  assert.ok(avenue.get('plane_pollarded') / 4000 > 0.5, 'avenues are mostly plane');
  assert.ok(!avenue.has('washingtonia'), 'no palms on an inland avenue');
  assert.ok(!avenue.has('orange_bitter'), 'no bitter orange on a main avenue');

  const coast = distribution('coast');
  assert.ok(coast.get('washingtonia') / 4000 > 0.7, 'the coast is mostly palm');
  assert.ok(!coast.has('plane_pollarded'), 'no plane trees on the seafront');

  const plaza = distribution('plaza');
  assert.ok(plaza.get('orange_bitter') / 4000 > 0.4, 'plaças and courtyards favour bitter orange');

  // The jacaranda is a seasonal accent everywhere except parks — a city 1/6 violet is not Barcelona.
  for (const ctx of ['avenue', 'street', 'coast', 'plaza']) {
    const d = distribution(ctx);
    assert.ok((d.get('jacaranda') || 0) / 4000 < 0.12, `${ctx}: jacaranda stays an accent`);
  }
  assert.ok(distribution('park').get('jacaranda') / 4000 > 0.1, 'parks are where jacarandas live');
});

test('classification is deterministic — the same tree gets the same species every load', () => {
  _setTreeVariantCountForTest(6);
  for (let i = 0; i < 200; i++) {
    assert.equal(classifySpecies({ ctx: 'street' }, i, 99, 0), classifySpecies({ ctx: 'street' }, i, 99, 0));
  }
});

test('an unknown context degrades to the street set rather than throwing', () => {
  // Species coverage is 13.8%; graceful degradation is the whole design, so an unrecognised
  // context must never be able to take the tile down.
  _setTreeVariantCountForTest(6);
  for (const ctx of [undefined, null, '', 'nonsense']) {
    const vi = classifySpecies({ ctx }, 7, 1, 0);
    assert.ok(vi >= 0 && vi < 6);
  }
});

test('the blob path is left completely alone', () => {
  // classifySpecies must not hand a 6-species index to a renderer that has 4 blob geometries —
  // meshMaterializer would filter the overflow out and a third of the trees would vanish.
  _setTreeVariantCountForTest(4);
  for (let i = 0; i < 100; i++) {
    const fallback = i * 7;
    assert.equal(classifySpecies({ ctx: 'coast' }, i, 3, fallback), fallback % 4);
  }
  _setTreeVariantCountForTest(6);
});

test('every context set references only species that exist in the atlas', () => {
  for (const [ctx, set] of Object.entries(SPECIES_SETS)) {
    for (const [idx, weight] of set) {
      assert.ok(idx >= 0 && idx < TREE_CARD_SPECIES.length, `${ctx}: species ${idx} exists`);
      assert.ok(weight > 0, `${ctx}: weights are positive`);
    }
  }
});
