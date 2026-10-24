'use strict';
(async function(){
  const {api,esc,toast,cooking}=LP;const box=document.getElementById('mb');const qs=new URLSearchParams(location.search);
  if(qs.get('checkout')==='success')document.getElementById('checkout-msg').innerHTML='<p class="note">Welcome to Restauranteur — your Menu Builder is ready.</p>';
  let me=null,R=null,opts={cuisines:[]};
  try{[me,opts]=await Promise.all([api('/api/me').then(d=>d.user),api('/api/options')])}catch{}
  if(!me){box.innerHTML=`<div class="card"><h3>Sign in to use the Menu Builder</h3><p class="muted">The Menu Builder is part of the Restauranteur plan.</p><p class="actions"><a class="btn" href="/account.html?next=/menu-builder.html">Sign in</a> <a class="btn ghost" href="/restauranteur.html">About Restauranteur</a></p></div>`;return}
  R=await api('/api/restaurant');
  if(!R.entitled){box.innerHTML=`<div class="card plan hot"><span class="eyebrow">Restauranteur plan</span><h3>Unlock the Menu Builder</h3><div class="price">${esc(R.price)}<small>/month</small></div><p class="muted plan-sub">or ${esc(R.annualPrice)}/year</p><ul><li>Everything in Head Chef</li><li>Restaurant website review and cuisine ideas</li><li>Menu Builder with website and file import</li><li>Smart search across your recipe history</li><li>Save, share and export PDF menus</li></ul><p class="actions"><a class="btn" href="/pricing.html#restaurant">Choose Restauranteur</a> <a class="btn ghost" href="/restauranteur.html">See all features</a></p><p class="muted" style="font-size:.85rem">You’re on ${esc(me.planName)}.</p></div>`;return}
  const P=R.profile||{};let source='',pinned=[],current=null;
  const sel=(id,o,v)=>`<select id="${id}">${Object.entries(o).map(([k,l])=>`<option value="${esc(k)}" ${k===v?'selected':''}>${esc(l)}</option>`).join('')}</select>`;
  const cuisines=opts.cuisines.filter(c=>c!=='any');
  box.innerHTML=`
  <div class="grid g2" style="align-items:start">
  <div class="card"><h3>1 · Your restaurant</h3>
    <label for="rName">Restaurant name</label><input type="text" id="rName" maxlength="80" value="${esc(P.name||'')}" placeholder="e.g. The Lantern, Bath">
    <label for="rUrl">Website address</label><input type="text" id="rUrl" maxlength="400" inputmode="url" value="${esc(P.url||'')}" placeholder="https://yourrestaurant.co.uk">
    <label for="rDesc">Restaurant description</label><textarea id="rDesc" rows="4" maxlength="1500" placeholder="Concept, setting, covers, price point, signature dishes, sourcing…">${esc(P.description||'')}</textarea>
    <p class="actions"><button class="btn ghost" id="rSave">Save</button> <button class="btn" id="rAnalyse">Analyse my website</button></p><div id="rAnalysis"></div></div>
  <div class="card"><h3>2 · Menu to build on <small class="muted">(optional)</small></h3>
    <div class="seg" role="radiogroup" aria-label="Menu source"><label><input type="radio" name="src" value="" checked><span>Start fresh</span></label><label><input type="radio" name="src" value="web"><span>Website menu</span></label><label><input type="radio" name="src" value="file"><span>Upload / paste</span></label></div>
    <div id="srcFile" hidden><label for="mFile">Upload an example menu (PDF, .txt, .md, .csv, .html, or a photo · max 4 MB)</label><input type="file" id="mFile" accept=".pdf,.txt,.md,.csv,.html,.htm,image/jpeg,image/png,image/webp"></div>
    <label for="mSrc">Menu text <small class="muted">(edit freely)</small></label><textarea id="mSrc" rows="9" maxlength="12000" placeholder="Paste a menu here, or import one above"></textarea><p class="muted" id="srcInfo" style="font-size:.85rem"></p></div>
  </div>
  <div class="card" style="margin-top:20px"><h3>3 · Menu Builder</h3>
    <div class="grid g3">
      <div><label for="mName">Menu name</label><input type="text" id="mName" maxlength="80" placeholder="e.g. Autumn Tasting Menu"></div>
      <div><label for="mType">Menu type</label>${sel('mType',R.menuTypes,'a-la-carte')}</div>
      <div><label for="mStyle">Style</label><input type="text" id="mStyle" maxlength="120" placeholder="e.g. modern, refined, seasonal, sharing"></div>
      <div><label for="mCourses">Number of courses</label><input type="number" id="mCourses" min="1" max="12" value="3"></div>
      <div><label for="mPer">Dishes per course</label><input type="number" id="mPer" min="1" max="8" value="3"></div>
      <div><label for="mCNames">Course names <small class="muted">(optional, comma-separated)</small></label><input type="text" id="mCNames" maxlength="400" placeholder="Snacks, Starters, Mains, Desserts"></div>
    </div>
    <fieldset><legend>Cuisine (up to 6)</legend><div class="checks" id="mCz">${cuisines.map(c=>`<label><input type="checkbox" value="${esc(c)}"><span>${esc(c)}${c==='Medicinal'?' 🌿':''}</span></label>`).join('')}</div></fieldset>
    <h4 style="margin:22px 0 0">Intelligent refinements</h4>
    <div class="grid g3">
      <div><label for="fAppeal">Appeal</label>${sel('fAppeal',{broad:'Broad crowd-pleaser',adventurous:'Adventurous',classic:'Classic',family:'Family-friendly'},'broad')}</div>
      <div><label for="fVariety">Variety</label>${sel('fVariety',{balanced:'Balanced',high:'Maximum variety',focused:'Focused / signature'},'balanced')}</div>
      <div><label for="fTaste">Taste balance</label>${sel('fTaste',{balanced:'Balanced',rich:'Rich',fresh:'Fresh & bright',spicy:'Spiced',umami:'Umami-led'},'balanced')}</div>
      <div><label for="fSeason">Season</label>${sel('fSeason',{now:'In season now',spring:'Spring',summer:'Summer',autumn:'Autumn',winter:'Winter',any:'Any'},'now')}</div>
      <div><label for="fCost">Food-cost target</label>${sel('fCost',{any:'Any',budget:'Budget / strong GP',mid:'Mid',premium:'Premium'},'any')}</div>
      <div><label>Extras</label><div class="checks"><label><input type="checkbox" id="fPrices" checked><span>Suggest prices</span></label><label><input type="checkbox" id="fPair"><span>Wine pairings</span></label></div></div>
    </div>
    <fieldset><legend>Dietary cover in every course</legend><div class="checks" id="fDiets">${R.diets.map(d=>`<label><input type="checkbox" value="${esc(d)}"><span>${esc(d)}</span></label>`).join('')}</div></fieldset>
    <label for="fPersonal">Personal brief</label><input type="text" id="fPersonal" maxlength="400" placeholder="e.g. showcase our kitchen garden; no beef; a nod to our Cornish roots">
    <h4 style="margin:22px 0 4px">Dishes from your account history</h4><p class="muted" style="margin:0 0 8px;font-size:.9rem">Search your favourites and past recipes (plus Malcolm’s library), then add dishes for Malcolm to refine into the menu.</p>
    <div class="grid g3"><div><input type="search" id="hQ" placeholder="Search e.g. lamb, risotto, tart" aria-label="Search your recipes"></div>
      <div class="row">${sel('hTaste',{'':'Any taste',rich:'Rich',fresh:'Fresh',spicy:'Spicy',sweet:'Sweet',umami:'Umami'},'')}${sel('hSeason',{'':'Any season',now:'In season now',spring:'Spring',summer:'Summer',autumn:'Autumn',winter:'Winter'},'')}</div>
      <div class="row">${sel('hCost',{'':'Any cost',budget:'Strong GP',premium:'Premium'},'')}${sel('hSort',{appeal:'Best appeal',variety:'Most variety',recent:'Most recent'},'appeal')}</div></div>
    <div class="row" style="margin-top:8px">${sel('hDiet',Object.fromEntries([['','Any diet'],...R.diets.map(d=>[d,d])]),'')}<input type="text" id="hCz" maxlength="40" placeholder="Cuisine filter"><button class="btn ghost" id="hGo">Search</button></div>
    <div id="hRes" class="chips" style="margin-top:10px"></div><div id="pinned" class="chips" style="margin-top:10px"></div>
    <p class="actions" style="margin-top:22px"><button class="btn lg" id="build">Compose menu with Malcolm</button></p>
  </div>
  <div id="out" style="margin-top:20px"></div>
  <div class="card" style="margin-top:20px"><h3>Saved menus</h3><div id="saved"></div></div>`;
  const $=s=>box.querySelector(s);
  const renderAnalysis=a=>{if(!a){$('#rAnalysis').innerHTML='';return}
    $('#rAnalysis').innerHTML=`<div class="note" style="margin-top:12px"><strong>Malcolm’s review</strong> <small class="muted">${a.source==='malcolm'?'AI analysis':'quick analysis'} · ${esc((a.at||'').slice(0,10))}</small><p>${esc(a.summary)}</p>
    <p class="muted" style="font-size:.9rem"><strong>Cuisine:</strong> ${esc((a.cuisines||[]).join(', ')||'—')} · <strong>Style:</strong> ${esc((a.style||[]).join(', '))} · <strong>Price:</strong> ${esc(a.priceBand)}${a.dishCount?` · <strong>Menu:</strong> ${a.dishCount} dishes`:''}</p>
    ${a.strengths&&a.strengths.length?`<strong>Strengths</strong><ul>${a.strengths.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${a.gaps&&a.gaps.length?`<strong>Opportunities</strong><ul>${a.gaps.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}
    ${a.ideas&&a.ideas.length?`<strong>Further cuisine ideas</strong><ul>${a.ideas.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}</div>`};
  renderAnalysis(P.analysis);
  const profile=()=>({name:$('#rName').value,url:$('#rUrl').value,description:$('#rDesc').value});
  $('#rSave').onclick=async()=>{try{const r=await api('/api/restaurant/profile',{method:'PUT',body:profile()});Object.assign(P,r.profile);$('#rUrl').value=P.url||'';toast('Saved')}catch(e){toast(e.message)}};
  $('#rAnalyse').onclick=async e=>{const b=e.target;b.disabled=true;b.textContent='Reading your website…';
    try{await api('/api/restaurant/profile',{method:'PUT',body:profile()});const r=await api('/api/restaurant/analyse',{method:'POST',body:{}});Object.assign(P,r.profile);if(!$('#rName').value)$('#rName').value=P.name||'';renderAnalysis(P.analysis);
      if(P.websiteMenu){toast(`Found ${r.parsed.dishCount} dishes on your website`)}else toast('Analysis ready')}catch(err){toast(err.message)}finally{b.disabled=false;b.textContent='Analyse my website'}};
  box.querySelectorAll('[name=src]').forEach(r=>r.onchange=()=>{source=r.value;$('#srcFile').hidden=source!=='file';
    if(source==='web'){if(P.websiteMenu){$('#mSrc').value=P.websiteMenu;$('#srcInfo').textContent='Imported from your website analysis.'}else{$('#srcInfo').textContent='Run “Analyse my website” first to import its menu.'}}
    if(source==='')$('#srcInfo').textContent=''});
  $('#mFile').onchange=async e=>{const f=e.target.files[0];if(!f)return;if(f.size>4e6){toast('Max 4 MB');return}$('#srcInfo').textContent='Reading '+f.name+'…';
    try{let body;if(/pdf$/i.test(f.type)||/\.pdf$/i.test(f.name)||/^image\//.test(f.type)){const buf=new Uint8Array(await f.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=32768)s+=String.fromCharCode.apply(null,buf.subarray(i,i+32768));body={kind:/^image\//.test(f.type)?'image':'pdf',name:f.name,data:btoa(s)}}
      else{let t=await f.text();if(/html?$/i.test(f.name))t=new DOMParser().parseFromString(t,'text/html').body.innerText;body={kind:'text',name:f.name,text:t}}
      const r=await api('/api/restaurant/parse-menu',{method:'POST',body});$('#mSrc').value=r.text;$('#srcInfo').textContent=r.warning||`Found ${r.parsed.dishCount} dishes in ${r.parsed.sections.length} sections.`}catch(err){$('#srcInfo').textContent=err.message}};
  const renderPinned=()=>{$('#pinned').innerHTML=pinned.length?'<strong style="width:100%">Included:</strong>'+pinned.map((t,i)=>`<span class="chip">${esc(t)} <button type="button" class="icon-btn" data-un="${i}" aria-label="Remove ${esc(t)}" style="min-width:24px;min-height:24px">×</button></span>`).join(''):'';
    $('#pinned').querySelectorAll('[data-un]').forEach(b=>b.onclick=()=>{pinned.splice(+b.dataset.un,1);renderPinned()})};
  const search=async()=>{const p=new URLSearchParams({q:$('#hQ').value,cuisine:$('#hCz').value,diet:$('#hDiet').value,season:$('#hSeason').value,taste:$('#hTaste').value,cost:$('#hCost').value,sort:$('#hSort').value});
    try{const {results}=await api('/api/restaurant/recipes?'+p);$('#hRes').innerHTML=results.length?results.slice(0,18).map((r,i)=>`<button type="button" class="chip" data-add="${esc(r.title)}" title="${esc(r.why.join(' · '))}">＋ ${esc(r.title)} <small class="muted">${esc(r.source==='library'?'library':r.why[0]||'')}</small></button>`).join(''):'<p class="muted">No matches — try fewer filters.</p>';
      $('#hRes').querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{if(pinned.length>=40||pinned.includes(b.dataset.add))return;pinned.push(b.dataset.add);renderPinned()})}catch(e){toast(e.message)}};
  $('#hGo').onclick=search;$('#hQ').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();search()}};search();
  const spec=()=>({name:$('#mName').value,restaurantName:$('#rName').value,description:$('#rDesc').value,menuType:$('#mType').value,style:$('#mStyle').value,courses:+$('#mCourses').value||3,dishesPerCourse:+$('#mPer').value||1,
    courseNames:$('#mCNames').value.split(',').map(s=>s.trim()).filter(Boolean).slice(0,12),cuisines:[...$('#mCz').querySelectorAll('input:checked')].map(i=>i.value).slice(0,6),pinned,sourceMenu:$('#mSrc').value.slice(0,12000),
    refine:{appeal:$('#fAppeal').value,variety:$('#fVariety').value,taste:$('#fTaste').value,season:$('#fSeason').value,cost:$('#fCost').value,prices:$('#fPrices').checked,pairings:$('#fPair').checked,diets:[...$('#fDiets').querySelectorAll('input:checked')].map(i=>i.value),personal:$('#fPersonal').value}});
  $('#mCz').addEventListener('change',e=>{if($('#mCz').querySelectorAll('input:checked').length>6){e.target.checked=false;toast('Up to 6 cuisines')}});
  $('#mType').onchange=()=>{if($('#mType').value==='tasting'){$('#mCourses').value=7;$('#mPer').value=1}else if(['set','prix-fixe'].includes($('#mType').value)){$('#mCourses').value=3;$('#mPer').value=2}};
  const tagAbbr={vegetarian:'V',vegan:'VG','gluten-free':'GF','dairy-free':'DF','nut-free':'NF',halal:'H'};
  const show=(id,m,share)=>{current={id,menu:m,share};
    $('#out').innerHTML=`<div class="card menu-preview"><div class="menu-card"><p class="mr">${esc((m.restaurantName||'').toUpperCase())}</p><h1>${esc(m.title)}</h1><p class="mt">${esc([m.menuTypeLabel,...(m.cuisines||[])].join(' · '))}</p>${m.intro?`<p class="mi">${esc(m.intro)}</p>`:''}
      ${m.courses.map(c=>`<section class="mc"><h2>${esc(c.name)}</h2>${c.dishes.map(d=>`<div class="md"><h3>${esc(d.name)}${d.tags.length?` <small>${d.tags.map(t=>tagAbbr[t]).join(' ')}</small>`:''}${d.price!=null?`<span class="mp">${esc(d.price)}</span>`:''}${d.fromHistory?' <small title="From your history">★</small>':''}</h3>${d.description?`<p>${esc(d.description)}</p>`:''}${d.pairing?`<p class="pair">To drink: ${esc(d.pairing)}</p>`:''}</div>`).join('')}</section>`).join('')}
      ${m.chefNote?`<p class="mi">${esc(m.chefNote)}</p>`:''}</div>${m.rationale?`<p class="muted" style="font-size:.9rem"><strong>Malcolm’s thinking:</strong> ${esc(m.rationale)}</p>`:''}
      <p class="actions no-print"><a class="btn" href="/api/restaurant/menus/${esc(id)}/pdf">Download PDF</a> <button class="btn ghost" id="share">${share?'Copy share link':'Create share link'}</button> <button class="btn ghost" id="regen">Regenerate</button> <button class="btn ghost" id="del">Delete</button></p><p id="shareOut" class="muted" style="word-break:break-all">${share?`Shared at <a href="/m/menu/${esc(share)}" target="_blank" rel="noopener">${esc(location.origin)}/m/menu/${esc(share)}</a>`:''}</p></div>`;
    $('#share').onclick=async()=>{try{const {url}=await api(`/api/restaurant/menus/${id}/share`,{method:'POST',body:{}});$('#shareOut').innerHTML=`Shared at <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;try{await navigator.clipboard.writeText(url);toast('Link copied')}catch{}loadSaved()}catch(e){toast(e.message)}};
    $('#regen').onclick=()=>$('#build').click();
    $('#del').onclick=async()=>{if(!confirm('Delete this menu?'))return;await api(`/api/restaurant/menus/${id}`,{method:'DELETE'});$('#out').innerHTML='';loadSaved()};
    $('#out').scrollIntoView({behavior:'smooth',block:'start'})};
  $('#build').onclick=async e=>{const done=cooking($('#out'),e.target);$('#out').querySelector('h2').textContent='Malcolm is composing your menu — usually 20–60 seconds';
    try{const r=await api('/api/restaurant/menus',{method:'POST',body:spec()});done();show(r.id,r.menu,null);loadSaved()}catch(err){done();$('#out').innerHTML=`<p class="note">${esc(err.message)}</p>`}};
  async function loadSaved(){const r=await api('/api/restaurant');const ms=r.menus||[];$('#saved').innerHTML=ms.length?`<ul class="hh-list">${ms.map(m=>`<li><button class="btn ghost sm" data-open="${esc(m.id)}">Open</button> <strong>${esc(m.title)}</strong> <span class="muted">${esc(m.type)} · ${esc((m.createdAt||'').slice(0,10))}${m.share?' · shared':''}</span></li>`).join('')}</ul>`:'<p class="muted">No menus yet — compose your first above.</p>';
    $('#saved').querySelectorAll('[data-open]').forEach(b=>b.onclick=async()=>{const r=await api('/api/restaurant/menus/'+b.dataset.open);show(r.id,r.menu,r.share)})}
  loadSaved();
})();
