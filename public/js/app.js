'use strict';
(async function(){
  const {api,esc,toast}=LP;const $=s=>document.querySelector(s);
  let me=null,opts={diets:[],cuisines:[]};
  try{[me,opts]=await Promise.all([api('/api/me').then(d=>d.user),api('/api/options')])}catch{}
  $('#cuisine').innerHTML=opts.cuisines.map(c=>`<option value="${esc(c)}">${c==='any'?'Any':esc(c)}</option>`).join('');
  $('#diets').innerHTML=opts.diets.map(d=>`<label><input type="checkbox" value="${esc(d)}"><span>${esc(d)}</span></label>`).join('');
  const quota=()=>{$('#quota').textContent=!me?'Sign in for 3 free searches':me.premium?`${me.plan==='family'?'Family Kitchen':'Chef Monthly'} · unlimited searches`:`Free trial · ${me.searchesLeft} search${me.searchesLeft===1?'':'es'} left`};quota();
  // tag inputs
  const tags={inc:[],exc:[]};
  function tagBox(id){const box=$('#'+id),inp=box.querySelector('input');
    const draw=()=>{box.querySelectorAll('.chip').forEach(c=>c.remove());tags[id].forEach((t,i)=>{const c=document.createElement('span');c.className='chip'+(id==='exc'?' ex':'');c.innerHTML=`${id==='exc'?'✕ ':''}${esc(t)} <button type="button" aria-label="Remove ${esc(t)}">×</button>`;c.querySelector('button').onclick=()=>{tags[id].splice(i,1);draw();inp.focus()};box.insertBefore(c,inp)})};
    const add=v=>{v.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean).forEach(s=>{if(!tags[id].includes(s)&&tags[id].length<20)tags[id].push(s.slice(0,40))});inp.value='';draw()};
    inp.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();add(inp.value)}else if(e.key==='Backspace'&&!inp.value&&tags[id].length){tags[id].pop();draw()}});
    inp.addEventListener('blur',()=>inp.value&&add(inp.value));box.onclick=e=>{if(e.target===box)inp.focus()};return {add,draw}}
  const inc=tagBox('inc'),exc=tagBox('exc');
  $('#time').oninput=e=>$('#timeOut').textContent=e.target.value>=180?'3 hours +':`${e.target.value} min`;
  // wizard
  let step=1;const show=n=>{step=n;document.querySelectorAll('.wiz-step').forEach(s=>s.hidden=+s.dataset.step!==n);document.querySelectorAll('.wiz-prog button').forEach(b=>b.removeAttribute('aria-current'));document.querySelectorAll('.wiz-prog button').forEach(b=>{if(+b.dataset.go===n)b.setAttribute('aria-current','step')});$('#back').hidden=n===1;$('#next').hidden=n===3;const f=document.querySelector(`.wiz-step[data-step="${n}"] input,.wiz-step[data-step="${n}"] textarea`);f&&f.focus({preventScroll:true})};
  document.querySelectorAll('.wiz-prog button').forEach(b=>b.onclick=()=>show(+b.dataset.go));$('#next').onclick=()=>show(Math.min(3,step+1));$('#back').onclick=()=>show(Math.max(1,step-1));
  document.querySelectorAll('[data-ex],[data-dish]').forEach(b=>b.onclick=()=>{if(b.dataset.ex){tags.inc=[];inc.add(b.dataset.ex)}else $('#dish').value=b.dataset.dish;$('#search').requestSubmit()});
  $('#dlgClose').onclick=()=>$('#authDlg').close();
  $('#search').onsubmit=async e=>{e.preventDefault();$('#formErr').textContent='';
    const ii=$('#inc-input'),ei=$('#exc-input');if(ii.value)inc.add(ii.value);if(ei.value)exc.add(ei.value);
    if(!me){$('#authDlg').showModal();return}
    const body={include:tags.inc,exclude:tags.exc,dish:$('#dish').value.trim(),maxMinutes:+$('#time').value,difficulty:document.querySelector('[name=diff]:checked').value,servings:+$('#servings').value||2,cuisine:$('#cuisine').value,diets:[...document.querySelectorAll('#diets input:checked')].map(i=>i.value),kidsMode:$('#kids').checked};
    if(!body.include.length&&!body.dish){$('#formErr').textContent='Add at least one ingredient or describe a dish.';show(1);return}
    const res=$('#results');const stop=LP.cooking(res,$('#go'));
    try{const d=await api('/api/search',{method:'POST',body});me=d.user;quota();stop();res.innerHTML='';
      const h=document.createElement('div');h.className='row no-print';h.style.marginBottom='14px';h.innerHTML=`<p class="muted" style="margin:0">${d.recipes.length} recipe${d.recipes.length===1?'':'s'} · ${d.source==='offline'?'Lux Prime curated library':'Malcolm AI'} ${d.fallbackReason?'(AI unavailable — showing library picks)':''}<br><small>${esc(d.disclaimer)}</small></p>`;res.appendChild(h);
      if(!d.recipes.length)res.innerHTML+='<div class="card empty"><div class="big">🤔</div><h2>No perfect match</h2><p class="muted">Try fewer filters, more time, or a different dish description.</p></div>';
      d.recipes.forEach((r,i)=>{const el=RecipeView.card(r,{premium:me.premium});if(i===0){const im=el.querySelector('.photo img');if(im){im.loading='eager';im.fetchPriority='high'}}res.appendChild(el)});
      res.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(err){stop();res.innerHTML=`<div class="card empty"><div class="big">🍳</div><h2>${esc(err.message)}</h2>${err.data&&err.data.upgrade?'<a class="btn" href="/pricing.html">See plans</a>':''}</div>`}
    finally{stop()}};
  const q=new URLSearchParams(location.search);if(q.get('i')){inc.add(q.get('i'))}
})();
