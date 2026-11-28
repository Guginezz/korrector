
const CATS={typo:'🔴 Опечатка',spell:'🟠 Орфография',punct:'🔵 Пунктуация',gram:'🟣 Грамматика',style:'⚪ Стиль'};
const DEBOUNCE=800;
const PROMPT=`Ты корректор русского текста. Верни ТОЛЬКО JSON: {"issues":[{"original":"...","fixed":"...","category":"typo|spell|punct|gram|style","note":"..."}]}.
Категории: typo — опечатка, промах по соседней клавише или автозамена Т9 (круэок вместо кружок); spell — орфография; punct — пунктуация; gram — грамматика, падежи, согласование; style — неудачная конструкция, порядок слов, тяжёлая фраза.
Пользователь может прислать контекст до и после: он нужен только чтобы понять смысл, а исправления бери только из блока «ПРОВЕРЬ ЭТОТ ТЕКСТ» (original дословно оттуда). Сначала пойми смысл предложения целиком, потом проверяй каждое слово в связке с соседними словами и с предыдущей фразой. Проверяй каждое слово в контексте фразы, а не по словарю: если слово существует, но по смыслу не подходит и похоже на опечатку или автозамену, это typo; слова, которых нет в языке, тоже ошибки. Пример: «Очин коряви текст» → original «Очин коряви», fixed «Очень корявый», category typo. Не пропускай такие случаи, даже если слово есть в словаре.
Правила: original — дословный короткий фрагмент из текста (слово или несколько слов; для пунктуации слово рядом со знаком). fixed — тот же фрагмент исправленным. Идти строго в порядке появления в тексте. Не трогай мат, сленг, авторский стиль и намеренные приёмы. Не переписывай текст целиком. Для style fixed — осторожное предложение, а note мягкий, без слов «плохо» и «неправильно» (например «здесь можно споткнуться при чтении»). note до 12 слов. Внутри значений экранируй кавычки и не используй переносы строк. Если проблем нет, верни {"issues":[]}.`;
const $=s=>document.querySelector(s);
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const doc=$('#doc'),fab=$('#fab');
doc.contentEditable='plaintext-only';if(doc.contentEditable!=='plaintext-only')doc.contentEditable='true';
const CE=doc.contentEditable;
let issues={},nid=0,cur=null,side='f',tm,ft,busy=false,saved=null;
const PROV={
  gemini:{n:'Google Gemini',m:'gemini-3.5-flash'},
  groq:{n:'Groq',u:'https://api.groq.com/openai/v1/chat/completions',m:'openai/gpt-oss-120b'},
  mistral:{n:'Mistral',u:'https://api.mistral.ai/v1/chat/completions',m:'mistral-small-latest'},
  cerebras:{n:'Cerebras',u:'https://api.cerebras.ai/v1/chat/completions',m:'gpt-oss-120b'},
  openrouter:{n:'OpenRouter',u:'https://openrouter.ai/api/v1/chat/completions',m:''},
  custom:{n:'Другой (OpenAI-совместимый)',u:'',m:''}
};
const ls=(k,v)=>{try{if(v===undefined)return localStorage.getItem(k)||'';localStorage.setItem(k,v)}catch(e){}return ''};
const sel=$('#prov');
for(const k in PROV)sel.add(new Option(PROV[k].n,k));
sel.value=ls('prov')||'gemini';
function loadP(){
  const p=sel.value;
  $('#key').value=ls('k:'+p);$('#mdl').value=ls('m:'+p);$('#url').value=ls('u:custom');
  $('#mdl').placeholder='Модель'+(PROV[p].m?' (пусто = '+PROV[p].m+')':'');
  $('#url').hidden=p!=='custom';
}
loadP();
sel.onchange=()=>{ls('prov',sel.value);loadP()};
$('#key').oninput=()=>ls('k:'+sel.value,$('#key').value.trim());
$('#mdl').oninput=()=>ls('m:'+sel.value,$('#mdl').value.trim());
$('#url').oninput=()=>ls('u:custom',$('#url').value.trim());
let snap=null;const ub=document.createElement('button');ub.id='undo';ub.className='g';ub.textContent='Отменить';ub.disabled=true;$('#cp').after(ub);
function snapshot(){snap=doc.innerHTML;ub.disabled=false}
ub.onclick=()=>{if(snap===null)return;doc.innerHTML=snap;snap=null;ub.disabled=true;upd()};
const text=()=>doc.contentEditable==='plaintext-only'?doc.textContent:doc.innerText,msg=t=>{$('#msg').textContent=t};
function upd(){
  const e=!text().trim();doc.classList.toggle('e',e);$('#go').disabled=busy||e;
  const m=[...doc.querySelectorAll('mark.m')];
  $('#cnt').textContent=m.length?'Найдено: '+m.length:'';
  $('#all').disabled=!m.some(x=>issues[x.dataset.i]&&issues[x.dataset.i].c!=='style');
}
doc.oninput=upd;
doc.addEventListener('paste',e=>{if(doc.contentEditable==='plaintext-only')return;e.preventDefault();document.execCommand('insertText',false,(e.clipboardData||window.clipboardData).getData('text/plain'))});

const SCHEMA={type:'OBJECT',properties:{issues:{type:'ARRAY',items:{type:'OBJECT',properties:{original:{type:'STRING'},fixed:{type:'STRING'},category:{type:'STRING',enum:['typo','spell','punct','gram','style']},note:{type:'STRING'}},required:['original','fixed','category','note']}}},required:['issues']};
const SAFE=['HARASSMENT','HATE_SPEECH','SEXUALLY_EXPLICIT','DANGEROUS_CONTENT'].map(c=>({category:'HARM_CATEGORY_'+c,threshold:'BLOCK_NONE'}));
const API='https://generativelanguage.googleapis.com/v1beta/models';
const cache=new Map();let skipped=0;
function gcall(u,key,M){
  return fetch(API+'/'+encodeURIComponent(M)+':generateContent?key='+encodeURIComponent(key),{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({systemInstruction:{parts:[{text:PROMPT}]},contents:[{role:'user',parts:[{text:u}]}],safetySettings:SAFE,
      generationConfig:{temperature:0,maxOutputTokens:8192,responseMimeType:'application/json',responseSchema:SCHEMA}})});
}
function ocall(u,key,M,url,json){
  return fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
    body:JSON.stringify({model:M,temperature:0,...(json?{response_format:{type:'json_object'}}:{}),
      messages:[{role:'system',content:PROMPT},{role:'user',content:u}]})});
}
async function ask(t,b,a){
  const p=sel.value,P=PROV[p],key=$('#key').value.trim(),M=$('#mdl').value.trim()||P.m,url=p==='custom'?$('#url').value.trim():P.u;
  const bad=m=>{$('#set').open=true;throw new Error(m)};
  if(!key)bad('Сначала вставь API-ключ');
  if(!M)bad('Впиши название модели');
  if(p!=='gemini'&&!url)bad('Впиши адрес API');
  const u=(b||a)?"КОНТЕКСТ ДО (не проверять):\n"+(b||"")+"\n\nПРОВЕРЬ ЭТОТ ТЕКСТ:\n"+t+"\n\nКОНТЕКСТ ПОСЛЕ (не проверять):\n"+(a||""):t;
  let r;
  for(let k=0;;k++){
    r=p==='gemini'?await gcall(u,key,M):await ocall(u,key,M,url,true);
    if(r.status===400&&p!=='gemini')r=await ocall(u,key,M,url,false);
    if((r.status!==429&&r.status!==503)||k>=4)break;
    let e='';try{e=(await r.clone().json()).error.message}catch(x){}
    const w=e.match(/(?:retry|try again) in (?:(\d+)m)?([\d.]+)s/i),sec=Math.min(60,w?(+(w[1]||0))*60+parseFloat(w[2])+1:12);
    for(let n=Math.ceil(sec);n>0;n--){msg('Лимит или нагрузка, жду '+n+' с…');await new Promise(x=>setTimeout(x,1000))}
  }
  if(!r.ok){
    let e='';try{e=(await r.json()).error.message}catch(x){}
    if(r.status===404&&p==='gemini'){try{const l=await(await fetch(API+'?key='+encodeURIComponent(key))).json();
      e+=' Доступны: '+l.models.filter(x=>(x.supportedGenerationMethods||[]).includes('generateContent')&&/flash/.test(x.name)).slice(0,8).map(x=>x.name.replace('models/','')).join(', ')}catch(x){}}
    throw new Error('Ошибка '+r.status+(r.status==429?': лимит, подожди':'')+(e?' — '+e.slice(0,220):''));
  }
  const j=await r.json();let raw='',fr='';
  if(p==='gemini'){
    const c=j.candidates&&j.candidates[0],ps=(c&&c.content&&c.content.parts)||[];
    raw=ps.filter(x=>!x.thought).map(x=>x.text||'').join('');fr=c&&c.finishReason||'';
  }else raw=(((j.choices||[{}])[0].message)||{}).content||'';
  if(!raw)throw new Error('Пустой ответ'+(fr?' ('+fr+')':''));
  const m=raw.match(/\{[\s\S]*\}/);
  try{const v=JSON.parse(m?m[0]:raw).issues;return Array.isArray(v)?v:[]}catch(x){throw new Error('Модель ответила не в том формате')}
}
function chunks(t){
  const p=t.match(/[^\n.!?…]*[\n.!?…]+\s*|[^\n.!?…]+$/g)||[t];
  if(p.join('')!==t)return [t];
  const o=[];let c='';
  for(const x of p){if(c&&c.length+x.length>(sel.value==='gemini'?9000:1500)){o.push(c);c=''}c+=x}
  if(c)o.push(c);return o;
}
function frag(t,list){
  const f=document.createDocumentFragment();let p=0;
  for(const it of list){
    if(typeof it.original!=='string'||typeof it.fixed!=='string'||!it.original||it.original===it.fixed)continue;
    const i=t.indexOf(it.original,p);if(i<0){skipped++;continue}
    if(i>p)f.append(t.slice(p,i));
    const id=nid++,c=CATS[it.category]?it.category:'spell';
    issues[id]={fv:it.fixed,c,n:String(it.note||''),ov:it.original};
    const m=document.createElement('mark');m.className='m';m.dataset.i=id;
    m.style.setProperty('--c','var(--'+c+')');m.textContent=it.original;f.append(m);
    p=i+it.original.length;
  }
  f.append(t.slice(p));return f;
}
async function run(job){
  busy=true;snapshot();doc.contentEditable='false';upd();msg('Проверяю…');
  try{msg(await job()||'')}catch(e){msg(e.message||'Не удалось проверить')}
  doc.contentEditable=CE;busy=false;upd();
}
$('#go').onclick=()=>run(async()=>{
  const cs=chunks(text()),f=document.createDocumentFragment(),pk=sel.value+'|'+($('#mdl').value.trim()||PROV[sel.value].m)+'|';
  let bad=0,done=0,stop='';skipped=0;
  for(let i=0;i<cs.length;i++){
    if(stop){f.append(cs[i]);continue}
    msg('Проверяю '+(i+1)+' из '+cs.length+'…');
    try{
      let l=cache.get(pk+cs[i]);
      if(!l){l=await ask(cs[i],(cs[i-1]||"").slice(-200),(cs[i+1]||"").slice(0,200));cache.set(pk+cs[i],l)}
      f.append(frag(cs[i],l));done++;
    }catch(e){
      f.append(cs[i]);
      if(/Ошибка 4|API-ключ|название модели|адрес API/.test(e.message))stop=e.message;else bad++;
    }
  }
  if(stop&&!done)throw new Error(stop);
  doc.replaceChildren(f);
  if(stop)throw new Error('Остановлено: '+stop+' Готовые куски сохранены.');
  return [bad?'Не проверено кусков: '+bad+'.':'',skipped?'Пропущено правок: '+skipped+'.':''].filter(Boolean).join(' ');
});
$('#all').onclick=()=>{snapshot();
  doc.querySelectorAll('mark.m').forEach(m=>{const g=issues[m.dataset.i];if(g&&g.c!=='style')m.replaceWith(document.createTextNode(g.fv))});
  doc.normalize();upd();
};
$('#cp').onclick=()=>navigator.clipboard.writeText(text());

/* кнопка у выделения, появляется через 0.4 с */
const mkOf=n=>{const e=n.nodeType===1?n:n.parentElement;return e&&e.closest('mark.m')};
document.addEventListener('selectionchange',()=>{
  clearTimeout(ft);fab.hidden=true;
  const s=getSelection();if(!s.rangeCount||!s.anchorNode||!doc.contains(s.anchorNode)||!$('#pop').hidden)return;
  const r=s.getRangeAt(0),a=mkOf(r.startContainer),b=mkOf(r.endContainer),mk=a&&a===b?a:null;
  if(r.collapsed&&!mk)return;
  ft=setTimeout(()=>{saved={r:r.cloneRange(),mk};showFab(r,mk)},400);
});
function showFab(r,mk){
  fab.textContent=mk?'Править':'Проверить отрезок';fab.hidden=false;
  const bb=(r.collapsed&&mk?mk:r).getBoundingClientRect(),vv=window.visualViewport;
  let top=bb.bottom+36;if(top+50>(vv?vv.height:innerHeight))top=Math.max(8,bb.top-96);
  fab.style.top=top+'px';
  fab.style.left=Math.min(Math.max(8,bb.left),innerWidth-fab.offsetWidth-8)+'px';
}
fab.onclick=()=>{
  fab.hidden=true;if(!saved)return;const{r,mk}=saved;
  if(mk){openPop(mk);return}
  const t=r.toString();if(!t.trim())return;
  run(async()=>{const l=await ask(t);r.deleteContents();r.insertNode(frag(t,l));doc.normalize()});
};

/* окошко исправления */
const G=()=>issues[cur.dataset.i];
function openPop(mk){cur=mk;G().ov=mk.textContent;side='f';draw();$('#pop').hidden=false}
function draw(){
  const g=G();
  $('#pt').textContent=CATS[g.c];$('#pnote').textContent=g.n;
  $('#to').classList.toggle('on',side==='o');$('#tf').classList.toggle('on',side==='f');
  $('#ed').value=side==='f'?g.fv:g.ov;
  $('#df').style.setProperty('--c','var(--'+g.c+')');diff();
}
$('#to').onclick=()=>{side='o';draw()};
$('#tf').onclick=()=>{side='f';draw()};
$('#ed').oninput=()=>{G()[side==='f'?'fv':'ov']=$('#ed').value;clearTimeout(tm);tm=setTimeout(diff,DEBOUNCE)};
$('#x').onclick=()=>{$('#pop').hidden=true};
$('#pop').onclick=e=>{if(e.target.id==='pop')$('#pop').hidden=true};
$('#ap').onclick=()=>{snapshot();
  const g=G();cur.replaceWith(document.createTextNode(side==='f'?g.fv:g.ov));
  doc.normalize();$('#pop').hidden=true;upd();
};
const tok=s=>s.length<=60?[...s]:s.split(/(\s+)/).filter(Boolean);
function diff(){
  const g=G(),a=tok(g.ov),b=tok(g.fv),m=a.length,n=b.length;
  const L=Array.from({length:m+1},()=>new Uint16Array(n+1));
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)L[i][j]=a[i]===b[j]?L[i+1][j+1]+1:Math.max(L[i+1][j],L[i][j+1]);
  let i=0,j=0,ha='',hb='';const w=x=>'<b>'+esc(x)+'<\/b>';
  while(i<m&&j<n){
    if(a[i]===b[j]){ha+=esc(a[i]);hb+=esc(b[j]);i++;j++}
    else if(L[i+1][j]>=L[i][j+1])ha+=w(a[i++]);else hb+=w(b[j++]);
  }
  while(i<m)ha+=w(a[i++]);while(j<n)hb+=w(b[j++]);
  $('#df').innerHTML=side==='f'?hb:ha;
}
upd();
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw2.js').catch(()=>{});
r.dataset.i];
function openPop(mk){cur=mk;G().ov=mk.textContent;side='f';draw();$('#pop').hidden=false}
function draw(){
  const g=G();
  $('#pt').textContent=CATS[g.c];$('#pnote').textContent=g.n;
  $('#to').classList.toggle('on',side==='o');$('#tf').classList.toggle('on',side==='f');
  $('#ed').value=side==='f'?g.fv:g.ov;
  $('#df').style.setProperty('--c','var(--'+g.c+')');diff();
}
$('#to').onclick=()=>{side='o';draw()};
$('#tf').onclick=()=>{side='f';draw()};
$('#ed').oninput=()=>{G()[side==='f'?'fv':'ov']=$('#ed').value;clearTimeout(tm);tm=setTimeout(diff,DEBOUNCE)};
$('#x').onclick=()=>{$('#pop').hidden=true};
$('#pop').onclick=e=>{if(e.target.id==='pop')$('#pop').hidden=true};
$('#ap').onclick=()=>{
  const g=G();cur.replaceWith(document.createTextNode(side==='f'?g.fv:g.ov));
  doc.normalize();$('#pop').hidden=true;upd();
};
const tok=s=>s.length<=60?[...s]:s.split(/(\s+)/).filter(Boolean);
function diff(){
  const g=G(),a=tok(g.ov),b=tok(g.fv),m=a.length,n=b.length;
  const L=Array.from({length:m+1},()=>new Uint16Array(n+1));
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)L[i][j]=a[i]===b[j]?L[i+1][j+1]+1:Math.max(L[i+1][j],L[i][j+1]);
  let i=0,j=0,ha='',hb='';const w=x=>'<b>'+esc(x)+'<\/b>';
  while(i<m&&j<n){
    if(a[i]===b[j]){ha+=esc(a[i]);hb+=esc(b[j]);i++;j++}
    else if(L[i+1][j]>=L[i][j+1])ha+=w(a[i++]);else hb+=w(b[j++]);
  }
  while(i<m)ha+=w(a[i++]);while(j<n)hb+=w(b[j++]);
  $('#df').innerHTML=side==='f'?hb:ha;
}
upd();
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
