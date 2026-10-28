'use strict';
// Malcolm AI Chef — floating "Ask Malcolm" companion on every page.
// Tabs: Chat · Cook-along (timers + hands-free Web Speech) · Plan (fridge-to-plate, week plan, aisle shopping list) · My kitchen (consented memory).
(function(){
  if(window.MalcolmWidget||!window.LP)return;const {api,esc}=LP;
  const LS={get:k=>{try{return JSON.parse(localStorage.getItem(k))}catch{return null}},set:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),del:k=>localStorage.removeItem(k)};
  const UK14=['celery','cereals containing gluten','crustaceans','eggs','fish','lupin','milk','molluscs','mustard','peanuts','tree nuts','sesame','soya','sulphites'];
  const DIETS=['vegetarian','vegan','gluten-free','dairy-free','nut-free','halal','slimming'];
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;const TTS='speechSynthesis' in window;
  let S={open:false,hello:null,history:LS.get('mw_hist')||[],mem:null,cook:null,step:0,timer:null,listening:false,rec:null,plan:null};
  const root=document.createElement('div');root.className='mw no-print';root.innerHTML=`
  <button class="mw-fab" type="button" aria-expanded="false" aria-controls="mwPanel"><span aria-hidden="true">👨‍🍳</span><span class="mw-fab-t">Ask Malcolm</span></button>
  <section class="mw-panel" id="mwPanel" role="dialog" aria-modal="false" aria-labelledby="mwTitle" hidden>
    <header class="mw-head"><span class="mw-av" aria-hidden="true">👨‍🍳</span><div><h2 id="mwTitle">Malcolm</h2><p class="mw-sub">Your AI chef · <span class="mw-plan">guest</span></p></div><button type="button" class="mw-x" aria-label="Close Malcolm">✕</button></header>
    <div class="mw-tabs" role="tablist" aria-label="Malcolm tools">
      ${[['chat','Chat'],['cook','Cook-along'],['plan','Plan'],['me','My kitchen']].map(([k,t],i)=>`<button role="tab" id="mwt-${k}" aria-controls="mwp-${k}" aria-selected="${i?'false':'true'}" tabindex="${i?-1:0}" data-tab="${k}">${t}</button>`).join('')}
    </div>
    <div class="mw-body">
      <div role="tabpanel" id="mwp-chat" aria-labelledby="mwt-chat" class="mw-pane">
        <div class="mw-log" role="log" aria-live="polite" tabindex="0" aria-label="Conversation with Malcolm"></div>
        <div class="mw-chips" aria-label="Suggestions"></div>
        <form class="mw-form"><label for="mwIn" class="sr-only">Message Malcolm</label><textarea id="mwIn" rows="1" maxlength="600" placeholder="Ask anything — “I’ve got chicken and peppers”" enterkeyhint="send"></textarea>
          ${SR?'<button type="button" class="mw-mic" aria-label="Speak to Malcolm" aria-pressed="false">🎤</button>':''}<button class="btn sm" type="submit">Send</button></form>
      </div>
      <div role="tabpanel" id="mwp-cook" aria-labelledby="mwt-cook" class="mw-pane" hidden><div class="mw-cook"><p class="muted">Pick a recipe from chat (“cook along with a curry”) or open any recipe page and press <strong>Cook along</strong>.</p></div></div>
      <div role="tabpanel" id="mwp-plan" aria-labelledby="mwt-plan" class="mw-pane" hidden>
        <form class="mw-fridge"><label for="mwFr">What’s in your fridge?</label><input id="mwFr" placeholder="e.g. chicken, peppers, rice" maxlength="600">
          <label class="mw-photo">📷 Photo<input type="file" accept="image/*" capture="environment" class="sr-only" aria-label="Scan a fridge photo"></label><button class="btn sm">Find plates</button></form>
        <form class="mw-week"><fieldset><legend>Weekly plan</legend><label>Servings <input type="number" name="sv" min="1" max="12" value="2"></label><label>Budget £ <input type="number" name="b" min="5" max="500" placeholder="optional"></label><button class="btn sm">Plan my week</button></fieldset></form>
        <div class="mw-out" aria-live="polite"></div>
      </div>
      <div role="tabpanel" id="mwp-me" aria-labelledby="mwt-me" class="mw-pane" hidden><form class="mw-mem"></form></div>
    </div>
    <p class="mw-disc">Malcolm is an AI. Check allergen labels; nutrition is an estimate; not medical advice. <a href="/privacy.html#malcolm">Privacy</a></p>
  </section>`;
  const $=s=>root.querySelector(s),$$=s=>[...root.querySelectorAll(s)];
  const fab=$('.mw-fab'),panel=$('.mw-panel'),log=$('.mw-log'),ta=$('#mwIn');

  // ---- open / close / tabs (keyboard accessible)
  function open(v){S.open=v;panel.hidden=!v;fab.setAttribute('aria-expanded',v);root.classList.toggle('on',v);if(v){boot();setTimeout(()=>ta.focus(),30)}else{stopListen();fab.focus()}}
  fab.onclick=()=>open(!S.open);$('.mw-x').onclick=()=>open(false);
  panel.addEventListener('keydown',e=>{if(e.key==='Escape')open(false)});
  function tab(k){$$('[role=tab]').forEach(b=>{const on=b.dataset.tab===k;b.setAttribute('aria-selected',on);b.tabIndex=on?0:-1});$$('.mw-pane').forEach(p=>p.hidden=p.id!=='mwp-'+k);if(k==='me')renderMem()}
  $$('[role=tab]').forEach((b,i,all)=>{b.onclick=()=>tab(b.dataset.tab);b.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){const n=all[(i+(e.key==='ArrowRight'?1:all.length-1))%all.length];n.focus();tab(n.dataset.tab)}}});

  async function boot(){if(S.hello)return;try{S.hello=await api('/api/assistant/hello')}catch{S.hello={greeting:'Malcolm here — ask me anything about cooking.',features:{},signedIn:false}}
    S.mem=S.hello.memory||(LS.get('mw_mem')||null);$('.mw-plan').textContent=S.hello.planName||'guest';
    if(!S.history.length)bubble('malcolm',S.hello.greeting);else S.history.slice(-8).forEach(t=>bubble(t.role,t.text,null,true));
    chips(['What’s for dinner?','I’ve got chicken and rice','Cook along with me','Plan my week','What plans do you offer?'])}

  // ---- chat
  function bubble(role,text,extra,noSave){const b=document.createElement('div');b.className='mw-msg '+role;b.innerHTML=`<span class="sr-only">${role==='user'?'You':'Malcolm'}: </span><p>${esc(text)}</p>${extra||''}`;log.appendChild(b);log.scrollTop=log.scrollHeight;if(!noSave&&role!=='typing'){S.history.push({role,text:String(text).slice(0,1500)});S.history=S.history.slice(-30);LS.set('mw_hist',S.history)}return b}
  function chips(list){const c=$('.mw-chips');c.innerHTML=list.map(s=>`<button type="button" class="chip">${esc(s)}</button>`).join('');c.querySelectorAll('button').forEach(b=>b.onclick=()=>{ta.value=b.textContent;send()})}
  const cards=rs=>rs&&rs.length?`<ul class="mw-cards">${rs.map(r=>`<li><a href="${esc(r.url)}">${esc(r.title)}</a><span class="muted"> · ${r.totalMinutes} min · ${esc(r.difficulty)}${r.missing&&r.missing.length?` · need: ${esc(r.missing.slice(0,3).join(', '))}`:''}</span> <button type="button" class="mw-cookbtn" data-id="${esc(r.id)}">Cook along</button></li>`).join('')}</ul>`:'';
  // Chat: SSE stream (/api/assistant/chat?stream=1) with graceful fallback to the plain JSON request.
  async function chatReq(body,onDelta){
    try{if(!window.ReadableStream||!window.TextDecoder)throw 0;if(!LP.csrf())await fetch('/api/csrf');
      const r=await fetch('/api/assistant/chat?stream=1',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'text/event-stream','x-csrf-token':LP.csrf()},body:JSON.stringify(body)});
      if(!r.ok||!/event-stream/.test(r.headers.get('content-type')||'')){const j=await r.json().catch(()=>({}));const e=new Error(j.error||'Sorry — I dropped a pan. Try again?');e.data=j;throw e}
      const rd=r.body.getReader(),dec=new TextDecoder();let buf='',done=null;
      for(;;){const {value,done:end}=await rd.read();if(end)break;buf+=dec.decode(value,{stream:true});let i;
        while((i=buf.indexOf('\n\n'))>=0){const blk=buf.slice(0,i);buf=buf.slice(i+2);const ev=(blk.match(/^event: (.+)$/m)||[])[1];const dl=(blk.match(/^data: (.*)$/m)||[])[1];if(!dl)continue;const d=JSON.parse(dl);
          if(ev==='delta')onDelta(d.text);else if(ev==='done')done=d;else if(ev==='error'){throw new Error(d.error)}}}
      if(done)return done;throw new Error('stream ended early')}
    catch(e){if(e&&e.data)throw e;return api('/api/assistant/chat',{method:'POST',body})}}
  const toolHtml=d=>{const t=d.tool;if(!t||!t.data&&!t.needsConfirm)return'';const x=t.data||{};let h='';
    if(x.recipe&&x.recipe.ingredients)h+=`<div class="mw-tool"><h4><a href="${esc(x.recipe.url)}">${esc(x.recipe.title)}</a> · serves ${x.recipe.servings}</h4><ul>${x.recipe.ingredients.map(i=>`<li>${esc(i)}</li>`).join('')}</ul></div>`;
    if(x.allergens)h+=`<p class="mw-tool small"><strong>UK 14 allergens:</strong> ${x.allergens.length?esc(x.allergens.join(', ')):'none listed'}${x.clashes&&x.clashes.length?` — <strong>⚠️ clashes with your allergies: ${esc(x.clashes.join(', '))}</strong>`:''}</p>`;
    if(x.items)h+=x.items.length?`<ul class="mw-tool mw-shoplist">${x.items.map(i=>`<li>${esc(i.qty||i.item)}${i.recipe_title?` <span class="muted small">· ${esc(i.recipe_title)}</span>`:''}</li>`).join('')}</ul>`:'';
    if(x.image)h+=`<p class="mw-tool"><button type="button" class="btn sm ghost mw-img" data-src="${esc(x.image.src)}" data-alt="${esc(x.image.alt||'')}" data-fb="${esc(x.image.fallback||'')}">📷 Show AI photo</button></p>`;
    if(x.generated)h+=`<ul class="mw-cards">${x.generated.map(r=>{const rc=r.recipe||{};const ing=(rc.ingredients||[]).map(i=>typeof i==='string'?i:(i.display||[i.qty,i.unit==='x'?'':i.unit,i.name].filter(Boolean).join(' ')));const st=(rc.steps||[]).map(s=>typeof s==='string'?s:s.text);return `<li><details><summary><strong>${esc(r.title)}</strong><span class="muted"> · ${r.totalMinutes||'?'} min${r.allergens&&r.allergens.length?' · allergens: '+esc(r.allergens.join(', ')):''}</span></summary>${ing.length?`<ul>${ing.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>`:''}${st.length?`<ol>${st.map(i=>`<li>${esc(i)}</li>`).join('')}</ol>`:''}</details>${r.image?`<button type="button" class="btn sm ghost mw-img" data-src="${esc(r.image)}" data-alt="${esc(r.title)}">📷 Show AI photo</button>`:''}</li>`}).join('')}</ul>`;
    if(t.needsConfirm)h+=`<p><button type="button" class="btn sm mw-confirm" data-act="${esc(t.needsConfirm.action)}">${esc(t.needsConfirm.label)}</button> <button type="button" class="btn sm ghost mw-cancel">No, keep it</button></p>`;
    return h};
  async function send(confirm){const text=confirm?'Yes, go ahead':ta.value.trim();if(!text)return;ta.value='';bubble('user',text);const t=bubble('typing','Malcolm is thinking…',null,true);let live=null,acc='';
    try{const d=await chatReq({message:text,history:S.history.slice(-10),page:location.pathname,lastRecipeIds:(S.lastIds||[]).slice(0,6),...(confirm?{confirm}:{}),localMemory:S.hello&&S.hello.signedIn?undefined:S.mem||undefined},
        chunk=>{acc+=chunk;if(!live){t.remove();live=document.createElement('div');live.className='mw-msg malcolm';live.innerHTML='<span class="sr-only">Malcolm: </span><p></p>';log.appendChild(live)}live.querySelector('p').textContent=acc;log.scrollTop=log.scrollHeight});
      if(live)live.remove();else t.remove();
      const ids=(d.recipes||[]).map(r=>r.id);if(d.tool&&d.tool.data&&d.tool.data.recipeId)ids.unshift(d.tool.data.recipeId);if(d.tool&&d.tool.data&&d.tool.data.recipe&&d.tool.data.recipe.id)ids.unshift(d.tool.data.recipe.id);if(ids.length)S.lastIds=[...new Set(ids)];
      let extra=toolHtml(d)+cards(d.recipes);if(d.notes&&d.notes.length)extra+=`<ul class="mw-notes">${d.notes.map(n=>`<li>⚠️ ${esc(n)}</li>`).join('')}</ul>`;
      if(d.plan)extra+=planHtml(d.plan);if(d.sources&&d.sources.length)extra+=`<p class="mw-src small">Sources: ${d.sources.map(s=>`<a href="${esc(s.url)}">${esc(s.title)}</a>`).join(" · ")}</p>`;if(d.link)extra+=`<p><a class="btn sm ghost" href="${esc(d.link)}">${esc(d.linkLabel||'Open')}</a></p>`;if(d.upgrade)extra+=`<p><a class="btn sm" href="${esc(d.upgrade)}">See plans</a></p>`;
      if(d.escalate)extra+=escForm();
      const b=bubble('malcolm',d.reply,extra);wire(b);speak(d.reply)}
    catch(e){if(live)live.remove();t.remove();bubble('malcolm',e.message||'Sorry — I dropped a pan. Try again?',e.data&&e.data.upgrade?`<p><a class="btn sm" href="${esc(e.data.upgrade)}">See plans</a></p>`:'',true)}}
  function wire(el){el.querySelectorAll('.mw-img').forEach(b=>b.onclick=()=>{const i=new Image();i.loading='lazy';i.alt=b.dataset.alt;i.className='mw-photo-img';i.style.maxWidth='100%';i.onerror=()=>{if(b.dataset.fb&&i.src!==b.dataset.fb)i.src=b.dataset.fb};i.src=b.dataset.src;b.replaceWith(i)});el.querySelectorAll('.mw-confirm').forEach(b=>b.onclick=()=>{b.parentNode.remove();send(b.dataset.act)});el.querySelectorAll('.mw-cancel').forEach(b=>b.onclick=()=>{b.parentNode.remove();bubble('malcolm','Righto — nothing changed.')});el.querySelectorAll('.mw-cookbtn').forEach(b=>b.onclick=()=>startCook(b.dataset.id));el.querySelectorAll('.mw-shop').forEach(b=>b.onclick=()=>shop());const f=el.querySelector('.mw-esc');if(f)f.onsubmit=async e=>{e.preventDefault();const m=f.querySelector('textarea').value;try{const d=await api('/api/assistant/escalate',{method:'POST',body:{message:m,...(f.email&&f.email.value?{email:f.email.value}:{})}});f.outerHTML=`<p>${esc(d.reply)} <a href="${esc(d.mailto)}">Email Oliver</a></p>`}catch(er){LP.toast(er.message)}}}
  const escForm=()=>`<form class="mw-esc"><label>Message for Oliver<textarea maxlength="1500" required></textarea></label>${S.hello&&S.hello.signedIn?'':'<label>Your email<input name="email" type="email" maxlength="200"></label>'}<button class="btn sm">Send to Oliver</button></form>`;
  $('.mw-form').onsubmit=e=>{e.preventDefault();send()};ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});

  // ---- voice (free browser Web Speech API; nothing leaves the browser except the recognised text)
  function speak(t){if(!TTS||!(S.mem&&S.mem.voice)&&!S.cook)return;try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(String(t).slice(0,600));u.lang='en-GB';const v=speechSynthesis.getVoices().find(v=>/en-GB/.test(v.lang));if(v)u.voice=v;speechSynthesis.speak(u)}catch{}}
  function listen(onText,continuous){if(!SR)return LP.toast('Voice needs Chrome, Edge or Safari');stopListen();const r=new SR();r.lang='en-GB';r.continuous=!!continuous;r.interimResults=false;
    r.onresult=e=>{const t=e.results[e.results.length-1][0].transcript;onText(t)};r.onend=()=>{if(S.listening&&continuous){try{r.start()}catch{}}else setMic(false)};r.onerror=e=>{if(e.error==='not-allowed'){S.listening=false;LP.toast('Microphone permission was blocked')}};
    S.rec=r;S.listening=true;setMic(true);try{r.start()}catch{}}
  function stopListen(){S.listening=false;if(S.rec)try{S.rec.stop()}catch{};S.rec=null;setMic(false)}
  function setMic(on){$$('.mw-mic,.mw-hands').forEach(b=>b.setAttribute('aria-pressed',on))}
  const mic=$('.mw-mic');if(mic)mic.onclick=()=>S.listening?stopListen():listen(t=>{ta.value=t;stopListen();send()},false);

  // ---- cook-along
  async function startCook(id){try{S.cook=await api('/api/assistant/cook/'+encodeURIComponent(id))}catch(e){return LP.toast(e.message)}S.step=0;tab('cook');if(!S.open)open(true);tab('cook');renderCook();say()}
  function renderCook(){const c=S.cook,s=c.steps[S.step];$('.mw-cook').innerHTML=`<h3>${esc(c.title)}</h3><p class="muted">Serves ${c.servings} · step ${S.step+1} of ${c.steps.length}</p>
    <details><summary>Ingredients</summary><ul>${c.ingredients.map(i=>`<li>${esc(i)}</li>`).join('')}</ul>${c.allergens.length?`<p><strong>Allergens:</strong> ${esc(c.allergens.join(', '))}</p>`:''}</details>
    <div class="mw-step" aria-live="assertive"><span class="mw-n">${S.step+1}</span><p>${esc(s.text)}</p></div>
    <div class="mw-timer" aria-live="polite">${s.timerSec?`<button type="button" class="btn sm ghost mw-t">⏱ Start ${Math.round(s.timerSec/60)} min timer</button>`:''}<span class="mw-tleft"></span></div>
    <div class="mw-nav"><button type="button" class="btn sm ghost mw-prev" ${S.step?'':'disabled'}>‹ Back</button><button type="button" class="btn sm ghost mw-rep">Repeat</button><button type="button" class="btn sm mw-next">${S.step===c.steps.length-1?'Finish':'Next ›'}</button></div>
    ${SR?`<button type="button" class="btn sm mw-hands" aria-pressed="${S.listening}">🎙 Hands-free</button><p class="muted small">Say “next step”, “back”, “repeat”, “start timer”, “how long left?”, “ingredients” or “stop”.</p>`:'<p class="muted small">Voice control needs Chrome, Edge or Safari.</p>'}
    <ul class="mw-notes">${c.safety.slice(0,3).map(n=>`<li>🛡 ${esc(n)}</li>`).join('')}</ul>`;
    const q=s=>$('.mw-cook '+s);q('.mw-next').onclick=()=>cmd({cmd:'next'});const p=q('.mw-prev');if(p)p.onclick=()=>cmd({cmd:'prev'});q('.mw-rep').onclick=()=>cmd({cmd:'repeat'});const t=q('.mw-t');if(t)t.onclick=()=>cmd({cmd:'timer'});
    const h=q('.mw-hands');if(h)h.onclick=()=>S.listening?stopListen():listen(t=>{const k=parse(t);if(k)cmd(k)},true);tick()}
  function say(){const s=S.cook.steps[S.step];speak(`Step ${S.step+1}. ${s.text}${s.timerSec?` Say start timer for ${Math.round(s.timerSec/60)} minutes.`:''}`)}
  function parse(t){const s=String(t).toLowerCase().replace(/^(hey |ok |okay )?malcolm[, ]*/,'').trim();
    if(/^(next|next step|go on|done|carry on|continue)\b/.test(s))return{cmd:'next'};if(/^(back|previous|go back|last step)\b/.test(s))return{cmd:'prev'};if(/^(repeat|say (that|it) again|again)/.test(s))return{cmd:'repeat'};
    if(/(start|set) (the )?timer/.test(s)){const m=s.match(/(\d+)\s*(min|minute|sec|second)/);return{cmd:'timer',sec:m?(+m[1])*(/^s/.test(m[2])?1:60):null}}if(/how long|time left|how much longer/.test(s))return{cmd:'timeleft'};
    if(/(stop|cancel|pause) (the )?timer/.test(s))return{cmd:'stoptimer'};if(/ingredients|what do i need/.test(s))return{cmd:'ingredients'};if(/^(stop|exit|finish|quit|end)/.test(s))return{cmd:'exit'};return null}
  function cmd(k){const c=S.cook;if(!c)return;const n=c.steps.length;
    if(k.cmd==='next'){if(S.step<n-1){S.step++;renderCook();say()}else{speak('All done — plate up and enjoy. Remember to check it’s piping hot.');stopListen();$('.mw-cook').insertAdjacentHTML('beforeend','<p class="mw-done">🎉 Finished — bon appétit!</p>')}}
    else if(k.cmd==='prev'&&S.step>0){S.step--;renderCook();say()}else if(k.cmd==='repeat')say();
    else if(k.cmd==='timer'){const sec=k.sec||c.steps[S.step].timerSec;if(!sec)return speak('How many minutes? Say start timer for 5 minutes.');S.timer={end:Date.now()+sec*1000,label:`Step ${S.step+1}`};speak(`Timer set for ${Math.round(sec/60)||sec+' seconds'} ${sec>=60?'minutes':''}`);tick()}
    else if(k.cmd==='timeleft'){speak(S.timer?`${Math.ceil((S.timer.end-Date.now())/60000)} minutes left`:'No timer running')}else if(k.cmd==='stoptimer'){S.timer=null;tick();speak('Timer cancelled')}
    else if(k.cmd==='ingredients')speak('You need: '+c.ingredients.join(', '));else if(k.cmd==='exit'){stopListen();speak('Righto, stopping the cook-along.')}}
  let iv=null;function tick(){clearInterval(iv);const el=$('.mw-tleft');if(!S.timer){if(el)el.textContent='';return}
    iv=setInterval(()=>{const left=Math.max(0,Math.round((S.timer.end-Date.now())/1000));const e=$('.mw-tleft');if(e)e.textContent=` ${S.timer.label}: ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')} left`;
      if(!left){clearInterval(iv);S.timer=null;speak('Ding! Timer’s up.');try{navigator.vibrate&&navigator.vibrate([300,150,300])}catch{};LP.toast('⏱ Timer’s up!')}},500)}

  // ---- plan tab: fridge-to-plate, weekly plan, shopping list
  const out=()=>$('.mw-out');
  function planHtml(p){return `<div class="mw-planbox"><ol class="mw-week-list">${p.days.map(d=>`<li><strong>${esc(d.day)}</strong> <a href="${esc(d.url)}">${esc(d.title)}</a> <span class="muted">${d.totalMinutes} min · ~£${d.estCostGBP.toFixed(2)}</span></li>`).join('')}</ol><p class="muted small">~£${p.estTotalGBP.toFixed(2)} total for ${p.servings}${p.budgetGBP?` (budget £${p.budgetGBP}${p.withinBudget?' ✓':' — a bit over'})`:''}. ${esc(p.note)}</p><button type="button" class="btn sm mw-shop">🛒 Shopping list by aisle</button></div>`}
  async function shop(){if(!S.plan)return;try{const d=await api('/api/assistant/shopping',{method:'POST',body:{ids:S.plan.days.map(x=>x.id),servings:S.plan.servings,have:[]}});
    const txt=d.aisles.map(a=>a.aisle+':\n'+a.items.map(i=>' - '+i.label).join('\n')).join('\n');
    out().insertAdjacentHTML('beforeend',`<div class="mw-shoplist"><h4>Shopping list</h4>${d.aisles.map(a=>`<h5>${esc(a.aisle)}</h5><ul>${a.items.map(i=>`<li><label><input type="checkbox"> ${esc(i.label)}</label></li>`).join('')}</ul>`).join('')}<button type="button" class="btn sm ghost mw-copy">Copy list</button></div>`);
    const cp=out().querySelector('.mw-copy');cp.onclick=()=>navigator.clipboard&&navigator.clipboard.writeText(txt).then(()=>LP.toast('Copied'))}catch(e){gateMsg(e)}}
  function gateMsg(e){out().innerHTML=`<p class="err">${esc(e.message)}</p>${e.data&&e.data.upgrade?`<a class="btn sm" href="${esc(e.data.upgrade)}">${e.data.upgrade.includes('pricing')?'See plans':'Sign in'}</a>`:''}`}
  $('.mw-fridge').onsubmit=async e=>{e.preventDefault();await fridge({text:$('#mwFr').value})};
  $('.mw-photo input').onchange=async e=>{const f=e.target.files[0];if(!f)return;const data=await shrink(f);fridge({text:$('#mwFr').value,image:data})};
  async function fridge(b){out().innerHTML='<p class="muted">Having a rummage…</p>';try{const d=await api('/api/assistant/fridge',{method:'POST',body:b});
    out().innerHTML=`${d.items.length?`<p>I spotted: <strong>${esc(d.items.join(', '))}</strong>${d.via==='photo'?' (from your photo — double-check me)':''}</p>`:''}${d.note?`<p class="muted">${esc(d.note)}</p>`:''}${cards(d.recipes)}${d.leftovers?`<ul class="mw-notes">${d.leftovers.map(n=>`<li>♻️ ${esc(n)}</li>`).join('')}</ul>`:''}`;wire(out())}catch(er){gateMsg(er)}}
  function shrink(file){return new Promise(res=>{const img=new Image();img.onload=()=>{const k=Math.min(1,768/Math.max(img.width,img.height));const cv=document.createElement('canvas');cv.width=img.width*k;cv.height=img.height*k;cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);res(cv.toDataURL('image/jpeg',.8));URL.revokeObjectURL(img.src)};img.src=URL.createObjectURL(file)})}
  $('.mw-week').onsubmit=async e=>{e.preventDefault();const f=e.target;out().innerHTML='<p class="muted">Planning your week…</p>';try{S.plan=await api('/api/assistant/plan',{method:'POST',body:{servings:+f.sv.value||2,...(f.b.value?{budgetGBP:+f.b.value}:{})}});out().innerHTML=planHtml(S.plan);wire(out())}catch(er){gateMsg(er)}};

  // ---- My kitchen (consented memory; server for members, this device only for guests)
  function renderMem(){const m=S.mem||{allergies:[],avoid:[],diets:[],kit:[],skill:'confident',household:2,favourites:[],voice:false};const f=$('.mw-mem');const signed=S.hello&&S.hello.signedIn;
    f.innerHTML=`<p class="muted small">${signed?'Saved to your AIchef.food account.':'Not signed in: saved on this device only.'} Malcolm uses this to tailor every answer. You can delete it any time.</p>
    <fieldset><legend>Allergies (UK 14)</legend><div class="mw-grid">${UK14.map(a=>`<label><input type="checkbox" name="al" value="${a}" ${m.allergies.includes(a)?'checked':''}> ${a}</label>`).join('')}</div></fieldset>
    <fieldset><legend>Diets</legend><div class="mw-grid">${DIETS.map(a=>`<label><input type="checkbox" name="di" value="${a}" ${m.diets.includes(a)?'checked':''}> ${a}</label>`).join('')}</div></fieldset>
    <label>Foods to avoid <input name="avoid" value="${esc(m.avoid.join(', '))}" placeholder="e.g. coriander, mushrooms"></label>
    <label>Kitchen kit <input name="kit" value="${esc(m.kit.join(', '))}" placeholder="e.g. air fryer, slow cooker, wok"></label>
    <label>Favourite foods <input name="fav" value="${esc(m.favourites.join(', '))}" placeholder="e.g. Thai, pasta, curry"></label>
    <div class="mw-row"><label>Skill <select name="skill">${['beginner','confident','advanced'].map(s=>`<option ${m.skill===s?'selected':''}>${s}</option>`).join('')}</select></label><label>Cooking for <input type="number" name="hh" min="1" max="12" value="${m.household}"></label></div>
    <label><input type="checkbox" name="voice" ${m.voice?'checked':''}> Read Malcolm’s replies aloud</label>
    <label class="mw-consent"><input type="checkbox" name="consent" required ${S.mem?'checked':''}> I agree Malcolm may store this kitchen profile (including allergy and diet info) to personalise answers. <a href="/privacy.html#malcolm">Privacy</a></label>
    <div class="mw-row"><button class="btn sm">Save</button><button type="button" class="btn sm ghost mw-del">Delete my data</button></div><p class="mw-memmsg" role="status"></p>`;
    const list=v=>v.split(',').map(s=>s.trim()).filter(Boolean).slice(0,20);
    f.onsubmit=async e=>{e.preventDefault();const mem={consent:f.consent.checked,allergies:[...f.querySelectorAll('[name=al]:checked')].map(x=>x.value),diets:[...f.querySelectorAll('[name=di]:checked')].map(x=>x.value),avoid:list(f.avoid.value),kit:list(f.kit.value),favourites:list(f.fav.value),skill:f.skill.value,household:+f.hh.value||2,voice:f.voice.checked};
      try{if(signed){S.mem=(await api('/api/assistant/memory',{method:'PUT',body:mem})).memory}else{S.mem=mem;LS.set('mw_mem',mem)}$('.mw-memmsg').textContent='Saved — I’ll remember that.'}catch(er){$('.mw-memmsg').textContent=er.message}};
    f.querySelector('.mw-del').onclick=async()=>{try{if(signed)await api('/api/assistant/memory',{method:'DELETE'});LS.del('mw_mem');LS.del('mw_hist');S.mem=null;S.history=[];log.innerHTML='';renderMem();$('.mw-memmsg').textContent='Deleted. Malcolm has forgotten your kitchen profile and chat history.'}catch(er){$('.mw-memmsg').textContent=er.message}}}

  document.addEventListener('DOMContentLoaded',()=>document.body.appendChild(root));if(document.readyState!=='loading')document.body.appendChild(root);
  window.MalcolmWidget={open:()=>open(true),cook:startCook};
  // Recipe pages: offer a cook-along button
  const cta=()=>{const id=new URLSearchParams(location.search).get('id');if(/\/recipe(\.html)?\/?$/.test(location.pathname)&&id){const b=document.createElement('button');b.type='button';b.className='btn mw-cook-cta no-print';b.textContent='👨‍🍳 Cook along with Malcolm';b.onclick=()=>startCook(id);const m=document.getElementById('main');if(m)m.prepend(b)}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',cta);else cta();
})();
