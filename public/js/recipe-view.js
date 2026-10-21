'use strict';
// Shared recipe renderer: timers, print, PDF export (jsPDF, client-side), image card (canvas), share.
(function(){
  const {esc}=window.LP;
  const ALN={'cereals containing gluten':'gluten'};
  function card(r,{actions=true,premium=false,shareId=null}={}){
    const img=r.image||{src:'/img/ingredients-sm.webp',alt:r.title};
    const el=document.createElement('article');el.className='card recipe';el.dataset.id=r.id;
    el.innerHTML=`<div class="photo"><img src="${esc(img.large||img.src)}" alt="${esc(img.alt||r.title)}" loading="lazy" decoding="async" ${img.fallback?`data-fallback="${esc(img.fallback)}"`:''}></div>
    <div class="recipe-head"><div style="flex:1;min-width:220px"><h3 style="font-size:1.7rem;margin:0">${esc(r.title)}</h3>
    ${r.whyItFits?`<p class="why" style="margin:.3em 0">Why it fits: ${esc(r.whyItFits)}</p>`:''}
    <div class="meta"><span class="pill">⏱ ${esc(r.totalMinutes)} min</span><span class="pill">${esc(r.difficulty)}</span><span class="pill">🍽 serves ${esc(r.servings||r.baseServings)}</span><span class="pill">${esc(r.cuisine)}</span>${Object.entries(r.diet||{}).filter(([,v])=>v).map(([k])=>`<span class="pill">${esc(k)}</span>`).join('')}</div>
    <div class="meta" aria-label="Allergens">${(r.allergens||[]).length?(r.allergens.map(a=>`<span class="pill al">⚠ ${esc(ALN[a]||a)}</span>`).join('')):'<span class="pill">No UK-14 allergens detected</span>'}</div></div>
    ${r.matchScore!=null?`<div class="score" style="--s:${+r.matchScore}" aria-label="Match score ${+r.matchScore} percent"><b>${+r.matchScore}%</b></div>`:''}</div>
    <div class="cols" style="margin-top:12px"><div><h4>Ingredients</h4><ul class="ing" style="padding-left:18px">${r.ingredients.map(i=>`<li>${esc(i.display||i.name)}</li>`).join('')}</ul>
    ${(r.shoppingList||[]).length?`<h4>🛒 Shopping list</h4><ul style="padding-left:18px" class="muted">${r.shoppingList.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>`:''}
    <h4>Nutrition per serving <small class="muted">(estimate)</small></h4><div class="nutri"><div><b>${esc(r.nutritionPerServing.kcal)}</b>kcal</div><div><b>${esc(r.nutritionPerServing.proteinG)}g</b>protein</div><div><b>${esc(r.nutritionPerServing.carbsG)}g</b>carbs</div><div><b>${esc(r.nutritionPerServing.fatG)}g</b>fat</div></div></div>
    <div><h4>Method</h4><ol class="steps">${r.steps.map(s=>`<li>${esc(s.text)}${s.timerMinutes?` <button type="button" class="btn ghost sm timer" data-min="${+s.timerMinutes}" aria-label="Start ${+s.timerMinutes} minute timer">⏲ ${+s.timerMinutes} min</button>`:''}</li>`).join('')}</ol>
    ${(r.substitutions||[]).length?`<h4>Swaps &amp; substitutions</h4><ul style="padding-left:18px">${r.substitutions.map(s=>`<li><strong>${esc(s.ingredient)}</strong> → ${esc(s.swap)}</li>`).join('')}</ul>`:''}
    ${(r.tips||[]).length?`<h4>Chef's tips</h4><ul style="padding-left:18px">${r.tips.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:''}
    ${(r.safetyNotes||[]).length?`<div class="note"><strong>Food safety</strong><ul style="margin:.3em 0 0;padding-left:18px">${r.safetyNotes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`:''}</div></div>
    ${actions?`<div class="actions no-print">${premium?'<button class="btn sm" data-act="fav">♥ Save</button>':'<a class="btn ghost sm" href="/pricing.html" title="Premium feature">♥ Save (Premium)</a>'}
      <button class="btn ghost sm" data-act="print">🖨 Print</button><button class="btn ghost sm" data-act="pdf">⬇ PDF</button><button class="btn ghost sm" data-act="card">🖼 Image card</button><button class="btn ghost sm" data-act="share" aria-expanded="false">↗ Share</button></div><div class="share-row no-print" hidden style="margin-top:10px"></div>`:''}`;
    const im=el.querySelector('.photo img');im.addEventListener('error',()=>{if(im.dataset.fallback&&im.src.indexOf(im.dataset.fallback)<0)im.src=im.dataset.fallback},{once:false});
    el.querySelectorAll('.timer').forEach(b=>b.onclick=()=>timer(b));
    if(actions){
      el.querySelector('[data-act=print]').onclick=()=>{el.classList.add('printing');window.print();setTimeout(()=>el.classList.remove('printing'),500)};
      el.querySelector('[data-act=pdf]').onclick=()=>pdf(r);
      el.querySelector('[data-act=card]').onclick=()=>imageCard(r);
      el.querySelector('[data-act=share]').onclick=e=>share(r,el,e.currentTarget,shareId);
      const f=el.querySelector('[data-act=fav]');if(f)f.onclick=async()=>{try{await LP.api('/api/favourites',{method:'POST',body:{recipe:r}});LP.toast('Saved to favourites ♥')}catch(e){LP.toast(e.message)}};
    }
    return el;
  }
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
    const line=(t,size=10,style='normal',gap=1.5)=>{d.setFont('helvetica',style);d.setFontSize(size);d.splitTextToSize(String(t),W-2*M).forEach(l=>{if(y>282){d.addPage();y=16}d.text(l,M,y);y+=size*.42+gap})};
    d.setTextColor(30,28,24);line(r.title,22,'bold',3);
    line(`${r.totalMinutes} min · ${r.difficulty} · serves ${r.servings||r.baseServings} · ${r.cuisine}`,10,'normal',2);
    if(r.allergens&&r.allergens.length)line('Allergens: '+r.allergens.join(', '),10,'bold',3);
    line('Ingredients',13,'bold',2);r.ingredients.forEach(i=>line('•  '+(i.display||i.name)));y+=3;
    line('Method',13,'bold',2);r.steps.forEach((s,n)=>line(`${n+1}.  ${s.text}${s.timerMinutes?` (${s.timerMinutes} min)`:''}`,10,'normal',2));y+=3;
    if((r.substitutions||[]).length){line('Substitutions',13,'bold',2);r.substitutions.forEach(s=>line(`•  ${s.ingredient} → ${s.swap}`))}
    if((r.safetyNotes||[]).length){y+=3;line('Food safety',13,'bold',2);r.safetyNotes.forEach(s=>line('•  '+s,9))}
    const n=r.nutritionPerServing;y+=3;line(`Nutrition per serving (estimate): ${n.kcal} kcal · ${n.proteinG}g protein · ${n.carbsG}g carbs · ${n.fatG}g fat`,9,'italic');
    y+=4;line('Lux Prime Kitchen · AI Chef powered by Malcolm AI · Always check allergen labels.',8,'italic');
    d.save(`${fname(r)}.pdf`);
  }
  async function imageCard(r){
    const c=document.createElement('canvas');c.width=1080;c.height=1350;const x=c.getContext('2d');
    x.fillStyle='#141517';x.fillRect(0,0,1080,1350);
    try{const i=await loadImg((r.image&&(r.image.large||r.image.src))||'/img/ingredients.webp');const sc=Math.max(1080/i.width,760/i.height);x.drawImage(i,(1080-i.width*sc)/2,(760-i.height*sc)/2,i.width*sc,i.height*sc)}catch{}
    const g=x.createLinearGradient(0,560,0,800);g.addColorStop(0,'rgba(20,21,23,0)');g.addColorStop(1,'#141517');x.fillStyle=g;x.fillRect(0,540,1080,260);
    x.fillStyle='#d9a86c';x.font='600 26px Inter, sans-serif';x.fillText('LUX PRIME KITCHEN · AI CHEF',60,800);
    x.fillStyle='#f5efe4';x.font='700 64px Georgia, serif';let y=880;wrap(x,r.title,60,y,960,72).forEach(l=>{x.fillText(l,60,y);y+=72});
    x.font='400 30px Inter, sans-serif';x.fillStyle='#d2c9ba';x.fillText(`⏱ ${r.totalMinutes} min  ·  ${r.difficulty}  ·  serves ${r.servings||r.baseServings}  ·  ${r.cuisine}`,60,y+10);y+=70;
    x.font='400 28px Inter, sans-serif';x.fillStyle='#f5efe4';r.ingredients.slice(0,6).forEach(i=>{if(y<1250){x.fillText('• '+(i.display||i.name),60,y);y+=42}});
    x.fillStyle='#c27c4a';x.fillRect(60,1290,960,2);x.fillStyle='#bdb5a8';x.font='400 22px Inter, sans-serif';x.fillText('Powered by Malcolm AI · luxprimekitchen',60,1325);
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
    const text=`${r.title} — a Lux Prime Kitchen AI Chef recipe`;const u=encodeURIComponent(url),t=encodeURIComponent(text);
    const img=encodeURIComponent(new URL((r.image&&r.image.og)||'/img/hero.jpg',location.origin).href);
    const links=[['X',`https://twitter.com/intent/tweet?text=${t}&url=${u}`],['Facebook',`https://www.facebook.com/sharer/sharer.php?u=${u}`],['WhatsApp',`https://wa.me/?text=${t}%20${u}`],['Pinterest',`https://pinterest.com/pin/create/button/?url=${u}&media=${img}&description=${t}`],['LinkedIn',`https://www.linkedin.com/sharing/share-offsite/?url=${u}`],['Email',`mailto:?subject=${t}&body=${t}%0A%0A${u}`]];
    row.innerHTML=`${navigator.share?'<button class="btn sm" data-native>📱 Share…</button>':''}<button class="btn ghost sm" data-copy>🔗 Copy link</button>`+links.map(([n,h])=>`<a class="btn ghost sm" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${n}</a>`).join('');
    row.querySelector('[data-copy]').onclick=async()=>{try{await navigator.clipboard.writeText(url);LP.toast('Link copied')}catch{prompt('Copy this link:',url)}};
    const nb=row.querySelector('[data-native]');if(nb)nb.onclick=()=>navigator.share({title:r.title,text,url}).catch(()=>{});
    row.hidden=false;btn.setAttribute('aria-expanded','true');
  }
  window.RecipeView={card,pdf,imageCard};
})();
