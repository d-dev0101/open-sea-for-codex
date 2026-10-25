// Isolated Electron host only. This test never discovers, starts, or attaches to Codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { CDPSession, sanitizeTarget } from '../src/cdp.mjs';
import { VideoLibrary, MAX_VIDEO_CHUNK_BYTES } from '../src/videos.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const evidence = path.join(root, '.local-evidence/media-transport-e2e');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(read, predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await pause(50);
  }
  throw new Error(`${description}: ${JSON.stringify(last)}`);
}

async function ownEndpoint(userData) {
  const text = await until(() => fs.readFile(path.join(userData, 'DevToolsActivePort'), 'utf8').catch(() => ''), value => /^\d+\r?\n\/devtools\/browser\//u.test(value), 'The isolated Electron debug endpoint was not recorded');
  const [portText, browserPath] = text.trim().split(/\r?\n/u);
  const port = Number(portText);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
  assert.match(browserPath, /^\/devtools\/browser\/[A-Za-z0-9._-]+$/u);
  const read = async pathname => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { redirect:'error', signal:AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.text();assert.ok(Buffer.byteLength(body) < 64 * 1024);
    return JSON.parse(body);
  };
  const version = await read('/json/version');
  const browserURL = new URL(version.webSocketDebuggerUrl);
  assert.equal(browserURL.hostname, '127.0.0.1');
  assert.equal(Number(browserURL.port), port);
  assert.equal(browserURL.pathname, browserPath);
  const candidates = (await read('/json/list')).filter(value => value.url === 'app://-/index.html').map(value => sanitizeTarget(value, port)).filter(Boolean);
  assert.equal(candidates.length, 1, 'only the exact shell belonging to our isolated host may be attached');
  return { port, target:candidates[0], browserVersion:version.Browser };
}

function findVideo(node) {
  if (node.nodeName === 'VIDEO') return node;
  for (const child of [...node.children || [], ...node.shadowRoots || [], ...(node.contentDocument ? [node.contentDocument] : [])]) {
    const found = findVideo(child);if (found) return found;
  }
  return null;
}

async function videoNode(session) {
  const { root:document } = await session.send('DOM.getDocument', { depth:-1, pierce:true });
  const node = findVideo(document);assert.ok(node, 'the production renderer must create a real video in its closed shadow root');
  const { object } = await session.send('DOM.resolveNode', { nodeId:node.nodeId });
  assert.ok(object.objectId);
  return { objectId:object.objectId, backendNodeId:node.backendNodeId };
}

async function inspectVideo(session, objectId) {
  const result = await session.send('Runtime.callFunctionOn', { objectId, returnByValue:true,
    functionDeclaration:'function() { return { src:this.getAttribute("src"), currentSrc:this.currentSrc, connected:this.isConnected, readyState:this.readyState, paused:this.paused, currentTime:this.currentTime, width:this.videoWidth, height:this.videoHeight, muted:this.muted, loop:this.loop, frames:this.getVideoPlaybackQuality().totalVideoFrames }; }',
  });
  assert.equal(result.exceptionDetails, undefined);
  return result.result.value;
}

test('synthetic loopback HTTPS media is fulfilled before networking, decoded, reused, and released on restore', { timeout:150000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-media-transport-'));
  const userData = path.join(temporary, 'user-data');
  const wrapper = path.join(temporary, 'main.cjs');
  await fs.mkdir(userData);await fs.mkdir(evidence, { recursive:true });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' app: blob: data: https:; connect-src 'self' app:; object-src 'none'; frame-src 'none'; base-uri 'none'"><title>Open Sea isolated media fixture</title></head><body><aside class="app-shell-left-panel">Fixture sidebar</aside><main data-app-shell-main-surface>Generated local video fixture</main></body></html>`;
  await fs.writeFile(wrapper, `
const {app,BrowserWindow,protocol}=require('electron');
app.setPath('userData',${JSON.stringify(userData)});
app.setPath('sessionData',${JSON.stringify(userData)});
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
global.__mediaFixture={fallback:[],permissions:[],permissionChecks:[]};
app.whenReady().then(async()=>{
  protocol.handle('app',request=>{
    if(request.url==='app://-/index.html')return new Response(${JSON.stringify(html)},{headers:{'Content-Type':'text/html'}});
    global.__mediaFixture.fallback.push({url:request.url,method:request.method});
    return new Response('Fixture has no media route',{status:404,headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
  });
  const window=new BrowserWindow({show:false,width:640,height:480,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.session.setPermissionRequestHandler((_webContents,permission,callback)=>{global.__mediaFixture.permissions.push(permission);callback(false);});
  window.webContents.session.setPermissionCheckHandler((_webContents,permission)=>{global.__mediaFixture.permissionChecks.push(permission);return false;});
  await window.loadURL('app://-/index.html');
});
app.on('window-all-closed',()=>app.quit());
`, 'utf8');
  const bundled = await build({ entryPoints:[path.join(root, 'runtime/skin.js')], write:false, bundle:true, minify:true,
    format:'iife', target:'chrome140', legalComments:'eof', loader:{ '.jpg':'dataurl', '.svg':'dataurl' } });
  const payload = bundled.outputFiles[0].text;
  const report = { passed:false, actualFetch:true, srcRewritten:false, codexTouched:false, isolatedUserData:true,
    mediaServer:false, dnsRequired:false, checks:[], transfers:[], fetchNotifications:[], browserResponses:[], console:[] };
  let application, page, session;
  let fetchDisabledProbeId;
  const pageErrors = [], cspViolations = [];
  try {
    const env = { ...process.env };delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath:require('electron'), args:[wrapper], env, timeout:30000 });
    page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      report.console.push({type:message.type(),text:message.text()});
      if (/Content Security Policy|Refused to|unsafe-eval/i.test(message.text())) cspViolations.push(message.text());
    });
    await page.waitForURL('app://-/index.html');
    const owner = await application.evaluate(({app})=>({pid:process.pid,userData:app.getPath('userData')}));
    assert.equal(owner.pid, application.process().pid);
    assert.equal(await fs.realpath(owner.userData), await fs.realpath(userData));
    const endpoint = await ownEndpoint(userData);
    report.pid = owner.pid;report.port = endpoint.port;report.browserVersion = endpoint.browserVersion;
    assert.equal(await page.evaluate(()=>document.hidden), false, 'the isolated fixture must be visible to the media engine');

    // Deterministic, original noise artwork makes a short VP8 WebM larger than
    // one range chunk. Its actual bytes are delivered unchanged through Fetch.
    const encoded = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');canvas.width = 640;canvas.height = 360;
      const context = canvas.getContext('2d'), pixels = context.createImageData(640,360), stream = canvas.captureStream(20);
      const chunks = [];let total = 0, seed = 0x12345678, stopped = false;
      const draw = () => {
        for (let i=0;i<pixels.data.length;i+=4) { seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels.data[i]=seed&255;pixels.data[i+1]=seed>>>8&255;pixels.data[i+2]=seed>>>16&255;pixels.data[i+3]=255; }
        context.putImageData(pixels,0,0);
      };
      draw();
      const recorder = new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:12000000});
      const began = performance.now();let timer, deadline;
      const stop = () => { if(stopped)return;stopped=true;clearInterval(timer);clearTimeout(deadline);recorder.stop(); };
      const finished = new Promise((resolve,reject)=>{
        recorder.ondataavailable = event=>{if(event.data.size){chunks.push(event.data);total+=event.data.size;}if(total>2*1024*1024+65536&&performance.now()-began>2000&&recorder.state==='recording')stop();};
        recorder.onerror = event=>reject(new Error(event.error?.message||'Fixture recording failed.'));
        recorder.onstop = resolve;
      });
      recorder.start(200);timer=setInterval(draw,50);deadline=setTimeout(stop,8000);
      await finished;stream.getTracks().forEach(track=>track.stop());
      const data = new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());
      let binary='';for(let i=0;i<data.length;i+=32768)binary+=String.fromCharCode(...data.subarray(i,i+32768));
      return btoa(binary);
    });
    const videoBytes = Buffer.from(encoded, 'base64');
    assert.ok(videoBytes.length > MAX_VIDEO_CHUNK_BYTES, 'the video must cross the actual range chunk boundary');
    report.videoBytes = videoBytes.length;
    const source = path.join(temporary, 'generated.webm');await fs.writeFile(source, videoBytes);
    const library = await new VideoLibrary({ directory:path.join(temporary, 'video-library'), systemRoots:[] }).init();
    const imported = await library.importFile(source, { name:'Generated range fixture.webm' });
    const url = library.rendererUrl(imported.videoId);
    assert.match(url,/^https:\/\/127\.0\.0\.1\/open-sea-media\/[a-f0-9]{32}\/[a-f0-9]{32}$/u);
    const settings = { theme:'video', ...imported, videoUrl:url, paused:false, opacity:30 };
    session = await new CDPSession({ target:endpoint.target, port:endpoint.port, mediaBridge:{ pattern:library.pattern, respond:async request=>{
      const response = await library.respond(request);
      const contentRange = response.responseHeaders.find(header=>header.name==='Content-Range')?.value ?? null;
      if (response.body && contentRange) {
        const [,start,end] = /^bytes (\d+)-(\d+)\//u.exec(contentRange);
        assert.deepEqual(Buffer.from(response.body,'base64'),videoBytes.subarray(Number(start),Number(end)+1));
      }
      report.transfers.push({ method:request.method, range:request.headers.Range ?? null, responseCode:response.responseCode,
        contentRange,
        bytes:response.body ? Buffer.from(response.body,'base64').length : 0 });
      return response;
    }} }).open();
    session.socket.addEventListener('message',event=>{
      if(typeof event.data!=='string')return;
      try {
        const notification=JSON.parse(event.data);
        if(notification.method?.startsWith('Fetch.'))report.fetchNotifications.push({method:notification.method,url:notification.params?.request?.url});
        if(notification.method==='Network.responseReceived'&&notification.params?.response?.url===url) {
          const response=notification.params.response;
          report.browserResponses.push({status:response.status,headers:response.headers,url:response.url});
        }
        if(notification.id===fetchDisabledProbeId&&notification.error)report.fetchDisabledProbeError=notification.error.message;
      }
      catch { /* The production CDPSession remains responsible for wire validation. */ }
    });
    await session.send('Network.enable');
    assert.equal((await session.install(payload, settings)).applied, true);
    await until(()=>session.evaluate('window.__codexOpenSea.status()'), value=>value.video?.playing && value.video.currentTime>.15, 'The synthetic loopback URL did not start playing',25000);
    await until(async()=>report.transfers, value=>value.some(transfer=>Number(/^bytes (\d+)-/u.exec(transfer.contentRange)?.[1])>=MAX_VIDEO_CHUNK_BYTES),
      'The actual media loader did not request bytes past the 2 MiB boundary',25000);
    const first = await videoNode(session);
    const playing = await inspectVideo(session, first.objectId);
    assert.equal(playing.src, url);assert.equal(playing.currentSrc, url);
    assert.equal(playing.width, 640);assert.equal(playing.height, 360);
    assert.equal(playing.muted, true);assert.equal(playing.loop, true);
    assert.ok(playing.frames>0);
    report.playing=playing;
    assert.ok(report.transfers.some(transfer=>transfer.responseCode===206));
    assert.ok(report.transfers.every(transfer=>transfer.bytes<=MAX_VIDEO_CHUNK_BYTES));
    assert.equal((await application.evaluate(()=>global.__mediaFixture.fallback)).filter(request=>request.url.includes('/open-sea-media/')).length,0);
    assert.ok(report.browserResponses.some(response=>response.status===206
      && Object.entries(response.headers).some(([name,value])=>name.toLowerCase()==='content-range'&&value===`bytes 0-${MAX_VIDEO_CHUNK_BYTES-1}/${videoBytes.length}`)),
      'Chromium must observe the real HTTP 206 range headers');
    report.checks.push('unchanged synthetic HTTPS source decodes through production Fetch fulfillment under media-src https; no server or native media handler');
    report.checks.push('actual media loader crosses the 2 MiB boundary with exact original bytes and browser-observed HTTP 206 range headers');

    await session.install(payload,{...settings,paused:true});
    const paused = await inspectVideo(session,first.objectId);assert.equal(paused.paused,true);
    await pause(180);assert.equal((await inspectVideo(session,first.objectId)).currentTime,paused.currentTime);
    await session.install(payload,{...settings,paused:true,opacity:55});
    const same = await videoNode(session);assert.equal(same.backendNodeId,first.backendNodeId);
    assert.equal((await inspectVideo(session,same.objectId)).currentTime,paused.currentTime);
    await session.send('Runtime.releaseObject',{objectId:same.objectId});
    await session.install(payload,settings);
    await until(()=>inspectVideo(session,first.objectId), value=>!value.paused && value.currentTime!==paused.currentTime,'Video did not resume');
    await session.send('Runtime.callFunctionOn',{objectId:first.objectId,functionDeclaration:'function(){this.currentTime=0.1;}'});
    await until(()=>inspectVideo(session,first.objectId),value=>!value.paused&&value.currentTime>=0.1&&value.currentTime<1,'Actual video seek did not complete');
    report.checks.push('pause freezes actual video time; repeated installation keeps its DOM node/time and resume continues playback');
    report.checks.push('seeking the same real video back to 0.1 seconds resumes decoding');

    const restored = await session.uninstall();assert.equal(restored.disposed,true);
    assert.equal(session.mediaEnabled,false);assert.equal(session.mediaRequests.size,0);assert.equal(session.pending.size,0);assert.equal(session.scriptIds.size,0);
    assert.equal(await session.evaluate('typeof window.__codexOpenSea'),'undefined');
    const removed = await inspectVideo(session,first.objectId);assert.equal(removed.src,null);assert.equal(removed.connected,false);assert.equal(removed.paused,true);
    await session.send('Runtime.releaseObject',{objectId:first.objectId});
    // Inspect the real CDP domain state without making any post-restore
    // request to loopback. A fake/ignored Fetch.disable cannot pass this check.
    fetchDisabledProbeId=session.sequence+1;
    await assert.rejects(session.send('Fetch.getResponseBody',{requestId:'open-sea-uninstalled-probe'}),/Fetch.getResponseBody failed/u);
    assert.match(report.fetchDisabledProbeError,/Fetch domain is not enabled/u);
    await page.reload();assert.equal(await session.evaluate('typeof window.__codexOpenSea'),'undefined');
    report.checks.push('restore removes video src and future bootstrap; real CDP confirms Fetch domain is disabled without a network probe');
    report.permissions=await application.evaluate(()=>({requests:global.__mediaFixture.permissions,checks:global.__mediaFixture.permissionChecks}));
    assert.deepEqual(report.permissions.requests,[]);
    assert.ok(report.permissions.checks.every(permission=>permission==='media'));
    assert.equal(report.console.some(entry=>/local network|private network|ERR_CERT|ERR_CONNECTION|CORS/iu.test(entry.text)),false);
    report.checks.push('no local network authorization request, TLS/network error, or CSP/CORS warning');
    session.close();assert.equal(session.closed,true);assert.equal(session.pending.size,0);assert.equal(session.mediaRequests.size,0);
    assert.deepEqual(pageErrors,[]);assert.deepEqual(cspViolations,[]);
    report.passed=true;
  } catch (error) {
    report.error=error.stack||String(error);
    if (session&&!session.closed) report.renderer=await session.evaluate('window.__codexOpenSea?.status() ?? null').catch(()=>null);
    if (application) report.nativeFallback=await application.evaluate(()=>global.__mediaFixture.fallback).catch(()=>null);
    throw error;
  } finally {
    report.pageErrors=pageErrors;report.cspViolations=cspViolations;
    await fs.writeFile(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
    session?.close();
    if (application) await application.close().catch(()=>application.process().kill('SIGKILL'));
    await fs.rm(temporary,{recursive:true,force:true});
  }
});
