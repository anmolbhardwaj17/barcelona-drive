/**
 * gameLauncher.js — one "Play" entry point for all game modes (UX consolidation).
 *
 * Replaces the per-mode Start buttons with a single launcher pill + a mode menu, so adding modes doesn't
 * clutter the HUD and only one mode can run at a time. Also surfaces the controls (previously buried in
 * the settings menu) so a new player knows how to drive.
 *
 * @param {Array<{name:string, icon:string, start:()=>void, stop:()=>void, isRunning:()=>boolean}>} modes
 */
export function createGameLauncher(modes) {
  const running = () => modes.find((m) => m.isRunning());

  const el = (t, cls) => { const e = document.createElement(t); if (cls) e.className = cls; return e; };

  // ── launcher pill (top-left, below the ☰ menu button) ──────────────────────
  const btn = el('button');
  btn.style.cssText = 'position:fixed;top:88px;left:14px;z-index:1300;cursor:pointer;' +
    'font-family:Poppins,system-ui,sans-serif;font-weight:800;font-size:14px;color:#241a08;' +
    'background:linear-gradient(#ffd23f,#f5a623);border:none;border-radius:22px;padding:9px 18px;' +
    'box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35);transition:transform .06s,box-shadow .06s;';
  btn.onmousedown = () => { btn.style.transform = 'translateY(4px)'; btn.style.boxShadow = '0 1px 0 #b9791a'; };
  btn.onmouseup = () => { btn.style.transform = ''; btn.style.boxShadow = '0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35)'; };
  document.body.appendChild(btn);

  // First-run nudge: pulse the Play button + a tooltip until the player interacts with it.
  let _tip = null, _pulse = null;
  const _seen = () => { try { return localStorage.getItem('dd_seenPlay') === '1'; } catch { return true; } };
  if (!_seen()) {
    _pulse = el('style');
    _pulse.textContent = '@keyframes ddPlayPulse{0%,100%{box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35),0 0 0 0 rgba(245,197,66,.55)}50%{box-shadow:0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35),0 0 0 12px rgba(245,197,66,0)}}';
    document.head.appendChild(_pulse);
    btn.style.animation = 'ddPlayPulse 1.6s ease-out infinite';
    _tip = el('div');
    _tip.style.cssText = 'position:fixed;top:90px;left:118px;z-index:1301;background:#0e1a2e;border:2px solid #f5c542;color:#fff;' +
      'font:800 12px Poppins,sans-serif;padding:7px 11px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap;';
    _tip.textContent = '▶ New here? Pick a mode';
    document.body.appendChild(_tip);
  }
  function dismissNudge() {
    if (_pulse) { btn.style.animation = ''; _pulse.remove(); _pulse = null; }
    if (_tip) { _tip.remove(); _tip = null; }
    try { localStorage.setItem('dd_seenPlay', '1'); } catch {}
  }

  // ── popover menu ────────────────────────────────────────────────────────────
  const pop = el('div');
  pop.style.cssText = 'position:fixed;top:130px;left:14px;z-index:1301;display:none;width:250px;' +
    'font-family:Poppins,system-ui,sans-serif;background:#0e1a2e;border:2px solid #f5c542;border-radius:16px;' +
    'padding:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:#fff;';
  document.body.appendChild(pop);
  let open = false;
  const setOpen = (v) => { open = v; pop.style.display = v ? 'block' : 'none'; };

  function modeRow(m, desc) {
    const row = el('button');
    row.style.cssText = 'display:block;width:100%;text-align:left;cursor:pointer;margin-bottom:8px;' +
      'background:#1b2b45;border:1px solid #2c4062;border-radius:11px;padding:9px 11px;color:#fff;font-family:inherit;transition:background .1s;';
    row.onmouseenter = () => { row.style.background = '#263c60'; };
    row.onmouseleave = () => { row.style.background = '#1b2b45'; };
    row.innerHTML = `<div style="font-weight:800;font-size:14px">${m.icon} ${m.name}</div>` +
      `<div style="font-size:11px;opacity:.7;margin-top:2px">${desc}</div>`;
    row.onclick = () => startMode(m);
    return row;
  }

  const DESCS = {
    'Checkpoint Dash': 'Race through gates against the clock — beat your best time.',
    'City Cab': 'Pick up fares, deliver fast, earn tips.',
  };

  pop.appendChild(Object.assign(el('div'), { textContent: 'GAME MODES', style: 'font-weight:800;font-size:11px;letter-spacing:1px;color:#f5c542;margin-bottom:8px' }));
  for (const m of modes) pop.appendChild(modeRow(m, DESCS[m.name] || ''));

  // Free roam = quit any running mode
  const freeRow = modeRow({ icon: '🗺️', name: 'Free Roam' }, 'Just drive — no objective.');
  freeRow.onclick = () => { quitAll(); setOpen(false); };
  pop.appendChild(freeRow);

  // controls cheatsheet
  const ctrls = el('div');
  ctrls.style.cssText = 'margin-top:6px;border-top:1px solid #2c4062;padding-top:9px;font-size:11px;line-height:1.7;color:#c9d6e8';
  const key = (k) => `<b style="display:inline-block;min-width:34px;background:#26364f;border-radius:5px;padding:1px 5px;text-align:center;color:#fff;font-family:monospace">${k}</b>`;
  ctrls.innerHTML =
    `<div style="font-weight:800;font-size:11px;letter-spacing:1px;color:#f5c542;margin-bottom:5px">CONTROLS</div>` +
    `${key('W A S D')} drive &nbsp; ${key('Space')} handbrake<br>` +
    `${key('H')} horn &nbsp; ${key('R')} recover &nbsp; ${key('M')} map<br>` +
    `${key('Esc')} settings`;
  pop.appendChild(ctrls);

  // ── behaviour ────────────────────────────────────────────────────────────────
  function startMode(m) {
    modes.forEach((x) => { if (x !== m) x.stop?.(); });
    m.start?.();
    setOpen(false);
    refresh();
  }
  function quitAll() { modes.forEach((m) => m.stop?.()); refresh(); }

  btn.onclick = (e) => {
    e.stopPropagation();
    dismissNudge();
    if (running()) { quitAll(); }
    else { setOpen(!open); }
  };
  // click-away closes the popover
  document.addEventListener('click', (e) => { if (open && !pop.contains(e.target) && e.target !== btn) setOpen(false); });

  function refresh() {
    const r = running();
    if (r) {
      btn.innerHTML = `✕ Quit ${r.icon}`;
      btn.style.background = 'linear-gradient(#ff8a6b,#f5533a)';
      btn.style.boxShadow = '0 5px 0 #b13320,0 8px 14px rgba(0,0,0,.35)';
      setOpen(false);
    } else {
      btn.innerHTML = '🎮 Play';
      btn.style.background = 'linear-gradient(#ffd23f,#f5a623)';
      btn.style.boxShadow = '0 5px 0 #b9791a,0 8px 14px rgba(0,0,0,.35)';
    }
  }

  // keep the label honest when a mode ends itself (dash finish, etc.)
  const poll = setInterval(refresh, 200);
  refresh();

  return { refresh, dispose() { clearInterval(poll); btn.remove(); pop.remove(); } };
}
