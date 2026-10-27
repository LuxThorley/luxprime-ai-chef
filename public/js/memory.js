// Malcolm personal memory: consent prompt + first-party signals. Does nothing for signed-out visitors or before consent.
(function () {
  if (window.__lpMem) return; window.__lpMem = true;
  const api = (u, o) => window.LP.api(u, o);
  let consent = null;
  async function load() {
    try { const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json(); if (!me.user) return; // signed out: no prompt, no tracking
      const r = await (await fetch('/api/memory/consent', { credentials: 'same-origin' })).json(); consent = r.consent;
      if (!consent.recorded && !sessionStorage.getItem('lp_mem_later') && !/\/memory\.html$/.test(location.pathname)) prompt(r.text);
      else if (on()) send('page_view', location.pathname);
    } catch {}
  }
  const on = () => consent && consent.recorded && !consent.paused && consent.behaviour;
  function send(kind, ref) { if (!on()) return; api('/api/memory/event', { method: 'POST', body: { kind, ref: String(ref || '').slice(0, 120) } }).catch(() => {}); }
  function prompt(t) {
    const d = document.createElement('div'); d.className = 'card'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', t.title);
    d.style.cssText = 'position:fixed;left:1rem;bottom:1rem;max-width:440px;z-index:9999;color:var(--ink)';
    const box = (k) => `<label style="display:flex;gap:.5rem;margin:.4rem 0"><input type="checkbox" data-k="${k}"> <span>${window.LP.esc(t[k])}</span></label>`;
    d.innerHTML = `<h3 style="margin-top:0">${window.LP.esc(t.title)}</h3><p class="muted">${window.LP.esc(t.intro)}</p>${box('chat')}${box('search')}${box('behaviour')}<p class="muted" style="font-size:.85rem">${window.LP.esc(t.retention)} <a href="/privacy.html#memory">Privacy notice</a></p><p><button class="btn" data-a="save">Save my choices</button> <button class="btn ghost" data-a="later">Not now</button></p>`;
    d.addEventListener('click', async e => { const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      if (a === 'later') { sessionStorage.setItem('lp_mem_later', '1'); d.remove(); return; }
      const b = {}; d.querySelectorAll('input[data-k]').forEach(i => b[i.dataset.k] = i.checked);
      const r = await api('/api/memory/consent', { method: 'PUT', body: b }); consent = r.consent; d.remove(); window.LP.toast && window.LP.toast('Saved — change it any time on “What Malcolm remembers”.'); });
    document.body.appendChild(d);
  }
  window.LPMemory = { track: send, reload: load };
  document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href]'); if (a && /\/recipe\.html|\/r\//.test(a.getAttribute('href'))) send('recipe_view', a.textContent.trim()); }, true);
  if (/menu-builder\.html$/.test(location.pathname)) document.addEventListener('submit', () => send('menu_builder', 'menu'), true);
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b && /kitchen pack/i.test(b.textContent)) send('kitchen_pack', 'pack'); }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
