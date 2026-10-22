'use strict';
(async function(){
  const {api,esc,toast}=LP;const q=new URLSearchParams(location.search);
  if(q.get('checkout')==='cancelled')document.getElementById('checkout-msg').innerHTML='<p class="note">Checkout cancelled — no payment taken.</p>';
  const [{plans},{user}]=await Promise.all([api('/api/plans'),api('/api/me')]);
  const imgs={free:'breakfast',monthly:'pasta',head:'comfort'};
  document.getElementById('plans').innerHTML=plans.map(p=>`<div class="card plan lift ${p.id==='monthly'?'hot':''}"><div class="photo"><img src="/img/${imgs[p.id]}-sm.webp" alt="" loading="lazy" width="640" height="480"></div><h3>${esc(p.name)}</h3><div class="price">${esc(p.price)}${p.id!=='free'?'<small>/month</small>':''}</div><ul>${p.features.map(f=>`<li>${esc(f)}</li>`).join('')}</ul>
  ${p.id==='free'?`<a class="btn ghost" href="/app.html">Start free</a>`:`<button class="btn" data-plan="${esc(p.id)}" ${p.available?'':'aria-describedby="nc"'}>Choose ${esc(p.name)}</button>${p.available?'':'<p id="nc" class="muted" style="font-size:.85rem">Payments not yet configured.</p>'}`}</div>`).join('');
  document.querySelectorAll('[data-plan]').forEach(b=>b.onclick=async()=>{if(!user){location.href='/account.html?next=/pricing.html';return}
    b.disabled=true;try{const {url}=await api('/api/billing/checkout',{method:'POST',body:{plan:b.dataset.plan}});location.href=url}catch(e){toast(e.message);b.disabled=false}});
})();
