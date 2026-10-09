import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSpokenSource } from '../extension/spoken-text.ts';
import { splitTextSections } from '../extension/text-sections.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [];
const paragraph = 'Keep going. This article explains how a reader can follow words in different paragraphs and return to a paused reading session without losing the place. '.repeat(5);
const article = `<title>Readflow browser validation</title><article><h1>Reading connection test</h1>${Array.from({length:8},(_,i)=>`<p id="p${i}">${paragraph}</p>`).join('')}</article>`;
const bridge = http.createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); if(req.method==='OPTIONS'){res.end();return;}
  if (req.url.startsWith('/v1/voices')) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({voices:[],hasMore:false})); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const data = JSON.parse(body); requests.push(data.text);
  const words = data.text.trim().split(/\s+/);
  const frames = Math.ceil(Math.max(4,words.length*0.35)*44100);
  const audio = Buffer.alloc(frames*2);
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  res.write(`data: ${JSON.stringify({event:'audio',audio_base64:audio.toString('base64'),audio_byte_count:audio.length,chunk_seq:0,chunk_audio_offset_sec:0,alignment:{segments:words.map((text,i)=>({text,start:i*0.35,end:(i+1)*0.35}))}})}\n\n`);
  res.end('data: {"event":"finish"}\n\n');
});
const page = http.createServer((req,res)=> { res.setHeader('Content-Type','text/html'); res.end(article); });
await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>page.listen(0,'127.0.0.1',resolve));
const profile = await mkdtemp(join(tmpdir(), 'readflow-chrome-'));
const chrome = spawn(process.env.CHROMIUM_PATH || 'chromium',['--headless=new','--no-sandbox','--disable-gpu','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=9224',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let browserLog = '';
let launchError;
chrome.stderr.on('data', data => { browserLog = (browserLog + data.toString()).slice(-8000); });
chrome.on('error', error => { launchError = error; });
let ws;
try {
  let version;
  for(let i=0;i<150;i++) {
    if (launchError || chrome.exitCode !== null) break;
    try { version=await (await fetch('http://127.0.0.1:9224/json/version')).json(); break; }
    catch { await wait(100); }
  }
  assert.ok(version, `Chromium starts: ${launchError?.message || browserLog}`);
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  let seq=0; const pending=new Map();
  ws.addEventListener('message',event=> { const data=JSON.parse(event.data); if(data.id) {const item=pending.get(data.id);pending.delete(data.id);data.error?item.reject(new Error(JSON.stringify(data.error))):item.resolve(data.result);} });
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,sessionId}));});
  console.log('Validating the built content script with real Web Audio and a controlled extension port.');
  const {targetId}=await send('Target.createTarget',{url:`http://127.0.0.1:${page.address().port}`});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const evaluate=async expression=> {const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId); if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const status=()=>evaluate(`document.querySelector('#readflow-controls')?.shadowRoot.querySelector('#status')?.textContent`);
  await wait(500);
  await evaluate(`
    window.__ports = [];
    window.chrome.runtime = {
      id: 'fixture-extension',
      onMessage: { addListener() {} },
      sendMessage: async message => {
        if (message.type === 'voice_settings') return { selected: { id: 'fixture', name: 'Fixture', languages: ['en'] }, favorites: [] };
        if (message.type === 'reading_for_page') return {};
        if (message.type === 'reading_save') {
          const item = { ...message.item, id: 'fixture-read', offset: 0, status: 'in-progress', sessionId: message.sessionId };
          window.__readingText = item.text;
          return { item };
        }
        if (message.type === 'reading_progress') window.__readingProgress = message;
        return { ok: true };
      },
      connect: () => {
        const handlers = [], disconnects = [];
        let connected = true;
        const port = {
          onMessage: { addListener: fn => handlers.push(fn) },
          onDisconnect: { addListener: fn => disconnects.push(fn) },
          emit: event => handlers.forEach(fn => fn(event)),
          disconnect: () => {
            if (!connected) return;
            connected = false;
            disconnects.forEach(fn => fn());
          },
          postMessage: message => {
            if (!connected) throw new Error('Port disconnected');
            if (message.type !== 'start') return;
            // Only generate the first section: later article words remain uncached.
            fetch('http://127.0.0.1:${bridge.address().port}/v1/tts/stream/with-timestamp', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: message.sections[0].text }),
            }).then(r => r.text()).then(text => {
              for (const record of text.trim().split('\\n\\n')) {
                const event = JSON.parse(record.slice(6));
                if (connected && event.event === 'audio') port.emit(event);
              }
            });
          },
        };
        window.__ports.push(port);
        return port;
      },
    };
  `);
  await evaluate(`window.__contexts=[];const NativeContext=window.AudioContext;window.AudioContext=class extends NativeContext{constructor(options){super(options);window.__contexts.push(this);}};`);
  await evaluate(await readFile(join(root, 'dist/content.js'),'utf8'));
  await wait(300);
  assert.equal(await evaluate(`!!document.querySelector('#readflow-controls')`),true,'built extension injects');
  const click=id=>evaluate(`document.querySelector('#readflow-controls').shadowRoot.querySelector('#${id}').click()`);
  await click('article-button'); await wait(1000);
  console.log('Initial playback:',await status());
  assert.ok(requests.length,'bridge receives requests');
  await click('pause-button'); await wait(200);
  assert.match(await status(),/Paused/);
  const beforeIdle=requests.length;
  await send('Page.setWebLifecycleState',{state:'frozen'},sessionId);
  const idleMs = Number(process.env.READFLOW_IDLE_MS) || 45000;
  console.log(`Article frozen while paused for ${idleMs / 1000} seconds.`);
  await wait(idleMs);
  await send('Page.setWebLifecycleState',{state:'active'},sessionId); await wait(500);
  assert.match(await status(),/Paused/);
  assert.equal(requests.length,beforeIdle,'paused generation stays paused');
  console.log('After idle:',await status());
  const selectWord=async (id,offset,length)=>evaluate(`(()=>{const node=document.querySelector('#${id}').firstChild;const r=document.createRange();r.setStart(node,${offset});r.setEnd(node,${offset+length});getSelection().removeAllRanges();getSelection().addRange(r);node.parentElement.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));})()`);
  const beforeCached=requests.length;
  await selectWord('p0',5,5); await wait(150);
  assert.equal(requests.length,beforeCached,'cached word seeks without another request');
  assert.doesNotMatch(await status(),/Paused|Refresh|lost/);
  assert.equal(await evaluate('window.__contexts.at(-1).state'), 'running');
  console.log('Cached double-click resumed:',await status());
  await selectWord('p7',5,5); await wait(1500);
  assert.equal(requests[beforeCached].startsWith('going.'),true,'ungenerated word starts new request exactly there');
  console.log('Ungenerated double-click request:',requests[beforeCached].slice(0,70));
  await click('pause-button'); await wait(100);
  // Simulate an unexpected worker restart through its disconnected port.
  const recoveryCheckpoint = await evaluate(`(()=>{
    window.__ports.at(-1).disconnect();
    return { text: window.__readingText, offset: window.__readingProgress.offset };
  })()`);
  await wait(1200);
  console.log('After simulated worker restart:',await status());
  console.log('Recovery checkpoint:', recoveryCheckpoint.offset, recoveryCheckpoint.text.slice(recoveryCheckpoint.offset, recoveryCheckpoint.offset + 70));
  console.log('Recovery request:', requests.at(-1).slice(0,70));
  assert.equal(await evaluate('window.__contexts.at(-1).state'), 'suspended');
  assert.match(await status(),/Paused/,'automatic recovery preserves pause');
  const expectedRecovery = splitTextSections(prepareSpokenSource(recoveryCheckpoint.text.slice(recoveryCheckpoint.offset)).text)[0].text;
  assert.equal(requests.at(-1),expectedRecovery,'recovery resumes exactly at the saved disconnect position');
  await evaluate('window.__ports.at(-1).disconnect()'); await wait(200);
  assert.match(await status(),/Press Listen/,'second disconnect ends bounded recovery');
  assert.doesNotMatch(await status(),/Refresh/);
  await click('article-button'); await wait(400);
  const selectPassage = `(()=>{const r=document.createRange();r.selectNodeContents(document.querySelector('#p1'));getSelection().removeAllRanges();getSelection().addRange(r);document.querySelector('#readflow-controls').shadowRoot.querySelector('#selection-button').click();})()`;
  await evaluate(selectPassage); await wait(400);
  const duringSelection=requests.length;
  await selectWord('p7',5,5); await wait(100);
  assert.equal(requests.length,duringSelection,'double-click does not hijack selected-text listening');
  await click('stop-button'); await wait(100);
  const afterStop=requests.length;
  await selectWord('p0',5,5); await wait(100);
  assert.equal(requests.length,afterStop,'stopped playback removes seek listener');
  await click('article-button'); await wait(500);
  await evaluate("window.__ports.at(-1).emit({event:'finish'}); window.__ports.at(-1).disconnect();");
  await wait(150);
  assert.doesNotMatch(await status(),/Refresh|lost/,'completed audio remains usable after disconnect');
  await click('pause-button'); await wait(100);
  await selectWord('p0',5,5); await wait(100);
  assert.equal(await evaluate('window.__contexts.at(-1).state'), 'running');
  await click('stop-button');
  console.log('Browser checks passed.');
} finally {
  ws?.close(); chrome.kill('SIGKILL'); bridge.closeAllConnections(); page.closeAllConnections(); bridge.close();page.close();
  await wait(100); await rm(profile,{recursive:true,force:true});
}
