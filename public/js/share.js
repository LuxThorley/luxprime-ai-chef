'use strict';
(async function(){
  const box=document.getElementById('shared');const id=box.dataset.shareId||new URLSearchParams(location.search).get('id');
  try{const {recipe}=await LP.api('/api/share/'+encodeURIComponent(id||''));box.innerHTML='';box.appendChild(RecipeView.card(recipe,{shareId:id}));
    const c=document.createElement('div');c.className='card no-print';c.style.textAlign='center';c.innerHTML='<h2>Cook something like this with your own ingredients</h2><a class="btn" href="/app.html">Try the Lux Prime AI Chef free</a>';box.appendChild(c)}
  catch{box.innerHTML='<div class="card empty"><div class="big">🍽</div><h2>Recipe not found</h2><a class="btn" href="/app.html">Open the AI Chef</a></div>'}
})();
