'use strict';
(function(){
  const LOGO='<svg width="34" height="34" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6dd9a"/><stop offset="1" stop-color="#c89a3c"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="none" stroke="url(#g)" stroke-width="3"/><path d="M20 30c-5 0-7-6-3-9 1-6 9-8 12-4 3-5 11-4 12 2 5-1 8 5 4 9v14H20z" fill="url(#g)"/><rect x="20" y="44" width="25" height="5" rx="2" fill="url(#g)"/><path d="M32 8l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#9b7bff"/></svg>';
  const theme=localStorage.getItem('lp_theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
  document.documentElement.dataset.theme=theme;
  const page=location.pathname.replace(/\.html$/,'').replace(/\/$/,'/index');
  const links=[['/','Home','/index'],['/app.html','AI Chef','/app'],['/escoffier.html','Escoffier','/escoffier'],['/about-escoffier.html','About Escoffier','/about-escoffier'],['/pricing.html','Pricing','/pricing'],['/account.html','Account','/account']];
  document.addEventListener('DOMContentLoaded',()=>{
    const h=document.getElementById('site-header');
    if(h)h.innerHTML=`<a class="skip" href="#main">Skip to content</a><header class="nav"><div class="wrap"><a class="brand" href="/">${LOGO}<span>Lux Prime Kitchen<small>AI Chef · Malcolm AI</small></span></a><nav aria-label="Main">${links.map(([u,t,k])=>`<a href="${u}" ${page===k?'aria-current="page"':''}>${t}</a>`).join('')}<button class="icon-btn" id="theme" aria-label="Toggle dark/light theme">${theme==='dark'?'☀':'☾'}</button></nav></div></header>`;
    const mn=document.createElement('nav');mn.className='mnav';mn.setAttribute('aria-label','Mobile');const ic={'/index':'⌂','/app':'✨','/escoffier':'📖','/about-escoffier':'👨‍🍳','/pricing':'£','/account':'☺'};mn.innerHTML=links.map(([u,t,k])=>`<a href="${u}" ${page===k?'aria-current="page"':''}><span aria-hidden="true">${ic[k]}</span>${t}</a>`).join('');document.body.appendChild(mn);
    const f=document.getElementById('site-footer');
    if(f)f.innerHTML=`<footer><div class="wrap row" style="flex-wrap:wrap;align-items:flex-start"><div><strong>Lux Prime Kitchen</strong><br>© ${new Date().getFullYear()} Oliver Thorley. AI Chef powered by Malcolm AI.<br><small>Recipes are guidance. Always check allergen labels; nutrition is estimated.</small></div><div style="text-align:right"><a href="/terms.html">Terms</a> · <a href="/privacy.html">Privacy & cookies</a> · <a href="/pricing.html">Pricing</a></div></div></footer>`;
    const tb=document.getElementById('theme');
    if(tb)tb.onclick=()=>{const t=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=t;localStorage.setItem('lp_theme',t);tb.textContent=t==='dark'?'☀':'☾'};
    if(!localStorage.getItem('lp_cookie_ok')){const c=document.createElement('div');c.className='card cookie';c.setAttribute('role','dialog');c.setAttribute('aria-label','Cookie notice');
      c.innerHTML='<strong>Cookies 🍪</strong><p class="muted" style="margin:.4em 0 .8em">We only use essential cookies: one to keep you signed in and one to protect forms (CSRF). No advertising or tracking cookies. <a href="/privacy.html#cookies">Learn more</a>.</p><button class="btn sm">OK, got it</button>';
      c.querySelector('button').onclick=()=>{localStorage.setItem('lp_cookie_ok','1');c.remove()};document.body.appendChild(c);}
  });
  function csrf(){const m=document.cookie.match(/(?:^|; )lp_csrf=([^;]+)/);return m?decodeURIComponent(m[1]):''}
  async function api(url,opts={}){
    if(!csrf())await fetch('/api/csrf');
    const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json','x-csrf-token':csrf(),...(opts.headers||{})},body:opts.body&&typeof opts.body!=='string'?JSON.stringify(opts.body):opts.body,credentials:'same-origin'});
    let d={};try{d=await r.json()}catch{}
    if(!r.ok){const e=new Error(d.error||'Request failed');e.status=r.status;e.data=d;throw e}return d;
  }
  function toast(msg){const t=document.createElement('div');t.className='toast';t.setAttribute('role','status');t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2800)}
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Friendly loading state while the AI chef cooks (aria-live, elapsed timer, rotating tips, disabled button).
  const TIPS=['Salt pasta water generously: it should taste like the sea.','Rest meat for 5–10 minutes so the juices settle.','Pat chicken dry before frying for a golden crust.','A squeeze of lemon at the end wakes up almost any dish.','Toast spices in a dry pan for 30 seconds to release their aroma.','Cool leftover rice within an hour and refrigerate it.','Keep a separate board for raw meat and for veg.','Taste as you go, but never raw batter or dough.','Onions take longer to soften than recipes admit: give them 10 minutes.','A pinch of sugar balances a sharp tomato sauce.'];
  function cooking(box,btn,{ai=true}={}){
    const label=ai?'Malcolm AI is cooking up your recipes — usually 20–40 seconds':'Finding your recipes…';
    box.innerHTML=`<div class="card empty cooking" role="status" aria-live="polite" aria-busy="true"><div class="pan" aria-hidden="true"><span class="steam s1"></span><span class="steam s2"></span><span class="steam s3"></span><span class="pan-body">🍳</span></div><h2>${esc(label)}</h2><p class="muted"><span class="elapsed">0</span>s elapsed</p><p class="tip" aria-live="off"><strong>Chef's tip:</strong> <span class="tip-text"></span></p><div class="bar" aria-hidden="true"><span></span></div></div>`;
    const t0=Date.now(),el=box.querySelector('.elapsed'),tip=box.querySelector('.tip-text');let i=Math.floor(Math.random()*TIPS.length);tip.textContent=TIPS[i];
    const iv=setInterval(()=>{const s=Math.floor((Date.now()-t0)/1000);el.textContent=s;if(s>0&&s%6===0){i=(i+1)%TIPS.length;tip.textContent=TIPS[i]}},1000);
    if(btn){btn.disabled=true;btn.setAttribute('aria-disabled','true');btn.dataset.label=btn.dataset.label||btn.textContent;btn.textContent='Cooking…'}
    let done=false;return ()=>{if(done)return;done=true;clearInterval(iv);if(btn){btn.disabled=false;btn.removeAttribute('aria-disabled');btn.textContent=btn.dataset.label}};
  }
  window.LP={api,toast,esc,csrf,cooking};
})();
