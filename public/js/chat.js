'use strict';
// Ask Malcolm: conversational thread under results (refine & Q&A) and on single recipe pages (Q&A only).
window.LPChat=(function(){const {api,esc}=LP;
  function mount(host,opts){
    let el=host.querySelector('.chat');if(el)el.remove();
    const history=[];const recipeMode=!!opts.recipe;
    el=document.createElement('section');el.className='card chat no-print';el.setAttribute('aria-labelledby','chatH');
    const sugg=recipeMode?['How do I know it’s done?','What can I swap?','Can I make it ahead?','What wine goes with it?']:['Spicier','Make it vegan','Cheaper','Quicker','What wine?','No dairy'];
    el.innerHTML=`<div class="chat-head"><span class="chat-av" aria-hidden="true">👨‍🍳</span><div><h2 id="chatH">Ask Malcolm</h2><p class="muted">${recipeMode?'Technique, swaps, timings — ask anything about this recipe.':'Reply to refine — “spicier”, “no dairy”, “swap the fish” — or ask a question.'}</p></div></div>
      <div class="chat-log" role="log" aria-live="polite" aria-relevant="additions" tabindex="0" aria-label="Conversation with Malcolm"></div>
      <div class="chat-sugg" aria-label="Suggestions"></div>
      <form class="chat-form"><label for="chatIn" class="sr-only">Message Malcolm</label><textarea id="chatIn" rows="1" maxlength="500" placeholder="${recipeMode?'e.g. Can I use thighs instead?':'e.g. Spicier, and what wine should I pour?'}" enterkeyhint="send"></textarea><button class="btn" type="submit" aria-label="Send to Malcolm">Send</button></form>
      <p class="chat-err err" role="alert"></p>`;
    host.appendChild(el);
    const log=el.querySelector('.chat-log'),ta=el.querySelector('textarea'),form=el.querySelector('form'),btn=form.querySelector('button'),err=el.querySelector('.chat-err'),sg=el.querySelector('.chat-sugg');
    const chips=list=>{sg.innerHTML=(list||[]).slice(0,6).map(s=>`<button type="button" class="chip">${esc(s)}</button>`).join('');sg.querySelectorAll('button').forEach(b=>b.onclick=()=>{ta.value=b.textContent;send()})};
    const bubble=(role,text,extra)=>{const b=document.createElement('div');b.className='msg '+role;b.innerHTML=`<span class="sr-only">${role==='user'?'You said':'Malcolm says'}: </span><p>${esc(text)}</p>${extra||''}`;log.appendChild(b);log.scrollTop=log.scrollHeight;return b};
    const grow=()=>{ta.style.height='auto';ta.style.height=Math.min(ta.scrollHeight,140)+'px'};
    ta.addEventListener('input',grow);ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
    form.onsubmit=e=>{e.preventDefault();send()};
    let busy=false;
    async function send(){const text=ta.value.trim();if(!text||busy)return;err.textContent='';busy=true;btn.disabled=true;ta.value='';grow();
      bubble('user',text);const typing=bubble('malcolm typing','Malcolm is thinking…');typing.setAttribute('aria-busy','true');
      try{const body={message:text,history:history.slice(-12),...(recipeMode?{recipe:opts.recipe()}:{context:opts.context()||{},recipes:opts.recipes()})};
        const d=await api('/api/chat',{method:'POST',body});typing.remove();
        history.push({role:'user',text},{role:'malcolm',text:d.reply});
        const note=d.search?`<p class="msg-note">${d.search.clarify?'':`🔄 ${d.search.recipes.length} fresh recipe${d.search.recipes.length===1?'':'s'} below.`}</p>`:(d.upgrade?`<p class="msg-note"><a href="${esc(d.upgrade)}">See plans</a></p>`:'');
        bubble('malcolm',d.reply,note);chips(d.suggestions&&d.suggestions.length?d.suggestions:sugg);
        if(d.search&&opts.onSearch){opts.onSearch(d.search,d.context);}
      }catch(e){typing.remove();err.innerHTML=esc(e.message||'Malcolm couldn’t reply just now — please try again.')+(e.data&&e.data.upgrade?` <a href="${esc(e.data.upgrade)}">Upgrade</a>`:'');ta.value=text;grow()}
      finally{busy=false;btn.disabled=false;ta.focus()}}
    chips(sugg);
    return el;
  }
  return {mount};
})();
