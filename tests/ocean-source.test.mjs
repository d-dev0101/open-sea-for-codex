import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const sourceURL = new URL('../runtime/ocean.js', import.meta.url);
const source = await readFile(sourceURL, 'utf8');
let moduleId = 0;

class Events extends EventTarget {
  listeners = new Map();
  addEventListener(type, handler, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    super.addEventListener(type, handler, options);
  }
  removeEventListener(type, handler, options) {
    this.listeners.get(type)?.delete(handler);
    super.removeEventListener(type, handler, options);
  }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

async function harness({ pending = false, webgpu = true, reducedMotion = false,
  failInit = false, failRender = false, failWebGPUInit = false, failWebGPURender = false,
  pendingFallback = false, lineEnding = '\n' } = {}) {
  const stats = { resources: [], renderers: [], observers: [], controls: [], renders: 0,
    gpuDestroyed: 0, contextLost: 0, unconfigured: 0 };
  let finishInit;
  let rejectInit;
  let finishFallback;
  const initPromise = pending ? new Promise((resolve, reject) => { finishInit = resolve; rejectInit = reject; })
    : Promise.resolve();
  const fallbackPromise = pendingFallback ? new Promise(resolve => { finishFallback = resolve; }) : Promise.resolve();
  class Resource {
    constructor() { this.disposals = 0; stats.resources.push(this); }
    dispose() { this.disposals++; }
  }
  let node;
  node = new Proxy(() => node, { get: () => node, apply: () => node });
  class Vector3 { set(...values) { this.values = values; return this; } }
  class Geometry extends Resource { rotateX() {} }
  class Renderer {
    constructor(options) {
      this.domElement = {
        style: {}, setAttribute() {}, parent: null,
        remove() { this.parent?.children.delete(this); this.parent = null; },
      };
      const isWebGPUBackend = webgpu && !options.forceWebGL;
      this.backend = { isWebGPUBackend,
        context: { unconfigure() { stats.unconfigured++; } },
        device: isWebGPUBackend ? { destroy() { stats.gpuDestroyed++; } } : null, dispose() {} };
      this.disposals = 0;
      this.loop = null;
      stats.renderers.push(this);
    }
    init() {
      if (failInit || (failWebGPUInit && this.backend.isWebGPUBackend)) return Promise.reject(new Error('GPU unavailable'));
      return this.backend.isWebGPUBackend ? initPromise : fallbackPromise;
    }
    setPixelRatio(value) { this.pixelRatio = value; }
    setSize(width, height) { this.size = [width, height]; }
    async setAnimationLoop(callback) { this.loop = callback; }
    getContext() { return { getExtension: () => ({ loseContext() { stats.contextLost++; } }) }; }
    dispose() { this.disposals++; this.loop = null; }
  }
  class Controls {
    constructor() { this.target = new Vector3(); this.disposals = 0; this.updates = 0; stats.controls.push(this); }
    update() { this.updates++; }
    disconnect() {}
    dispose() { this.disposals++; }
  }
  class PostProcessing extends Resource {
    constructor(renderer) { super(); this.renderer = renderer; }
    render() {
      if (failRender || (failWebGPURender && this.renderer.backend.isWebGPUBackend)) throw new Error('Device lost');
      stats.renders++;
    }
  }
  const THREE = {
    Vector3, WebGPURenderer: Renderer,
    Scene: class { add() {} clear() {} },
    Color: class {},
    PerspectiveCamera: class { position = new Vector3(); updateProjectionMatrix() {} },
    PlaneGeometry: Geometry, SphereGeometry: Geometry, MeshBasicNodeMaterial: Resource,
    Mesh: class {}, PostProcessing, ACESFilmicToneMapping: 1, BackSide: 1,
  };
  const bindings = { THREE, OrbitControls: Controls, Fn: () => () => node,
    uniform: value => ({ value }),
    pass: () => Object.assign(new Resource(), { getTextureNode: () => node }),
    bloom: () => Object.assign(new Resource(), {
      _compositeMaterial: new Resource(), _highPassFilterMaterial: new Resource(),
      _separableBlurMaterials: [new Resource(), new Resource()],
    }),
  };
  for (const name of ['float', 'vec2', 'vec3', 'vec4', 'If', 'sin', 'cos', 'dot', 'cross',
    'normalize', 'mix', 'pow', 'max', 'clamp', 'fract', 'floor', 'smoothstep', 'distance',
    'reflect', 'positionLocal', 'positionWorld', 'cameraPosition']) bindings[name] = node;
  const id = ++moduleId;
  globalThis.__oceanTestBindings ??= new Map();
  globalThis.__oceanTestBindings.set(id, bindings);
  const isolated = `const { ${Object.keys(bindings).join(', ')} } = globalThis.__oceanTestBindings.get(${id});\n`
    + source.replace(/\r?\n/g, lineEnding).replace(/^import[\s\S]*?;\r?\n/gm, '');
  let createOcean;
  try {
    assert.doesNotMatch(isolated, /^import\s/m, 'all runtime imports must be replaced on LF and CRLF checkouts');
    ({ createOcean } = await import(`data:text/javascript;base64,${Buffer.from(isolated).toString('base64')}`));
  } finally { globalThis.__oceanTestBindings.delete(id); }
  const view = new Events();
  Object.assign(view, { devicePixelRatio: 2, performance: { now: () => 0 },
    navigator: { hardwareConcurrency: 8 }, matchMedia: () => ({ matches: reducedMotion }),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; stats.observers.push(this); }
      observe(element) { this.element = element; }
      disconnect() { this.disconnected = true; }
    },
  });
  const doc = Object.assign(new Events(), { hidden: false, defaultView: view });
  const rect = { width: 800, height: 600 };
  const container = { ownerDocument: doc, children: new Set(),
    appendChild(child) { child.parent = this; this.children.add(child); },
    getBoundingClientRect: () => rect };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { createOcean, container, doc, view, rect, stats, finishInit, rejectInit, finishFallback, settle };
}

test('ocean dependency graph is local and does not install host/global hooks', async () => {
  assert.doesNotMatch(source, /document\.body|documentElement|__ossState|postMessage|location\.search/);
  assert.doesNotMatch(source, /addEventListener\(['"]message/);
  const seen = new Set();
  async function inspect(path) {
    if (seen.has(path)) return;
    seen.add(path);
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.'), `nonlocal dependency: ${match[1]}`);
      const dependency = resolve(dirname(path), match[1]);
      await access(dependency);
      await inspect(dependency);
    }
  }
  await inspect(fileURLToPath(sourceURL));
  assert.equal(seen.size, 6);
});

test('first frame honors settings, resizing follows container, and paused edits stay still', async () => {
  const h = await harness();
  const ready = [];
  const ocean = h.createOcean(h.container, { wave: 82, daylight: 18, paused: true },
    { onReady: state => ready.push(state) });
  await h.settle();
  assert.equal(ready.length, 1);
  assert.deepEqual([ready[0].wave, ready[0].daylight, ready[0].paused], [82, 18, true]);
  assert.equal(ocean.status().state, 'ready');
  assert.equal(h.stats.renderers[0].loop, null);
  assert.equal(h.stats.renders, 1);
  ocean.update({ wave: 1000, daylight: -20 });
  assert.equal(h.stats.renders, 2);
  assert.deepEqual([ocean.status().wave, ocean.status().daylight, ocean.status().elapsed], [100, 0, 0]);
  h.rect.width = 440; h.rect.height = 280;
  h.stats.observers[0].callback();
  assert.deepEqual(h.stats.renderers[0].size, [440, 280]);
  assert.equal(ready.length, 1);
  ocean.dispose();
  assert.equal(ocean.status().state, 'disposed');
  assert.equal(h.container.children.size, 0);
  assert.equal(h.doc.count() + h.view.count(), 0);
  assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
  assert.equal(h.stats.controls[0].disposals, 1);
  assert.equal(h.stats.renderers[0].disposals, 1);
  assert.equal(h.stats.gpuDestroyed, 1);
  ocean.dispose();
  assert.equal(h.stats.renderers[0].disposals, 1);
});

test('the runtime fixture executes and releases the same ocean with LF and Windows CRLF source', async () => {
  for (const lineEnding of ['\n', '\r\n']) {
    const h = await harness({ lineEnding });
    const ocean = h.createOcean(h.container, { paused:true });
    await h.settle();
    assert.equal(ocean.status().state, 'ready');
    assert.equal(ocean.status().backend, 'webgpu');
    assert.equal(h.stats.renderers.length, 1, 'healthy WebGPU must not be replaced');
    ocean.dispose();
    assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
    assert.equal(h.stats.gpuDestroyed, 1);
  }
});

test('explicit pause combines with visibility and elapsed time never jumps after resume', async () => {
  const h = await harness();
  const ocean = h.createOcean(h.container);
  await h.settle();
  const renderer = h.stats.renderers[0];
  renderer.loop(100); renderer.loop(200);
  const elapsed = ocean.status().elapsed;
  assert.ok(elapsed > 0);
  h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(renderer.loop, null);
  ocean.pause(true);
  h.doc.hidden = false; h.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(renderer.loop, null);
  assert.equal(ocean.status().elapsed, elapsed);
  ocean.pause(false);
  renderer.loop(1_000_000);
  assert.equal(ocean.status().elapsed, elapsed);
  renderer.loop(1_000_020);
  assert.ok(ocean.status().elapsed - elapsed < 0.03);
  ocean.dispose();
});

test('dispose during asynchronous init removes DOM immediately and releases late GPU allocations', async () => {
  const h = await harness({ pending: true });
  let notified = false;
  const ocean = h.createOcean(h.container, {}, { onReady: () => { notified = true; },
    onError: () => { notified = true; } });
  ocean.dispose();
  assert.equal(h.container.children.size, 0);
  assert.equal(h.doc.count() + h.view.count(), 0);
  assert.equal(h.stats.renderers[0].disposals, 0);
  h.finishInit();
  await h.settle();
  assert.equal(h.stats.renders, 0);
  assert.equal(notified, false);
  assert.equal(h.stats.renderers[0].disposals, 1);
  assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
  assert.equal(h.stats.observers[0].disconnected, true);
});

test('init failure and rendering failure notify once and leave no DOM/listeners', async () => {
  for (const config of [{ failInit: true }, { failRender: true }, { webgpu:false, failRender:true }]) {
    const h = await harness(config);
    const errors = [];
    const ocean = h.createOcean(h.container, {}, { onError: error => errors.push(error) });
    await h.settle();
    assert.equal(ocean.status().state, 'error');
    assert.equal(errors.length, 1);
    assert.equal(h.stats.renderers.length, config.webgpu === false ? 1 : 2, 'a failed WebGL attempt must never be retried');
    assert.equal(h.container.children.size, 0);
    assert.equal(h.doc.count() + h.view.count(), 0);
    assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
    ocean.dispose();
    assert.equal(errors.length, 1);
  }
});

test('ShadowRoot sizing and WebGL fallback work without host styles or global state', async () => {
  const h = await harness({ webgpu: false, reducedMotion: true });
  const shadow = { ownerDocument: h.doc, host: h.container,
    children: new Set(), appendChild: h.container.appendChild };
  const ocean = h.createOcean(shadow, { paused: true });
  await h.settle();
  assert.equal(ocean.status().backend, 'webgl2');
  assert.equal(ocean.status().renderScale, 0.6);
  assert.equal(ocean.status().reducedMotion, true);
  assert.equal(h.stats.observers[0].element, h.container);
  assert.deepEqual(h.stats.renderers[0].size, [800, 600]);
  assert.equal(h.container.children.size, 0);
  assert.equal(shadow.children.size, 1);
  assert.equal(h.stats.controls[0].autoRotate, false);
  ocean.dispose();
  assert.equal(shadow.children.size, 0);
  assert.equal(h.stats.contextLost, 1);
});

test('WebGPU init or first-frame failure releases the attempt before a single WebGL retry', async () => {
  for (const config of [{ failWebGPUInit:true }, { failWebGPURender:true }]) {
    const h = await harness(config);
    const errors = [], ready = [];
    const ocean = h.createOcean(h.container, { wave:78, daylight:23, paused:true },
      { onError: error => errors.push(error), onReady: value => ready.push(value) });
    await h.settle();
    assert.equal(ocean.status().state, 'ready');
    assert.equal(ocean.status().backend, 'webgl2');
    assert.deepEqual([ready[0].wave, ready[0].daylight, ready[0].paused], [78,23,true]);
    assert.equal(ready.length, 1);
    assert.deepEqual(errors, []);
    assert.equal(h.stats.renderers.length, 2);
    assert.equal(h.stats.gpuDestroyed, 1);
    assert.equal(h.stats.controls[0].disposals, 1);
    assert.equal(h.stats.observers[0].disconnected, true);
    assert.equal(h.stats.renderers[0].domElement.parent, null);
    assert.equal(h.container.children.size, 1);
    h.stats.renderers[0].onDeviceLost({ message:'Stale WebGPU device callback' });
    assert.equal(ocean.status().state, 'ready');
    ocean.update({ wave:64 });
    assert.equal(ocean.status().wave, 64);
    ocean.dispose();
    assert.equal(h.stats.contextLost, 1);
    assert.equal(h.doc.count() + h.view.count(), 0);
    assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
  }
});

test('device loss during init waits for release, preserves settings, then retries WebGL', async () => {
  const h = await harness({ pending: true });
  const errors = [];
  const ocean = h.createOcean(h.container, {}, { onError: error => errors.push(error) });
  h.stats.renderers[0].onDeviceLost({ message: 'GPU disconnected' });
  await h.settle();
  assert.equal(ocean.status().state, 'initializing');
  assert.equal(h.container.children.size, 0);
  assert.equal(h.doc.count() + h.view.count(), 0);
  assert.equal(h.stats.renderers.length, 1, 'retry must wait for pending GPU allocations to settle');
  ocean.update({ wave:91, daylight:12, paused:true });
  h.rejectInit(new Error('Initialization rejected'));
  await h.settle();
  assert.equal(ocean.status().state, 'ready');
  assert.equal(ocean.status().backend, 'webgl2');
  assert.deepEqual([ocean.status().wave, ocean.status().daylight, ocean.status().paused], [91,12,true]);
  assert.equal(errors.length, 0);
  assert.equal(h.stats.gpuDestroyed, 1);
  ocean.dispose();
  assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
});

test('device loss after readiness recovers once, preserves settings and pause, and retains the first failure', async () => {
  const h = await harness({ pendingFallback:true });
  const ready = [], errors = [];
  const ocean = h.createOcean(h.container, { wave:73, daylight:17, paused:true },
    { onReady: value => ready.push(value), onError: error => errors.push(error) });
  await h.settle();
  assert.equal(ready.length, 1);
  assert.equal(ocean.status().backend, 'webgpu');
  h.stats.renderers[0].onDeviceLost({ message:'A valid external Instance reference no longer exists.' });
  assert.equal(ocean.status().ready, false, 'a failed device must never remain ready');
  await h.settle();
  assert.equal(ocean.status().state, 'initializing');
  assert.equal(ocean.status().ready, false);
  assert.equal(ocean.status().recoveryAttempted, true);
  assert.deepEqual(ocean.status().firstFailure, { backend:'webgpu',
    message:'A valid external Instance reference no longer exists.', afterReady:true });
  assert.deepEqual([ocean.status().wave,ocean.status().daylight,ocean.status().paused], [73,17,true]);
  assert.equal(h.stats.gpuDestroyed, 1);
  assert.equal(h.stats.renderers[0].domElement.parent, null);
  ocean.update({ wave:85, daylight:32 });
  h.finishFallback();
  await h.settle();
  assert.equal(ocean.status().state, 'ready');
  assert.equal(ocean.status().backend, 'webgl2');
  assert.deepEqual([ocean.status().wave,ocean.status().daylight,ocean.status().paused], [85,32,true]);
  assert.equal(h.stats.renderers[1].loop, null);
  assert.equal(ready.length, 2, 'the adapter must be notified to reveal the replacement canvas');
  assert.deepEqual(errors, []);
  h.stats.renderers[1].onDeviceLost({ message:'WebGL device also failed' });
  await h.settle();
  assert.equal(ocean.status().state, 'error');
  assert.equal(ocean.status().firstFailure.afterReady, true);
  assert.match(ocean.status().firstFailure.message, /external Instance/);
  assert.equal(ocean.status().error, 'WebGL device also failed');
  assert.equal(h.stats.renderers.length, 2, 'recovery must not loop after the WebGL attempt');
  assert.equal(errors.length, 1);
  ocean.dispose();
  assert.equal(h.stats.contextLost, 1);
  assert.equal(h.container.children.size, 0);
  assert.equal(h.doc.count() + h.view.count(), 0);
  assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
});

test('disposing a queued or initializing WebGL retry cannot recreate a canvas or notify readiness', async () => {
  for (const queued of [true, false]) {
    const h = await harness(queued ? { pending:true } : { failWebGPURender:true, pendingFallback:true });
    const notifications = [];
    const ocean = h.createOcean(h.container, {}, { onReady: value => notifications.push(value), onError: value => notifications.push(value) });
    if (queued) h.stats.renderers[0].onDeviceLost({ message:'Lost during initialization' });
    await h.settle();
    assert.equal(ocean.status().state, 'initializing');
    ocean.dispose();
    if (queued) h.finishInit(); else h.finishFallback();
    await h.settle();
    assert.equal(ocean.status().state, 'disposed');
    assert.equal(h.container.children.size, 0);
    assert.equal(h.doc.count() + h.view.count(), 0);
    assert.equal(h.stats.renderers.length, queued ? 1 : 2);
    assert.ok(h.stats.resources.every(resource => resource.disposals === 1));
    assert.deepEqual(notifications, []);
  }
});
