'use strict';
(async function(){const box=document.getElementById('one');const id=new URLSearchParams(location.search).get('id')||'';
  if(/^esc-/.test(id)){location.replace('/escoffier.html?no='+encodeURIComponent(id.slice(4)));return}
  try{const {recipe}=await LP.api('/api/recipes/'+encodeURIComponent(id));document.title=recipe.title+' · AIchef.food';box.innerHTML='';box.appendChild(RecipeView.card(recipe));if(window.LPChat)LPChat.mount(box,{recipe:()=>({title:recipe.title,ingredients:(recipe.ingredients||[]).map(i=>i.display||i.name).slice(0,40),steps:(recipe.steps||[]).map(s=>s.text).slice(0,30),totalMinutes:recipe.totalMinutes,servings:recipe.servings})});RecipeView.hydrate(box);
    const c=document.createElement('div');c.className='card no-print';c.style.cssText='text-align:center;margin-top:18px';c.innerHTML='<h2>Want something like this with your ingredients?</h2><a class="btn" href="/app.html">Ask Malcolm</a> <a class="btn ghost" href="/favourites.html">My favourites</a>';box.appendChild(c)}
  catch(e){box.innerHTML=`<div class="card empty"><div class="big">🍽</div><h2>${e.status===404?'Recipe not found':'Could not load this recipe'}</h2><p class="muted">It may not have been saved or rated yet.</p><div class="next"><a class="btn" href="/app.html">Ask Malcolm</a><a class="btn ghost" href="/#kings">Top-rated recipes</a></div></div>`}
})();
