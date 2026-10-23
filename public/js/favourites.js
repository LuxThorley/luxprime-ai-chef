'use strict';
(async function(){const {api,esc}=LP;const box=document.getElementById('favs'),cnt=document.getElementById('fcount');
  const empty=(h,p,a)=>{box.innerHTML=`<div class="card empty" style="grid-column:1/-1"><div class="big">♥</div><h2>${h}</h2><p class="muted">${p}</p><div class="next">${a}</div></div>`;cnt.textContent=''};
  let favs=[],stats={};
  try{const d=await api('/api/favourites');favs=d.favourites;stats=d.stats||{}}
  catch(e){if(e.status===401)return empty('Sign in to see your favourites','Your hearted recipes are saved to your account and sync across devices.','<a class="btn" href="/account.html">Sign in</a><a class="btn ghost" href="/account.html?mode=register">Create free account</a>');
    if(e.status===402)return empty('Favourites are a Chef de Partie feature','Upgrade to heart recipes, keep your history and get better suggestions from Malcolm.','<a class="btn" href="/pricing.html">See plans</a>');return empty('Could not load favourites',esc(e.message),'<a class="btn" href="/favourites.html">Try again</a>')}
  if(!favs.length)return empty('No favourites yet','Tap the ♥ on any recipe and it will appear here.','<a class="btn" href="/app.html">Ask Malcolm</a><a class="btn ghost" href="/#kings">See top-rated</a>');
  const cuis=[...new Set(favs.map(r=>r.cuisine).filter(Boolean))].sort();document.getElementById('fc').innerHTML+=cuis.map(c=>`<option>${esc(c)}</option>`).join('');
  const D={easy:1,medium:2,hard:3};const q=document.getElementById('fq'),s=document.getElementById('fs'),fc=document.getElementById('fc');
  const P=new URLSearchParams(location.search);if(P.get('sort'))s.value=P.get('sort');
  const st=r=>stats[r.id]||{};
  function draw(){const t=q.value.trim().toLowerCase();let L=favs.filter(r=>(!fc.value||r.cuisine===fc.value)&&(!t||[r.title,r.cuisine,...(r.ingredients||[]).map(i=>i.name)].join(' ').toLowerCase().includes(t)));
    const k=s.value;L.sort((a,b)=>k==='rating'?((st(b).avg||0)-(st(a).avg||0)||(st(b).count||0)-(st(a).count||0)):k==='mine'?((st(b).mine||0)-(st(a).mine||0)):k==='name'?a.title.localeCompare(b.title):k==='cuisine'?String(a.cuisine).localeCompare(String(b.cuisine))||a.title.localeCompare(b.title):k==='time'?(a.totalMinutes||999)-(b.totalMinutes||999):k==='difficulty'?(D[a.difficulty]||9)-(D[b.difficulty]||9):String(b.addedAt).localeCompare(String(a.addedAt)));
    cnt.textContent=`${L.length} of ${favs.length} favourite${favs.length===1?'':'s'}`;
    box.innerHTML=L.length?'':'<p class="muted" style="grid-column:1/-1">No favourites match. Try a different search or cuisine.</p>';
    L.forEach(r=>{const x=st(r);const href=r.id.startsWith('esc-')?`/escoffier.html?no=${encodeURIComponent(r.id.slice(4))}`:`/recipe.html?id=${encodeURIComponent(r.id)}`;const im=r.image||{};
      const el=document.createElement('article');el.className='card fav lift';
      el.innerHTML=`<a class="im" href="${href}"><img src="${esc(im.src||'/img/ingredients-sm.webp')}" alt="${esc(im.alt||r.title)}" loading="lazy" data-fallback="${esc(im.fallback||'')}"></a><div class="tx"><h3><a href="${href}" style="color:inherit;text-decoration:none">${esc(r.title)}</a></h3>
      <div class="meta">${r.cuisine?`<span class="pill">${esc(r.cuisine)}</span>`:''}${r.totalMinutes?`<span class="pill">⏱ ${+r.totalMinutes} min</span>`:''}${r.difficulty?`<span class="pill">${esc(r.difficulty)}</span>`:''}</div>
      <p style="margin:4px 0 0">${x.count?`<span class="stars-ro" aria-hidden="true">${'★'.repeat(Math.round(x.avg))}${'☆'.repeat(5-Math.round(x.avg))}</span> <strong>${x.avg.toFixed(3)}</strong> <span class="muted">(${x.count})</span>`:'<span class="muted">Not rated yet</span>'}${x.mine?` · <span class="muted">yours ${x.mine}★</span>`:''}</p>
      <p class="muted" style="margin:0;font-size:.82rem">Added ${esc(String(r.addedAt||'').slice(0,10))}</p>
      <div class="row2"><a class="btn sm" href="${href}">Open recipe</a><button type="button" class="btn ghost sm rm" aria-label="Remove ${esc(r.title)} from favourites">Remove</button></div></div>`;
      const img=el.querySelector('img');img.onerror=()=>{if(img.dataset.fallback&&img.src.indexOf(img.dataset.fallback)<0)img.src=img.dataset.fallback};
      el.querySelector('.rm').onclick=async()=>{try{await api('/api/favourites/'+encodeURIComponent(r.id),{method:'DELETE'});favs=favs.filter(f=>f.id!==r.id);LP.toast('Removed from favourites');favs.length?draw():location.reload()}catch(e){LP.toast(e.message)}};box.appendChild(el)})}
  [q,s,fc].forEach(e=>e.addEventListener('input',draw));draw();
})();
