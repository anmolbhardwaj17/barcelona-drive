/**
 * defects.mjs — every geometry audit, one command, one table.
 *
 * WHY. The numbers that describe this world's condition live in ten separate tools, each of which
 * re-reads 432 tiles and prints a different shape. In practice that means nobody runs them, so a
 * regression is found on screen instead of in a diff — which is how the N-52 overlap gates cost 7
 * dead ends unnoticed, and how a bad bake shipped 177 junction steps for the length of a session.
 *
 * This runs them all and prints the headline number from each. It is a DASHBOARD, not a gate: it
 * asserts nothing and fails nothing, because every one of these numbers has a legitimate non-zero
 * value and pretending otherwise would train people to ignore it.
 *
 * Usage:  node backend/tools/defects.mjs
 */
import { execFileSync } from 'node:child_process';

/** Each: the tool, and a regex whose first capture group is the number that matters. */
const AUDITS = [
  { tool: 'junctionStepAudit.mjs', label: 'junction height-steps (drivable, shared endpoint)',
    re: /disagreeing on its height \(>1 m\): (\d+)/,
    extra: [['at exactly one LAYER_STEP', /LAYER_STEP \(6 m\) : (\d+)/],
            ['unfixable by reconciliation', /unfixable by reconciliation\s*: (\d+)/]] },
  { tool: 'floatClassify.mjs', label: 'floating surface roads, unjustified',
    re: /unjustified floaters: (\d+)/,
    extra: [['APPROACH — missing embankment, height correct', /APPROACH\s+(\d+)/],
            ['ORPHAN — climbs to nothing', /ORPHAN\s+(\d+)/],
            ['TAG — hoisted by the layer model', /TAG\s+(\d+)/]] },
  { tool: 'deadEndCause.mjs', label: 'unjoined drivable ends',
    re: /unjoined drivable ends\s*: (\d+)/,
    extra: [['of which TUNNEL PORTAL (correct)', /TUNNEL PORTAL[^:]*: (\d+)/],
            ['of which BECOMES PEDESTRIAN (correct)', /BECOMES PEDESTRIAN\s*: (\d+)/],
            ['real defects, past the hairline gate', /\(all (\d+) defects/],
            ['of those, NAME-backed (actionable)', /safely actionable set\): (\d+)/]] },
];

const pad = (s, n) => String(s).padEnd(n);
console.log('\nBarcelona Drive — geometry defect dashboard');
console.log('(numbers describe the tiles CURRENTLY ON DISK; re-bake first if you changed the bake)\n');

for (const a of AUDITS) {
  let out;
  try {
    out = execFileSync('node', [`backend/tools/${a.tool}`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch (e) {
    console.log(`  ${pad(a.label, 52)} TOOL FAILED (${a.tool}): ${e.message.split('\n')[0]}`);
    continue;
  }
  const m = out.match(a.re);
  console.log(`  ${pad(a.label, 52)} ${m ? m[1] : '??'}`);
  for (const [name, ex] of a.extra || []) {
    const em = out.match(ex);
    // Print the MISS too. A sub-count that silently vanishes because a tool reworded its output is
    // the same failure as a counter that never fires — you cannot tell "zero" from "not measured".
    console.log(`      ${pad(name, 48)} ${em ? em[1] : 'PATTERN NO LONGER MATCHES'}`);
  }
}
console.log('\nnone of these are gates — every one has a legitimate non-zero value.');
console.log('what matters is the DIRECTION across a change. See docs/context/changelog.md.\n');
