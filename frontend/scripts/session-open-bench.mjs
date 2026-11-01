import {chromium} from 'playwright-core';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const ROOT=resolve(process.env.BENCH_ROOT || (()=>{throw Error('BENCH_ROOT must name a private evidence directory')})());
const BASE=process.env.BASE||'http://127.0.0.1:18431';
if ([8321,8324,8399].includes(Number(new URL(BASE).port))) throw Error('protected port');
const selected=JSON.parse(readFileSync(join(ROOT,'logs/selected.json'),'utf8')).filter(s=>!process.env.LABELS||process.env.LABELS.split(',').includes(s.label));
const prefix=process.env.PREFIX||'baseline';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','--disable-background-networking']});
const bc=await browser.newBrowserCDPSession();
const info=await bc.send('SystemInfo.getProcessInfo');
appendFileSync(join(ROOT,'logs/processes.jsonl'),JSON.stringify({role:'chrome',driver_pid:process.pid,pids:info.processInfo.map(p=>({pid:p.id,type:p.type})),version:browser.version(),started:new Date().toISOString()})+'\n');
function init(){
 localStorage.setItem('oasis-code.token','bench-only-local-not-a-user-credential');
 performance.setResourceTimingBufferSize(30000);
 window.__bench={active:false,marks:[],json:[],long:[],commits:[],rafGaps:[],lastMutation:0,lastLong:0,lastResource:0};
 const b=window.__bench;
 // Native Response.json is unchanged. This is body-consumption + parse, NOT pure JSON.parse time.
 const nativeJson=Response.prototype.json;
 Response.prototype.json=async function(){const t=performance.now();const value=await nativeJson.call(this);if(b.active)b.json.push({path:new URL(this.url).pathname,start:t,end:performance.now(),entries:Array.isArray(value?.entries)?value.entries.length:null});return value};
 // Minimal supported DevTools hook: only commit timestamp/count, no content/fibers kept.
 let renderer=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>++renderer,onCommitFiberRoot:()=>{if(b.active)b.commits.push(performance.now())},onCommitFiberUnmount:()=>{},onPostCommitFiberRoot:()=>{}};
 const takeLong=entries=>{for(const e of entries)if(b.active){b.long.push({start:e.startTime,duration:e.duration});b.lastLong=e.startTime+e.duration}};
 const longObserver=new PerformanceObserver(l=>takeLong(l.getEntries()));longObserver.observe({type:'longtask',buffered:true});window.__drainLong=()=>takeLong(longObserver.takeRecords());
 new PerformanceObserver(l=>{for(const e of l.getEntries())if(b.active&&!e.name.includes('/events'))b.lastResource=Math.max(b.lastResource,e.responseEnd)}).observe({type:'resource',buffered:true});
 document.addEventListener('click',e=>{const el=e.target.closest?.('[data-testid]');if(b.active&&el?.getAttribute('data-testid')===`session-${b.target}`){b.click=performance.now();performance.mark('bench-click')}},true);
 addEventListener('DOMContentLoaded',()=>{new MutationObserver(m=>{if(!b.active)return;if(m.some(x=>x.type==='childList'||x.type==='characterData'))b.lastMutation=performance.now();const el=document.querySelector(`[data-testid="session-${b.target}"]`);if(!b.content&&el?.classList.contains('active')&&document.querySelector('.thread-scroll > .turn-group')){b.content=performance.now();performance.mark('bench-content-dom');requestAnimationFrame(()=>requestAnimationFrame(()=>{b.contentPaint=performance.now();const t=document.querySelector('.thread-scroll');b.contentState={chars:t.textContent.length,children:t.children.length,top:t.scrollTop,height:t.scrollHeight,client:t.clientHeight};performance.mark('bench-content-raf')}))}if(!b.display&&el?.classList.contains('active')){b.display=performance.now();performance.mark('bench-active-dom');requestAnimationFrame(()=>requestAnimationFrame(()=>{b.paint=performance.now();performance.mark('bench-two-raf')}))}}).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']})});
 function readableTail(){
  const t=document.querySelector('.thread-scroll');
  if(!t || t.dataset.sessionId!==b.target || t.dataset.transcriptPending) return null;
  const runs=t.querySelectorAll(':scope > [data-testid^="run-"]');
  const tail=t.querySelector(`[data-testid="${b.expectedTailRun}"]`);
  if(runs.length!==b.expectedRunCount || !tail) return null;
  const gap=t.scrollHeight-t.clientHeight-t.scrollTop;
  if(gap>2) return null;
  const view=t.getBoundingClientRect(),dock=document.querySelector('.composer-dock')?.getBoundingClientRect();
  const selectors=b.expectedTailKind==='answer'?'.turn-agent .turn-text':'.run-failure, .work-head';
  const bodies=[...tail.querySelectorAll(selectors)];
  if(b.expectedTailKind==='answer'&&!bodies.some(e=>e.textContent.includes(b.expectedAnswerFragment)))return null;
  let chars=0;
  for(const el of bodies) {
    if(!el.checkVisibility({contentVisibilityAuto:true})) continue;
    const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
    while(node=walk.nextNode()){
      if(!node.textContent.trim())continue;
      const range=document.createRange();range.selectNodeContents(node);const visible=[...range.getClientRects()].some(r=>r.width>0&&r.height>0&&r.bottom>view.top&&r.top<Math.min(view.bottom,dock?.top??view.bottom));
      if(visible)chars+=node.textContent.trim().length;
    }
  }
  return chars?{gap,answerFragmentMatched:b.expectedTailKind==='answer',runCount:runs.length,visibleBodyChars:chars,top:t.scrollTop,height:t.scrollHeight,client:t.clientHeight}:null;
}
window.__tailProof=readableTail;
let last=0;function frame(t){
  if(b.active && b.content && !b.tailPaint && !b.tailChecking){
    const proof=readableTail();
    if(proof){b.tailChecking=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const proof=readableTail();
      if(b.active&&proof){b.tailPaint=performance.now();b.tailProof=proof;performance.mark('bench-correct-tail-raf')}
      b.tailChecking=false;
    }))}
  }
if(b.active&&last&&t-last>50)b.rafGaps.push({at:t,duration:t-last});last=t;requestAnimationFrame(frame)}requestAnimationFrame(frame);
}
async function traceEnd(cdp,path){const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const {stream}=await done;let s='';while(true){const r=await cdp.send('IO.read',{handle:stream});s+=r.data;if(r.eof)break}await cdp.send('IO.close',{handle:stream});
 // Raw CDP timing events retained, but strip query strings (synthetic auth) and external titles if any.
 const raw=JSON.parse(s);for(const e of raw.traceEvents??[]){if(e.args?.data?.url){try{const u=new URL(e.args.data.url);e.args.data.url=u.origin+u.pathname}catch{}}}
 writeFileSync(path,JSON.stringify(raw));}
async function measure(page,cdp,sample,rep,mode){
 const tag=`${prefix}-${sample.label}-${rep}-${mode}`;
 await page.getByTestId(`session-${sample.id}`).scrollIntoViewIfNeeded();
 const collectors=new Set();const reqs=new Map(),done=[];const pending=new Set();
 const onReq=q=>{const u=new URL(q.url());if(u.origin!==BASE)return;const path=u.pathname; if(path.endsWith('/events'))return; reqs.set(q,{path,method:q.method(),type:q.resourceType(),at:Date.now(),start:q.timing().startTime});pending.add(q)};
 const onDone=async q=>{pending.delete(q);const r=reqs.get(q);if(!r)return;try{const response=await q.response();const h=await response?.allHeaders();Object.assign(r,{status:response?.status(),timing:q.timing(),start:q.timing().startTime,server_ms:Number(h?.['server-timing']?.match(/dur=([\d.]+)/)?.[1]||0),request_id:h?.['x-bench-request'],sizes:await q.sizes()});}catch{}done.push(r)};
 const onFinished=q=>{const task=onDone(q);collectors.add(task);void task.finally(()=>collectors.delete(task))};
 page.on('request',onReq);page.on('requestfinished',onFinished);page.on('requestfailed',q=>{pending.delete(q);const r=reqs.get(q);if(r)done.push({...r,start:q.timing().startTime,failed:true})});
 await cdp.send('Performance.enable');const before=await cdp.send('Performance.getMetrics');
 await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',options:'sampling-frequency=1000',transferMode:'ReturnAsStream'});
 await page.evaluate(id=>{performance.clearResourceTimings();Object.assign(window.__bench,{active:true,target:id.id,expectedRunCount:id.expectedRunCount,expectedTailRun:id.expectedTailRun,expectedTailKind:id.expectedTailKind,expectedAnswerFragment:id.expectedAnswerFragment,tailPaint:null,tailProof:null,tailChecking:false,click:null,display:null,paint:null,content:null,contentPaint:null,json:[],long:[],commits:[],rafGaps:[],lastMutation:performance.now(),lastLong:0,lastResource:0,segments:[],profile:[]});performance.mark('bench-begin')},sample);
 await page.getByTestId(`session-${sample.id}`).click({timeout:120000});
 await page.waitForFunction(()=>window.__bench.tailPaint!==null,{},{timeout:180000});
 // Stability: initial read/image requests complete; no DOM text/children or long task for 500ms.
 const deadline=Date.now()+180000;let settle;
 while(Date.now()<deadline){await page.waitForTimeout(100);settle=await page.evaluate(()=>({tailProof:window.__tailProof(),quiet:performance.now()-Math.max(window.__bench.lastMutation,window.__bench.lastLong,window.__bench.lastResource),now:performance.now()}));if(pending.size===0&&settle.quiet>=500&&settle.tailProof)break}
 if(!settle?.tailProof||pending.size||settle.quiet<500)throw Error('did not reach correct-tail quiet stability');
 await Promise.all([...collectors]);
 const result=await page.evaluate(async()=>{window.__drainLong();const b=window.__bench;const timerStart=performance.now();await new Promise(r=>setTimeout(r,0));const timerDelay=performance.now()-timerStart;const boundary=performance.now();const resources=performance.getEntriesByType('resource').filter(e=>e.startTime>=b.click&&e.responseEnd<=boundary).map(e=>({path:new URL(e.name).pathname,type:e.initiatorType,start:e.startTime,end:e.responseEnd,requestStart:e.requestStart,responseStart:e.responseStart,duration:e.duration,transfer:e.transferSize,encoded:e.encodedBodySize,decoded:e.decodedBodySize,server:e.serverTiming.map(t=>({name:t.name,duration:t.duration}))}));b.active=false;return {...b,stableTailProof:window.__tailProof(),threadAtCapture:(()=>{const t=document.querySelector('.thread-scroll');return t?{top:t.scrollTop,height:t.scrollHeight,client:t.clientHeight,gap:t.scrollHeight-t.scrollTop-t.clientHeight}:null})(),resources,bootResources:window.__bootResources,attachmentImages:[...document.images].filter(i=>i.src.includes('/attachments/')).map(i=>({id:i.src.split('/').at(-1).split('?')[0],loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth,height:i.naturalHeight,visible:i.getBoundingClientRect().bottom>0&&i.getBoundingClientRect().top<innerHeight})),end:boundary,timeOrigin:performance.timeOrigin,timerDelay,domNodes:document.querySelectorAll('*').length,threadNodes:document.querySelector('.thread-scroll')?.querySelectorAll('*').length??0,imgCount:document.images.length,loadedImages:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length,composerEnabled:[...document.querySelectorAll('textarea')].some(x=>!x.disabled)}});
 page.off('request',onReq);page.off('requestfinished',onFinished);page.removeAllListeners('requestfailed');
 await Promise.all([...collectors]);
 const after=await cdp.send('Performance.getMetrics');const bm=Object.fromEntries(before.metrics.map(m=>[m.name,m.value]));result.metrics=Object.fromEntries(after.metrics.map(m=>[m.name,m.value-(bm[m.name]??0)]));
 await traceEnd(cdp,join(ROOT,'traces',tag+'.json'));
 page.off('request',onReq);page.off('requestfinished',onFinished);page.removeAllListeners('requestfailed');
 await Promise.all([...collectors]);
 Object.assign(result,{tag,session_id:sample.id,label:sample.label,rep,mode,requests:done.filter(r=>r.start>=result.timeOrigin+result.click&&r.start<=result.timeOrigin+result.end),requestsOutsideWindow:done.filter(r=>r.start<result.timeOrigin+result.click||r.start>result.timeOrigin+result.end),pendingAtEnd:pending.size,wall:Date.now(),instrumentation:prefix});
 writeFileSync(join(ROOT,'logs',tag+'.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({tag,correct_tail_raf:result.tailPaint-result.click,tail_proof:result.tailProof,click_to_dom:result.display-result.click,content_dom:result.content-result.click,content_raf:result.contentPaint-result.click,click_to_raf:result.paint-result.click,click_to_stable:Math.max(result.lastMutation,result.lastLong,result.lastResource,result.contentPaint,result.tailPaint)-result.click,long_count:result.long.length,long_ms:result.long.reduce((a,x)=>a+x.duration,0),requests:result.requests.length,transcripts:result.requests.filter(x=>x.path.endsWith('/transcript')).length,dom:result.domNodes}));
}
try{
 for(const sample of selected){for(let rep=1;rep<=Number(process.env.REPS||3);rep++){
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,serviceWorkers:'block'});await context.addInitScript(init);
  const page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setBlockedURLs',{urls:['https://*']});
  await context.request.get(BASE+'/api/auth/session?token=bench-only-local-not-a-user-credential');
  if(!(await context.cookies()).some(c=>c.name==='oasis_code_session'))throw Error('missing benchmark cookie');
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.getByTestId(`session-${sample.id}`).waitFor({state:'visible',timeout:30000});await page.waitForTimeout(500);
  await page.evaluate(()=>window.__bootResources=performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')).map(e=>({path:new URL(e.name).pathname,duration:e.duration,transfer:e.transferSize,decoded:e.decodedBodySize,server:e.serverTiming.map(t=>({name:t.name,duration:t.duration}))})));
  await measure(page,cdp,sample,rep,'cold');
  await page.getByTestId('new-task').click();await page.waitForTimeout(700);
  await measure(page,cdp,sample,rep,'warm');
  await context.close();
 }}
}finally{await browser.close();appendFileSync(join(ROOT,'logs/processes.jsonl'),JSON.stringify({role:'chrome',driver_pid:process.pid,closed:true,at:new Date().toISOString()})+'\n')}
