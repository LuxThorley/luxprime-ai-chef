(()=>{const{api,esc}=window.LP;const $=s=>document.querySelector(s);const q=new URLSearchParams(location.search);
const fmt=t=>new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
async function showOrder(id,t){const box=$('#giftOrder');box.innerHTML='<p class="note">Loading your gift…</p>';
  for(let i=0;i<10;i++){let o;try{o=await api(`/api/gift/order/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`)}catch(e){box.innerHTML=`<p class="note">${esc(e.message)}</p>`;return}
    if(o.status==='paid'){const cert=`/api/gift/order/${encodeURIComponent(id)}/certificate?t=${encodeURIComponent(t)}`;
      const deliv=o.delivery==='print'?'Download and print the certificate to hand over in person.':o.emailStatus==='scheduled'?`We’ll email ${esc(o.recipientName)} on ${fmt(o.sendAt)}.`:o.emailStatus==='sent'?`We’ve emailed ${esc(o.recipientName)} at ${esc(o.recipientEmail)}.`:`Email delivery to ${esc(o.recipientEmail)} is pending — you can also share the certificate yourself.`;
      box.innerHTML=`<div class="card" style="padding:22px;margin-top:14px"><span class="eyebrow">Thank you — payment received</span><h3 style="margin:.3em 0">${esc(o.term)} of ${esc(o.planName)} for ${esc(o.recipientName)}</h3><p>${deliv}</p><div class="gift-code" aria-label="Gift code">${esc(o.code)}</div><p class="muted" style="font-size:.85rem">Single-use · redeem at aichef.food/redeem by ${fmt(o.expiresAt)} · ${o.redeemed?'<b>Redeemed</b>':'not yet redeemed'} · paid ${esc(o.amount)} once. Keep this page’s link private: it shows the code.</p><p class="actions"><a class="btn" href="${cert}" target="_blank" rel="noopener">Download gift certificate (PDF)</a> <a class="btn ghost" href="/gift">Give another gift</a></p></div>`;$('#giftForm').hidden=true;return}
    box.innerHTML='<p class="note">Waiting for payment confirmation from Stripe…</p>';await new Promise(r=>setTimeout(r,2500))}
  box.innerHTML='<p class="note">We haven’t received payment confirmation yet. If you completed payment, refresh in a minute — your receipt email has the link too.</p>'}
async function init(){if(q.get('order')&&q.get('t'))showOrder(q.get('order'),q.get('t'));if(q.get('checkout')==='cancelled')$('#giftOrder').innerHTML='<p class="note">Checkout cancelled — nothing was charged.</p>';
  const [o,me]=await Promise.all([api('/api/gift/options'),api('/api/me').catch(()=>({}))]);
  $('#giftPlans').innerHTML=o.plans.map((p,i)=>`<label class="gift-plan"><input type="radio" name="plan" value="${esc(p.id)}" ${p.id==='head'?'checked':''}><b>${esc(p.name)}</b><small>${esc(p.blurb)}</small><small>from ${esc(p.prices[1])}</small></label>`).join('');
  const pre=q.get('plan');if(pre&&document.querySelector(`input[name=plan][value="${CSS.escape(pre)}"]`))document.querySelector(`input[name=plan][value="${CSS.escape(pre)}"]`).checked=true;
  $('#giftTerms').innerHTML=o.terms.map(t=>`<label><input type="radio" name="months" value="${t.months}" ${t.months===3?'checked':''}><span>${t.months===1?'1 month (monthly)':esc(t.label)}</span></label>`).join('');
  const price=()=>{const p=o.plans.find(x=>x.id===document.querySelector('input[name=plan]:checked').value);const m=+document.querySelector('input[name=months]:checked').value;$('#giftPrice').textContent=`${p.name} · ${m===1?'1 month':m+' months'}: ${p.prices[m]} paid once${m===12?' (annual price — best value)':''}. No renewal.`};
  const deliv=()=>{$('#emailBits').hidden=document.querySelector('input[name=delivery]:checked').value!=='email'};
  document.addEventListener('change',e=>{if(['plan','months'].includes(e.target.name))price();if(e.target.name==='delivery')deliv()});price();deliv();
  const d=new Date();$('#gSendOn').min=d.toISOString().slice(0,10);d.setFullYear(d.getFullYear()+1);$('#gSendOn').max=d.toISOString().slice(0,10);
  if(me&&me.user&&me.user.name)$('#gBuyer').value=me.user.name;
  $('#giftForm').addEventListener('submit',async e=>{e.preventDefault();$('#giftErr').textContent='';
    if(!me||!me.user){$('#giftErr').innerHTML='Please <a href="/account.html?next=/gift">sign in or create a free account</a> to buy a gift (so we can send your receipt).';return}
    const b={plan:document.querySelector('input[name=plan]:checked').value,months:+document.querySelector('input[name=months]:checked').value,delivery:document.querySelector('input[name=delivery]:checked').value,buyerName:$('#gBuyer').value.trim(),recipientName:$('#gRecipient').value.trim(),recipientEmail:$('#gEmail').value.trim(),message:$('#gMsg').value.trim(),sendOn:$('#gSendOn').value};
    if(b.delivery==='print'){b.recipientEmail='';b.sendOn=''}
    const btn=$('#giftBuy');btn.disabled=true;btn.textContent='Opening secure checkout…';
    try{const r=await api('/api/gift/checkout',{method:'POST',body:b});location.href=r.url}catch(err){$('#giftErr').textContent=err.message;btn.disabled=false;btn.textContent='Continue to secure payment'}});
  if(!o.onSale){$('#giftBuy').disabled=true;$('#giftErr').textContent='Gift purchases open soon.'}}
init().catch(e=>{$('#giftErr').textContent=e.message})})();
