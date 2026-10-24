# Builds the full De Materia Medica catalogue (all chapters) as structured data + OWN paraphrased summaries (no source text reproduced).
import re, json, sys
T=open(sys.argv[1] if len(sys.argv)>1 else '/tmp/d.txt').read()
SAFE=json.load(open('src/data/dioscorides.json'))
SAFEMAP={e['id']:e for e in SAFE['entries']}
heads=[(m.start(),m.group(1),m.group(2).strip()) for m in re.finditer(r'^([1-5]-\d+[a-z]?)\. ([A-Z][^\n]*)$',T,re.M)]
seen=set();chap=[]
for i,(p,cid,g) in enumerate(heads):
    end=heads[i+1][0] if i+1<len(heads) else len(T)
    if cid in seen: cid=cid+'b'
    seen.add(cid); chap.append((cid,g,T[p:end]))
ROMAN=['I','II','III','IV','V']
def num(cid): b,n=cid.split('-'); return int(b),int(re.match(r'\d+',n).group())
def category(cid,body):
    b,n=num(cid)
    if b==1: return 'aromatic' if n<=28 else 'oil' if n<=77 else 'resin' if n<=101 else 'tree' if n<=137 else 'fruit'
    if b==2: return 'animal' if n<=74 else 'dairy' if n<=83 else 'animal' if n<=100 else 'honey' if n<=106 else 'cereal' if n<=125 else 'legume' if n<=133 else 'vegetable' if n<=166 else 'herb'
    if b==3: return 'root' if n<=25 else 'herb'
    if b==4: return 'herb'
    return 'vine' if n<=6 else 'wine' if n<=83 else 'mineral'
CATFIX={'1-30':'oil','1-29':'oil','1-39':'oil','1-41':'oil','2-121':'cereal','2-152':'vegetable','2-157':'vegetable','2-160':'vegetable','2-162':'vegetable','2-163':'vegetable','2-164':'fruit','2-165':'vegetable','2-179':'vegetable','2-181':'vegetable','2-182':'vegetable','2-184':'spice','2-189':'spice','2-190':'spice','1-5':'spice','1-12':'spice','1-13':'spice','1-25':'spice','5-126':'mineral','2-171':'herb','2-170':'vegetable','2-185':'vegetable','5-3':'fruit','5-4':'fruit','4-37':'fruit','3-83':'vegetable'}
TOXIC=set('4-79 4-76 4-77 4-78 4-150 4-151 4-69 4-64 4-65 4-66 4-67 4-68 4-71 4-72 4-73 4-74 4-75 4-84 4-82 4-81 4-157 4-171 4-178 4-155 4-154 4-156 4-164 4-165 4-165a 4-165b 4-165c 4-165d 4-165e 4-165f 4-165g 4-166 4-168 4-169 4-170 4-172 4-173 2-65 2-66 2-67 2-18 2-17 3-52 3-53 3-36 3-26 3-27 3-28 2-202 2-201 3-1 3-10 3-11 3-96 4-83 4-85 4-80 2-194 2-195 3-167 2-206 4-162 4-163'.split())
PARTS={'root':r'\broots?\b','leaf':r'\bleaves\b|\bleaf\b','seed':r'\bseeds?\b','flower':r'\bflowers?\b|\bblossoms?\b','fruit':r'\bfruit\b|\bberr(y|ies)\b','bark':r'\bbark\b','juice/sap':r'\bjuice\b|\bsap\b|\bliquid\b','gum/resin':r'\bgum\b|\bresin\b','stalk':r'\bstalks?\b|\bstems?\b','flesh/meat':r'\bflesh\b|\bmeat\b','whole herb':r'\bherb\b'}
PREP={'decoction':r'decoction|boiled? (?:in|with) water','infusion':r'infus|steep','in wine':r'(?:with|in) wine','with honey':r'with honey|honey water|melikrat','with vinegar':r'vinegar|oxymel','with oil':r'with oil|rosaceum','poultice/plaster':r'poultice|plaster|applied','eaten as food':r'\beaten\b|\bfood\b|\beat\b|vegetable','boiled':r'\bboiled\b','roasted':r'\broast','pounded/ground':r'pound|bruised|ground|beaten small','dried':r'\bdried\b','pickled/preserved':r'pickl|preserv|brine|in salt','ointment':r'ointment|salve','drink':r'taken as a drink|drunk|as a drink','gargle/mouthwash':r'gargl|mouthwash|wash the mouth'}
TOPICS={'digestion':r'stomach|belly|bowel|digest|intestin|wind|griping|colic|appetite|nause|vomit|dysenter|laxative|loose','respiratory':r'cough|chest|lung|breath|asthma|throat|phlegm|mucus|catarrh|hoarse','skin':r'skin|freckle|sunburn|itch|scab|lichen|leprosy|psoriasis|warts?|pimple|spots','wounds & ulcers':r'wound|ulcer|sores?|fistula|burns?|bruise','pain & inflammation':r'pain|ache|inflamm|swelling|gout|sciatica|headache','sleep & nerves':r'sleep|convuls|epilep|palsy|paraly|nerve|lethargy|madness|melanchol','women\'s health':r'menstru|womb|uterus|women|breast milk|childbirth|conception|labour','urinary & kidneys':r'urine|kidney|bladder|stone|diuretic','liver & spleen':r'liver|spleen|jaundice|bile','eyes':r'\beyes?\b|sight|eyelid','mouth & teeth':r'teeth|tooth|gums|mouth|toothache','fever':r'fever|ague|shivering','bites & poisons':r'bite|bitten|venom|poison|scorpion|serpent|snake|antidote','hair & scalp':r'hair|dandruff|scalp|bald','circulation & heart':r'heart|blood|bleeding|haemorrh|veins','joints & muscles':r'joint|sinew|muscle|cramp|sprain','ears':r'\bears?\b|deafness','vitality & nourishment':r'nourish|strength|fatten|good juice|wholesome|nutritious'}
PROPS={'warming':r'\bwarm','cooling':r'\bcool','astringent':r'astring|binds','softening':r'soften|emollient','diuretic':r'urine|diuretic','laxative':r'loosens the belly|soften the belly|purg|laxative','drying':r'\bdry(?:ing)?\b','nourishing':r'nourish|good juice|wholesome','sharp/biting':r'sharp|biting','soothing':r'sooth|eas(?:e|es) '}
def clean(s): return re.sub(r'\s+',' ',re.sub(r'\n\d+\n|BOOK [A-Z]+[^\n]*\n|THE HERBAL OF DIOSCORIDES THE GREEK|\b[A-Z][a-z]+ [a-z]+ (?:after|from) [A-Z]+ ?— ?\d{4}','\n',s)).strip()
TOPW={'digestion':'the stomach and digestion','respiratory':'coughs, the chest and the throat','skin':'the skin','wounds & ulcers':'sores and wounds','pain & inflammation':'aches and swellings','sleep & nerves':'sleep and the nerves','women\'s health':"women's complaints",'urinary & kidneys':'the kidneys and urine','liver & spleen':'the liver and spleen','eyes':'the eyes','mouth & teeth':'the mouth and teeth','fever':'fevers','bites & poisons':'bites and poisons','hair & scalp':'the hair and scalp','circulation & heart':'bleeding and the blood','joints & muscles':'joints and muscles','ears':'the ears','vitality & nourishment':'nourishment and strength'}
out=[]
for cid,g,body in chap:
    b,n=num(cid); ref=f"{ROMAN[b-1]}.{cid.split('-')[1]}"
    hb=[]
    for ln in body.split('\n')[1:14]:
        if re.fullmatch(r'[A-Z]',ln.strip()): break
        hb.append(ln.strip())
    hb=re.sub(r'\s+',' ',' '.join(hb)).replace('SUGGESTED:','').strip()
    bot=common=None
    m=re.search(r'([A-Z][a-z]+(?: [a-z\-]+){1,2})\s*\[Linnaeus\]',hb) or re.search(r'^([A-Z][a-z]+(?: [a-z\-]+){1,2})',hb)
    if m: bot=m.group(1)
    m=re.search(r'—\s*([A-Z][^\[—]{2,60})',hb)
    if m: common=re.split(r',|\(| (?=[A-Z][a-z]+ [a-z]{3,})',m.group(1))[0].strip()
    txt=clean(body); low=txt.lower()
    cat=CATFIX.get(cid,category(cid,body))
    s=SAFEMAP.get('D'+cid)
    if s and s['recipeSafe']: safety='recipe-safe'
    elif cid in TOXIC or (s and not s['recipeSafe']): safety='historical-only-toxic'
    elif cat in('mineral','resin') or (cat=='animal') or (b==1 and 29<=n<=77) or (b==5 and 84<=n): safety='non-food'
    elif re.search(r'\b(deadly|kills?|lethal|fatal|destroys? (?:those|them))\b',low): safety='historical-only-toxic'
    else: safety='caution'
    name=(s['name'] if s else None) or common or g.title()
    parts=[] if cat in('animal','mineral','wine','dairy','honey','oil') else [k for k,r in PARTS.items() if re.search(r,low)][:6]
    preps=[k for k,r in PREP.items() if re.search(r,low)]
    topicc={k:len(re.findall(r,low)) for k,r in TOPICS.items()}; topics=[k for k,v in sorted(topicc.items(),key=lambda x:-x[1]) if v]
    props=[k for k,r in PROPS.items() if re.search(r,low)]
    uses=len(re.findall(r'good for|good against|helps?|heals?|cures?|suitable for|is effective|stops|eases|relieves',low))
    catw={'aromatic':'an aromatic','oil':'an oil or ointment','resin':'a gum or resin','tree':'a tree or shrub','fruit':'a fruit','animal':'an animal or animal product','dairy':'a dairy product','honey':'a bee product','cereal':'a cereal or grain','legume':'a pulse','vegetable':'a vegetable','herb':'a herb','root':'a root','vine':'a vine product','wine':'a wine or prepared drink','mineral':'a mineral or earth','spice':'a spice'}[cat]
    sm=f"{name} ({g.title()}) is {catw} in Book {ROMAN[b-1]} of De Materia Medica."
    if bot: sm+=f" Modern identification: {bot}."
    if parts: sm+=f" Dioscorides discusses the {', '.join(parts[:4])}."
    if preps: sm+=f" Preparations he mentions include {', '.join(preps[:5])}."
    if props: sm+=f" He describes it as {', '.join(props[:4])}."
    if topics: sm+=f" He lists uses relating to {', '.join(TOPW[x] for x in topics[:5])}."
    sm+={'recipe-safe':' An ordinary food ingredient that Malcolm can cook with.','caution':' A historical herbal entry. It is not used in our recipes unless it is a familiar culinary food.','historical-only-toxic':' Toxic or dangerous: recorded for history only and never used for cooking.','non-food':' Not a food. Recorded for history only.'}[safety]
    out.append(dict(id='D'+cid,ref=ref,book=b,chapter=cid.split('-')[1],order=b*1000+n,greek=g.title(),name=name,common=common,botanical=bot,category=cat,safety=safety,parts=parts,preparations=preps,properties=props,topics=topics[:8],uses=uses,summary=sm,caution=(s or {}).get('caution')))
json.dump({'source':SAFE['source'].replace(' Short excerpts quoted for reference.',''),'note':'Structured fields and paraphrased summaries by AIchef.food; no source text reproduced.','count':len(out),'entries':out},open('public/data/dioscorides-catalogue.json','w'),ensure_ascii=False,separators=(',',':'))
from collections import Counter
print(len(out),Counter(e['category'] for e in out),Counter(e['safety'] for e in out))

# Recipe-safe subset for the server: paraphrased only (no source sentences).
cat={e['id']:e for e in out}
for e in SAFE['entries']:
    c=cat.get(e['id'])
    if not c: continue
    t=[x for x in c['topics'] if x not in("women's health","bites & poisons")][:3]
    u=[]
    if c['properties']: u.append(f"Dioscorides classed it as {', '.join(c['properties'][:3])}.")
    if t: u.append(f"He recommended it for {', '.join(TOPW[x] for x in t)} ({'De Materia Medica '+c['ref']}).")
    if c['preparations']: u.append(f"His preparations include {', '.join(c['preparations'][:3])}.")
    e['uses']=u; e['properties']=c['properties']; e['preparations']=c['preparations']; e['topics']=c['topics']; e['summary']=c['summary']; e.pop('excerpt',None)
SAFE['source']=SAFE['source'].replace(' Short excerpts quoted for reference.',' Summaries and fields are AIchef.food paraphrases; no source text reproduced.')
json.dump(SAFE,open('src/data/dioscorides.json','w'),ensure_ascii=False,indent=0)
print('safe paraphrased',len(SAFE['entries']))
