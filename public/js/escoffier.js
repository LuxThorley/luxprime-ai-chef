'use strict';
// Escoffier Classics: browse/search the 1907 public-domain guide; "Modernise with Malcolm" hands the dish to the AI chef.
(async function(){
  const {api,esc}=LP;const $=s=>document.querySelector(s);let page=0,q='',sec='';
  const list=$('#escList'),entry=$('#escEntry');
  async function load(){list.innerHTML='<p class="muted">Searching…</p>';
    const d=await api(`/api/escoffier?q=${encodeURIComponent(q)}&section=${encodeURIComponent(sec)}&page=${page}`);
    $('#escAttr').textContent=d.attribution;
    if($('#escSec').options.length<2)d.sections.forEach(s=>{const o=document.createElement('option');o.value=s.name;o.textContent=`${s.name} (${s.count})`;$('#escSec').appendChild(o)});
    list.innerHTML=d.entries.length?'':'<div class="card empty"><h3>Nothing found</h3><p class="muted">Try a French or English name, e.g. “poulet” or “chicken”.</p></div>';
    d.entries.forEach(e=>{const a=document.createElement('a');a.className='card esc-item';a.href=`#no-${e.no}`;a.innerHTML=`<span class="pill esc-no">No. ${esc(e.no)}</span> <strong>${esc(e.title)}</strong><br><small class="muted">${esc(e.section)}</small><p class="muted" style="margin:.4em 0 0">${esc(e.snippet)}</p>`;list.appendChild(a)});
    $('#escPrev').hidden=page===0;$('#escNext').hidden=d.entries.length<24}
  async function show(no){try{const {entry:e,attribution}=await api(`/api/escoffier/${encodeURIComponent(no)}`);
    entry.hidden=false;entry.innerHTML=`<span class="eyebrow">${esc(e.section)}</span><h2 style="margin:.2em 0">${esc(e.title)}</h2><p><span class="pill esc-no">Escoffier No. ${esc(e.no)}</span></p>${window.RecipeView?RecipeView.RB({id:"esc-"+e.no,title:e.title}):""}
      <div class="esc-text">${esc(e.text).split(/\n{2,}/).map(p=>`<p>${p.replace(/\n/g,' ')}</p>`).join('')}</div>
      ${e.refs.length?`<p class="muted">See also: ${e.refs.map(r=>`<a href="#no-${esc(r.no)}">No. ${esc(r.no)} ${esc(r.title)}</a>`).join(' · ')}</p>`:''}
      <div class="actions"><a class="btn" href="/app.html?dish=${encodeURIComponent(e.title)}&escoffier=${encodeURIComponent(e.no)}">✨ Modernise with Malcolm</a><button class="btn ghost sm" id="escClose">Close</button></div>
      <p class="muted" style="font-size:.8rem;margin-top:14px">${esc(attribution)} Original 1907 text: measures are imperial and some practices are historical; the modernised version applies today’s food-safety guidance.</p>`;
    if(window.RecipeView){const rb=entry.querySelector('.rate-bar');RecipeView.bindRate(rb,{id:'esc-'+e.no,title:e.title,cuisine:'French (Escoffier)'});RecipeView.hydrate(entry)}
    $('#escClose').onclick=()=>{entry.hidden=true;history.replaceState(null,'',location.pathname)};entry.scrollIntoView({behavior:'smooth',block:'start'})}catch(err){entry.hidden=false;entry.innerHTML=`<p>${esc(err.message)}</p>`}}
  $('#escSearch').onsubmit=e=>{e.preventDefault();q=$('#escQ').value.trim();sec=$('#escSec').value;page=0;load()};
  $('#escSec').onchange=()=>$('#escSearch').requestSubmit();
  $('#escNext').onclick=()=>{page++;load();window.scrollTo({top:0,behavior:'smooth'})};$('#escPrev').onclick=()=>{page=Math.max(0,page-1);load()};
  const hash=()=>{const m=location.hash.match(/^#no-(\d{1,4}[a-z]?)$/);if(m)show(m[1])};window.addEventListener('hashchange',hash);
  const p=new URLSearchParams(location.search);if(p.get('q')){q=p.get('q');$('#escQ').value=q}
  await load();hash();
})();
