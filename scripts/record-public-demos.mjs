#!/usr/bin/env node
// Rebuild public GIFs from this repository's real renderer and a synthetic shell.
// Uses a fresh Playwright browser profile, an allowlisted loopback server and no
// app bridge. Never opens Codex, scans user folders or loads Apple wallpapers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'docs/media');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-public-demo-'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const gifsicle = process.env.GIFSICLE || 'gifsicle';
const width = 1120, height = 700, gifWidth = 960, gifHeight = 600, fps = 10;
const defaults = { wave:56, daylight:55, opacity:40 };
const requests = new Set(), blocked = [], consoleErrors = [];
const evidence = { schema:1, capture:'Synthetic Codex layout, real production ocean renderer and skin adapter',
  privacy:{ realSessions:false, officialCodexAccess:false, userFiles:false, appleMedia:false, network:'loopback allowlist only' },
  source:{ renderer:'runtime/ocean.js', adapter:'runtime/skin.js', fixture:'scripts/public-demo.html' },
  settings:defaults, clips:[] };
evidence.source.sha256 = Object.fromEntries(await Promise.all(['runtime/ocean.js','runtime/skin.js','scripts/public-demo.html'].map(async file =>
  [file,createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')])));

const buildOptions = { absWorkingDir:root, bundle:true, write:false, format:'iife', target:'chrome140',
  minify:true, legalComments:'eof', loader:{'.jpg':'dataurl','.svg':'dataurl'} };
const skin = (await build({...buildOptions, entryPoints:['runtime/skin.js']})).outputFiles[0].contents;
const preview = (await build({...buildOptions, entryPoints:['runtime/preview.js']})).outputFiles[0].contents;
const files = new Map([
  ['/', ['scripts/public-demo.html','text/html; charset=utf-8']],
  ['/icon.svg', ['assets/icon.svg','image/svg+xml']],
  ['/ui/index.html', ['ui/index.html','text/html; charset=utf-8']],
  ['/ui/style.css', ['ui/style.css','text/css; charset=utf-8']],
  ['/ui/app.js', ['ui/app.js','text/javascript; charset=utf-8']],
  ...['aurora','dunes','coast'].map(name => [`/ui/presets/${name}.svg`,[`ui/presets/${name}.svg`,'image/svg+xml']]),
]);
const server = createServer(async (request,response) => {
  const route = new URL(request.url,'http://localhost').pathname;
  requests.add(route);
  if (route === '/skin.js' || route === '/dist/preview.js') {
    response.setHeader('content-type','text/javascript');
    response.end(route === '/skin.js' ? skin : preview);
    return;
  }
  const file = files.get(route);
  if (!file) { response.writeHead(404); response.end(); return; }
  response.setHeader('content-type',file[1]);
  response.end(await fs.readFile(path.join(root,file[0])));
});
let browser;
const smooth = n => n*n*(3-2*n);
const between = (time, from, to) => smooth(Math.max(0,Math.min(1,(time-from)/(to-from))));
const lerp = (a,b,t) => Math.round(a+(b-a)*t);
function controlSettings(t) {
  const value = {...defaults};
  let active = null, stage = '每一次调节，都实时看见。';
  if (t >= .7 && t < 2.7) {
    value.wave = lerp(56,88,between(t,.7,2.05));
    active = 'wave'; stage = '01 / 波浪起伏 · Wave motion';
  } else if (t >= 2.7 && t < 4.9) {
    value.wave = 88; value.daylight = lerp(55,12,between(t,2.7,4.15));
    active = 'daylight'; stage = '02 / 日光到夕阳 · Daylight to dusk';
  } else if (t >= 4.9 && t < 6.4) {
    value.wave = 88; value.daylight = 12;
    value.opacity = lerp(40,70,between(t,4.9,5.9));
    active = 'opacity'; stage = '03 / 玻璃质感 · Glass opacity';
  } else if (t >= 6.4) {
    const k = between(t,6.4,7.6);
    value.wave = lerp(88,56,k); value.daylight = lerp(12,55,k); value.opacity = lerp(70,40,k);
    stage = '让风景，刚刚好。';
  }
  return {value,active,stage};
}
async function describe(file, metadata) {
  const bytes = await fs.readFile(path.join(output,file));
  return {file,...metadata,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
try {
  await fs.mkdir(output,{recursive:true});
  await run(ffmpeg,['-version']);
  await run(gifsicle,['--version']);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,args:['--enable-unsafe-webgpu'],
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  const context = await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:'dark',locale:'zh-CN',reducedMotion:'no-preference'});
  await context.route('**/*',route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && (files.has(url.pathname) || ['/skin.js','/dist/preview.js'].includes(url.pathname))) return route.continue();
    blocked.push(url.protocol === 'data:' ? 'unexpected data request' : url.origin + url.pathname);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror',error => consoleErrors.push(error.message));
  await page.goto(origin);
  await page.addScriptTag({url:`${origin}/skin.js`});
  await page.evaluate(value => demoApply(value), defaults);
  await page.waitForFunction(() => __codexOpenSea.status().state === 'ready',null,{timeout:60000});
  await page.waitForFunction(() => __codexOpenSea.status().ocean.elapsed > 1,null,{timeout:15000});
  assert.ok(await page.locator('.mock-label').isVisible());
  for (const clip of [{name:'hero-dark',seconds:6,controls:false},{name:'controls-demo',seconds:8,controls:true}]) {
    const frames = path.join(scratch,clip.name);
    await fs.mkdir(frames);
    await page.evaluate(({controls,defaults}) => {document.body.classList.toggle('controls',controls);demoApply(defaults);}, {controls:clip.controls,defaults});
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => __codexOpenSea.status());
    const frameCount = Math.round(clip.seconds*fps), started = performance.now();
    const milestones = [];
    for (let frame=0; frame<frameCount; frame++) {
      const t = frame/fps;
      if (clip.controls) await page.evaluate(({value,active,stage}) => demoApply(value,active,stage),controlSettings(t));
      const scheduled = started + frame*1000/fps;
      if (scheduled > performance.now()) await new Promise(resolve => setTimeout(resolve,scheduled-performance.now()));
      await page.screenshot({path:path.join(frames,`${String(frame).padStart(4,'0')}.png`),animations:'allow'});
      if (frame === 0 || frame === Math.round(frameCount/2) || frame === frameCount-1) {
        const state = await page.evaluate(() => __codexOpenSea.status());
        milestones.push({frame,elapsed:state.ocean.elapsed,wave:state.ocean.wave,daylight:state.ocean.daylight,opacity:state.opacity,backend:state.ocean.backend});
      }
    }
    const after = await page.evaluate(() => __codexOpenSea.status());
    const captureSeconds = Math.round((performance.now()-started)/10)/100;
    assert.equal(after.state,'ready');
    assert.ok(after.ocean.elapsed > before.ocean.elapsed + 1,'Ocean must really animate during capture');
    await run(ffmpeg,['-y','-hide_banner','-loglevel','warning','-framerate',String(fps),'-i',path.join(frames,'%04d.png'),
      '-c:v','libx264','-crf','20','-preset','slow','-pix_fmt','yuv420p','-movflags','+faststart','-an',
      path.join(output,`${clip.name}.mp4`)],{maxBuffer:1024*1024});
    await run(ffmpeg,['-y','-hide_banner','-loglevel','warning','-framerate',String(fps),'-i',path.join(frames,'%04d.png'),
      '-filter_complex',`[0:v]scale=${gifWidth}:${gifHeight}:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      '-loop','0',path.join(scratch,`${clip.name}-source.gif`)],{maxBuffer:1024*1024});
    let lossy = 0;
    for (const quality of [200,500,900,1400,2000]) {
      lossy = quality;
      await run(gifsicle,['-O3',`--lossy=${lossy}`,path.join(scratch,`${clip.name}-source.gif`),'-o',path.join(output,`${clip.name}.gif`)]);
      if ((await fs.stat(path.join(output,`${clip.name}.gif`))).size < 8_000_000) break;
    }
    const result = await describe(`${clip.name}.gif`,{width:gifWidth,height:gifHeight,fps,frames:frameCount,durationSeconds:frameCount/fps,
      rendererBackend:after.ocean.backend,captureSeconds,milestones,encoding:{colors:64,dither:'none',gifsicleLossy:lossy},
      highQualityVideo:await describe(`${clip.name}.mp4`,{width,height,fps,codec:'H.264',audio:false})});
    assert.ok(result.bytes < 8_000_000,`${clip.name} exceeds 8 MB`);
    evidence.clips.push(result);
    await fs.copyFile(path.join(frames,'0000.png'),path.join(output,`${clip.name}-poster.png`));
    console.log(`${result.file}: ${gifWidth}x${gifHeight}, ${result.durationSeconds}s, ${(result.bytes/1024/1024).toFixed(2)} MiB, ${result.rendererBackend}`);
  }
  // The actual controller UI has a self-contained preview mode. No native bridge,
  // mock account, stored session, wallpaper scan or client connection is supplied.
  await page.setViewportSize({width:1120,height:1050});
  await page.goto(`${origin}/ui/index.html`);
  await page.waitForFunction(() => document.querySelector('#motion-label')?.textContent === '波浪流动中',null,{timeout:60000});
  await page.evaluate(() => {
    document.querySelector('.preview-layout-label').textContent = 'Codex 布局演示 / Mock preview';
    document.querySelector('#connection-label').textContent = '控制端界面预览';
    document.querySelector('#status-message').textContent = '公开演示 · 未连接 Codex · 无真实会话';
  });
  assert.equal(await page.evaluate(() => typeof window.openSea),'undefined');
  await page.screenshot({path:path.join(output,'preview-controller.png'),fullPage:true,animations:'allow'});
  const controllerSize = await page.evaluate(() => ({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
  evidence.controller = await describe('preview-controller.png',{...controllerSize,source:'Actual controller in browser preview mode; labels explicitly identify mock layout',nativeBridge:false});
  assert.deepEqual(blocked,[],'No off-allowlist requests may be attempted');
  assert.deepEqual(consoleErrors,[],'No runtime page errors');
  for (const [file,hash] of Object.entries(evidence.source.sha256)) {
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex'),hash,`Capture must not change ${file}`);
  }
  evidence.requestedPaths = [...requests].sort();
  evidence.checks = {offAllowlistRequests:0,pageErrors:0,realOceanAdvanced:true,mockLabelVisible:true,sourceFilesUnchanged:true};
  await fs.writeFile(path.join(output,'capture-manifest.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log('Public media and capture-manifest.json written to docs/media/.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(scratch,{recursive:true,force:true});
}
