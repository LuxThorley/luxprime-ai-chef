'use strict';
// Static (GitHub Pages) edition: replaces the server API with an in-browser engine. No accounts, no payments.
(function(){
  const E=window.LPEngine, COMING='Coming soon – full service. Accounts and subscriptions launch with the full Lux Prime Kitchen server.';
  const DIETS=['vegetarian','vegan','gluten-free','dairy-free','nut-free','halal'];
  const user={id:0,name:'Guest',email:'',plan:'static',premium:false,searchesLeft:'unlimited',static:true};
  const b64e=s=>btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const b64d=s=>decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/'))));
  const fail=(msg,status=501)=>{const e=new Error(msg);e.status=status;e.data={error:msg};throw e};
  function slim(r){const keep={id:r.id,title:r.title,cuisine:r.cuisine,difficulty:r.difficulty,totalMinutes:r.totalMinutes,servings:r.servings,baseServings:r.baseServings,matchScore:r.matchScore,whyItFits:r.whyItFits,ingredients:r.ingredients,steps:r.steps,allergens:r.allergens,nutritionPerServing:r.nutritionPerServing,substitutions:r.substitutions,safetyNotes:r.safetyNotes,shoppingList:r.shoppingList,diet:r.diet,image:r.image,tags:r.tags,source:r.source};return keep}
  async function api(url,opts={}){
    const m=(opts.method||'GET').toUpperCase(), body=opts.body&&typeof opts.body==='string'?JSON.parse(opts.body):(opts.body||{});
    const path=url.replace(/^\.?\/?/,'/');
    if(path==='/api/me'&&m==='GET')return {user};
    if(path==='/api/options')return {diets:DIETS,allergens:E.UK14,cuisines:['any',...new Set(E.RECIPES.map(r=>r.cuisine))].sort()};
    if(path==='/api/plans'){const {plans}=E;return {plans:Object.values(plans).map(p=>({...p,available:false}))}}
    if(path==='/api/search'){
      if(!(body.include||[]).length&&!body.dish)fail('Add at least one ingredient or describe a dish',400);
      const q={...body,difficulty:body.difficulty==='any'?null:body.difficulty,limit:5};
      const recipes=E.rank(q,{limit:5}).map(r=>({...r,image:r.image,safetyNotes:E.safetyNotes(r,q)}));
      return {source:'offline',disclaimer:E.DISCLAIMER,recipes,user};
    }
    if(path==='/api/share'&&m==='POST'){const id=b64e(JSON.stringify(slim(body.recipe)));return {id,url:new URL('share.html?id='+id,location.href).href}}
    const sm=path.match(/^\/api\/share\/(.+)$/);if(sm){try{return {recipe:JSON.parse(b64d(decodeURIComponent(sm[1])))}}catch{fail('Not found',404)}}
    fail(COMING);
  }
  LP.api=api;LP.STATIC=true;LP.COMING=COMING;
  document.addEventListener('DOMContentLoaded',()=>{const b=document.createElement('div');b.className='note no-print';b.style.cssText='margin:0;border-radius:0;text-align:center;padding:8px 14px;font-size:.9rem';
    b.innerHTML='Preview edition · runs on the Lux Prime curated library in your browser. <strong>Coming soon – full service</strong> with Malcolm AI, accounts and subscriptions.';
    const h=document.getElementById('site-header');h&&h.after(b)});
})();
