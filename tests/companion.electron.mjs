// Run separately: node --test tests/companion.electron.mjs
// Loads the actual main process in isolated userData. Never launches Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { _electron as electron } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const evidence = path.join(root, '.local-evidence/companion-e2e');

test('preview ignores obsolete play rejections after pause or visibility races, but reports current playback failures', async () => {
  // Control promise settlement to reproduce the pause/play microtask race.
  // This evaluates the production preview; only the media element is a test double.
  const source = (await fs.readFile(path.join(root, 'runtime/preview.js'), 'utf8'))
    .replace(/^import \{ createOcean \} from '\.\/ocean\.js';\r?\n/, 'const createOcean = () => { throw new Error("Unexpected ocean in video test"); };\n')
    .replace('export function createPreview', 'function createPreview');
  const context = { window:{}, queueMicrotask };
  runInNewContext(source, context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  for (const mode of ['native visibility','page visibility','explicit pause','current failure','current abort failure']) {
    const requests = [];
    const video = Object.assign(new EventTarget(), {
      paused:true, readyState:4, videoWidth:320, videoHeight:180, currentTime:0, duration:2, style:{},
      setAttribute() {}, removeAttribute() {}, load() {}, remove() {},
      pause() { this.paused = true; },
      play() {
        this.paused = false;
        return new Promise((resolve,reject) => requests.push({resolve,reject}));
      },
    });
    const doc = Object.assign(new EventTarget(), {
      hidden:false, defaultView:{setInterval:() => 0,clearInterval() {}}, createElement:() => video,
    });
    const preview = context.window.openSeaPreview.create({ownerDocument:doc,appendChild() {}}, {
      theme:'video', videoId:'b'.repeat(32), videoUrl:`open-sea-media://${'a'.repeat(32)}/${'b'.repeat(32)}`,
    });
    try {
      await settle();
      assert.equal(requests.length, 1);
      if (mode.startsWith('current')) {
        requests[0].reject(mode === 'current abort failure' ? new DOMException('Decoder unavailable', 'AbortError') : new Error('Decoder unavailable'));
        await settle();
        assert.equal(preview.status().state, 'error');
        assert.equal(preview.status().error, 'Decoder unavailable');
        continue;
      }
      if (mode === 'native visibility') { preview.setVisible(false); preview.setVisible(true); }
      if (mode === 'page visibility') {
        doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
        doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
      }
      if (mode === 'explicit pause') { preview.update({paused:true}); preview.update({paused:false}); }
      await settle();
      assert.equal(requests.length, 2, `${mode}: resume starts its own play request`);
      requests[0].reject(new DOMException('Interrupted by pause', 'AbortError'));
      await settle();
      assert.equal(preview.status().error, null, `${mode}: obsolete rejection cannot fail the resumed preview`);
      requests[1].resolve();
      video.dispatchEvent(new Event('playing'));
      await settle();
      assert.equal(preview.status().state, 'ready', mode);
      assert.equal(preview.status().playing, true, mode);
      assert.equal(requests.length, 2, `${mode}: old settlement does not restart the new request`);
    } finally { preview.dispose(); }
  }
});

async function waitForState(page, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.openSea.getState());
    if (predicate(state)) return state;
    await page.waitForTimeout(50);
  }
  throw new Error('The companion did not reach the expected native state.');
}

async function nativeVisibilityCheck(executable, wrapper, env) {
  const child = spawn(executable, [wrapper], { env:{ ...env, OPEN_SEA_NATIVE_VISIBILITY_TEST:'1' }, stdio:['ignore','pipe','pipe'] });
  let output = '', diagnostics = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const line = output.split('\n').find(item => item.startsWith('OPEN_SEA_VISIBILITY_RESULT '));
    assert.equal(code, 0, diagnostics);
    assert.ok(line, diagnostics || 'No native visibility result was returned.');
    return JSON.parse(line.slice('OPEN_SEA_VISIBILITY_RESULT '.length));
  } finally { clearTimeout(timer); }
}

test('actual companion imports and previews local video, syncs tray edits, and hides without quitting', { timeout:120000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-companion-test-'));
  const userData = path.join(temporary, 'user-data');
  const videoPath = path.join(temporary, 'local-fixture.webm');
  const brokenPath = path.join(temporary, 'broken-fixture.webm');
  const wrapper = path.join(temporary, 'main.cjs');
  await fs.mkdir(userData);
  await fs.mkdir(evidence, { recursive:true });
  // Only dialog selection and test observation are replaced. IPC handlers,
  // VideoLibrary, the protocol, preload, UI and tray actions are production code.
  await fs.writeFile(wrapper, `
const { app, dialog, ipcMain, Menu, protocol, shell } = require('electron');
app.setPath('userData', ${JSON.stringify(userData)});
app.setPath('sessionData', ${JSON.stringify(userData)});
global.__companionTest = { patches:[], forbiddenActions:[], selections:0, choice:'good', mediaResponses:[], externalURLs:[], previewVisibility:[], windowEvents:[] };
app.on('browser-window-created', (_event, window) => {
  for (const event of ['show','hide','minimize','restore']) window.on(event, () => global.__companionTest.windowEvents.push({event,visible:window.isVisible(),minimized:window.isMinimized()}));
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if (channel === 'open-sea:preview-visibility') global.__companionTest.previewVisibility.push(args[0]);
    return send(channel, ...args);
  };
});
shell.openExternal = async url => { global.__companionTest.externalURLs.push(url); };
const handleProtocol = protocol.handle.bind(protocol);
protocol.handle = (scheme, callback) => handleProtocol(scheme, async request => {
  const response = await callback(request);
  global.__companionTest.mediaResponses.push({ scheme, method:request.method, range:request.headers.get('range'),
    status:response.status, type:response.headers.get('content-type'), length:response.headers.get('content-length'), contentRange:response.headers.get('content-range') });
  return response;
});
dialog.showErrorBox = (title, message) => {
  global.__companionTest.startupError = {title, message};
  console.error('[companion fixture startup]', title, message);
};
const files = {good:${JSON.stringify(videoPath)}, broken:${JSON.stringify(brokenPath)}};
dialog.showOpenDialog = async () => {
  global.__companionTest.selections++;
  const choice = global.__companionTest.choice;
  return choice === 'cancel' ? {canceled:true,filePaths:[]} : {canceled:false,filePaths:[files[choice]]};
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (event, ...args) => {
  if (channel === 'open-sea:launch' || channel === 'open-sea:restore') {
    global.__companionTest.forbiddenActions.push(channel);
    throw new Error('Codex actions are forbidden in this isolated test.');
  }
  if (channel === 'open-sea:apply') global.__companionTest.patches.push(args[0]);
  return callback(event, ...args);
});
const buildMenu = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = template => {
  const menu = buildMenu(template);
  if (template.some(item => item.id === 'background')) global.__companionTest.menu = menu;
  return menu;
};
global.__companionMenuAction = id => {
  if (!['settings','paused','theme-ocean','theme-aurora','theme-dunes','theme-coast','theme-video'].includes(id)) throw new Error('Unsafe fixture menu action.');
  const item = global.__companionTest.menu.getMenuItemById(id);
  if (!item || !item.enabled) throw new Error('Fixture menu action is unavailable: ' + id);
  item.click();
};
if (process.env.OPEN_SEA_NATIVE_VISIBILITY_TEST === '1') {
  const until = async (condition, describe = async () => ({})) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Native visibility condition timed out: ' + JSON.stringify(await describe()));
  };
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      void (async () => {
        const read = () => window.webContents.executeJavaScript("({hidden:document.hidden,paused:document.querySelector('video')?.paused,time:document.querySelector('video')?.currentTime,ready:document.querySelector('video')?.readyState})");
        await until(async () => (await read()).ready >= 2);
        window.close();
        await until(async () => { const state = await read(); return !window.isVisible() && state.paused; }, async () => ({visible:window.isVisible(),...await read()}));
        const hidden = await read();
        await new Promise(resolve => setTimeout(resolve, 180));
        if ((await read()).time !== hidden.time) throw new Error('A hidden native window kept playing.');
        global.__companionMenuAction('settings');
        await until(async () => { const state = await read(); return window.isVisible() && !state.paused; });
        window.minimize();
        await until(async () => window.isMinimized() && (await read()).paused, async () => ({visible:window.isVisible(),minimized:window.isMinimized(),events:global.__companionTest.windowEvents,visibilityMessages:global.__companionTest.previewVisibility,...await read()}));
        const minimized = await read();
        await new Promise(resolve => setTimeout(resolve, 180));
        if ((await read()).time !== minimized.time) throw new Error('A minimized native window kept playing.');
        global.__companionMenuAction('settings');
        await until(async () => !window.isMinimized() && window.isVisible() && !(await read()).paused);
        const savedPause = await window.webContents.executeJavaScript("window.openSea.getState().then(state => state.settings.paused)");
        if (savedPause) throw new Error('Native visibility overwrote the explicit pause preference.');
        await window.webContents.executeJavaScript("window.openSea.apply({paused:true})");
        await until(async () => (await read()).paused);
        window.close();
        await until(async () => !window.isVisible());
        global.__companionMenuAction('settings');
        await until(async () => window.isVisible());
        await new Promise(resolve => setTimeout(resolve, 180));
        if (!(await read()).paused) throw new Error('Revealing the window overrode an explicit pause.');
        console.log('OPEN_SEA_VISIBILITY_RESULT ' + JSON.stringify({passed:true,hiddenPaused:true,revealedPlaying:true,minimizedPaused:true,explicitPausePreserved:true,windowSurvived:!window.isDestroyed(),forbiddenActions:global.__companionTest.forbiddenActions}));
        app.quit();
      })().catch(error => { console.error(error.stack); process.exitCode=1; app.quit(); });
    });
  });
}
require(${JSON.stringify(path.join(root, 'src/main.cjs'))});
`, 'utf8');

  let application, page;
  const errors = [], violations = [], checks = [], messages = [];
  const report = { passed:false, actualMain:true, isolatedUserData:true, codexLaunched:false, checks, console:messages };
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath:require('electron'), args:[wrapper], env, timeout:30000 });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (messages.length < 100) messages.push({ type:message.type(), text:message.text() });
      if (/Content Security Policy|Refused to|unsafe-eval/i.test(message.text())) violations.push(message.text());
    });
    await page.waitForFunction(() => typeof window.openSea?.importVideo === 'function' && !document.querySelector('#import-video-button').disabled);
    await page.evaluate(() => {
      window.__companionMediaEvents = [];
      for (const event of ['loadstart','loadedmetadata','loadeddata','canplay','play','playing','waiting','stalled','pause','error','abort','emptied','ended']) {
        document.addEventListener(event, ({ target }) => {
          if (!target.matches?.('#ocean-preview video')) return;
          const events = window.__companionMediaEvents;
          events.push({ event, time:performance.now(), readyState:target.readyState, networkState:target.networkState, currentTime:target.currentTime, paused:target.paused, hidden:document.hidden, error:target.error?.message });
          if (events.length > 120) events.shift();
        }, true);
      }
    });

    if (process.platform === 'darwin') {
      await page.locator('#open-wallpaper-settings').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-wallpapers').disabled);
      assert.deepEqual(await application.evaluate(() => global.__companionTest.externalURLs), ['x-apple.systempreferences:com.apple.Wallpaper-Settings.extension']);
      checks.push('Wallpaper Settings button uses the fixed macOS destination (external opening mocked)');
    } else assert.equal(await page.locator('#open-wallpaper-settings').isVisible(), false);
    await page.locator('#refresh-wallpapers').click();
    await page.waitForFunction(() => !document.querySelector('#refresh-wallpapers').disabled);
    const paneColors = () => page.evaluate(() => [
      getComputedStyle(document.querySelector('#scene'), '::before').backgroundColor,
      getComputedStyle(document.querySelector('.codex-composer')).backgroundColor,
    ]);
    const beforeColors = await paneColors();
    await page.locator('#opacity').evaluate(input => {
      input.value = '80'; input.dispatchEvent(new Event('input', {bubbles:true}));input.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await waitForState(page, state => state.settings.opacity === 80);
    const afterColors = await paneColors();
    assert.ok(beforeColors.every((color,i) => color !== afterColors[i]), 'opacity changes the shared window glass and composer');
    const paneBackgrounds = await page.evaluate(() => ['.preview-topline','.scene-bottomline','.codex-sidebar','.codex-main'].map(selector => getComputedStyle(document.querySelector(selector)).backgroundColor));
    assert.ok(paneBackgrounds.every(color => color === 'rgba(0, 0, 0, 0)'), 'toolbar and panes share one glass layer without extra tint bands');
    assert.equal(await page.locator('.codex-preview').getAttribute('aria-hidden'), 'true');
    await page.locator('#opacity').evaluate(input => {
      input.value = '40'; input.dispatchEvent(new Event('input', {bubbles:true}));input.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await waitForState(page, state => state.settings.opacity === 40);
    for (const [width,height] of [[760,640],[1120,820]]) {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width,height]);
      await page.waitForTimeout(100);
      const geometry = await page.evaluate(() => ({
        overflow:document.documentElement.scrollWidth > innerWidth,
        footer:document.querySelector('.footer').getBoundingClientRect().bottom,
        viewport:innerHeight,
        scene:(() => { const box = document.querySelector('#scene').getBoundingClientRect(); return {width:box.width,height:box.height}; })(),
      }));
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.footer <= geometry.viewport, 'footer actions stay inside the native viewport');
      assert.ok(Math.abs(geometry.scene.width / geometry.scene.height - 1.6) < 0.02, 'preview preserves desktop window proportions');
    }
    checks.push('one continuous glass layer and 16:10 Codex preview; footer stays reachable at default/minimum window sizes');

    // Wait for actual encoded data, rather than stopping an unchecked recording
    // after a short wall-clock delay on a potentially busy CI renderer.
    const fixture = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        context.fillStyle = `hsl(${frame++ * 7}, 50%, 30%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#fff'; context.font = '20px sans-serif';
        context.fillText('Local test video', 80, 95);
      };
      draw();
      const stream = canvas.captureStream(20);
      const recorder = new MediaRecorder(stream, { mimeType:'video/webm;codecs=vp8' });
      const chunks = [];
      const began = performance.now();
      let timer, deadline, stopped = false, total = 0;
      const stop = () => {
        if (stopped) return;
        stopped = true; clearInterval(timer); clearTimeout(deadline);
        recorder.stop();
      };
      const finished = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => {
          if (event.data.size) { chunks.push(event.data); total += event.data.size; }
          if (chunks.length >= 4 && total > 4096 && frame >= 20 && performance.now() - began >= 1500) stop();
        };
        recorder.onerror = event => reject(new Error(event.error?.message || 'Fixture recording failed.'));
        recorder.onstop = resolve;
      });
      recorder.start(200); timer = setInterval(draw, 50); deadline = setTimeout(stop, 10000);
      try { await finished; }
      finally { clearInterval(timer); clearTimeout(deadline); stream.getTracks().forEach(track => track.stop()); }
      const blob = new Blob(chunks, { type:'video/webm' });
      window.__companionFixture = { mimeType:recorder.mimeType, frames:frame, chunks:chunks.length, bytes:blob.size };
      const url = URL.createObjectURL(blob);
      const probe = document.createElement('video');
      probe.muted = true; probe.loop = true; probe.playsInline = true; probe.src = url;
      const playback = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error(`Generated fixture did not decode: readyState=${probe.readyState}, networkState=${probe.networkState}`)), 10000);
        const polling = setInterval(() => {
          if (probe.readyState >= 2 && probe.videoWidth > 0 && probe.currentTime > 0.1 && !probe.paused) finish();
        }, 30);
        function finish(error) {
          clearTimeout(timeout); clearInterval(polling);
          if (error) reject(error); else resolve({ width:probe.videoWidth, height:probe.videoHeight, currentTime:probe.currentTime, readyState:probe.readyState });
        }
        probe.onerror = () => finish(new Error(`Generated fixture could not decode: ${probe.error?.message}`));
        probe.play().catch(finish);
      });
      try {
        const decoded = await playback;
        window.__companionFixture.decoded = decoded;
        return { bytes:Array.from(new Uint8Array(await blob.arrayBuffer())), metadata:window.__companionFixture };
      } finally { probe.pause(); probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(url); }
    });
    const { bytes } = fixture;
    report.fixture = fixture.metadata;
    assert.ok(bytes.length > 4096, 'the generated fixture must contain encoded video data');
    assert.ok(fixture.metadata.decoded.currentTime > 0.1, 'the generated fixture must really decode and play before import');
    await fs.writeFile(videoPath, Buffer.from(bytes));
    await fs.writeFile(brokenPath, Buffer.from(bytes).subarray(0, 48));

    await page.locator('#import-video-button').click();
    await page.waitForFunction(() => {
      const video = document.querySelector('#ocean-preview video');
      return document.querySelector('#scene').dataset.previewState === 'ready' && video && !video.paused && video.currentTime > 0;
    }, null, { timeout:20000 });
    const imported = await page.evaluate(() => window.openSea.getState());
    report.systemWallpaperNames = imported.media.systemWallpapers.map(item => item.name);
    assert.equal(imported.settings.theme, 'video');
    assert.match(imported.media.videoUrl, /^open-sea-media:\/\/[a-f\d]{32}\/[a-f\d]{32}$/);
    assert.deepEqual(await page.locator('video').evaluate(video => [video.muted, video.defaultMuted, video.loop, video.playsInline]), [true, true, true, true]);
    const firstTime = await page.locator('video').evaluate(video => video.currentTime);
    await page.waitForTimeout(180);
    assert.notEqual(await page.locator('video').evaluate(video => video.currentTime), firstTime);
    const catalog = JSON.parse(await fs.readFile(path.join(userData, 'videos/catalog.json'), 'utf8'));
    assert.equal(catalog.videos.length, 1);
    assert.equal((await fs.stat(path.join(userData, 'videos', `${imported.settings.videoId}.video`))).size, bytes.length);
    checks.push('actual import IPC copies local WebM and serves a playing video through open-sea-media');
    await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
    await page.screenshot({ path:path.join(evidence, 'video.png'), fullPage:true });
    await page.screenshot({ path:path.join(root, '.local-evidence/preview-polish.png'), fullPage:true });

    // Repeated buffering at a loop boundary must not flash the loading veil.
    const buffering = await page.locator('#ocean-preview video').evaluate(video => {
      window.__stablePreviewVideo = video;
      window.__stablePreviewSource = video.currentSrc;
      window.__previewReloads = 0;
      video.addEventListener('loadstart', () => window.__previewReloads++);
      const states = [];
      for (let index = 0; index < 3; index++) {
        video.dispatchEvent(new Event('waiting'));
        states.push({state:document.querySelector('#scene').dataset.previewState,hidden:document.querySelector('#preview-feedback').hidden,label:document.querySelector('#motion-label').textContent});
        video.dispatchEvent(new Event('playing'));
      }
      return states;
    });
    assert.ok(buffering.every(state => state.state === 'initializing' && state.hidden && state.label === '视频缓冲中 · 保留当前画面'), 'buffering remains truthful while retaining the visible frame');
    // A full UI render, state pushes and the ordinary two-second poll all use
    // the same video element/source; cosmetic edits must not restart playback.
    await page.locator('#opacity').evaluate(input => {
      input.value = '41'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true}));
    });
    await waitForState(page, state => state.settings.opacity === 41);
    await page.waitForTimeout(2200);
    assert.deepEqual(await page.evaluate(() => ({
      sameElement:document.querySelector('#ocean-preview video') === window.__stablePreviewVideo,
      sameSource:document.querySelector('#ocean-preview video').currentSrc === window.__stablePreviewSource,
      reloads:window.__previewReloads,
      feedbackHidden:document.querySelector('#preview-feedback').hidden,
    })), {sameElement:true,sameSource:true,reloads:0,feedbackHidden:true});
    checks.push('repeated buffering retains the decoded frame; UI edits, state pushes and polling do not reload the video');

    await page.locator('#pause-button').click();
    await waitForState(page, state => state.settings.paused);
    await page.waitForFunction(() => document.querySelector('video').paused && !document.querySelector('#import-video-button').disabled);
    const pausedTime = await page.locator('video').evaluate(video => video.currentTime);
    await page.waitForTimeout(180);
    assert.equal(await page.locator('video').evaluate(video => video.currentTime), pausedTime);
    assert.equal(await page.locator('#scene').getAttribute('data-preview-state'), 'ready', 'a paused decoded frame remains ready');
    await application.evaluate(() => global.__companionMenuAction('paused'));
    await waitForState(page, state => !state.settings.paused);
    await page.waitForFunction(() => !document.querySelector('video').paused && document.querySelector('#pause-button').getAttribute('aria-pressed') === 'false' && document.querySelector('#scene').dataset.previewState === 'ready');
    assert.equal(await page.locator('#pause-button').getAttribute('aria-pressed'), 'false');
    checks.push('buffering is initializing; paused decoded frames remain ready; UI pause freezes playback and the real tray resumes it');

    // Native window visibility must pause only this preview, even when the
    // browser reports document.hidden=false. Persisted playback is unchanged.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; return [window.isDestroyed(), window.isVisible()]; }), [false, false]);
    await page.waitForFunction(() => document.querySelector('#ocean-preview video').paused, null, {timeout:5000});
    assert.equal((await page.evaluate(() => window.openSea.getState())).settings.paused, false);
    await application.evaluate(() => global.__companionMenuAction('settings'));
    await application.evaluate(async ({ BrowserWindow }) => {
      const end = Date.now() + 10000;
      while (!BrowserWindow.getAllWindows()[0].isVisible() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    await page.waitForFunction(() => !document.querySelector('#ocean-preview video').paused);
    checks.push('closing pauses only the preview and preserves the settings window; tray reveal resumes it');

    await application.evaluate(() => global.__companionMenuAction('theme-ocean'));
    await page.waitForFunction(() => document.querySelector('#scene').dataset.theme === 'ocean' && document.querySelector('#scene').dataset.previewState === 'ready', null, { timeout:30000 });
    assert.equal(await page.locator('#ocean-preview canvas').count(), 1);
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.locator('.sea-waves,.ocean-sun,.ocean-sky').count(), 0);
    checks.push('tray returns to the original real ocean renderer and disposes video');
    await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
    await page.screenshot({ path:path.join(evidence, 'ocean.png'), fullPage:true });
    await page.screenshot({ path:path.join(root, '.local-evidence/preview-polish-ocean.png'), fullPage:true });
    await page.locator('#daylight').evaluate(input => {
      input.value = '12'; input.dispatchEvent(new Event('input', { bubbles:true })); input.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await waitForState(page, state => state.settings.daylight === 12);
    await page.waitForFunction(() => !document.querySelector('#import-video-button').disabled);
    await page.screenshot({ path:path.join(evidence, 'ocean-dusk.png'), fullPage:true });

    await page.locator('#wave').evaluate(input => { input.value = '80'; input.dispatchEvent(new Event('input', { bubbles:true })); });
    await application.evaluate(() => global.__companionMenuAction('theme-coast'));
    await waitForState(page, ({ settings }) => settings.wave === 80 && settings.theme === 'coast');
    await page.waitForFunction(() => !document.querySelector('#import-video-button').disabled);
    const patches = await application.evaluate(() => global.__companionTest.patches);
    assert.deepEqual(patches.at(-1), { wave:80 });
    assert.ok(patches.every(patch => !Object.hasOwn(patch, 'videoUrl')));
    assert.equal(await page.locator('#scene').getAttribute('data-theme'), 'coast');
    const saved = JSON.parse(await fs.readFile(path.join(userData, 'skin-settings.json'), 'utf8'));
    assert.equal(Object.hasOwn(saved, 'videoUrl'), false);
    checks.push('dirty wave patch does not overwrite the tray theme; persisted settings contain no media URL');

    await application.evaluate(() => { global.__companionTest.choice = 'broken'; });
    await page.locator('#import-video-button').click();
    await page.waitForFunction(() => document.querySelector('#scene').dataset.theme === 'video' && document.querySelector('#scene').dataset.previewState === 'error', null, { timeout:20000 });
    assert.equal(await page.locator('#preview-feedback').isVisible(), true);
    assert.equal(await page.locator('#motion-label').textContent(), '视频预览未能播放');
    await application.evaluate(() => { global.__companionTest.choice = 'good'; });
    await page.locator('#import-video-button').click();
    await page.waitForFunction(() => document.querySelector('#scene').dataset.previewState === 'ready' && !document.querySelector('video').paused, null, { timeout:20000 });
    checks.push('a corrupt imported video reports a real decoding error; another import recovers');

    const beforeCancel = await page.evaluate(() => window.openSea.getState());
    await application.evaluate(() => { global.__companionTest.choice = 'cancel'; });
    await page.locator('#import-video-button').click();
    await page.waitForFunction(() => !document.querySelector('#import-video-button').disabled);
    assert.equal((await page.evaluate(() => window.openSea.getState())).settings.videoId, beforeCancel.settings.videoId);
    assert.deepEqual(await application.evaluate(() => global.__companionTest.forbiddenActions), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(violations, []);
    checks.push('cancel preserves the selected video; no Codex launch/restore, page errors or CSP violations');
    report.videoBytes = bytes.length;
    report.browserVersion = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getUserAgent());
    report.mediaEvents = await page.evaluate(() => window.__companionMediaEvents);
    report.mediaResponses = await application.evaluate(() => global.__companionTest.mediaResponses);
    await application.close();
    application = null;
    report.nativeVisibility = await nativeVisibilityCheck(require('electron'), wrapper, env);
    assert.deepEqual(report.nativeVisibility.forbiddenActions, []);
    checks.push('native hiding/minimizing freezes video time; reveal resumes; explicit pause is preserved without changing client preferences');
    report.passed = true;
    await fs.rm(path.join(evidence, 'failure.png'), { force:true });
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) report.fixture = await page.evaluate(() => window.__companionFixture).catch(() => null);
    if (page && !page.isClosed()) report.ui = await page.evaluate(() => {
      const video = document.querySelector('video');
      return { visibility:document.visibilityState, theme:document.querySelector('#scene')?.dataset.theme,
        previewState:document.querySelector('#scene')?.dataset.previewState,
        message:document.querySelector('#status-message')?.textContent,
        feedback:document.querySelector('#preview-feedback-detail')?.textContent,
        video:video ? { readyState:video.readyState, networkState:video.networkState, currentTime:video.currentTime, duration:video.duration, paused:video.paused, width:video.videoWidth, height:video.videoHeight, error:video.error?.message } : null };
    }).catch(() => null);
    if (page && !page.isClosed()) report.mediaEvents = await page.evaluate(() => window.__companionMediaEvents).catch(() => []);
    if (application) report.native = await application.evaluate(() => ({ selections:global.__companionTest.selections, startupError:global.__companionTest.startupError, mediaResponses:global.__companionTest.mediaResponses, previewVisibility:global.__companionTest.previewVisibility, windowEvents:global.__companionTest.windowEvents })).catch(() => null);
    if (page && !page.isClosed()) await page.screenshot({ path:path.join(evidence, 'failure.png'), fullPage:true }).catch(() => {});
    throw error;
  } finally {
    report.pageErrors = errors;
    report.cspViolations = violations;
    await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
    await fs.rm(temporary, { recursive:true, force:true });
  }
});

for (const [locale, warning, ready] of [
  ['zh', '上次导入的视频已不可用，已选择海洋。可重新导入视频。', '控制器已就绪。点击启动，在 Codex 中应用皮肤。'],
  ['en', 'The previously imported video is unavailable. Ocean is selected; you can import the video again.', 'Controller ready. Launch Codex to apply your skin.']
]) {
  test(`actual companion preserves the missing-video explanation until a successful apply (${locale})`, { timeout:45000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-missing-video-test-'));
    const userData = path.join(temporary, 'user-data');
    const wrapper = path.join(temporary, 'main.cjs');
    await fs.mkdir(userData);
    await fs.mkdir(evidence, { recursive:true });
    await fs.writeFile(path.join(userData, 'skin-settings.json'), JSON.stringify({
      theme:'video', videoId:'a'.repeat(32), videoName:'missing.webm', locale
    }));
    await fs.writeFile(wrapper, `
const { app, ipcMain } = require('electron');
app.setPath('userData', ${JSON.stringify(userData)});
app.setPath('sessionData', ${JSON.stringify(userData)});
global.__forbiddenActions = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => handle(channel, async (event, ...args) => {
  if (channel === 'open-sea:launch' || channel === 'open-sea:restore') {
    global.__forbiddenActions.push(channel);
    throw new Error('Codex actions are forbidden in this isolated test.');
  }
  return callback(event, ...args);
});
require(${JSON.stringify(path.join(root, 'src/main.cjs'))});
`, 'utf8');
    let application;
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      application = await electron.launch({ executablePath:require('electron'), args:[wrapper], env, timeout:30000 });
      const page = await application.firstWindow();
      await page.waitForFunction(expected => document.querySelector('#status-message')?.textContent === expected, warning);
      const missing = await page.evaluate(() => window.openSea.getState());
      assert.equal(missing.status.reason, 'missing-video');
      assert.equal(missing.status.phase, 'idle');
      assert.equal(missing.settings.theme, 'ocean');
      assert.equal(missing.media.videoUrl, null);
      // A normal background state poll must not replace the explanation with idle copy.
      await page.waitForTimeout(2200);
      assert.equal(await page.locator('#status-message').textContent(), warning);
      await page.screenshot({ path:path.join(evidence, `missing-video-${locale}.png`), fullPage:true });
      await page.locator('#opacity').evaluate(input => {
        input.value = '41'; input.dispatchEvent(new Event('input', { bubbles:true })); input.dispatchEvent(new Event('change', { bubbles:true }));
      });
      const applied = await waitForState(page, state => state.settings.opacity === 41 && !state.status.reason);
      assert.equal(applied.status.phase, 'idle');
      assert.doesNotMatch(applied.status.message, /不可用|unavailable/);
      await page.waitForFunction(expected => document.querySelector('#status-message')?.textContent === expected, ready);
      assert.deepEqual(await application.evaluate(() => global.__forbiddenActions), []);
    } finally {
      if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
      await fs.rm(temporary, { recursive:true, force:true });
    }
  });
}
