(function () {
  const el = document.getElementById('mem'); const esc = s => window.LP.esc(String(s ?? ''));
  const when = ms => ms ? new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London' }) + ' (UK time)' : '—';
  async function render() {
    const me = await (await fetch('/api/me', { credentials: 'same-origin' })).json();
    if (!me.user) { el.innerHTML = '<p>Please <a href="/account.html?next=/memory.html">sign in</a> to see what Malcolm remembers. Nothing is remembered for signed-out visitors.</p>'; return; }
    const ct = await (await fetch('/api/memory/consent', { credentials: 'same-origin' })).json(); const c = ct.consent, t = ct.text;
    const d = await (await fetch('/api/memory', { credentials: 'same-origin' })).json(); const p = d.profile || {};
    const tog = k => `<label style="display:flex;gap:.5rem;margin:.4rem 0"><input type="checkbox" data-k="${k}" ${c[k] ? 'checked' : ''}> <span>${esc(t[k])}</span></label>`;
    const list = (label, a) => a && a.length ? `<li><strong>${label}:</strong> ${esc(a.join(', '))}</li>` : '';
    el.innerHTML = `<section class="card"><h2>Your choices</h2><p class="muted">${esc(t.intro)}</p>${tog('chat')}${tog('search')}${tog('behaviour')}
      <label style="display:flex;gap:.5rem;margin:.4rem 0"><input type="checkbox" data-k="paused" ${c.paused ? 'checked' : ''}> <span><strong>Pause</strong>: keep what Malcolm knows but stop remembering and stop using it for now.</span></label>
      <p class="muted">${c.consentedAt ? 'Consent given ' + esc(when(c.consentedAt)) + ', version ' + esc(c.version) : 'You haven’t switched anything on.'} ${esc(t.retention)}</p>
      <p><button class="btn" id="save">Save choices</button> <a class="btn ghost" href="/api/memory/export" download>Download my data (JSON)</a> <button class="btn ghost" id="del">Delete everything</button></p></section>
      <section class="card"><h2>What Malcolm has learnt</h2><ul>${list('Favourite cuisines', p.cuisines)}${list('Favourite ingredients', p.ingredients)}${list('Dietary needs', p.dietary)}${list('Avoids', p.avoids)}${p.typicalMinutes ? `<li><strong>Usual time:</strong> about ${esc(p.typicalMinutes)} min</li>` : ''}${p.servings ? `<li><strong>Usually cooks for:</strong> ${esc(p.servings)}</li>` : ''}${list('Frequent searches', p.frequentSearches)}${list('Recently viewed or saved', p.recentRecipes)}</ul>${d.profile ? '' : '<p class="muted">Nothing yet.</p>'}</section>
      <section class="card"><h2>Conversations (${d.chats.length})</h2>${d.chats.slice(-30).map(m => `<p><strong>${m.role === 'user' ? 'You' : 'Malcolm'}</strong> <span class="muted">${esc(when(m.created_at))}</span><br>${esc(m.text)}</p>`).join('') || '<p class="muted">None stored.</p>'}</section>
      <section class="card"><h2>Searches (${d.searches.length}) and browsing (${d.events.length})</h2><ul>${d.searches.slice(-15).reverse().map(s => `<li>${esc(when(s.created_at))}: ${esc([s.query.dish, (s.query.include || []).join(', ')].filter(Boolean).join(' · '))}</li>`).join('')}${d.events.slice(-15).reverse().map(e => `<li>${esc(when(e.created_at))}: ${esc(e.kind.replace('_', ' '))} ${esc(e.ref || '')}</li>`).join('')}</ul></section>`;
    document.getElementById('save').onclick = async () => { const b = {}; el.querySelectorAll('input[data-k]').forEach(i => b[i.dataset.k] = i.checked); await window.LP.api('/api/memory/consent', { method: 'PUT', body: b }); window.LP.toast && window.LP.toast('Saved'); render(); };
    document.getElementById('del').onclick = async () => { if (!confirm('Delete everything Malcolm remembers about you and switch memory off? This can’t be undone.')) return; await window.LP.api('/api/memory', { method: 'DELETE' }); window.LP.toast && window.LP.toast('Deleted'); render(); };
  }
  render().catch(() => { el.innerHTML = '<p>Couldn’t load your memory just now — please try again.</p>'; });
})();
