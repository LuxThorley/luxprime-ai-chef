'use strict';
(async function(){
  const {api,esc,toast}=LP;const box=document.getElementById('acct');const q=new URLSearchParams(location.search);
  const next=/^\/[a-z./]*$/i.test(q.get('next')||'')?q.get('next'):null;
  let {user}=await api('/api/me');
  function authView(){box.innerHTML=`<div class="card auth"><div class="tabs" role="tablist"><button class="btn" data-m="login" role="tab" aria-selected="true">Sign in</button><button class="btn ghost" data-m="register" role="tab" aria-selected="false">Create account</button></div>
  <form id="af" novalidate><div id="nm" hidden><label for="name">First name (optional)</label><input id="name" type="text" autocomplete="given-name" maxlength="80"></div>
  <label for="email">Email</label><input id="email" type="email" required autocomplete="email"><label for="pw">Password <span class="muted">(8+ characters)</span></label><input id="pw" type="password" required minlength="8" autocomplete="current-password">
  <p class="err" id="ae" role="alert"></p><button class="btn" style="width:100%;justify-content:center" id="as">Sign in</button></form><p class="muted" style="font-size:.85rem">By continuing you agree to our <a href="/terms.html">Terms</a> and <a href="/privacy.html">Privacy policy</a>.</p></div>`;
    let mode='login';box.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{mode=b.dataset.m;box.querySelectorAll('[data-m]').forEach(x=>{x.className='btn'+(x===b?'':' ghost');x.setAttribute('aria-selected',x===b)});document.getElementById('nm').hidden=mode!=='register';document.getElementById('as').textContent=mode==='register'?'Create free account':'Sign in';document.getElementById('pw').autocomplete=mode==='register'?'new-password':'current-password'});
    document.getElementById('af').onsubmit=async e=>{e.preventDefault();const ae=document.getElementById('ae');ae.textContent='';
      try{const d=await api('/api/auth/'+mode,{method:'POST',body:{email:document.getElementById('email').value,password:document.getElementById('pw').value,name:document.getElementById('name').value||undefined}});user=d.user;if(q.get('invite'))location.reload();else if(next)location.href=next;else view()}catch(err){ae.textContent=err.message}}}
  async function view(){if(!user)return authView();
    box.innerHTML=`<section><span class="eyebrow">Your kitchen</span><h2>Hello${user.name?', '+esc(user.name):''} 👋</h2>
    ${q.get('checkout')==='success'?'<p class="note">Thank you! Your subscription is being activated — it can take a few seconds.</p>':''}
    <div class="grid g3"><div class="card"><h3>Plan</h3><p class="price" style="font-size:1.8rem">${user.admin?'Admin · Unlimited':user.tester?'Tester · Full access':esc(user.planName||'Commis Chef')}</p><p class="muted">${user.premium?'Unlimited searches':`${user.searchesLeft} free searches left`}</p>
    ${user.admin?'<p class="muted">Owner account — all features, no billing.</p>':user.tester?'<p class="muted">Shared friends &amp; family test account. Favourites and history are shared by everyone who uses it.</p>':user.premium?'<button class="btn" id="portal">Manage billing</button>':'<a class="btn" href="/pricing.html">Upgrade</a>'}</div>
    <div class="card"><h3>Account</h3><p class="muted">${esc(user.email)}</p><div class="actions"><button class="btn ghost" id="lo">Sign out</button>${user.tester?'':'<button class="btn ghost" id="del">Delete account</button>'}</div></div>
    <div class="card"><h3>Change password</h3><form id="pwf" novalidate><label for="cpw">Current password</label><input id="cpw" type="password" required autocomplete="current-password"><label for="npw">New password <span class="muted">(8+ characters)</span></label><input id="npw" type="password" required minlength="8" autocomplete="new-password"><p class="err" id="pwe" role="alert"></p><button class="btn ghost">Update password</button></form><p class="muted" style="font-size:.8rem">Other devices are signed out after a change.</p></div></div></section>
    <section id="household" hidden></section>
    <section id="magazine"><p class="muted">Loading magazine…</p></section>
    <section><h2>♥ Favourites</h2><div id="favs"><p class="muted">${user.premium?'Loading…':'Favourites are a premium feature.'}</p></div></section>
    <section><h2>History</h2><div id="hist"><p class="muted">${user.premium?'Loading…':'Search history is a premium feature.'}</p></div></section>`;
    document.getElementById('lo').onclick=async()=>{await api('/api/auth/logout',{method:'POST'});location.href='/'};
    document.getElementById('pwf').onsubmit=async e=>{e.preventDefault();const pe=document.getElementById('pwe');pe.textContent='';try{await api('/api/auth/password',{method:'POST',body:{currentPassword:document.getElementById('cpw').value,newPassword:document.getElementById('npw').value}});e.target.reset();toast('Password updated')}catch(err){pe.textContent=err.message}};
    const dl=document.getElementById('del');if(dl)dl.onclick=async()=>{if(confirm('Permanently delete your account, favourites and history? Cancel any subscription in Manage billing first.')){await api('/api/me',{method:'DELETE'});location.href='/'}};
    const p=document.getElementById('portal');if(p)p.onclick=async()=>{try{location.href=(await api('/api/billing/portal',{method:'POST'})).url}catch(e){toast(e.message)}};
    household();
    if(window.LPMag)LPMag.account(document.getElementById('magazine')).then(()=>{if(location.hash==='#magazine')document.getElementById('magazine').scrollIntoView()}).catch(()=>{});
    if(q.get('checkout')==='magazine')toast('Thank you! Your magazine add-on is being activated.');
    if(user.premium){const [{favourites},{history}]=await Promise.all([api('/api/favourites'),api('/api/history')]);
      const fb=document.getElementById('favs');fb.innerHTML=favourites.length?'':'<p class="muted">No favourites yet — tap ♥ Save on a recipe.</p>';favourites.forEach(r=>fb.appendChild(RecipeView.card(r,{premium:true})));
      document.getElementById('hist').innerHTML=history.length?`<div class="card"><ul style="padding-left:18px">${history.map(h=>`<li><strong>${esc([...(h.query.include||[]),h.query.dish].filter(Boolean).join(', '))}</strong> <span class="muted">· ${esc(h.created_at)} UTC</span><br><small class="muted">${esc(h.titles)}</small></li>`).join('')}</ul></div>`:'<p class="muted">No searches yet.</p>'}}
  async function household(){const el=document.getElementById('household');const h=user.household;if(!h)return;el.hidden=false;
    if(h.role==='member'){el.innerHTML=`<h2>🍽️ Your household</h2><div class="card"><p>You’re a member of <strong>${esc(h.owner)}</strong>’s Gastronomique household — unlimited recipes and your own personalised magazine.</p><button class="btn ghost" id="hhLeave">Leave household</button></div>`;
      document.getElementById('hhLeave').onclick=async()=>{if(confirm('Leave this household? You’ll lose the Gastronomique benefits.')){await api('/api/members/me',{method:'DELETE'});location.reload()}};return}
    const d=await api('/api/members');const left=d.seats-d.used;
    el.innerHTML=`<h2>🍽️ Your Gastronomique household</h2><div class="card"><p class="muted">${d.used} of ${d.seats} seats used (including you). Members get unlimited recipes and their own personalised magazine, sent to their own address if they opt in.</p>
    <ul class="hh-list">${d.members.map(m=>`<li><span><strong>${esc(m.name||m.email)}</strong> <small class="muted">${esc(m.email)} · ${m.status==='active'?'joined':'invite pending'}</small></span><button class="btn ghost" data-rm="${m.id}">Remove</button></li>`).join('')||'<li class="muted">No members yet.</li>'}</ul>
    ${left>0?`<form id="hhInv" class="row" style="gap:8px;flex-wrap:wrap"><label class="sr-only" for="hhEmail">Email</label><input id="hhEmail" type="email" required placeholder="name@example.com" style="flex:1;min-width:220px"><button class="btn">Invite</button></form>`:'<p class="muted">All seats are in use.</p>'}<p class="muted" id="hhOut" role="status" style="font-size:.85rem"></p></div>`;
    el.querySelectorAll('[data-rm]').forEach(b=>b.onclick=async()=>{if(confirm('Remove this member? They lose access straight away.')){await api('/api/members/'+b.dataset.rm,{method:'DELETE'});household()}});
    const f=document.getElementById('hhInv');if(f)f.onsubmit=async e=>{e.preventDefault();const o=document.getElementById('hhOut');try{const r=await api('/api/members/invite',{method:'POST',body:{email:document.getElementById('hhEmail').value}});await household();document.getElementById('hhOut').innerHTML=r.emailed?'Invite sent by email.':`Share this invite link with them: <input readonly value="${esc(r.link)}" style="width:100%" onclick="this.select()">`}catch(err){o.textContent=err.message}}}
  const inv=q.get('invite');
  if(inv&&/^[0-9a-f]{48}$/.test(inv)){if(!user){authView();const n=document.createElement('p');n.className='note';n.textContent='Sign in or create an account with the invited email address to join the household.';box.prepend(n)}
    else{try{const r=await api('/api/members/accept',{method:'POST',body:{token:inv}});if(r.user)user=r.user;toast('Welcome to the household!');history.replaceState(null,'','/account.html')}catch(e){toast(e.message)}view()}}
  else view();
})();
