/**
 * gameLauncher.js — game-mode buttons as a clean vertical column on the left.
 *
 * One button per mode. Click a mode to start it (stops any other → one at a time); click the running
 * mode to quit it (turns red). Controls live in the ESC menu, so they're not repeated here.
 *
 * @param {Array<{name:string, icon:string, start:()=>void, stop:()=>void, isRunning:()=>boolean}>} modes
 */
export function createGameLauncher(modes) {
  const THEME = {
    'Checkpoint Dash': { grad: '#ffd23f,#f5a623', shadow: '#b9791a', text: '#241a08' },
    'City Cab':        { grad: '#8ef0b0,#2ee06a', shadow: '#1c9c48', text: '#0b2417' },
  };
  const QUIT = { grad: '#ff8a6b,#f5533a', shadow: '#b13320', text: '#2a0a04' };

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;top:88px;left:14px;z-index:1300;display:flex;flex-direction:column;gap:8px;align-items:flex-start;';
  document.body.appendChild(wrap);

  function paint(b, m) {
    const running = m.isRunning();
    const t = running ? QUIT : (THEME[m.name] || THEME['Checkpoint Dash']);
    b.innerHTML = `${running ? '✕ ' : ''}${m.icon} ${m.name}`;
    b.style.background = `linear-gradient(${t.grad})`;
    b.style.color = t.text;
    b.style.boxShadow = `0 4px 0 ${t.shadow},0 7px 12px rgba(0,0,0,.32)`;
    b.dataset.shadow = t.shadow;
  }

  const buttons = modes.map((m) => {
    const b = document.createElement('button');
    b.style.cssText = 'cursor:pointer;font-family:Poppins,system-ui,sans-serif;font-weight:800;font-size:13.5px;' +
      'border:none;border-radius:20px;padding:9px 16px;white-space:nowrap;transition:transform .06s,box-shadow .06s;';
    b.onmousedown = () => { b.style.transform = 'translateY(3px)'; b.style.boxShadow = `0 1px 0 ${b.dataset.shadow}`; };
    b.onmouseup = () => { b.style.transform = ''; paint(b, m); };
    b.onmouseleave = () => { b.style.transform = ''; };
    b.onclick = () => {
      if (m.isRunning()) { m.stop?.(); }
      else { modes.forEach((x) => { if (x !== m) x.stop?.(); }); m.start?.(); }
      refresh();
    };
    paint(b, m);
    wrap.appendChild(b);
    return { m, b };
  });

  function refresh() { for (const { m, b } of buttons) paint(b, m); }
  const poll = setInterval(refresh, 200);   // keeps labels honest when a mode ends itself (dash finish)

  return { refresh, dispose() { clearInterval(poll); wrap.remove(); } };
}
