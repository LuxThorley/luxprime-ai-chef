'use strict';
(async function(){try{const {plans}=await LP.api('/api/plans');const p=plans.find(x=>x.id==='restaurant');if(p){document.getElementById('rPrice').innerHTML=`${LP.esc(p.price)}<small>/month</small>`;document.getElementById('rAnnual').textContent=`or ${p.annualPrice}/year — save ${p.savePct}%`}}catch{}})();
