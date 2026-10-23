'use strict';
// Shared recipe renderer: timers, print, PDF export (jsPDF, client-side), image card (canvas), share.
(function(){
  const {esc}=window.LP;
  const ALN={'cereals containing gluten':'gluten'};
  function card(r,{actions=true,premium=false,shareId=null}={}){
    const img=r.image||{src:'/img/ingredients-sm.webp',alt:r.title};
    const el=document.createElement('article');el.className='card recipe';el.dataset.id=r.id;
    el.innerHTML=`<div class="photo${img.ai?' shimmer':''}"><img src="${esc(img.large||img.src)}" alt="${esc(img.alt||r.title)}" loading="lazy" decoding="async" ${img.fallback?`data-fallback="${esc(img.fallback)}"`:''}></div>
    <div class="recipe-head"><div style="flex:1;min-width:220px"><h3 style="font-size:1.7rem;margin:0">${esc(r.title)}</h3>
    ${r.escoffier?`<p style="margin:.35em 0"><a class="pill esc-badge" href="${esc(r.escoffier.url)}" title="Escoffier, A Guide to Modern Cookery (1907)">📖 ${esc(r.escoffier.label)}</a></p>`:''}
    ${r.tagline?`<p class="why tagline" style="margin:.3em 0;font-style:italic">${esc(r.tagline)}</p>`:r.whyItFits?`<p class="why" style="margin:.3em 0">Why it fits: ${esc(r.whyItFits)}</p>`:''}
    <div class="meta"><span class="pill">⏱ ${esc(r.totalMinutes)} min</span><span class="pill">${esc(r.difficulty)}</span><span class="pill">🍽 serves ${esc(r.servings||r.baseServings)}</span><span class="pill">${esc(r.cuisine)}</span>${Object.entries(r.diet||{}).filter(([,v])=>v).map(([k])=>`<span class="pill">${esc(k)}</span>`).join('')}</div>
    ${RB(r)}
    <div class="meta" aria-label="Allergens">${(r.allergens||[]).length?(r.allergens.map(a=>`<span class="pill al">⚠ ${esc(ALN[a]||a)}</span>`).join('')):'<span class="pill">No UK-14 allergens detected</span>'}</div></div>
    ${r.matchScore!=null?`<div class="score" style="--s:${+r.matchScore}" aria-label="Match score ${+r.matchScore} percent"><b>${+r.matchScore}%</b></div>`:''}</div>
    <div class="cols" style="margin-top:12px"><div><h4>Ingredients</h4><ul class="ing" style="padding-left:18px">${r.ingredients.map(i=>`<li>${esc(i.display||i.name)}</li>`).join('')}</ul>
    ${(r.shoppingList||[]).length?`<h4>🛒 Shopping list</h4><ul style="padding-left:18px" class="muted">${r.shoppingList.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>`:''}
    <h4>Nutrition per serving <small class="muted">(estimate)</small></h4><div class="nutri"><div><b>${esc(r.nutritionPerServing.kcal)}</b>kcal</div><div><b>${esc(r.nutritionPerServing.proteinG)}g</b>protein</div>${r.nutritionPartial?'':`<div><b>${esc(r.nutritionPerServing.carbsG)}g</b>carbs</div><div><b>${esc(r.nutritionPerServing.fatG)}g</b>fat</div>`}</div></div>
    <div><h4>Method</h4><ol class="steps">${r.steps.map(s=>`<li>${esc(s.text)}${s.timerMinutes?` <button type="button" class="btn ghost sm timer" data-min="${+s.timerMinutes}" aria-label="Start ${+s.timerMinutes} minute timer">⏲ ${+s.timerMinutes} min</button>`:''}</li>`).join('')}</ol>
    ${(r.substitutions||[]).length?`<h4>Swaps &amp; substitutions</h4><ul style="padding-left:18px">${r.substitutions.map(s=>`<li><strong>${esc(s.ingredient)}</strong> → ${esc(s.swap)}</li>`).join('')}</ul>`:''}
    ${r.chefSecret?`<div class="note chef-secret"><strong>🤫 Chef’s secret</strong><p style="margin:.3em 0 0">${esc(r.chefSecret)}</p></div>`:''}
    ${r.pairing?`<p><strong>🍷 Pairing:</strong> ${esc(r.pairing)}</p>`:''}
    ${(r.tips||[]).length?`<h4>Chef's tips</h4><ul style="padding-left:18px">${r.tips.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}
    ${(r.safetyNotes||[]).length?`<div class="note"><strong>Food safety</strong><ul style="margin:.3em 0 0;padding-left:18px">${r.safetyNotes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`:''}</div></div>
    ${actions?`<div class="actions no-print"><button class="btn sm" data-act="cooked" aria-pressed="false">👩‍🍳 I made this</button>
      <button class="btn ghost sm" data-act="print">🖨 Print</button><button class="btn ghost sm" data-act="pdf">⬇ PDF</button><button class="btn ghost sm" data-act="card">🖼 Image card</button><button class="btn ghost sm" data-act="share" aria-expanded="false">↗ Share</button></div><div class="share-row no-print" hidden style="margin-top:10px"></div>`:''}`;
    const im=el.querySelector('.photo img');if(img.ai){const ph=el.querySelector('.photo');const done=()=>ph.classList.remove('shimmer');im.addEventListener('load',done);im.addEventListener('error',done);if(im.complete&&im.naturalWidth)done()}im.addEventListener('error',()=>{if(im.dataset.fallback&&im.src.indexOf(im.dataset.fallback)<0)im.src=im.dataset.fallback},{once:false});
    el.querySelectorAll('.timer').forEach(b=>b.onclick=()=>timer(b));bindRate(el.querySelector('.rate-bar'),r);
    if(actions){
      el.querySelector('[data-act=print]').onclick=()=>{el.classList.add('printing');window.print();setTimeout(()=>el.classList.remove('printing'),500)};
      el.querySelector('[data-act=pdf]').onclick=()=>pdf(r);
      el.querySelector('[data-act=card]').onclick=()=>imageCard(r);
      el.querySelector('[data-act=share]').onclick=e=>share(r,el,e.currentTarget,shareId);
      el.querySelector('[data-act=cooked]').onclick=async e=>{const b=e.currentTarget;try{await LP.api(`/api/recipes/${encodeURIComponent(r.id)}/event`,{method:'POST',body:{kind:'cook',recipe:r}});b.setAttribute('aria-pressed','true');b.textContent='✅ Made it!';LP.toast('Nice! Thanks for telling Malcolm.')}catch(err){LP.toast(err.status===401?'Sign in to log your cooks':err.message)}};
      ['pdf','card','share'].forEach(k=>{const b=el.querySelector(`[data-act=${k}]`);b&&b.addEventListener('click',()=>evt(r,k==='pdf'?'pdf':'share'))});
    }
    return el;
  }
  // ---- Ratings + favourites (shared by results, shared page, recipe page, favourites, Escoffier) ----
  const STAR='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
  function RB(r){return `<div class="rate-bar no-print" data-rid="${esc(r.id)}"><div class="stars" role="radiogroup" aria-label="Your rating for ${esc(r.title)}">${[1,2,3,4,5].map(n=>`<button type="button" class="star" role="radio" aria-checked="false" data-n="${n}" aria-label="${n} star${n>1?'s':''}">${STAR}</button>`).join('')}</div><span class="rate-sum" aria-live="polite"><span class="muted">Not rated yet</span></span><span class="feat" hidden></span><button type="button" class="heart" aria-pressed="false" aria-label="Save to favourites"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.2 3.1 4.5 6.8 4.5c2.1 0 3.7 1.2 5.2 3 1.5-1.8 3.1-3 5.2-3 3.7 0 5.9 3.7 4.4 7.2C19.5 16.4 12 21 12 21z"/></svg><span class="hn"></span></button></div>`}
  const fmt=s=>s&&s.count?`<strong class="avg">${s.avg.toFixed(3)}</strong> <span class="muted">★ · ${s.count} rating${s.count===1?'':'s'}</span>`:'<span class="muted">Be the first to rate</span>';
  function paint(bar,s,rank){if(!bar)return;bar._s=s;const mine=s&&s.mine;bar.querySelectorAll('.star').forEach(b=>{const on=mine&&+b.dataset.n<=mine;b.classList.toggle('on',!!on);b.setAttribute('aria-checked',String(mine===+b.dataset.n))});
    bar.querySelector('.rate-sum').innerHTML=fmt(s)+(mine?` <span class="mine">· yours ${mine}★</span>`:'');const h=bar.querySelector('.heart');h.setAttribute('aria-pressed',String(!!(s&&s.hearted)));h.setAttribute('aria-label',s&&s.hearted?'Remove from favourites':'Save to favourites');h.querySelector('.hn').textContent=s&&s.hearts?s.hearts:'';
    const f=bar.querySelector('.feat');if(rank){f.hidden=false;f.innerHTML=`<span class="badge-feat">👑 Featured #${rank}</span>`}}
  function evt(r,kind){LP.api(`/api/recipes/${encodeURIComponent(r.id)}/event`,{method:'POST',body:{kind,recipe:r}}).catch(()=>{})}
  function bindRate(bar,r){if(!bar)return;bar._r=r;
    bar.querySelectorAll('.star').forEach(b=>{b.onclick=async()=>{const n=+b.dataset.n;try{const d=await LP.api(`/api/recipes/${encodeURIComponent(r.id)}/rating`,{method:'PUT',body:{stars:n,recipe:r}});paint(bar,{...d.stats,hearted:bar._s&&bar._s.hearted},null);LP.toast(`Rated ${n}★, thank you`)}catch(e){LP.toast(e.status===401?'Sign in to rate recipes':e.message)}};
      b.onkeydown=e=>{if(['ArrowRight','ArrowUp','ArrowLeft','ArrowDown'].includes(e.key)){e.preventDefault();const d=/Right|Up/.test(e.key)?1:-1;const nx=bar.querySelector(`.star[data-n="${Math.min(5,Math.max(1,+b.dataset.n+d))}"]`);nx.focus()}}});
    bar.querySelector('.heart').onclick=async()=>{const on=bar._s&&bar._s.hearted;try{if(on)await LP.api('/api/favourites/'+encodeURIComponent(r.id),{method:'DELETE'});else await LP.api('/api/favourites',{method:'POST',body:{recipe:r}});const s={...(bar._s||{count:0,avg:null,hearts:0}),hearted:!on};s.hearts=Math.max(0,(s.hearts||0)+(on?-1:1));paint(bar,s,null);LP.toast(on?'Removed from favourites':'Saved to favourites ♥');document.dispatchEvent(new CustomEvent('lp:fav',{detail:{id:r.id,on:!on}}))}catch(e){if(e.status===402){LP.toast('Favourites come with Chef de Partie and above');}else LP.toast(e.status===401?'Sign in to save favourites':e.message)}}}
  async function hydrate(root){const bars=[...(root||document).querySelectorAll('.rate-bar[data-rid]')];if(!bars.length)return;
    try{const d=await LP.api('/api/recipes/stats?ids='+encodeURIComponent(bars.map(b=>b.dataset.rid).join(',')));bars.forEach(b=>paint(b,d.stats[b.dataset.rid],d.featured[b.dataset.rid]))}catch{}}
  function timer(b){
    if(b._t){clearInterval(b._t);b._t=null;b.classList.remove('run');b.textContent=`⏲ ${b.dataset.min} min`;return}
    let left=+b.dataset.min*60;b.classList.add('run');
    const tick=()=>{const m=Math.floor(left/60),s=left%60;b.textContent=`⏸ ${m}:${String(s).padStart(2,'0')}`;if(left--<=0){clearInterval(b._t);b._t=null;b.classList.remove('run');b.textContent='✅ Done!';LP.toast('⏲ Timer finished!');try{navigator.vibrate&&navigator.vibrate([300,150,300])}catch{}}};
    tick();b._t=setInterval(tick,1000);
  }
  function loadImg(src){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src})}
  const fname=r=>r.title.replace(/[^a-z0-9]+/gi,'-').toLowerCase();
  async function pdf(r){
    if(!window.jspdf){LP.toast('PDF library not loaded — use Print → Save as PDF');return}
    const {jsPDF}=window.jspdf;const d=new jsPDF({unit:'mm',format:'a4'});const W=210,M=16;let y=0;
    try{const i=await loadImg((r.image&&(r.image.large||r.image.src))||'/img/ingredients.webp');const c=document.createElement('canvas');c.width=1200;c.height=500;const x=c.getContext('2d');const sc=Math.max(1200/i.width,500/i.height);x.drawImage(i,(1200-i.width*sc)/2,(500-i.height*sc)/2,i.width*sc,i.height*sc);d.addImage(c.toDataURL('image/jpeg',.82),'JPEG',0,0,W,W*500/1200);y=W*500/1200+10}catch{y=16}
    try{const m=await loadImg('/img/brand/logo-email.png');const c2=document.createElement('canvas');c2.width=m.width;c2.height=m.height;c2.getContext('2d').drawImage(m,0,0);d.addImage(c2.toDataURL('image/png'),'PNG',W-M-44,y-8,44,44*m.height/m.width);y+=4}catch{}
    const line=(t,size=10,style='normal',gap=1.5)=>{d.setFont('helvetica',style);d.setFontSize(size);d.splitTextToSize(String(t),W-2*M).forEach(l=>{if(y>282){d.addPage();y=16}d.text(l,M,y);y+=size*.42+gap})};
    d.setTextColor(30,28,24);line(r.title,22,'bold',3);if(r.tagline)line(r.tagline,11,'italic',2);if(r.escoffier)line(r.escoffier.label,9,'italic',2);
    line(`${r.totalMinutes} min · ${r.difficulty} · serves ${r.servings||r.baseServings} · ${r.cuisine}`,10,'normal',2);
    if(r.allergens&&r.allergens.length)line('Allergens: '+r.allergens.join(', '),10,'bold',3);
    line('Ingredients',13,'bold',2);r.ingredients.forEach(i=>line('•  '+(i.display||i.name)));y+=3;
    line('Method',13,'bold',2);r.steps.forEach((s,n)=>line(`${n+1}.  ${s.text}${s.timerMinutes?` (${s.timerMinutes} min)`:''}`,10,'normal',2));y+=3;
    if(r.chefSecret){line('Chef’s secret',13,'bold',2);line(r.chefSecret);y+=3}if(r.pairing){line('Pairing: '+r.pairing,10,'normal',3)}
    if((r.substitutions||[]).length){line('Substitutions',13,'bold',2);r.substitutions.forEach(s=>line(`•  ${s.ingredient} → ${s.swap}`))}
    if((r.safetyNotes||[]).length){y+=3;line('Food safety',13,'bold',2);r.safetyNotes.forEach(s=>line('•  '+s,9))}
    const n=r.nutritionPerServing;y+=3;line(`Nutrition per serving (estimate): ${n.kcal} kcal · ${n.proteinG}g protein${r.nutritionPartial?'':` · ${n.carbsG}g carbs · ${n.fatG}g fat`}`,9,'italic');
    y+=4;line('AIchef.food · Ask Malcolm, your AI chef · Always check allergen labels.',8,'italic');
    d.save(`${fname(r)}.pdf`);
  }
  async function imageCard(r){
    const c=document.createElement('canvas');c.width=1080;c.height=1350;const x=c.getContext('2d');
    x.fillStyle='#150d18';x.fillRect(0,0,1080,1350);
    try{const i=await loadImg((r.image&&(r.image.large||r.image.src))||'/img/ingredients.webp');const sc=Math.max(1080/i.width,760/i.height);x.drawImage(i,(1080-i.width*sc)/2,(760-i.height*sc)/2,i.width*sc,i.height*sc)}catch{}
    const g=x.createLinearGradient(0,560,0,800);g.addColorStop(0,'rgba(21,13,24,0)');g.addColorStop(1,'#150d18');x.fillStyle=g;x.fillRect(0,540,1080,260);
    x.fillStyle='#ffc24d';x.font='600 26px Inter, sans-serif';x.fillText('ASK MALCOLM, YOUR AI CHEF',60,800);
    x.fillStyle='#f5efe4';x.font='700 64px Fraunces, Georgia, serif';let y=880;wrap(x,r.title,60,y,960,72).forEach(l=>{x.fillText(l,60,y);y+=72});
    x.font='400 30px Inter, sans-serif';x.fillStyle='#d2c9ba';x.fillText(`⏱ ${r.totalMinutes} min  ·  ${r.difficulty}  ·  serves ${r.servings||r.baseServings}  ·  ${r.cuisine}`,60,y+10);y+=70;
    x.font='400 28px Inter, sans-serif';x.fillStyle='#f5efe4';r.ingredients.slice(0,6).forEach(i=>{if(y<1250){x.fillText('• '+(i.display||i.name),60,y);y+=42}});
    const gb=x.createLinearGradient(60,0,1020,0);gb.addColorStop(0,'#f29a1f');gb.addColorStop(.5,'#d7262e');gb.addColorStop(1,'#2f8f4b');x.fillStyle=gb;x.fillRect(60,1262,960,4);
    try{const m=await loadImg('/img/brand/mark-180.png');x.drawImage(m,60,1282,48,48)}catch{}x.font='800 30px Inter, sans-serif';x.fillStyle='#ff6a4a';x.fillText('AI',122,1318);let wx=122+x.measureText('AI').width;x.font='italic 500 30px Fraunces, Georgia, serif';x.fillStyle='#fff6e6';x.fillText('chef',wx+2,1318);wx+=x.measureText('chef').width+2;x.font='700 30px Fraunces, Georgia, serif';x.fillStyle='#5cc979';x.fillText('.food',wx,1318);
    c.toBlob(async b=>{const file=new File([b],`${fname(r)}.png`,{type:'image/png'});
      if(navigator.canShare&&navigator.canShare({files:[file]})&&matchMedia('(pointer:coarse)').matches){try{await navigator.share({files:[file],title:r.title});return}catch{}}
      const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);LP.toast('Image card downloaded')},'image/png');
  }
  function wrap(x,t,_,__,w){const out=[];let line='';for(const word of t.split(' ')){const tryL=line?line+' '+word:word;if(x.measureText(tryL).width>w&&line){out.push(line);line=word}else line=tryL}out.push(line);return out.slice(0,3)}
  async function share(r,el,btn,shareId){
    const row=el.querySelector('.share-row');
    if(!row.hidden){row.hidden=true;btn.setAttribute('aria-expanded','false');return}
    let url=shareId?location.href:null;
    if(!url){try{url=(await LP.api('/api/share',{method:'POST',body:{recipe:r}})).url}catch(e){LP.toast(e.message);return}}
    const text=`${r.title} — an AIchef.food recipe by Malcolm`;const u=encodeURIComponent(url),t=encodeURIComponent(text);
    const img=encodeURIComponent(new URL((r.image&&r.image.og)||'/img/hero.jpg',location.origin).href);
    const links=[['X',`https://twitter.com/intent/tweet?text=${t}&url=${u}`],['Facebook',`https://www.facebook.com/sharer/sharer.php?u=${u}`],['WhatsApp',`https://wa.me/?text=${t}%20${u}`],['Pinterest',`https://pinterest.com/pin/create/button/?url=${u}&media=${img}&description=${t}`],['LinkedIn',`https://www.linkedin.com/sharing/share-offsite/?url=${u}`],['Email',`mailto:?subject=${t}&body=${t}%0A%0A${u}`]];
    row.innerHTML=`${navigator.share?'<button class="btn sm" data-native>📱 Share…</button>':''}<button class="btn ghost sm" data-copy>🔗 Copy link</button>`+links.map(([n,h])=>`<a class="btn ghost sm" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${n}</a>`).join('');
    row.querySelector('[data-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(url);LP.toast('Link copied')}catch{prompt('Copy this link:',url)}};
    const nb=row.querySelector('[data-native]');if(nb)nb.onclick=()=>navigator.share({title:r.title,text,url}).catch(()=>{});
    row.hidden=false;btn.setAttribute('aria-expanded','true');
  }
  window.RecipeView={card,pdf,imageCard,hydrate,RB,bindRate,paint};
})();
/* dish-images v2 */
