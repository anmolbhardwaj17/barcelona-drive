/**
 * xp — global, persistent driver progression (localStorage `dd_xp`). Earned from STYLE tricks (drift, air,
 * near-miss, speed) — NOT money; cash stays tied to actual jobs (taxi/delivery/police). XP only ever grows,
 * and drives a driver LEVEL used for flavor/bragging. Mirrors the wallet singleton's shape.
 *
 *   xp.total()          → lifetime style XP
 *   xp.add(n)           → award XP (returns { leveledUp, level })
 *   xp.level()          → current driver level (1-based)
 *   xp.levelProgress()  → 0..1 progress toward the next level
 *   xp.onChange(cb)     → cb(total, level, leveledUp) on every award
 */
const KEY = 'dd_xp';

// XP required to REACH level L (level 1 = 0). Ramps so early levels come quick, later ones are a grind.
function xpForLevel(l) { return l <= 1 ? 0 : Math.round(600 * Math.pow(l - 1, 1.55)); }
function levelFromXp(x) { let l = 1; while (xpForLevel(l + 1) <= x) l++; return l; }

let _total = (() => { try { return Math.max(0, parseInt(localStorage.getItem(KEY) || '0', 10)) || 0; } catch { return 0; } })();
const _subs = [];

export const xp = {
  total() { return _total; },
  level() { return levelFromXp(_total); },
  xpForLevel,
  levelProgress() {
    const l = levelFromXp(_total);
    const cur = xpForLevel(l), next = xpForLevel(l + 1);
    return next > cur ? Math.max(0, Math.min(1, (_total - cur) / (next - cur))) : 1;
  },
  xpToNext() {
    const l = levelFromXp(_total);
    return Math.max(0, xpForLevel(l + 1) - _total);
  },
  add(n) {
    const amt = Math.round(n);
    if (!(amt > 0)) return { leveledUp: false, level: this.level() };
    const before = this.level();
    _total += amt;
    try { localStorage.setItem(KEY, String(_total)); } catch { /* ignore */ }
    const after = this.level();
    const leveledUp = after > before;
    for (const f of _subs) { try { f(_total, after, leveledUp); } catch { /* ignore */ } }
    return { leveledUp, level: after };
  },
  onChange(cb) { if (typeof cb === 'function') _subs.push(cb); },
};
