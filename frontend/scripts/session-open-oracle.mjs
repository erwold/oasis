import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const R=resolve(process.env.BENCH_ROOT || (()=>{throw Error('BENCH_ROOT required')})()),BASE=process.env.BASE||'http://127.0.0.1:18431',prefix=process.env.PREFIX;
if(!prefix||[8321,8324,8399].includes(Number(new URL(BASE).port)))throw Error('prefix/port refused');
const selected=JSON.parse(readFileSync(join(R,'logs/selected.json'),'utf8')).filter(s=>!process.env.LABELS||process.env.LABELS.split(',').includes(s.label));
const browser=await chromium.launch({channel:'chrome',headless:true});
const bc=await browser.newBrowserCDPSession();const info=await bc.send('SystemInfo.getProcessInfo');appendFileSync(join(R,'logs/processes.jsonl'),JSON.stringify({role:'chrome-ui',driver_pid:process.pid,pids:info.processInfo.map(p=>({pid:p.id,type:p.type})),version:browser.version(),started:new Date().toISOString()})+'\n');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const frame=page=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(null)))));
async function snapshot(page){return page.evaluate(()=>{const t=document.querySelector('.thread-scroll');return {text:t.textContent,children:[...t.children].map(e=>({tag:e.tagName,id:e.getAttribute('data-testid'),text:e.textContent})),code:[...t.querySelectorAll('.code-block')].map(e=>e.textContent),images:[...t.querySelectorAll('img')].map(i=>({src:i.getAttribute('src'),alt:i.alt})),links:[...t.querySelectorAll('a[href]')].map(a=>({href:a.getAttribute('href'),text:a.textContent})),folds:[...t.querySelectorAll('[aria-expanded]')].map(e=>({class:e.className,expanded:e.getAttribute('aria-expanded')}))}})}
async function bottom(page){return page.evaluate(()=>{const t=document.querySelector('.thread-scroll');return {top:t.scrollTop,height:t.scrollHeight,client:t.clientHeight,gap:t.scrollHeight-t.clientHeight-t.scrollTop,jump:!!document.querySelector('[data-testid="jump-bottom"]')}})}
const results=[];
try{for(const sample of selected){
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
 await ctx.addInitScript(()=>localStorage.setItem('oasis-code.token','bench-only-local-not-a-user-credential'));
 await ctx.request.get(BASE+'/api/auth/session?token=bench-only-local-not-a-user-credential');
 const p=await ctx.newPage();const assetReads=[];const servedAssets=[];p.on('response',response=>{const path=new URL(response.url()).pathname;if(/^\/assets\/index-.*\.(js|css)$/.test(path)){assetReads.push((async()=>{const digest=createHash('sha256').update(await response.body()).digest('hex');servedAssets.push({path,sha256:digest});const expected=resolve(R,process.env.TREE||'tree','frontend/dist','.'+path);if(createHash('sha256').update(readFileSync(expected)).digest('hex')!==digest)throw Error('served build differs from measured source artifact')})())}});const errors=[];const finished=new Set();p.on('requestfinished',q=>finished.add(new URL(q.url()).pathname));p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://**',r=>r.abort());await p.goto(BASE);await Promise.all(assetReads);await p.getByTestId('session-'+sample.id).click();
 await p.waitForSelector('.thread-scroll > .turn-group',{timeout:120000});await p.waitForTimeout(1800);
 const initial=await snapshot(p);const initialBottom=await bottom(p);
 const deadline=Date.now()+30000;
 while(!['/runs/tree','/collaboration','/director'].every(suffix=>finished.has(`/api/sessions/${sample.id}${suffix}`))){if(Date.now()>deadline)throw Error('opening ancillary reads did not finish');await p.waitForTimeout(50)}
 await frame(p);
 // Normalize only CONTROL STATE through the app's real handlers, never snapshot fields or text. The baseline
 // first mount can hold an old bot identity until a note redraws; retain initial as evidence of that race.
 const attempts={notes:0,work:0};
 async function clickNotes(open){const n=await p.evaluate(open=>{const buttons=[...document.querySelectorAll('.thread-scroll .note-fold')].filter(e=>e.textContent===(open?'Read it whole':'Fold'));buttons.forEach(e=>e.click());return buttons.length},open);attempts.notes+=n;await frame(p);return n}
 async function clickWork(open){const n=await p.evaluate(open=>{const buttons=[...document.querySelectorAll(`.thread-scroll .work-head[aria-expanded="${!open}"]`)];buttons.forEach(e=>e.click());return buttons.length},open);attempts.work+=n;await frame(p);return n}
 const controlState=()=>p.evaluate(()=>({notesClosed:[...document.querySelectorAll('.thread-scroll .note-fold')].filter(e=>e.textContent==='Read it whole').length,workClosed:document.querySelectorAll('.thread-scroll .work-head[aria-expanded="false"]').length,workOpen:document.querySelectorAll('.thread-scroll .work-head[aria-expanded="true"]').length,detailsClosed:document.querySelectorAll('.thread-scroll details:not([open])').length}));
 await clickNotes(true);await clickNotes(false);await clickWork(true);await clickWork(false);
 await p.evaluate(()=>document.querySelectorAll('.thread-scroll details').forEach(e=>e.open=false));await frame(p);
 const settledCollapsed=await snapshot(p);
 async function expandAll(){for(let pass=0;pass<4;pass++){await clickNotes(true);await clickWork(true);await p.evaluate(()=>document.querySelectorAll('.thread-scroll details').forEach(e=>e.open=true));await frame(p);const state=await controlState();if(!state.notesClosed&&!state.workClosed&&!state.detailsClosed)return {...state,passes:pass+1};}throw Error('expanded controls did not stabilize')}

 // Shelve floating cards via their controls, so subsequent transcript controls are not physically covered.
 while(await p.locator('[data-testid="card-shelve"]:visible').count())await p.locator('[data-testid="card-shelve"]:visible').first().click({timeout:10000});
 // Traversal has its own observation window. It is NOT opening stability or time spent loading pages.
 await p.evaluate(()=>{
   const s={start:performance.now(),long:[],gaps:[],active:true,last:0};window.__traversal=s;
   const observer=new PerformanceObserver(l=>{if(s.active)s.long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))});observer.observe({type:'longtask'});
   function frame(t){if(!s.active)return;if(s.last&&t-s.last>50)s.gaps.push(t-s.last);s.last=t;requestAnimationFrame(frame)}requestAnimationFrame(frame);
   s.finish=()=>{s.long.push(...observer.takeRecords().map(e=>({start:e.startTime,duration:e.duration})));observer.disconnect();s.active=false;return {elapsed:performance.now()-s.start,long:s.long,gaps:s.gaps}};
 });
 const scrollStart=Date.now();let scrollSteps=0;
 // Overlapping viewports from tail to head, with no arbitrary sleep; the subsequent per-item oracle also
 // requires every nonzero item to be rendered/readable after CV activation. No nodes are removed or remounted.
 while(scrollSteps<10000){
  const state=await p.locator('.thread-scroll').evaluate(e=>{const top=e.scrollTop;if(top<=1)return {top,done:true};e.scrollTop=Math.max(0,top-e.clientHeight*.75);return {top,done:false}});
  if(state.done)break;scrollSteps++;await frame(p);
 }
 if(scrollSteps>=10000)throw Error('scroll traversal did not reach head');
 const scrollMs=Date.now()-scrollStart;
 // Visit every mounted item without replacing/remounting it; require its box to enter the viewport.
 const visited=[];const items=await p.locator('.thread-scroll > *').elementHandles();
 for(let i=0;i<items.length;i++){
  let visit;
  for(let attempt=1;attempt<=4;attempt++){
   await items[i].evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await frame(p);await p.waitForTimeout(40);
   visit=await items[i].evaluate(e=>{const r=e.getBoundingClientRect(),t=e.closest('.thread-scroll').getBoundingClientRect(),dock=document.querySelector('.composer-dock')?.getBoundingClientRect();return {id:e.getAttribute('data-testid'),visible:r.bottom>t.top&&r.top<Math.min(t.bottom,dock?.top??t.bottom),zeroSize:r.width<=0||r.height<=0,renderedChars:e.innerText.length,contentVisible:e.checkVisibility({contentVisibilityAuto:true}),hasContent:!!e.textContent.trim()||!!e.querySelector('img,button,input,svg,canvas,iframe'),chars:e.textContent.length,width:r.width,height:r.height,top:r.top,bottom:r.bottom,viewTop:t.top,viewBottom:Math.min(t.bottom,dock?.top??t.bottom)}});
   visit.attempts=attempt;if((visit.visible&&visit.contentVisible&&visit.renderedChars>0)||visit.zeroSize||!visit.hasContent)break;
  }
  visited.push(visit);
  if((!visit.visible||!visit.contentVisible||!visit.renderedChars)&&!visit.zeroSize&&visit.hasContent)throw Error('nonzero content item not visible after bounded relocation: '+JSON.stringify({label:sample.label,index:i,...visit}));
 }
 const traversal=await p.evaluate(()=>window.__traversal.finish());
 traversal.scrollSteps=scrollSteps;traversal.scrollMs=scrollMs;
 // Actual browser text search and range selection, not textContent pretending to be rendered selection.
 const find=await p.evaluate(()=>{const t=document.querySelector('.thread-scroll');const walker=document.createTreeWalker(t,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){const text=node.textContent.trim();if(text.length>24){window.getSelection()?.removeAllRanges();t.scrollTop=t.scrollHeight;const needle=text.slice(0,24);return {found:window.find(needle,false,false,true),needle,selected:window.getSelection()?.toString()}}}return null});await frame(p);
 const selection=await p.evaluate(()=>{const t=document.querySelector('.thread-scroll');const range=document.createRange();range.selectNodeContents(t);const s=getSelection();s.removeAllRanges();s.addRange(range);const text=s.toString();s.removeAllRanges();return text});
 const expanded=await expandAll();
 const copies=[];
 for(const selector of ['[data-testid="copy-text"]','[data-testid="code-copy"]']){
  const buttons=p.locator('.thread-scroll '+selector);const n=await buttons.count();
  for(const index of [...new Set([0,n-1])].filter(i=>i>=0&&n)){
   await buttons.nth(index).click({timeout:10000});const text=await p.evaluate(()=>navigator.clipboard.readText());copies.push({selector,index,chars:text.length,hash:hash(text)});
  }
 }
 await p.waitForTimeout(1800);const afterCopies=await expandAll();const open=await snapshot(p);
 // Detailed tool calls at both ends use the real row controls and real GET responses.
 const tools=p.locator('.thread-scroll .activity.row > button.activity-line');const toolCount=await tools.count(),details=[];
 for(const index of [...new Set([0,toolCount-1])].filter(i=>i>=0&&toolCount)){
  await tools.nth(index).click({timeout:10000});
  await p.waitForFunction(index=>{const button=document.querySelectorAll('.thread-scroll .activity.row > button.activity-line')[index];const row=button?.parentElement;return !!row?.querySelector('[data-testid="call-detail"]')&&!row.textContent.includes('Reading the call…')},index,{timeout:30000});
  await frame(p);if(![...finished].some(path=>path.includes('/calls/')))throw Error('no completed real tool-call GET');details.push(await snapshot(p));
  await tools.nth(index).click({timeout:10000});
 }
 const pictures=p.locator('.thread-scroll button.shown-image');let picture=null;
 if(await pictures.count()){
  await pictures.first().evaluate(e=>{e.querySelector('img').loading='eager';e.parentElement.scrollIntoView({block:'center'})});
  await p.waitForFunction(()=>document.querySelector('.thread-scroll button.shown-image img')?.naturalWidth>0,{},{timeout:20000});
  await pictures.first().click({timeout:10000});await p.getByTestId('media-viewer').waitFor();picture=await p.getByTestId('media-viewer').evaluate(e=>({label:e.getAttribute('aria-label'),src:e.querySelector('img')?.getAttribute('src')}));await p.keyboard.press('Escape');
 }
 // Programmatic scrolling leaves follow mode; trusted wheel/key/selection inputs are covered by the cold-open E2E.
 await p.locator('.thread-scroll').evaluate(e=>e.scrollTo({top:0,behavior:'instant'}));await frame(p);const beforeJump=await bottom(p);
 const jump=p.getByTestId('jump-bottom');if(await jump.count())await jump.click();await p.waitForTimeout(250);const afterJump=await bottom(p);await p.waitForTimeout(600);const settledBottom=await bottom(p);
 const evidence={label:sample.label,servedAssets,traversal,initial,settledCollapsed,open,details,selection,find,copies,expanded,afterCopies,attempts,toolCount,picture,visited,initialBottom,beforeJump,afterJump,settledBottom,errors};
 writeFileSync(join(R,'logs',prefix+'-ui-'+sample.label+'.json'),JSON.stringify(evidence,null,2));
 const summary={label:sample.label,servedAssets,traversal,initialHash:hash(initial),settledCollapsedHash:hash(settledCollapsed),openHash:hash(open),expanded,afterCopies,attempts,selectionHash:hash(selection),initialChars:initial.text.length,openChars:open.text.length,children:initial.children.length,visited:visited.length,notVisible:visited.filter(v=>!v.visible&&!v.zeroSize&&v.hasContent).length,zeroSize:visited.filter(v=>v.zeroSize).length,initialBottom,afterJump,settledBottom,errors};results.push(summary);console.log(JSON.stringify(summary));await ctx.close();
}}finally{await browser.close();appendFileSync(join(R,'logs/processes.jsonl'),JSON.stringify({role:'chrome-ui',driver_pid:process.pid,closed:true,at:new Date().toISOString()})+'\n');writeFileSync(join(R,'logs',prefix+'-ui-summary.json'),JSON.stringify(results,null,2))}
