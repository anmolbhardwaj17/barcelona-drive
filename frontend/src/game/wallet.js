/**
 * wallet.js — persistent player economy (localStorage). Taxi fares pay into the wallet; the car-colour
 * shop spends from it. Owned (unlocked) colours are remembered forever. Purely client-side.
 *
 *   dd_wallet        → number, current spendable balance
 *   dd_ownedColors   → string[] of lowercase hex colours the player has bought
 */
const BAL_KEY = 'dd_wallet';
const OWNED_KEY = 'dd_ownedColors';

function _readNum(key, def) { try { const v = parseFloat(localStorage.getItem(key)); return Number.isFinite(v) ? v : def; } catch { return def; } }
function _readArr(key) { try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function _write(key, val) { try { localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val)); } catch {} }

const _subs = [];
function _emit() { for (const cb of _subs) { try { cb(); } catch {} } }

export const wallet = {
  balance() { return Math.max(0, Math.round(_readNum(BAL_KEY, 0))); },
  add(n) { const b = this.balance() + Math.max(0, Math.round(n || 0)); _write(BAL_KEY, String(b)); _emit(); return b; },
  /** Try to spend `n`. Returns true and deducts if affordable, else false. */
  spend(n) { const b = this.balance(); n = Math.max(0, Math.round(n || 0)); if (n > b) return false; _write(BAL_KEY, String(b - n)); _emit(); return true; },

  owned() { return new Set(_readArr(OWNED_KEY).map((h) => String(h).toLowerCase())); },
  isOwned(hex) { return this.owned().has(String(hex).toLowerCase()); },
  own(hex) { const h = String(hex).toLowerCase(); const arr = _readArr(OWNED_KEY); if (!arr.includes(h)) { arr.push(h); _write(OWNED_KEY, arr); _emit(); } },

  /** Subscribe to balance/ownership changes (returns an unsubscribe fn). */
  onChange(cb) { _subs.push(cb); return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); }; },
};
