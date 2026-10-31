'use strict';
// Contact form: client-side checks mirror the server (which re-checks everything). Files go as multipart/form-data.
(function () {
  const MAX_FILES = 3, MAX_BYTES = 5 * 1024 * 1024, OK_EXT = /\.(jpe?g|png|webp|pdf|txt|csv|docx)$/i;
  const $ = (id) => document.getElementById(id);
  let token = '', files = [];
  const fmt = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  async function freshToken() { try { const r = await fetch('/api/contact/token', { credentials: 'same-origin' }); const j = await r.json(); token = j.token || ''; } catch { token = ''; } }
  function setErr(field, msg) {
    const el = $('cf-' + field + '-err'); if (el) el.textContent = msg || '';
    const input = field === 'file' ? $('cf-file') : $('cf-' + field); if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  function clearErrs() { ['name', 'email', 'topic', 'message', 'file', 'consent'].forEach((f) => setErr(f, '')); const box = $('cf-errors'); box.hidden = true; box.textContent = ''; }
  function summary(list) {
    const box = $('cf-errors'); box.innerHTML = '<strong>Please fix the following:</strong><ul>' + list.map(([f, m]) => `<li><a href="#cf-${f === 'file' ? 'file' : f}">${LP.esc(m)}</a></li>`).join('') + '</ul>';
    box.hidden = false; box.focus();
  }
  function renderFiles() {
    const ul = $('cf-files');
    ul.innerHTML = files.map((f, i) => `<li><span class="cf-fname">${LP.esc(f.name)}</span> <span class="muted small">${fmt(f.size)}</span> <button type="button" class="icon-btn sm" data-rm="${i}" aria-label="Remove ${LP.esc(f.name)}">✕</button></li>`).join('');
    ul.hidden = !files.length;
  }
  function addFiles(list) {
    setErr('file', '');
    for (const f of list) {
      if (files.length >= MAX_FILES) { setErr('file', `You can attach up to ${MAX_FILES} files.`); break; }
      if (!OK_EXT.test(f.name)) { setErr('file', `${f.name}: only JPG, PNG, WebP, PDF, TXT, CSV and DOCX files can be attached.`); continue; }
      if (f.size > MAX_BYTES) { setErr('file', `${f.name} is larger than 5 MB.`); continue; }
      if (!f.size) { setErr('file', `${f.name} is empty.`); continue; }
      if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
    }
    renderFiles();
  }
  function validate(form) {
    const errs = []; const v = (n) => form.elements[n].value.trim();
    if (!v('name')) errs.push(['name', 'Please tell Malcolm your name']);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v('email'))) errs.push(['email', 'Please enter a valid email address']);
    if (v('message').length < 10) errs.push(['message', 'Please write a little more (at least 10 characters)']);
    if (!form.elements.consent.checked) errs.push(['consent', 'Please confirm you have read how we use your message']);
    return errs;
  }
  document.addEventListener('DOMContentLoaded', async () => {
    const form = $('contact-form'); if (!form) return;
    freshToken();
    // Prefill for signed-in members (they can still change it).
    fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then(({ user }) => {
      if (!user) return; if (user.name && !form.elements.name.value) form.elements.name.value = user.name; if (user.email && !form.elements.email.value) form.elements.email.value = user.email;
    }).catch(() => {});
    const qs = new URLSearchParams(location.search); const t = qs.get('topic'); if (t && form.elements.topic.querySelector(`option[value="${CSS.escape(t)}"]`)) form.elements.topic.value = t;
    const msg = form.elements.message, count = $('cf-message-count');
    msg.addEventListener('input', () => { count.textContent = `${msg.value.length.toLocaleString('en-GB')} / 5,000`; });
    $('cf-file').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
    $('cf-files').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; files.splice(+b.dataset.rm, 1); renderFiles(); setErr('file', ''); $('cf-file').focus(); });
    const drop = form.querySelector('.cf-msg');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); drop.classList.add('drag'); } }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
    renderFiles();

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clearErrs();
      const errs = validate(form);
      if (errs.length) { errs.forEach(([f, m]) => setErr(f, m)); summary(errs); return; }
      const btn = $('cf-send'), status = $('cf-status');
      btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); btn.textContent = 'Sending…';
      status.textContent = files.length ? 'Malcolm is reading your message and attachments. This can take up to a minute.' : 'Malcolm is reading your message…';
      const fd = new FormData(form); fd.delete('file'); files.forEach((f) => fd.append('file', f, f.name)); fd.set('formToken', token);
      try {
        if (!LP.csrf()) await fetch('/api/csrf', { credentials: 'same-origin' });
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 100000);
        const r = await fetch('/api/contact', { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'x-csrf-token': LP.csrf() }, signal: ctrl.signal });
        clearTimeout(timer);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (j.retryToken) await freshToken();
          const f = j.field && ['name', 'email', 'topic', 'message', 'file', 'consent'].includes(j.field) ? j.field : null;
          if (f) setErr(f, j.error); summary([[f || 'message', j.error || 'Something went wrong. Please try again, or email malcolm@aichef.food.']]);
          status.textContent = ''; return;
        }
        const email = form.elements.email.value.trim();
        $('cf-done-text').textContent = j.dryRun ? (j.note || 'Staging preview: your message passed every check.')
          : j.emailed ? `Malcolm has read your message${j.attachments ? (j.attachmentsRead ? ' and your attachments' : ' (he couldn\u2019t read your attachments, but Oliver has them)') : ''} and emailed his reply to ${email}. If you can\u2019t see it in a few minutes, please check your spam folder.`
          : `We\u2019ve received your message and passed it to Oliver, who will reply to ${email} personally.`;
        $('cf-done-ref').textContent = j.reference ? `Reference: ${j.reference}` : '';
        form.hidden = true; const done = $('cf-done'); done.hidden = false; done.focus();
        form.reset(); files = []; renderFiles(); count.textContent = '0 / 5,000'; freshToken();
      } catch (err) {
        summary([['message', err && err.name === 'AbortError' ? 'Malcolm is taking longer than usual. Your message may still arrive; please wait a few minutes before sending it again, or email malcolm@aichef.food.' : 'Could not send your message. Please check your connection and try again, or email malcolm@aichef.food.']]);
        status.textContent = '';
      } finally { btn.disabled = false; btn.removeAttribute('aria-disabled'); btn.textContent = 'Send to Malcolm'; }
    });
    $('cf-again').addEventListener('click', () => { $('cf-done').hidden = true; form.hidden = false; form.elements.name.focus(); });
  });
})();
