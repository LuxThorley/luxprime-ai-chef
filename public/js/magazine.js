'use strict';
// Lux Prime Kitchen Magazine — promo blocks, purchase, opt-in and on-demand preview (shared by home, pricing, app, account).
window.LPMag=(function(){
  const {api,esc,toast}=LP;let info=null;
  const load=async(force)=>info&&!force?info:(info=await api('/api/magazine'));
  const blurb='A monthly, fully personalised PDF magazine: a cover made for you, three new recipes from Malcolm composed around what you love to cook, an aisle-by-aisle shopping list, wine pairings and a note from Escoffier — delivered to your inbox.';
  async function buy(btn){let me=(await api('/api/me')).user;if(!me){location.href='/account.html?next=/pricing.html';return}
    const m=await load(true);if(m.entitled){location.href='/account.html#magazine';return}
    if(!m.available){toast('The magazine goes on sale soon — payments are not configured yet.');return}
    btn&&(btn.disabled=true);
    try{if(m.canAdd&&confirm('Add Lux Prime Kitchen Magazine to your current plan for '+(m.price||'£3.99')+'/month? It is prorated on your next invoice and you can cancel any time.')){await api('/api/billing/checkout',{method:'POST',body:{plan:'magazine',mode:'add'}});toast('Added — welcome to the magazine!');location.href='/account.html#magazine';return}
      const {url}=await api('/api/billing/checkout',{method:'POST',body:{plan:'magazine'}});location.href=url}catch(e){toast(e.message)}finally{btn&&(btn.disabled=false)}}
  async function preview(btn,out){btn.disabled=true;const t=btn.textContent;btn.textContent='Malcolm is composing your issue… (about a minute)';out&&(out.textContent='');
    try{const r=await fetch('/api/magazine/preview',{credentials:'same-origin'});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Preview failed')}
      const b=await r.blob();const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=(r.headers.get('content-disposition')||'').match(/filename="([^"]+)"/)?.[1]||'Lux-Prime-Kitchen-Magazine.pdf';document.body.appendChild(a);a.click();a.remove();
      out&&(out.innerHTML=`Your preview is ready — <a href="${u}" target="_blank" rel="noopener">open it</a>.`)}catch(e){out?out.textContent=e.message:toast(e.message)}finally{btn.disabled=false;btn.textContent=t}}
  const cover=(w)=>`<a href="/mag/sample.pdf" target="_blank" rel="noopener" class="mag-cover" style="${w?`max-width:${w}px`:''}"><img src="/mag/sample-cover.jpg" alt="Sample cover of Lux Prime Kitchen Magazine: a personalised monthly issue" loading="lazy" width="600" height="849"></a>`;
  const price=m=>(m&&m.price)||'£3.99';
  const cta=(m)=>m&&m.entitled?`<a class="btn" href="/account.html#magazine">${m.viaPlan?'Included in '+esc(m.planName||'your plan'):'Your magazine'}</a>`:`<button class="btn" data-mag-buy>Get the magazine · ${price(m)}/month</button>`;
  const head=(m)=>m&&m.entitled?'':`<a class="btn ghost" href="/pricing.html#plans">Or go Head Chef / Gastronomique — magazine included</a>`;
  function wire(root){root.querySelectorAll('[data-mag-buy]').forEach(b=>b.onclick=()=>buy(b))}
  async function home(el){const m=await load().catch(()=>null);
    el.innerHTML=`<div class="wrap split mag-feature"><div>${cover(420)}</div><div><span class="eyebrow">New · Lux Prime Kitchen Magazine</span><h2>Your kitchen, in print — every month</h2><p class="lede">${blurb}</p>
    <ul class="mag-list"><li>Three new recipes personalised to your history, favourites and diet</li><li>Shopping list grouped by aisle, with gentle “you may be running low” reminders</li><li>Wine pairings by style, grape and region</li><li>Malcolm’s letter and an Escoffier note</li><li>Gastronomique: a personal issue for everyone in your household</li></ul>
    <div class="actions">${cta(m)}<a class="btn ghost" href="/mag/sample.pdf" target="_blank" rel="noopener">See a sample</a></div><p class="muted" style="font-size:.85rem">${price(m)}/month as an add-on for Commis Chef or Chef de Partie — included with Head Chef, and for every member of a Gastronomique household. Cancel anytime. Emails only if you opt in.</p></div></div>`;wire(el)}
  async function pricing(el){const m=await load().catch(()=>null);
    el.innerHTML=`<div class="card plan mag-card"><div class="split"><div>${cover(300)}</div><div><span class="eyebrow">Add-on · included in Head Chef &amp; Gastronomique</span><h3 style="font-size:1.6rem;margin:.4em 0 .1em">Lux Prime Kitchen Magazine</h3><div class="price">${price(m)}<small>/month</small></div><p class="muted">${blurb}</p>
    <ul><li>Personalised cover and 3 Malcolm recipes with AI photos</li><li>Aisle-by-aisle shopping list</li><li>Wine pairings &amp; accompaniments</li><li>Chef’s letter + Escoffier note</li><li>Monthly email (opt-in), unsubscribe in one click</li></ul>
    <div class="actions">${cta(m)}<a class="btn ghost" href="/mag/sample.pdf" target="_blank" rel="noopener">See a sample</a>${head(m)}</div>${m&&!m.available?'<p class="muted" style="font-size:.85rem">Payments not yet configured — coming soon.</p>':''}<p class="muted" style="font-size:.8rem">Commis Chef (free) buyers get the magazine without the other premium features; Chef de Partie members add it to their plan; Head Chef includes it; on Gastronomique every household member gets their own issue.</p></div></div></div>`;wire(el)}
  async function banner(el){const m=await load(true).catch(()=>null);if(!m||m.entitled||sessionStorage.getItem('lp_mag_banner'))return;sessionStorage.setItem('lp_mag_banner','1');
    const d=document.createElement('div');d.className='card mag-banner no-print';d.innerHTML=`<img src="/mag/sample-cover.jpg" alt="" width="90" height="127" loading="lazy"><div><strong style="font-family:var(--serif);font-size:1.25rem">Love these? Get recipes like them every month.</strong><p class="muted" style="margin:.3em 0 .6em">Lux Prime Kitchen Magazine — a personalised PDF issue built from your searches, with a shopping list and wine pairings. ${price(m)}/month, or included with Head Chef and Gastronomique.</p><div class="actions">${cta(m)}<a class="btn ghost" href="/mag/sample.pdf" target="_blank" rel="noopener">See a sample</a><button class="btn ghost" data-x aria-label="Dismiss">Not now</button></div></div>`;
    d.querySelector('[data-x]').onclick=()=>d.remove();el.appendChild(d);wire(d)}
  async function account(el){const m=await load(true);
    const status=m.free?'Included free on your account (admin/tester)':m.viaPlan?`Included in ${m.household?'your household’s ':'your '}${esc(m.planName||'')} plan`:m.entitled?'Active':m.status==='canceled'?'Cancelled':'Not subscribed';
    el.innerHTML=`<h2>📰 Lux Prime Kitchen Magazine</h2><div class="card mag-acct"><div class="split"><div>${cover(240)}</div><div><p><strong>Status:</strong> ${esc(status)}</p>
    ${m.entitled?`<label class="mag-toggle"><input type="checkbox" id="magOpt" ${m.optIn?'checked':''}> Email me my magazine on the 1st of each month (08:00 UK)</label><p class="muted" style="font-size:.85rem">${m.emailReady?'Sent to your account email. Unsubscribe any time — here or from any issue.':'Email delivery is being set up; your issues will also appear here.'}</p>`:`<p class="muted">${blurb}</p>`}
    <div class="actions">${m.entitled?'':cta(m)+head(m)}${m.previewsLeft>0&&(m.entitled||m.free||m.canAdd)?'<button class="btn ghost" id="magPrev">Preview my magazine</button>':''}<a class="btn ghost" href="/mag/sample.pdf" target="_blank" rel="noopener">See a sample</a>${m.latest?`<a class="btn ghost" href="${esc(m.latest.url)}" target="_blank" rel="noopener">Latest issue (${esc(m.latest.month)})</a>`:''}</div>
    <p class="muted" id="magOut" role="status" style="font-size:.85rem"></p>${m.entitled&&!m.free&&!m.viaPlan?`<p class="muted" style="font-size:.8rem">To cancel the ${price(m)} add-on, use Manage billing.</p>`:''}</div></div></div>`;
    const o=el.querySelector('#magOpt');if(o)o.onchange=async()=>{try{await api('/api/magazine/optin',{method:'POST',body:{optIn:o.checked}});toast(o.checked?'You’re in — your next issue arrives on the 1st.':'Magazine emails switched off.')}catch(e){o.checked=!o.checked;toast(e.message)}};
    const p=el.querySelector('#magPrev');if(p)p.onclick=()=>preview(p,el.querySelector('#magOut'));wire(el)}
  const api_={home,pricing,banner,account,buy,preview};
  const f=document.getElementById('magazine-feature');if(f)home(f);const pc=document.getElementById('magazine');if(pc&&pc.dataset.mag==='pricing')pricing(pc.querySelector('.wrap')||pc);
  return api_;
})();
