'use strict';
(async function(){
  const {api,esc,toast}=LP;const q=new URLSearchParams(location.search);
  if(q.get('checkout')==='cancelled')document.getElementById('checkout-msg').innerHTML='<p class="note">Checkout cancelled — no payment taken.</p>';
  const [{plans,magazine},{user}]=await Promise.all([api('/api/plans'),api('/api/me')]);
  const imgs={free:'breakfast',monthly:'pasta',head:'comfort',gastronomique:'seafood',restaurant:'ingredients'};
  const maxSave=Math.max(...plans.filter(p=>p.savePct).map(p=>p.savePct));
  let interval=q.get('billing')==='annual'?'year':'month';
  const box=document.getElementById('plans');
  const tog=document.createElement('div');tog.className='bill-toggle';tog.setAttribute('role','radiogroup');tog.setAttribute('aria-label','Billing period');
  box.before(tog);
  function render(){window.LPInterval=interval;
    tog.innerHTML=`<button role="radio" aria-checked="${interval==='month'}" data-i="month">Monthly</button><button role="radio" aria-checked="${interval==='year'}" data-i="year">Annual <span class="save">save up to ${maxSave}%</span></button>`;
    tog.querySelectorAll('[data-i]').forEach(b=>b.onclick=()=>{interval=b.dataset.i;render();document.dispatchEvent(new CustomEvent('lp:interval',{detail:interval}))});
    const yr=interval==='year';
    box.innerHTML=plans.map(p=>{const ok=yr?p.availableAnnual:p.available;return `<div class="card plan lift ${p.popular?'hot':''} ${p.pro?'pro':''}" id="${p.id==='restaurant'?'restaurant':'plan-'+esc(p.id)}"><div class="photo"><img src="/img/${imgs[p.id]}-sm.webp" alt="" loading="lazy" width="640" height="480"></div>${p.pro?'<span class="pro-tag">For restaurants</span>':''}<h3>${esc(p.name)}</h3>
    <div class="price">${p.id==='free'?'£0':esc(yr?p.annualPrice:p.price)}${p.id!=='free'?`<small>/${yr?'year':'month'}</small>`:''}</div>
    ${p.id==='free'?'<p class="muted plan-sub">Free for ever</p>':yr?`<p class="plan-sub"><span class="save">Save ${p.savePct}%</span> <span class="muted">vs ${esc(p.price)}/month</span></p>`:`<p class="muted plan-sub">or ${esc(p.annualPrice)}/year — save ${p.savePct}%</p>`}
    <ul>${p.features.map(f=>`<li>${esc(f)}</li>`).join('')}</ul>${p.pro?'<p><a href="/restauranteur.html">See the Menu Builder →</a></p>':''}
    ${p.id==='free'?`<a class="btn ghost" href="/app.html">Start free</a>`:`<button class="btn" data-plan="${esc(p.id)}">Choose ${esc(p.name)}</button>${ok?'':'<p class="muted" style="font-size:.85rem">Payments not yet configured.</p>'}`}</div>`}).join('');
    box.querySelectorAll('[data-plan]').forEach(b=>b.onclick=async()=>{if(!user){location.href='/account.html?next=/pricing.html';return}
      b.disabled=true;try{const {url}=await api('/api/billing/checkout',{method:'POST',body:{plan:b.dataset.plan,interval}});location.href=url}catch(e){toast(e.message);b.disabled=false}})}
  render();if(location.hash==='#restaurant'){const r=document.getElementById('restaurant');if(r)r.scrollIntoView({block:'center'})}
})();
