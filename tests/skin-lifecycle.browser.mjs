// Run with: node --test tests/skin-lifecycle.browser.mjs
// PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an existing Chrome for Testing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `<!doctype html><html class="electron-dark" data-open-sea="prior"><head>
  <link rel="icon" href="data:,"><style>
    body { margin:0; background:rgb(31,32,33); }
    #root { display:flex; min-height:100vh; background:rgb(41,42,43); }
    main { flex:1; background:rgb(51,52,53); }
    aside { width:220px; background:rgb(61,62,63); }
    .composer-surface-chrome { background:rgb(71,72,73); }
    [role="dialog"] { position:fixed; inset:40px 40px auto auto; width:200px; background:rgb(81,82,83); }
  </style></head><body><div id="root">
  <aside class="app-shell-left-panel"><nav>Fixture navigation</nav></aside>
  <main data-app-shell-main-surface data-open-sea-part="prior-main">
    <header data-app-shell-header-edge-scroll>Fixture header</header>
    <section data-app-shell-page-surface="true">Fixture content</section>
    <div id="composer" class="composer-surface-chrome">Fixture composer</div>
  </main></div>
  <div id="overlay" role="dialog"><div id="overlay-composer" class="composer-surface-chrome">Fixture settings</div>
    <header data-app-shell-header-edge-scroll>Fixture dialog header</header></div>
</body></html>`;

const mockOcean = `export function createOcean(container, initial, hooks = {}) {
  window.__skinOceanRecords ||= [];
  let settings = {...initial}, state = 'initializing';
  const canvas = document.createElement('canvas'); container.appendChild(canvas);
  const record = {canvas, disposals:0,
    ready(){state='ready';hooks.onReady?.();},
    recover(){state='initializing';},
    fail(){state='error';hooks.onError?.(new Error('Fixture GPU failure'));}};
  window.__skinOceanRecords.push(record);
  const status = () => ({state,paused:settings.paused,wave:settings.wave,daylight:settings.daylight});
  return {status,update(patch){Object.assign(settings,patch);return status();},
    pause(paused){settings.paused=paused;return status();},
    dispose(){record.disposals++;state='disposed';canvas.remove();}};
}`;
let browser, server, origin, payload, realPayload;
before(async () => {
  const options = { absWorkingDir: root, entryPoints: ['runtime/skin.js'], bundle: true,
    write: false, format: 'iife', target: 'chrome140', loader: { '.jpg':'dataurl', '.svg':'dataurl' } };
  const mock = await build({ ...options, plugins: [{ name:'fixture-ocean', setup(builder) {
    builder.onResolve({ filter: /^\.\/ocean\.js$/ }, () => ({ path: 'fixture-ocean', namespace:'fixture' }));
    builder.onLoad({ filter: /.*/, namespace:'fixture' }, () => ({ contents:mockOcean, loader:'js' }));
  } }] });
  payload = mock.outputFiles[0].text;
  realPayload = (await build(options)).outputFiles[0].text;
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless:true, args:['--enable-unsafe-webgpu'],
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function pageWithSkin({ beforeInstall, real = false } = {}) {
  const page = await browser.newPage();
  await page.goto(origin);
  await page.evaluate(() => {
    const sentinel = new CSSStyleSheet(); sentinel.replaceSync('#root { color: rgb(101,102,103); }');
    document.adoptedStyleSheets = [sentinel]; window.__sentinel = sentinel;
  });
  if (beforeInstall) await page.evaluate(beforeInstall);
  await page.addScriptTag({ content: real ? realPayload : payload });
  return page;
}

const videoId = 'a'.repeat(32), videoToken = 'b'.repeat(32);
const localVideo = (overrides = {}) => ({ theme:'video',videoId,videoName:'Fixture video.webm',
  videoUrl:`https://127.0.0.1/open-sea-media/${videoToken}/${videoId}`, ...overrides });

function installVideoMock() {
  window.__videoRecords = [];
  window.__videoHidden = false;
  Object.defineProperty(document, 'hidden', { configurable:true, get:() => __videoHidden });
  const createElement = document.createElement.bind(document);
  document.createElement = function(tag, ...args) {
    const element = createElement(tag, ...args);
    if (tag !== 'video') return element;
    const record = { element, source:null, readyState:0, paused:true, mediaError:null,
      loads:0, pauses:0, plays:[], listeners:new Map(),
      emit(type) {
        if (type === 'loadeddata' || type === 'playing') this.readyState = 2;
        if (type === 'playing') this.paused = false;
        element.dispatchEvent(new Event(type));
      } };
    __videoRecords.push(record);
    Object.defineProperties(element, {
      src:{ get:() => record.source || '', set:value => { record.source=value; } },
      paused:{ get:() => record.paused }, readyState:{ get:() => record.readyState },
      error:{ get:() => record.mediaError },
    });
    const remove = element.removeAttribute.bind(element);
    element.removeAttribute = name => { if (name === 'src') record.source=null; else remove(name); };
    element.load = () => { record.loads++; };
    element.pause = () => {
      record.pauses++;
      const playing = !record.paused; record.paused=true;
      if (playing) element.dispatchEvent(new Event('pause'));
    };
    element.play = () => {
      record.paused=false;
      return new Promise((resolve, reject) => record.plays.push({ resolve,reject }));
    };
    const addEvent = element.addEventListener.bind(element), removeEvent = element.removeEventListener.bind(element);
    element.addEventListener = (type, listener) => { record.listeners.set(type,listener); addEvent(type,listener); };
    element.removeEventListener = (type, listener) => { record.listeners.delete(type); removeEvent(type,listener); };
    return element;
  };
}

test('invalid video addresses never create a media element or replace an active background', async () => {
  const page = await pageWithSkin({ beforeInstall:installVideoMock });
  try {
    for (const url of [
      `app://-/open-sea-media/${videoToken}/${videoId}`,
      localVideo().videoUrl.replace('127.0.0.1','localhost'),
      localVideo().videoUrl.replace('127.0.0.1','127.0.0.2'),
      localVideo().videoUrl.replace('127.0.0.1','127.0.0.1:443'),
      localVideo().videoUrl.replace('https:','http:'),
      localVideo().videoUrl+'?extra=1',localVideo().videoUrl+'\n',
    ]) await assert.rejects(page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({videoUrl:url})),/Invalid local video URL/);
    assert.equal(await page.evaluate(() => __videoRecords.length),0);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().theme),'ocean');
    assert.equal(await page.evaluate(() => __skinOceanRecords[0].disposals),0);
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo());
    await page.evaluate(() => __videoRecords[0].emit('playing'));
    await assert.rejects(page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({videoId:'c'.repeat(32)})),/Invalid local video URL/);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().video.playing),true);
    assert.equal(await page.evaluate(() => __videoRecords[0].source),localVideo().videoUrl);
    assert.equal(await page.evaluate(() => __videoRecords.length),1);
  } finally { await page.close(); }
});

test('local video waits for its URL and actual playback, uses cover, and respects explicit and visibility pauses', async () => {
  const page = await pageWithSkin({ beforeInstall:installVideoMock });
  try {
    let status = await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({ videoUrl:null }));
    assert.equal(status.state,'initializing'); assert.equal(status.video.ready,false);
    assert.equal(await page.evaluate(() => __videoRecords.length),0);
    status = await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo());
    assert.equal(status.state,'initializing'); assert.equal(status.ocean,null);
    assert.equal(await page.evaluate(() => __skinOceanRecords[0].disposals),1);
    assert.deepEqual(await page.evaluate(() => {
      const element=__videoRecords[0].element;
      return [element.muted,element.defaultMuted,element.loop,element.playsInline,element.style.objectFit];
    }),[true,true,true,true,'cover']);
    assert.equal(await page.locator('#codex-open-sea-backdrop').evaluate(element => element.style.backgroundImage),'none');
    await page.evaluate(() => __videoRecords[0].emit('loadeddata'));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'initializing','a decoded frame alone is not playing');
    await page.evaluate(() => __videoRecords[0].emit('playing'));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().video.playing),true);
    await page.evaluate(() => __videoRecords[0].emit('stalled'));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'ready','a stalled download can still play buffered frames');
    await page.evaluate(() => __videoRecords[0].emit('waiting'));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'initializing','buffering must stop reporting playback readiness');
    await page.evaluate(() => __videoRecords[0].emit('playing'));
    status=await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({paused:true}));
    assert.equal(status.state,'ready'); assert.equal(status.video.playing,false); assert.equal(status.video.paused,true);
    await page.evaluate(() => __videoRecords[0].plays[0].reject(new Error('pause interrupted the original play request')));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'ready','an intentional pause must invalidate the outstanding play promise');
    await page.evaluate(() => { __videoHidden=true;document.dispatchEvent(new Event('visibilitychange'));__videoHidden=false;document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => __videoRecords[0].plays.length),1,'visibility cannot override explicit pause');
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({paused:false}));
    await page.evaluate(() => __videoRecords[0].emit('playing'));
    await page.evaluate(() => { __videoHidden=true;document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => __codexOpenSea.status().video.effectivePaused),true);
    assert.equal(await page.evaluate(() => __videoRecords[0].paused),true);
    await page.evaluate(() => { __videoHidden=false;document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => __videoRecords[0].plays.length),3);
    assert.equal(await page.evaluate(() => __videoRecords.length),1,'pause and visibility must not recreate the video');
  } finally { await page.close(); }
});

test('video errors are honest and stale media events or play promises cannot overwrite a replacement theme', async () => {
  const page = await pageWithSkin({ beforeInstall:installVideoMock });
  try {
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo());
    const id='c'.repeat(32);
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({videoId:id,videoUrl:`https://127.0.0.1/open-sea-media/${videoToken}/${id}`}));
    assert.deepEqual(await page.evaluate(() => [__videoRecords[0].source,__videoRecords[0].element.isConnected,__videoRecords[0].loads,__videoRecords[0].listeners.size]),[null,false,2,0]);
    await page.evaluate(() => { __videoRecords[0].emit('playing');__videoRecords[0].plays[0].reject(new Error('stale request')); });
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'initializing');
    await page.evaluate(() => { __videoRecords[1].mediaError={code:3};__videoRecords[1].emit('error'); });
    const failed=await page.evaluate(() => __codexOpenSea.status());
    assert.equal(failed.state,'error'); assert.equal(failed.video.ready,false);
    assert.match(failed.error,/decoded/);
    await page.evaluate(() => __codexOpenSea.apply({theme:'coast'}));
    await page.evaluate(() => { __videoRecords[1].emit('playing');__videoRecords[1].plays[0].reject(new Error('late failure')); });
    const preset=await page.evaluate(() => __codexOpenSea.status());
    assert.equal(preset.state,'ready'); assert.equal(preset.theme,'coast'); assert.equal(preset.video,null); assert.equal(preset.error,null);
    assert.equal(await page.evaluate(() => __videoRecords[1].source),null);
  } finally { await page.close(); }
});

test('rejected play fails instead of claiming readiness, and a paused retry waits for its first decoded frame', async () => {
  const page = await pageWithSkin({ beforeInstall:installVideoMock });
  try {
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo());
    await page.evaluate(() => __videoRecords[0].plays[0].reject(new Error('play denied')));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'error');
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({paused:true}));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'initializing');
    assert.equal(await page.evaluate(() => __videoRecords[1].plays.length),0);
    await page.evaluate(() => __videoRecords[1].emit('loadeddata'));
    const paused=await page.evaluate(() => __codexOpenSea.status());
    assert.equal(paused.state,'ready'); assert.equal(paused.video.playing,false); assert.equal(paused.error,null);
    await page.evaluate(() => { __savedVideoMain=document.querySelector('main');__savedVideoMain.remove(); });
    await page.waitForFunction(() => __codexOpenSea.status().state === 'waiting-shell');
    assert.equal(await page.evaluate(() => __videoRecords[1].source),null);
    assert.equal(await page.locator('#codex-open-sea-backdrop').evaluate(element => getComputedStyle(element).display),'none');
    await page.evaluate(() => document.querySelector('#root').append(__savedVideoMain));
    await page.waitForFunction(() => __videoRecords.length === 3);
    await page.evaluate(() => __codexOpenSea.dispose());
    assert.deepEqual(await page.evaluate(() => [__videoRecords[2].source,__videoRecords[2].listeners.size,__videoRecords[2].element.isConnected]),[null,0,false]);
    await page.evaluate(() => { __videoHidden=false;document.dispatchEvent(new Event('visibilitychange'));__videoRecords[2].emit('playing'); });
    assert.equal(await page.evaluate(() => __videoRecords[2].plays.length),0);
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(),0);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length),1);
  } finally { await page.close(); }
});

test('an original in-memory video really decodes, loops, pauses and unloads through the renderer', async () => {
  const page = await pageWithSkin({ beforeInstall:async function() {
    // Original test artwork, generated in memory; no Apple or external media is used.
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;
    const context=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
    recorder.ondataavailable=event => { if(event.data.size)chunks.push(event.data); };
    const finished=new Promise(resolve => { recorder.onstop=resolve; });
    let frame=0;
    const draw=() => {context.fillStyle='#184852';context.fillRect(0,0,64,32);context.fillStyle='#9ad6c5';context.fillRect((frame++*5)%64,8,16,16);};
    draw();recorder.start();const timer=setInterval(draw,50);
    await new Promise(resolve => setTimeout(resolve,650));
    recorder.stop();await finished;clearInterval(timer);stream.getTracks().forEach(track => track.stop());
    const blobUrl=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));
    window.__realVideoProbe={blobUrl,requested:[],elements:[]};
    // The production Fetch bridge owns HTTPS loopback delivery. This fixture substitutes only
    // its byte source while exercising the actual HTMLVideoElement and renderer.
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
    Object.defineProperty(HTMLMediaElement.prototype,'src',{...descriptor,set(value) {
      __realVideoProbe.requested.push(value);
      descriptor.set.call(this,value===`https://127.0.0.1/open-sea-media/${'b'.repeat(32)}/${'a'.repeat(32)}`?blobUrl:value);
    }});
    const create=document.createElement.bind(document);
    document.createElement=function(tag,...args){const element=create(tag,...args);if(tag==='video')__realVideoProbe.elements.push(element);return element;};
  } });
  try {
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo());
    await page.waitForFunction(() => __codexOpenSea.status().video?.playing, null,{timeout:15000});
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state),'ready');
    assert.deepEqual(await page.evaluate(() => [__realVideoProbe.elements[0].videoWidth,__realVideoProbe.elements[0].videoHeight]),[64,32]);
    await page.waitForFunction(() => __realVideoProbe.elements[0].getVideoPlaybackQuality().totalVideoFrames>12);
    assert.equal(await page.evaluate(() => __realVideoProbe.requested[0]),localVideo().videoUrl);
    await page.evaluate(settings => __codexOpenSea.apply(settings),localVideo({paused:true}));
    const time=await page.evaluate(() => __codexOpenSea.status().video.currentTime);
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().video.currentTime),time);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().video.playing),false);
    await page.evaluate(() => __codexOpenSea.dispose());
    await page.waitForFunction(() => __realVideoProbe.elements[0].readyState===0);
    assert.deepEqual(await page.evaluate(() => [__realVideoProbe.elements[0].getAttribute('src'),__realVideoProbe.elements[0].isConnected]),[null,false]);
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(),0);
  } finally {
    await page.evaluate(() => URL.revokeObjectURL(__realVideoProbe.blobUrl));
    await page.close();
  }
});

test('initialization and presets preserve native overlays; ocean settings and pause reach the engine', async () => {
  const page = await pageWithSkin();
  try {
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state), 'initializing');
    await page.evaluate(() => __skinOceanRecords[0].ready());
    await page.waitForFunction(() => __codexOpenSea.status().state === 'ready');
    assert.equal(await page.evaluate(() => __skinOceanRecords[0].canvas.style.opacity), '1');
    assert.equal(await page.locator('#overlay [data-open-sea-part]').count(), 0);
    for (const theme of ['aurora', 'dunes', 'coast']) {
      const status = await page.evaluate(theme => __codexOpenSea.apply({ theme }), theme);
      assert.equal(status.state, 'ready'); assert.equal(status.ocean, null);
      assert.match(await page.locator('#codex-open-sea-backdrop').evaluate(el => el.style.backgroundImage.slice(0,60)), /^url\("data:image\/svg\+xml/);
    }
    assert.equal(await page.evaluate(() => __skinOceanRecords[0].disposals), 1);
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zp1sAAAAASUVORK5CYII=';
    assert.equal((await page.evaluate(imageData => __codexOpenSea.apply({ theme:'custom',imageData }), image)).theme, 'custom');
    assert.match(await page.locator('#codex-open-sea-backdrop').evaluate(el => el.style.backgroundImage.slice(0,60)), /^url\("data:image\/png/);
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',wave:80,daylight:18,paused:true}));
    await page.evaluate(() => __skinOceanRecords.at(-1).ready());
    const ocean = await page.evaluate(() => __codexOpenSea.status().ocean);
    assert.deepEqual([ocean.wave, ocean.daylight, ocean.paused], [80,18,true]);
  } finally { await page.close(); }
});

test('missing shell removes transparency and actually hides the host; late first frame cannot reactivate it', async () => {
  const page = await pageWithSkin();
  try {
    await page.evaluate(() => { window.__savedMain = document.querySelector('main'); __savedMain.remove(); });
    await page.waitForFunction(() => __codexOpenSea.status().state === 'waiting-shell');
    const inactive = await page.evaluate(() => ({
      root:document.documentElement.getAttribute('data-open-sea'), sheets:document.adoptedStyleSheets.length,
      body:getComputedStyle(document.body).backgroundColor,
      hidden:document.querySelector('#codex-open-sea-backdrop').hidden,
      display:getComputedStyle(document.querySelector('#codex-open-sea-backdrop')).display,
      marked:document.querySelectorAll('[data-open-sea-part]').length,
      savedMark:__savedMain.getAttribute('data-open-sea-part'),
    }));
    assert.deepEqual(inactive, {root:'prior',sheets:1,body:'rgb(31, 32, 33)',hidden:true,display:'none',marked:0,savedMark:'prior-main'});
    await page.evaluate(() => __skinOceanRecords[0].ready());
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state), 'waiting-shell');
    await page.evaluate(() => document.querySelector('#root').append(__savedMain));
    await page.waitForFunction(() => __skinOceanRecords.length === 2);
    assert.equal(await page.locator('#codex-open-sea-backdrop').evaluate(el => getComputedStyle(el).display), 'block');
    await page.evaluate(() => __skinOceanRecords[1].ready());
    await page.waitForFunction(() => __codexOpenSea.status().state === 'ready');
  } finally { await page.close(); }
});

test('an overlay-only main never activates the adapter; shell added later uses the selected preset', async () => {
  const page = await pageWithSkin({ beforeInstall() {
    document.querySelector('main').remove();
    const overlayMain = document.createElement('main'); overlayMain.setAttribute('data-app-shell-main-surface','');
    document.querySelector('#overlay').append(overlayMain);
  } });
  try {
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state), 'waiting-shell');
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 1);
    await page.evaluate(() => __codexOpenSea.apply({theme:'coast'}));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state), 'waiting-shell');
    await page.evaluate(() => { const main=document.createElement('main');main.setAttribute('data-app-shell-main-surface','');document.querySelector('#root').append(main); });
    await page.waitForFunction(() => __codexOpenSea.status().state === 'ready');
    assert.equal(await page.evaluate(() => __codexOpenSea.status().theme), 'coast');
  } finally { await page.close(); }
});

test('dark/light changes only semantic surfaces and markers leave elements moved into dialogs', async () => {
  const page = await pageWithSkin();
  try {
    await page.evaluate(() => __codexOpenSea.apply({theme:'aurora',opacity:65}));
    assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(17, 23, 29, 0.65)');
    await page.evaluate(() => document.documentElement.className = 'electron-light');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('main')).backgroundColor === 'rgba(245, 248, 249, 0.65)');
    assert.equal(await page.locator('#overlay').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(81, 82, 83)');
    assert.equal(await page.locator('#overlay-composer').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(71, 72, 73)');
    await page.evaluate(() => document.querySelector('#overlay').append(document.querySelector('#composer')));
    await page.waitForFunction(() => !document.querySelector('#composer').hasAttribute('data-open-sea-part'));
    assert.equal(await page.locator('#composer').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(71, 72, 73)');
    await page.evaluate(() => document.querySelector('main').removeAttribute('data-app-shell-main-surface'));
    await page.waitForFunction(() => __codexOpenSea.status().state === 'waiting-shell');
    assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(51, 52, 53)');
  } finally { await page.close(); }
});

test('window frame and nested titlebars share one glass layer without changing navigation or drag regions', async () => {
  const page = await pageWithSkin({ beforeInstall() {
    const root = document.querySelector('#root');
    const frame = document.createElement('div');
    frame.id = 'app-frame'; frame.setAttribute('data-app-shell-frame', 'true');
    frame.style.cssText = 'background:linear-gradient(rgb(120,130,140),rgb(150,160,170));';
    root.before(frame);
    const titlebar = document.createElement('header');
    titlebar.id = 'titlebar'; titlebar.setAttribute('data-app-shell-titlebar', 'true');
    titlebar.setAttribute('data-open-sea-part', 'prior-titlebar');
    titlebar.style.cssText = 'height:44px;position:relative;padding:0 12px;pointer-events:auto;-webkit-app-region:drag;background:linear-gradient(rgb(180,190,200),rgb(160,170,180));';
    titlebar.innerHTML = '<div id="main-titlebar" data-app-shell-main-titlebar style="height:44px;background:rgb(190,200,210)"><header id="window-titlebar" data-window-titlebar style="height:44px;background:linear-gradient(rgb(160,170,180),rgb(140,150,160))"><button id="navigation-back" type="button" aria-label="Back" style="-webkit-app-region:no-drag;background:rgb(90,100,110)">Back</button></header></div>';
    frame.append(titlebar, root);
    const dialogTitlebar = document.createElement('header');
    dialogTitlebar.id = 'dialog-titlebar'; dialogTitlebar.setAttribute('data-app-shell-titlebar', 'true');
    dialogTitlebar.style.background = 'rgb(111, 112, 113)';
    document.querySelector('#overlay').append(dialogTitlebar);
    window.__titlebarClicks = 0;
    document.querySelector('#navigation-back').addEventListener('click', () => { window.__titlebarClicks++; });
    window.__titlebarBefore = Object.fromEntries(['app-frame','titlebar','main-titlebar','window-titlebar','navigation-back'].map(id => {
      const element = document.getElementById(id), style = getComputedStyle(element);
      return [id, { inline:element.getAttribute('style'), background:style.backgroundColor, image:style.backgroundImage,
        height:style.height, position:style.position, pointerEvents:style.pointerEvents, appRegion:style.webkitAppRegion }];
    }));
  } });
  try {
    await page.evaluate(() => __codexOpenSea.apply({theme:'aurora',opacity:40}));
    assert.equal(await page.locator('#titlebar').getAttribute('data-open-sea-part'), 'titlebar');
    for (const id of ['main-titlebar','window-titlebar']) {
      assert.equal(await page.locator(`#${id}`).getAttribute('data-open-sea-part'), 'titlebar-inner');
    }
    const paint = () => page.evaluate(() => Object.fromEntries(['app-frame','titlebar','main-titlebar','window-titlebar'].map(id => {
      const style = getComputedStyle(document.getElementById(id));
      return [id, [style.backgroundColor,style.backgroundImage]];
    })));
    assert.deepEqual(await paint(), {
      'app-frame':['rgba(17, 23, 29, 0.4)','none'], titlebar:['rgba(0, 0, 0, 0)','none'],
      'main-titlebar':['rgba(0, 0, 0, 0)','none'], 'window-titlebar':['rgba(0, 0, 0, 0)','none'],
    });
    assert.equal(await page.locator('#dialog-titlebar').getAttribute('data-open-sea-part'), null);
    assert.equal(await page.locator('#dialog-titlebar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(111, 112, 113)');
    assert.equal(await page.locator('#navigation-back').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(90, 100, 110)');
    const geometry = await page.evaluate(() => ['titlebar','main-titlebar','window-titlebar','navigation-back'].map(id => {
      const element = document.getElementById(id), style = getComputedStyle(element), before = __titlebarBefore[id];
      return { same:['height','position','pointerEvents'].every(property => style[property] === before[property])
        && style.webkitAppRegion === before.appRegion, inline:element.getAttribute('style') === before.inline };
    }));
    assert.ok(geometry.every(result => result.same && result.inline), 'paint-only overrides must preserve geometry, native drag properties and inline styles');
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.querySelector('#titlebar')).webkitAppRegion,
      getComputedStyle(document.querySelector('#navigation-back')).webkitAppRegion]), ['drag','no-drag']);
    const back = page.getByRole('button', {name:'Back',exact:true});
    await back.click(); await back.press('Enter');
    assert.equal(await page.evaluate(() => __titlebarClicks), 2, 'navigation remains usable by pointer and keyboard');
    await page.evaluate(() => { __codexOpenSea.apply({theme:'aurora',opacity:70}); document.documentElement.className='electron-light'; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#app-frame')).backgroundColor === 'rgba(245, 248, 249, 0.7)');
    assert.equal((await paint()).titlebar[0], 'rgba(0, 0, 0, 0)', 'the titlebar uses its frame glass rather than a second layer');
    assert.equal((await paint())['window-titlebar'][0], 'rgba(0, 0, 0, 0)', 'nested titlebars must not stack opacity after a theme change');
    await page.evaluate(() => __codexOpenSea.dispose());
    assert.equal(await page.locator('#titlebar').getAttribute('data-open-sea-part'), 'prior-titlebar');
    for (const id of ['app-frame','main-titlebar','window-titlebar']) assert.equal(await page.locator(`#${id}`).getAttribute('data-open-sea-part'), null);
    assert.ok(await page.evaluate(() => Object.entries(__titlebarBefore).every(([id, before]) => {
      const element = document.getElementById(id), style = getComputedStyle(element);
      return element.getAttribute('style') === before.inline && style.backgroundColor === before.background && style.backgroundImage === before.image;
    })), 'restore brings back every original paint and inline style');
    assert.deepEqual(await page.evaluate(() => [document.adoptedStyleSheets.length,document.adoptedStyleSheets[0]===__sentinel]), [1,true]);
  } finally { await page.close(); }
});

test('late titlebar attributes, nesting changes and dialog moves restore their own surfaces', async () => {
  const page = await pageWithSkin();
  try {
    await page.evaluate(() => {
      const frame = document.createElement('div'); frame.id='late-frame';frame.style.background='rgb(100, 110, 120)';
      const header = document.createElement('header'); header.id='late-titlebar';header.style.background='rgb(130, 140, 150)';
      const inner = document.createElement('header'); inner.id='late-inner';inner.style.background='rgb(160, 170, 180)';
      header.append(inner);frame.append(header);document.querySelector('#root').before(frame);
    });
    assert.equal(await page.locator('#late-titlebar').getAttribute('data-open-sea-part'), null);
    await page.evaluate(() => {
      document.querySelector('#late-frame').setAttribute('data-app-shell-frame','true');
      document.querySelector('#late-titlebar').setAttribute('data-app-shell-titlebar','true');
      document.querySelector('#late-inner').setAttribute('data-window-titlebar','true');
    });
    await page.waitForFunction(() => document.querySelector('#late-frame').getAttribute('data-open-sea-part')==='frame'
      && document.querySelector('#late-titlebar').getAttribute('data-open-sea-part')==='titlebar'
      && document.querySelector('#late-inner').getAttribute('data-open-sea-part')==='titlebar-inner');
    await page.evaluate(() => document.querySelector('#late-titlebar').removeAttribute('data-app-shell-titlebar'));
    await page.waitForFunction(() => !document.querySelector('#late-titlebar').hasAttribute('data-open-sea-part')
      && document.querySelector('#late-inner').getAttribute('data-open-sea-part')==='titlebar');
    assert.equal(await page.locator('#late-titlebar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(130, 140, 150)');
    await page.evaluate(() => document.querySelector('#late-titlebar').setAttribute('data-app-shell-main-titlebar','true'));
    await page.waitForFunction(() => document.querySelector('#late-titlebar').getAttribute('data-open-sea-part')==='titlebar'
      && document.querySelector('#late-inner').getAttribute('data-open-sea-part')==='titlebar-inner');
    await page.evaluate(() => document.querySelector('#overlay').append(document.querySelector('#late-titlebar')));
    await page.waitForFunction(() => !document.querySelector('#late-titlebar').hasAttribute('data-open-sea-part')
      && !document.querySelector('#late-inner').hasAttribute('data-open-sea-part'));
    assert.deepEqual(await page.evaluate(() => ['late-titlebar','late-inner'].map(id => getComputedStyle(document.getElementById(id)).backgroundColor)),
      ['rgb(130, 140, 150)','rgb(160, 170, 180)']);
    await page.evaluate(() => {
      document.querySelector('#late-frame').append(document.querySelector('#late-titlebar'));
      window.__lateMain=document.querySelector('main');__lateMain.remove();
    });
    await page.waitForFunction(() => __codexOpenSea.status().state==='waiting-shell');
    assert.equal(await page.locator('#late-frame').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(100, 110, 120)');
    for (const id of ['late-frame','late-titlebar','late-inner']) assert.equal(await page.locator(`#${id}`).getAttribute('data-open-sea-part'), null);
    await page.evaluate(() => document.querySelector('#root').append(__lateMain));
    await page.waitForFunction(() => document.querySelector('#late-titlebar').getAttribute('data-open-sea-part')==='titlebar'
      && document.querySelector('#late-inner').getAttribute('data-open-sea-part')==='titlebar-inner');
    assert.equal(await page.locator('#late-frame').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(17, 23, 29, 0.4)');
  } finally { await page.close(); }
});

test('one frame glass covers edge insets and rounded corners while sidebar extension and resize hit area stay independent', async () => {
  const page = await pageWithSkin({ beforeInstall() {
    const style = document.createElement('style');
    style.textContent = `
      #seam-frame { display:flex;flex-direction:column;width:900px;height:540px;box-sizing:border-box;
        padding-block-end:4px;padding-inline-end:4px;background:linear-gradient(rgb(130,140,150),rgb(160,170,180)); }
      #seam-frame > #root { flex:1;min-height:0;width:100%; }
      #seam-titlebar { height:40px;flex:none;background:rgb(90,100,110); }
      #seam-sidebar { position:relative;flex:none;height:100%; }
      #seam-sidebar:not([data-app-shell-left-panel-appearance="content-surface"])::after {
        content:"";position:absolute;inset:0 -20px 0 auto;width:20px;background:inherit;pointer-events:none;
      }
      #seam-main { min-width:0;border-radius:20px;clip-path:inset(0 round 20px); }
      #seam-resizer { position:absolute;right:-5px;top:0;bottom:0;width:10px;z-index:2;cursor:col-resize;touch-action:none; }
      #seam-resizer::after { content:"";position:absolute;left:5px;top:0;bottom:0;width:1px;background:rgb(90,110,120); }
      #seam-nested { width:60px;height:30px;background:rgb(180,190,200); }
      #overlay-aside { background:rgb(100,110,120); }
      #overlay-aside::after { content:"";background:inherit;width:20px;position:absolute;right:-20px;top:0;bottom:0; }
    `;
    document.head.append(style);
    const root = document.querySelector('#root'), frame = document.createElement('div');
    frame.id = 'seam-frame';frame.setAttribute('data-app-shell-frame','true');frame.setAttribute('data-app-shell-page-surface','true');
    root.before(frame);
    const titlebar = document.createElement('header');titlebar.id='seam-titlebar';titlebar.setAttribute('data-app-shell-titlebar','true');
    frame.append(titlebar,root,document.querySelector('#overlay'));
    const sidebar = root.querySelector('aside');sidebar.id='seam-sidebar';
    const main = root.querySelector('main');main.id='seam-main';
    const nested = document.createElement('div');nested.id='seam-nested';nested.setAttribute('data-app-shell-frame','true');nested.setAttribute('data-app-shell-page-surface','true');main.append(nested);
    const resizer = document.createElement('div');resizer.id='seam-resizer';resizer.setAttribute('role','separator');resizer.setAttribute('aria-label','Resize sidebar');resizer.setAttribute('aria-orientation','vertical');sidebar.append(resizer);
    window.__seamMoves = 0;
    resizer.addEventListener('pointerdown', event => { resizer.setPointerCapture(event.pointerId);window.__seamDrag={x:event.clientX,width:sidebar.getBoundingClientRect().width}; });
    resizer.addEventListener('pointermove', event => { if(!__seamDrag)return;__seamMoves++;sidebar.style.width=`${__seamDrag.width+event.clientX-__seamDrag.x}px`; });
    resizer.addEventListener('pointerup', () => { window.__seamDrag=null; });
    const overlayAside = document.createElement('aside');overlayAside.id='overlay-aside';overlayAside.className='app-shell-left-panel';document.querySelector('#overlay').append(overlayAside);
    window.__seamStyle = (id, pseudo = null) => {
      const element = document.getElementById(id), css = getComputedStyle(element,pseudo);
      return { background:css.backgroundColor,image:css.backgroundImage,width:css.width,height:css.height,
        top:css.top,right:css.right,bottom:css.bottom,left:css.left,position:css.position,pointerEvents:css.pointerEvents,
        cursor:css.cursor,clipPath:css.clipPath,radius:css.borderRadius,paddingRight:css.paddingRight,paddingBottom:css.paddingBottom,
        inline:element.getAttribute('style') };
    };
    window.__seamBefore = Object.fromEntries(['seam-frame','seam-titlebar','seam-sidebar','seam-main','seam-nested','seam-resizer','overlay-aside'].map(id => [id,__seamStyle(id)]));
    window.__seamBeforeExtension=__seamStyle('seam-sidebar','::after');
    window.__seamBeforeDivider=__seamStyle('seam-resizer','::after');
  } });
  try {
    assert.equal(await page.locator('#seam-frame').getAttribute('data-open-sea-part'),'frame','frame wins when the same root is also a page surface');
    assert.equal(await page.locator('#seam-nested').getAttribute('data-open-sea-part'),'frame-inner');
    for (const [scheme, opacity, expected] of [
      ['electron-dark',40,'rgba(17, 23, 29, 0.4)'],
      ['electron-light',65,'rgba(245, 248, 249, 0.65)'],
    ]) {
      await page.evaluate(({scheme,opacity}) => { document.documentElement.className=scheme;__codexOpenSea.apply({theme:'aurora',opacity}); },{scheme,opacity});
      assert.equal(await page.locator('#seam-frame').evaluate(el => getComputedStyle(el).backgroundColor),expected);
      for (const id of ['seam-titlebar','seam-sidebar','seam-main','seam-nested']) {
        assert.equal(await page.locator(`#${id}`).evaluate(el => getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)',`${id} must not stack glass over the frame`);
      }
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#seam-sidebar'),'::after').backgroundColor),'rgba(0, 0, 0, 0)','the wide native sidebar extension must not inherit a second tint');
      const separatorImage=await page.evaluate(() => getComputedStyle(document.querySelector('#seam-sidebar'),'::after').backgroundImage);
      assert.match(separatorImage,/^linear-gradient\(to right,/);
      assert.match(separatorImage,/rgba\(0, 0, 0, 0\) 1px\)$/,'only the first pixel is painted; the remaining extension stays transparent');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#seam-frame')).backgroundImage),'none');
      assert.deepEqual(await page.evaluate(() => {
        const frame=document.querySelector('#seam-frame'), box=frame.getBoundingClientRect();
        return [[box.right-2,box.top+150],[box.left+500,box.bottom-2]].map(([x,y])=>document.elementFromPoint(x,y)?.id);
      }),['seam-frame','seam-frame'],'right and bottom insets expose the same painted frame rather than an untinted backdrop');
    }
    assert.ok(await page.evaluate(() => ['seam-frame','seam-titlebar','seam-sidebar','seam-main','seam-nested','seam-resizer'].every(id => {
      const now=__seamStyle(id),before=__seamBefore[id];
      return Object.keys(before).filter(key=>!['background','image'].includes(key)).every(key=>now[key]===before[key]);
    })), 'paint-only fixes must preserve dimensions, native roundness, clipping, padding and resize hit area');
    assert.ok(await page.evaluate(() => {
      const now=__seamStyle('seam-sidebar','::after');
      return Object.keys(__seamBeforeExtension).filter(key=>!['background','image'].includes(key)).every(key=>now[key]===__seamBeforeExtension[key]);
    }), 'the extension geometry and pointer-events remain untouched');
    assert.deepEqual(await page.evaluate(() => __seamStyle('seam-resizer','::after')),await page.evaluate(() => __seamBeforeDivider),'the original one-pixel divider remains intact');
    assert.equal(await page.locator('#overlay-aside').getAttribute('data-open-sea-part'),null);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#overlay-aside'),'::after').backgroundColor),'rgb(100, 110, 120)');
    const handle = await page.locator('#seam-resizer').boundingBox();
    await page.mouse.move(handle.x+handle.width/2,handle.y+100);await page.mouse.down();
    await page.mouse.move(handle.x+handle.width/2+35,handle.y+100,{steps:5});await page.mouse.up();
    assert.equal(await page.locator('#seam-sidebar').evaluate(el=>el.getBoundingClientRect().width),255);
    assert.ok(await page.evaluate(()=>__seamMoves)>0,'a real pointer drag reaches the original resize control');
    await page.evaluate(()=>document.querySelector('#seam-sidebar').removeAttribute('style'));
    await page.evaluate(() => __codexOpenSea.dispose());
    assert.ok(await page.evaluate(() => Object.entries(__seamBefore).every(([id,before])=>JSON.stringify(__seamStyle(id))===JSON.stringify(before))),'dispose restores each original background, geometry and inline style');
    assert.deepEqual(await page.evaluate(() => __seamStyle('seam-sidebar','::after')),await page.evaluate(() => __seamBeforeExtension));
  } finally { await page.close(); }
});

function installNativeComposerFixture() {
  document.querySelector('#composer').remove();
  const style=document.createElement('style');
  style.textContent=`
    .native-composer {
      position:relative;width:440px;margin:55px 20px 20px;overflow:visible;
      --composer-layout-surface-background:rgb(70,80,90);
      --composer-layout-surface-backdrop-filter:blur(4px);
      --composer-layout-surface-shadow:0 2px 8px rgba(0,0,0,.2);
    }
    .native-composer[data-composer-surface-variant="opaque"] { --composer-layout-surface-background:rgb(90,100,110); }
    .native-composer[data-composer-surface-variant="secondary"] { --composer-layout-surface-background:rgb(110,120,130); }
    .native-composer[data-composer-surface-variant="inline"] {
      --composer-layout-surface-background:transparent;--composer-layout-surface-backdrop-filter:none;--composer-layout-surface-shadow:none;
    }
    .native-composer[data-composer-surface-variant="document"] { --composer-layout-surface-background:rgba(150,160,170,.25); }
    .native-composer[data-composer-surface-variant="document"]:focus-within { --composer-layout-surface-background:rgb(150,160,170); }
    .native-composer[data-composer-drag-active] { --composer-layout-surface-background:rgb(40,100,180);--composer-layout-surface-backdrop-filter:none; }
    .native-composer:not([data-composer-utility-bar-variant="home"]),
    .native-composer[data-composer-utility-bar-variant="home"] [data-composer-body] {
      background-color:var(--composer-layout-surface-background);
      backdrop-filter:var(--composer-layout-surface-backdrop-filter);
      box-shadow:var(--composer-layout-surface-shadow);
    }
    .native-composer [data-composer-body] { height:110px;padding:10px;box-sizing:border-box; }
    .native-composer[data-composer-radius-variant="default"]:not([data-composer-utility-bar-variant="home"]),
    .native-composer[data-composer-radius-variant="default"] [data-composer-body] { border-radius:24px; }
    .native-composer[data-composer-radius-variant="single-line"]:not([data-composer-utility-bar-variant="home"]),
    .native-composer[data-composer-radius-variant="single-line"] [data-composer-body] { border-radius:32px; }
    .native-composer .utility { position:absolute;left:12px;right:12px;top:-35px;height:35px;overflow:visible;background:rgb(170,180,190);border-radius:16px 16px 0 0; }
    .native-composer textarea { display:block;width:250px;height:35px;background:transparent; }
  `;
  document.head.append(style);
  const main=document.querySelector('main');
  for(const [id,utility] of [['native-home','home'],['native-thread','default'],['native-dialog','home']]) {
    const composer=document.createElement('div');composer.id=id;composer.className='native-composer fixture_ComposerLayoutRoot_abc';
    composer.setAttribute('data-composer-surface-variant','default');composer.setAttribute('data-composer-radius-variant','default');composer.setAttribute('data-composer-utility-bar-variant',utility);
    composer.innerHTML=`<div class="utility"><button type="button" id="${id}-utility">Fixture workspace</button></div><div id="${id}-body" data-composer-body class="fixture_ComposerLayoutBody_def"><textarea aria-label="${id} input"></textarea><div data-composer-footer-responsive>Fixture footer</div></div>`;
    (id==='native-dialog'?document.querySelector('#overlay'):main).append(composer);
  }
  window.__utilityClicks=0;document.querySelector('#native-home-utility').addEventListener('click',()=>{__utilityClicks++;});
  window.__composerPaint=(id)=> {
    const element=document.getElementById(id),css=getComputedStyle(element);
    return {background:css.backgroundColor,filter:css.backdropFilter,shadow:css.boxShadow,radius:css.borderRadius,
      overflow:css.overflow,position:css.position,height:css.height,width:css.width,inline:element.getAttribute('style')};
  };
  window.__composerBefore=Object.fromEntries(['native-home','native-home-body','native-thread','native-thread-body','native-dialog','native-dialog-body'].map(id=>[id,__composerPaint(id)]));
}

test('native composers retain their actual rounded paint layer, animated radii and protruding utility controls', async () => {
  const page=await pageWithSkin({beforeInstall:installNativeComposerFixture});
  try {
    await page.evaluate(()=>__codexOpenSea.apply({theme:'aurora',opacity:40}));
    const paint=id=>page.evaluate(id=>__composerPaint(id),id);
    assert.equal((await paint('native-home')).background,'rgba(0, 0, 0, 0)','home wrapper must not paint a square backdrop outside its rounded body');
    assert.equal((await paint('native-home')).filter,'none','home wrapper must not blur the rectangular area outside its body');
    assert.equal((await paint('native-home-body')).background,'rgba(17, 23, 29, 0.6)');
    assert.equal((await paint('native-home-body')).radius,'24px');
    assert.equal((await paint('native-thread')).background,'rgba(17, 23, 29, 0.6)','ordinary thread keeps painting its own rounded root');
    assert.equal((await paint('native-thread-body')).background,'rgba(0, 0, 0, 0)','a thread body must not add another glass layer');
    assert.equal((await paint('native-thread')).radius,'24px');
    assert.equal((await paint('native-home-body')).filter,'blur(12px)');
    assert.ok(await page.evaluate(()=>Object.entries(__composerBefore).every(([id,before])=> {
      const now=__composerPaint(id);return ['radius','overflow','position','height','width','inline','shadow'].every(key=>now[key]===before[key]);
    })),'official roundness, geometry, overflow and shadows stay unchanged');
    await page.locator('#native-home-utility').click();
    assert.equal(await page.evaluate(()=>__utilityClicks),1,'utility controls outside the root bounds must not get clipped');
    await page.evaluate(()=> {
      for(const id of ['native-home','native-thread'])document.getElementById(id).setAttribute('data-composer-radius-variant','single-line');
    });
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#native-home-body')).borderRadius==='32px');
    assert.equal((await paint('native-thread')).radius,'32px');
    await page.evaluate(()=>document.querySelector('#native-home-body').style.borderRadius='29px 31px 27px 25px');
    assert.equal((await paint('native-home-body')).radius,'29px 31px 27px 25px','host inline animation owns the intermediate radius');
    await page.evaluate(()=> {document.documentElement.className='electron-light';__codexOpenSea.apply({theme:'aurora',opacity:80});});
    assert.equal((await paint('native-home-body')).background,'rgba(245, 248, 249, 0.8)');
    assert.equal((await paint('native-home')).background,'rgba(0, 0, 0, 0)');
    assert.equal((await paint('native-thread')).background,'rgba(245, 248, 249, 0.8)');
    assert.equal(await page.locator('#native-dialog').getAttribute('data-open-sea-part'),null);
    assert.equal((await paint('native-dialog-body')).background,'rgb(70, 80, 90)');
    await page.evaluate(()=> {
      for(const id of ['native-home','native-thread'])document.getElementById(id).setAttribute('data-composer-radius-variant','default');
      document.querySelector('#native-home-body').removeAttribute('style');__codexOpenSea.dispose();
    });
    assert.ok(await page.evaluate(()=>Object.entries(__composerBefore).every(([id,before])=>JSON.stringify(__composerPaint(id))===JSON.stringify(before))),'restore returns all native paint, radii, shadow, filter and inline styles');
  } finally { await page.close(); }
});

test('native composer inline, focused document and drag states keep their original visual semantics', async () => {
  const page=await pageWithSkin({beforeInstall:installNativeComposerFixture});
  try {
    await page.evaluate(()=>__codexOpenSea.apply({theme:'aurora',opacity:40}));
    for(const variant of ['default','opaque','secondary']) {
      await page.evaluate(variant=>document.querySelector('#native-home').setAttribute('data-composer-surface-variant',variant),variant);
      assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#native-home-body')).backgroundColor),'rgba(17, 23, 29, 0.6)');
    }
    await page.evaluate(()=>document.querySelector('#native-home').setAttribute('data-composer-surface-variant','inline'));
    assert.deepEqual(await page.evaluate(()=> {const css=getComputedStyle(document.querySelector('#native-home-body'));return [css.backgroundColor,css.backdropFilter,css.boxShadow];}),['rgba(0, 0, 0, 0)','none','none']);
    await page.evaluate(()=>document.querySelector('#native-home').setAttribute('data-composer-surface-variant','document'));
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#native-home-body')).backgroundColor),'rgba(150, 160, 170, 0.25)');
    await page.getByRole('textbox',{name:'native-home input',exact:true}).focus();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#native-home-body')).backgroundColor),'rgb(150, 160, 170)','document focus opacity remains controlled by Codex');
    await page.evaluate(()=> {document.activeElement.blur();const home=document.querySelector('#native-home');home.setAttribute('data-composer-surface-variant','default');home.setAttribute('data-composer-drag-active','true');});
    assert.deepEqual(await page.evaluate(()=> {const css=getComputedStyle(document.querySelector('#native-home-body'));return [css.backgroundColor,css.backdropFilter];}),['rgb(40, 100, 180)','none'],'drag feedback remains distinct');
    await page.evaluate(()=>document.querySelector('#native-home').removeAttribute('data-composer-drag-active'));
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#native-home-body')).backgroundColor),'rgba(17, 23, 29, 0.6)');
    await page.evaluate(()=>document.querySelector('#overlay').append(document.querySelector('#native-home')));
    await page.waitForFunction(()=>!document.querySelector('#native-home').hasAttribute('data-open-sea-part'));
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('#native-home-body')).backgroundColor),'rgb(70, 80, 90)','moving into an overlay relinquishes the variables');
  } finally { await page.close(); }
});

test('restore preserves prior attributes/stylesheets and rejects stale callbacks and reinsertion', async () => {
  const page = await pageWithSkin({beforeInstall() { document.documentElement.setAttribute('data-open-sea','active'); }});
  try {
    await page.evaluate(() => { window.__staleSkin = __codexOpenSea; __codexOpenSea.dispose(); });
    const restored = await page.evaluate(() => ({ api:typeof window.__codexOpenSea,
      host:document.querySelector('#codex-open-sea-backdrop'), root:document.documentElement.getAttribute('data-open-sea'),
      mark:document.querySelector('main').getAttribute('data-open-sea-part'), sheets:document.adoptedStyleSheets.length,
      sentinel:document.adoptedStyleSheets[0] === __sentinel, body:getComputedStyle(document.body).backgroundColor,
    }));
    assert.deepEqual(restored, {api:'undefined',host:null,root:'active',mark:'prior-main',sheets:1,sentinel:true,body:'rgb(31, 32, 33)'});
    await page.evaluate(() => { __skinOceanRecords[0].ready(); __skinOceanRecords[0].fail(); document.body.append(document.createElement('section')); document.documentElement.className='electron-light'; });
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => __staleSkin.status().state), 'disposed');
    assert.equal(await page.evaluate(() => __staleSkin.dispose().state), 'disposed');
    assert.equal(await page.evaluate(() => {try {__staleSkin.apply({});return false;}catch{return true;}}), true);
  } finally { await page.close(); }
});

test('renderer failure keeps the static ocean and a later apply starts a fresh instance', async () => {
  const page = await pageWithSkin();
  try {
    await page.evaluate(() => __skinOceanRecords[0].fail());
    await page.waitForFunction(() => __codexOpenSea.status().state === 'fallback');
    assert.match(await page.locator('#codex-open-sea-backdrop').evaluate(el => el.style.backgroundImage.slice(0,60)), /^url\("data:image\/jpeg/);
    assert.match(await page.evaluate(() => __codexOpenSea.status().error), /static ocean remains visible/);
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',paused:true}));
    assert.equal(await page.evaluate(() => __skinOceanRecords.length), 2);
    assert.equal(await page.evaluate(() => __skinOceanRecords[0].disposals), 1);
    await page.evaluate(() => { __skinOceanRecords[0].ready(); __skinOceanRecords[0].fail(); });
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state), 'initializing');
    await page.evaluate(() => __skinOceanRecords[1].ready());
    await page.waitForFunction(() => __codexOpenSea.status().state === 'ready');
    assert.equal(await page.evaluate(() => __codexOpenSea.status().error), null);
  } finally { await page.close(); }
});

test('status reads an active ocean recovery immediately without a document mutation or callback', async () => {
  const page = await pageWithSkin();
  try {
    await page.evaluate(() => __skinOceanRecords[0].ready());
    await page.waitForFunction(() => __codexOpenSea.status().state === 'ready');
    const status = await page.evaluate(() => {
      __skinOceanRecords[0].recover();
      return __codexOpenSea.status();
    });
    assert.equal(status.state, 'initializing');
    assert.equal(status.ocean.state, 'initializing');
    assert.equal(status.error, null);
    await page.evaluate(() => __skinOceanRecords[0].ready());
    assert.equal(await page.evaluate(() => __codexOpenSea.status().state), 'ready');
  } finally { await page.close(); }
});

test('real bundled ocean becomes ready, honors pause, switches preset, and restores the fixture', async t => {
  const page = await pageWithSkin({real:true});
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',paused:true,wave:70,daylight:20}));
    await page.waitForFunction(() => ['ready','fallback'].includes(__codexOpenSea.status().state), null, {timeout:45000});
    const status = await page.evaluate(() => __codexOpenSea.status());
    assert.equal(status.state, 'ready', JSON.stringify(status));
    t.diagnostic(`Normal ocean backend: ${status.ocean.backend}; first failure: ${JSON.stringify(status.ocean.firstFailure)}`);
    assert.deepEqual([status.ocean.wave,status.ocean.daylight,status.ocean.paused], [70,20,true]);
    const elapsed=status.ocean.elapsed;
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().ocean.elapsed), elapsed);
    await page.evaluate(() => __codexOpenSea.apply({theme:'dunes'}));
    assert.equal(await page.evaluate(() => __codexOpenSea.status().ocean), null);
    await page.evaluate(() => __codexOpenSea.dispose());
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('real ocean recovers a rejected WebGPU first frame with WebGL2 and releases both contexts', async () => {
  const page = await pageWithSkin({ real:true, beforeInstall() {
    window.__gpuFailureProbe = { failures:0, destroyedDevices:0, canvases:[], webglContexts:[] };
    // Reproduce a browser exposing WebGPU whose device cannot supply the first frame.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const context = getContext.call(this, type, ...args);
      if (type === 'webgpu' && context) {
        __gpuFailureProbe.canvases.push(this);
        context.getCurrentTexture = () => {
          __gpuFailureProbe.failures++;
          throw new DOMException('A valid external Instance reference no longer exists.', 'OperationError');
        };
      }
      if (type === 'webgl2' && context) __gpuFailureProbe.webglContexts.push(context);
      return context;
    };
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await requestDevice.apply(this, args);
      const destroy = device.destroy.bind(device);
      device.destroy = () => { __gpuFailureProbe.destroyedDevices++; destroy(); };
      return device;
    };
  } });
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',paused:true,wave:81,daylight:29}));
    await page.waitForFunction(() => ['ready','fallback'].includes(__codexOpenSea.status().state), null, {timeout:45000});
    const status = await page.evaluate(() => __codexOpenSea.status());
    assert.equal(status.state, 'ready', JSON.stringify(status));
    assert.equal(status.ocean.backend, 'webgl2');
    assert.deepEqual([status.ocean.wave,status.ocean.daylight,status.ocean.paused], [81,29,true]);
    assert.equal(status.error, null);
    const probe = await page.evaluate(() => ({ failures:__gpuFailureProbe.failures,
      destroyedDevices:__gpuFailureProbe.destroyedDevices,
      oldCanvasesRemoved:__gpuFailureProbe.canvases.every(canvas => !canvas.isConnected),
      webglContexts:__gpuFailureProbe.webglContexts.length }));
    assert.ok(probe.failures > 0, 'the first-frame failure must actually be exercised');
    assert.ok(probe.destroyedDevices > 0, 'the failed GPU device must be destroyed before ready');
    assert.equal(probe.oldCanvasesRemoved, true);
    assert.ok(probe.webglContexts > 0);
    const elapsed=status.ocean.elapsed;
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().ocean.elapsed), elapsed);
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',paused:false,wave:63,daylight:41}));
    await page.waitForFunction(elapsed => __codexOpenSea.status().ocean.elapsed > elapsed, elapsed);
    await page.evaluate(() => __codexOpenSea.dispose());
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => __gpuFailureProbe.webglContexts.every(context => context.isContextLost())), true);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('a real WebGPU device lost after readiness recovers visibly without reporting false readiness', async t => {
  const page = await pageWithSkin({ real:true, beforeInstall() {
    window.__lateLossProbe = { devices:[], canvases:[], webglContexts:[], transitions:[], destroyed:0 };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      const context = getContext.call(this, type, ...args);
      if (type === 'webgpu' && context) __lateLossProbe.canvases.push(this);
      if (type === 'webgl2' && context) __lateLossProbe.webglContexts.push(context);
      return context;
    };
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await requestDevice.apply(this, args);
      __lateLossProbe.devices.push(device);
      const destroy = device.destroy.bind(device);
      device.destroy = () => { __lateLossProbe.destroyed++; destroy(); };
      // Observe after Three's loss handler, before the replacement attempt starts.
      device.lost.then(() => queueMicrotask(() => queueMicrotask(() => {
        if (window.__codexOpenSea) __lateLossProbe.transitions.push(__codexOpenSea.status());
      })));
      return device;
    };
  } });
  const errors=[]; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',paused:true,wave:79,daylight:24}));
    await page.waitForFunction(() => ['ready','fallback'].includes(__codexOpenSea.status().state), null, {timeout:45000});
    const before = await page.evaluate(() => __codexOpenSea.status());
    assert.equal(before.state, 'ready', JSON.stringify(before));
    if (before.ocean.backend === 'webgpu') {
      // Destroy the real, already-rendering device; its native lost promise drives recovery.
      await page.evaluate(() => __lateLossProbe.devices[0].destroy());
    }
    // On restricted Linux Chromium the native loss may already have reproduced this case.
    await page.waitForFunction(() => {
      const status = __codexOpenSea.status();
      return status.state === 'fallback' || (status.state === 'ready' && status.ocean.backend === 'webgl2');
    }, null, {timeout:45000});
    const status = await page.evaluate(() => __codexOpenSea.status());
    assert.equal(status.state, 'ready', JSON.stringify(status));
    assert.equal(status.ocean.backend, 'webgl2');
    assert.equal(status.ocean.recoveryAttempted, true);
    assert.equal(status.ocean.firstFailure.afterReady, true, 'this regression must exercise loss after a rendered frame');
    assert.equal(status.ocean.firstFailure.backend, 'webgpu');
    assert.deepEqual([status.ocean.wave,status.ocean.daylight,status.ocean.paused], [79,24,true]);
    assert.equal(status.error, null);
    t.diagnostic(`Recovered late GPU loss: ${JSON.stringify(status.ocean.firstFailure)}`);
    const proof = await page.evaluate(() => ({ transitions:__lateLossProbe.transitions,
      devices:__lateLossProbe.devices.length, destroyed:__lateLossProbe.destroyed,
      oldCanvasesRemoved:__lateLossProbe.canvases.every(canvas => !canvas.isConnected),
      replacementVisible:__lateLossProbe.webglContexts.some(context => context.canvas.isConnected && context.canvas.style.opacity === '1') }));
    assert.equal(proof.devices, 1, 'recovery must not allocate a second WebGPU device');
    assert.ok(proof.destroyed >= 1);
    assert.equal(proof.oldCanvasesRemoved, true);
    assert.equal(proof.replacementVisible, true);
    assert.ok(proof.transitions.some(value => value.state === 'initializing' && value.ocean.ready === false), JSON.stringify(proof.transitions));
    const elapsed=status.ocean.elapsed;
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => __codexOpenSea.status().ocean.elapsed), elapsed);
    await page.evaluate(() => __codexOpenSea.apply({theme:'ocean',paused:false,wave:68,daylight:37}));
    await page.waitForFunction(elapsed => __codexOpenSea.status().ocean.elapsed > elapsed, elapsed);
    await page.evaluate(() => __codexOpenSea.dispose());
    assert.equal(await page.locator('#codex-open-sea-backdrop').count(), 0);
    assert.equal(await page.evaluate(() => __lateLossProbe.webglContexts.every(context => context.isContextLost())), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
