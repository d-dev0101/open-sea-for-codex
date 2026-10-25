// Ocean artwork and shader model adapted from Open Sea Skin (MIT).
// See licenses/open-sea-MIT.txt and licenses/three-MIT.txt.
import * as THREE from './vendor/three.webgpu.js';
import {
  Fn, pass, uniform, float, vec2, vec3, vec4, If,
  sin, cos, dot, cross, normalize, mix, pow, max, clamp, fract, floor,
  smoothstep, distance, reflect,
  positionLocal, positionWorld, cameraPosition
} from './vendor/three.tsl.js';
import { OrbitControls } from './vendor/addons/controls/OrbitControls.js';
import { bloom } from './vendor/addons/tsl/display/BloomNode.js';


function oceanSettings(value, previous = { wave:56, daylight:55, paused:false }) {
  const bounded = (input, fallback) => {
    const number = Number(input);
    return input === null || input === '' || !Number.isFinite(number)
      ? fallback : Math.min(100, Math.max(0, number));
  };
  return {
    wave: bounded(value.wave, previous.wave), daylight: bounded(value.daylight, previous.daylight),
    paused: Object.hasOwn(value, 'paused') ? value.paused === true : previous.paused,
  };
}

/** An isolated ocean surface. No host UI or global renderer state is modified. */
export function createOcean(container, initial = {}, { onReady, onError } = {}) {
  let settings = oceanSettings(initial), current;
  let disposed = false, retrying = false, retried = false, ready = false, generation = 0;
  let firstFailure = null;
  const notify = (callback, value) => {
    try { callback?.(value); } catch (error) { console.warn('[Open Sea] Callback failed:', error); }
  };
  function status() {
    const result = current.status();
    return { ...result, ...settings,
      state: disposed ? 'disposed' : retrying ? 'initializing' : result.state,
      ready: !disposed && !retrying && result.ready,
      error: retrying ? null : result.error,
      recoveryAttempted: retried, firstFailure: firstFailure ? { ...firstFailure } : null };
  }
  function start(forceWebGL = false) {
    const epoch = ++generation;
    current = createOceanAttempt(container, settings, {
      onReady() {
        if (disposed || epoch !== generation) return;
        ready = true;
        notify(onReady, status());
      },
      onError(reason) {
        // An attempt can fail before its constructor returns; defer access to current.
        queueMicrotask(() => {
          if (disposed || epoch !== generation) return;
          const backend = current.status().backend;
          firstFailure ??= { backend, message:reason.message || String(reason), afterReady:ready };
          // Device loss may arrive after a successful render; recovery is still bounded to one attempt.
          if (!retried && backend === 'webgpu') {
            retried = retrying = true;
            current.dispose();
            // A pending init may still allocate resources. Never reuse its canvas/device.
            void current.released.then(() => {
              if (disposed || epoch !== generation) return;
              retrying = false;
              start(true);
            });
          } else notify(onError, reason);
        });
      },
    }, forceWebGL);
  }
  function update(patch = {}) {
    if (disposed || (!retrying && current.status().state === 'error')) return status();
    settings = oceanSettings(patch, settings);
    if (!retrying) current.update(settings);
    return status();
  }
  start();
  return { update, pause: paused => update({ paused:paused === true }), status,
    dispose() { if (!disposed) { disposed = true; current.dispose(); } } };
}

function createOceanAttempt(container, initial, { onReady, onError }, forceWebGL) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('createOcean requires a DOM container');
  }
  const element = container.host || container;
  const doc = container.ownerDocument || element.ownerDocument;
  const view = doc?.defaultView;
  if (!doc || !view || typeof element.getBoundingClientRect !== 'function') {
    throw new TypeError('createOcean requires a connected browser document');
  }
  const valueInRange = (value, fallback) => {
    const number = Number(value);
    return value === null || value === '' || !Number.isFinite(number)
      ? fallback : Math.min(100, Math.max(0, number));
  };
  const settings = {
    wave: valueInRange(initial.wave, 56),
    daylight: valueInRange(initial.daylight, 55),
    paused: initial.paused === true,
  };
  const REDUCED_MOTION = view.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const hardware = view.navigator || {};
  const LOW_END_DEVICE = (hardware.hardwareConcurrency || 8) <= 4
    || ('deviceMemory' in hardware && Number(hardware.deviceMemory) <= 4);

  const uTime = uniform(0);
  const uSea = uniform(0.25 + (settings.wave / 100) * 1.5);
  const uSunDir = uniform(new THREE.Vector3(0, 0.5, -0.87));
  const uSunColor = uniform(new THREE.Vector3(1, 1, 1));
  const uHorizonColor = uniform(new THREE.Vector3(1, 1, 1));
  const uZenithColor = uniform(new THREE.Vector3(1, 1, 1));
  const uDeepColor = uniform(new THREE.Vector3(1, 1, 1));
  const uShallowColor = uniform(new THREE.Vector3(1, 1, 1));

  // ----------------------------------------------------------------------------
  // SECTION 2 · GERSTNER SWELL (identical to the standalone site)
  // ----------------------------------------------------------------------------

  const GERSTNER_DEFS = [
    { dir: [1.0, 0.0],     wavelength: 60.0, steepness: 0.12 },
    { dir: [0.6, 0.8],     wavelength: 31.0, steepness: 0.12 },
    { dir: [-0.7, 0.7],    wavelength: 18.0, steepness: 0.09 },
    { dir: [0.3, -0.95],   wavelength: 9.5,  steepness: 0.07 },
    { dir: [-0.35, -0.94], wavelength: 5.0,  steepness: 0.05 },
  ].map((w) => {
    const len = Math.hypot(w.dir[0], w.dir[1]);
    const dx = w.dir[0] / len;
    const dy = w.dir[1] / len;
    const k = (Math.PI * 2) / w.wavelength;
    const c = Math.sqrt(9.8 * k);
    return { dx, dy, k, c, a0: w.steepness / k };
  });

  const wavePosition = Fn(([xz, time, sea]) => {
    let x = xz.x;
    let y = float(0);
    let z = xz.y;
    for (const w of GERSTNER_DEFS) {
      const dir = vec2(w.dx, w.dy);
      const f = float(w.k).mul(dir.dot(xz).sub(time.mul(float(w.c))));
      const a = float(w.a0).mul(sea);
      x = x.add(a.mul(dir.x).mul(cos(f)));
      y = y.add(a.mul(sin(f)));
      z = z.add(a.mul(dir.y).mul(cos(f)));
    }
    return vec3(x, y, z);
  });

  const waveNormal = Fn(([xz, time, sea]) => {
    let tx = float(1), ty = float(0), tz = float(0);
    let bx = float(0), by = float(0), bz = float(1);
    for (const w of GERSTNER_DEFS) {
      const dir = vec2(w.dx, w.dy);
      const f = float(w.k).mul(dir.dot(xz).sub(time.mul(float(w.c))));
      const a = float(w.a0).mul(sea);
      const s = sin(f);
      const co = cos(f);
      const ak = a.mul(float(w.k));
      const aks = ak.mul(s);
      const akc = ak.mul(co);
      tx = tx.sub(aks.mul(dir.x).mul(dir.x));
      ty = ty.add(akc.mul(dir.x));
      tz = tz.sub(aks.mul(dir.x).mul(dir.y));
      bx = bx.sub(aks.mul(dir.x).mul(dir.y));
      by = by.add(akc.mul(dir.y));
      bz = bz.sub(aks.mul(dir.y).mul(dir.y));
    }
    return normalize(cross(vec3(bx, by, bz), vec3(tx, ty, tz)));
  });

  const waveCrest = Fn(([xz, time, sea]) => {
    let crest = float(0);
    for (const w of GERSTNER_DEFS) {
      const f = float(w.k).mul(vec2(w.dx, w.dy).dot(xz).sub(time.mul(float(w.c))));
      crest = crest.add(float(w.a0).mul(sea).mul(sin(f)));
    }
    return crest;
  });

  // ----------------------------------------------------------------------------
  // SECTION 3 · PROCEDURAL GRADIENT NOISE + FBM (identical to the standalone)
  // ----------------------------------------------------------------------------

  const hash2 = Fn(([p]) => {
    // Keep the sine input in a compact range. Large dot products lose enough
    // float precision for the far field to band on some integrated GPUs.
    const q = p.sub(floor(p.div(289)).mul(289));
    const a = sin(q.dot(vec2(127.1, 311.7))).mul(43758.5453);
    const b = sin(q.dot(vec2(269.5, 183.3))).mul(43758.5453);
    return vec2(fract(a).mul(2).sub(1), fract(b).mul(2).sub(1));
  });

  const gradNoise = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const g00 = hash2(i);
    const g10 = hash2(i.add(vec2(1, 0)));
    const g01 = hash2(i.add(vec2(0, 1)));
    const g11 = hash2(i.add(vec2(1, 1)));
    const n00 = g00.dot(f);
    const n10 = g10.dot(f.sub(vec2(1, 0)));
    const n01 = g01.dot(f.sub(vec2(0, 1)));
    const n11 = g11.dot(f.sub(vec2(1, 1)));
    return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
  });

  const fbm = Fn(([p]) => {
    const o1 = gradNoise(p);
    const o2 = gradNoise(p.mul(2.04).add(vec2(17.3, 9.1))).mul(0.5);
    const o3 = gradNoise(p.mul(4.11).add(vec2(42.7, 28.6))).mul(0.25);
    return o1.add(o2).add(o3);
  });

  const detailHeight = Fn(([xz, time]) => {
    const driftA = vec2(time.mul(0.55), time.mul(0.32));
    const driftB = vec2(time.mul(-0.4), time.mul(0.5));
    return fbm(xz.mul(0.85).add(driftA)).add(fbm(xz.mul(2.1).add(driftB)).mul(0.45));
  });

  // ----------------------------------------------------------------------------
  // SECTION 4 · SHARED ANALYTIC SKY
  // cloudMask gates the cloud FBM: the dome always passes 1, the ocean only
  // pays for cloud noise where the reflection is actually visible.
  // ----------------------------------------------------------------------------

  const skyColor = Fn(([dir, cloudMask]) => {
    const d = normalize(dir);
    const up = clamp(d.y, -0.15, 1);
    const col = mix(uHorizonColor, uZenithColor, pow(max(up, 0), 0.42)).toVar();

    col.assign(mix(col, uDeepColor.mul(1.4).add(uHorizonColor.mul(0.25)), smoothstep(0, -0.15, d.y)));

    const s = max(dot(d, uSunDir), 0);
    col.addAssign(uSunColor.mul(pow(s, 10)).mul(0.18));
    col.addAssign(uSunColor.mul(smoothstep(0.9994, 0.9998, s)).mul(30));

    // clouds only inside the low band: skips one FBM for most sky pixels
    const band = smoothstep(0.03, 0.16, d.y).mul(smoothstep(0.6, 0.22, d.y));
    If(band.mul(cloudMask).greaterThan(0.001), () => {
      const proj = d.xz.div(d.y.add(0.18)).mul(0.55);
      const cloudNoise = clamp(fbm(proj.add(vec2(uTime.mul(0.006), uTime.mul(0.003)))).mul(0.5).add(0.5), 0, 1);
      const cover = band.mul(smoothstep(0.62, 0.95, cloudNoise));
      const cloudColor = mix(vec3(0.92, 0.90, 0.87), uSunColor.mul(0.5), 0.45);
      col.assign(mix(col, cloudColor, cover.mul(0.6)));
    });

    return col;
  });

  // ----------------------------------------------------------------------------
  // SECTION 5 · OCEAN MATERIAL
  // ECO: the FBM detail normal, sparkle and foam (4 FBM = 12 gradient-noise
  // evaluations per pixel) only run within 140 units of the camera — beyond
  // that the horizon haze dissolves them anyway. Swell shading stays analytic.
  // ----------------------------------------------------------------------------

  const DETAIL_RADIUS = 140;

  const oceanColor = Fn(() => {
    const P = positionWorld;
    const xz = P.xz;
    const time = uTime;
    const sea = uSea;
    const dist = distance(P, cameraPosition);

    const N0 = waveNormal(xz, time, sea);
    const N = N0.toVar();
    const crest = waveCrest(xz, time, sea);
    const V = normalize(cameraPosition.sub(P));

    const spec = vec3(0).toVar();
    const foam = float(0).toVar();

    If(dist.lessThan(DETAIL_RADIUS), () => {
      // finite-difference FBM detail normal (capillary chop)
      const e = float(0.1);
      const h0 = detailHeight(xz, time);
      const hx = detailHeight(xz.add(vec2(e, 0)), time);
      const hz = detailHeight(xz.add(vec2(0, e)), time);
      const detailScale = float(1.5).mul(sea.mul(0.6).add(0.4));
      N.assign(normalize(N.add(vec3(h0.sub(hx), 0, h0.sub(hz)).mul(detailScale))));

      // sun specular: tight noise-modulated sparkle + broad gloss
      const H = normalize(uSunDir.add(V));
      const ndh = max(dot(N, H), 0);
      const sparkleNoise = clamp(fbm(xz.mul(0.3).add(vec2(time.mul(-0.07), time.mul(0.05)))).mul(0.5).add(0.5), 0, 1);
      spec.assign(uSunColor.mul(pow(ndh, 500).mul(mix(0.4, 3.4, sparkleNoise)).add(pow(ndh, 48).mul(0.12))));

      // crest foam
      const foamNoise = clamp(fbm(xz.mul(1.1).add(vec2(time.mul(0.22), time.mul(0.14)))).mul(0.5).add(0.5), 0, 1);
      foam.assign(smoothstep(0.5, 0.95, foamNoise).mul(smoothstep(1.0, 2.0, crest)).mul(0.85));
    });

    // base water color + backlit crest glow
    const col = mix(uDeepColor, uShallowColor, clamp(crest.mul(0.35).add(0.45), 0, 1)).toVar();
    const sss = pow(max(dot(V, uSunDir), 0), 3).mul(max(crest, 0)).mul(0.18);
    col.addAssign(uShallowColor.mul(uSunColor).mul(sss));

    // sky reflection (cloud FBM only where the reflection matters)
    const R = reflect(V.negate(), N).toVar();
    R.y.assign(max(R.y, 0.04));
    const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(N, V), 0)), 5)));
    col.assign(mix(col, skyColor(R.normalize(), fresnel.greaterThan(0.25)), fresnel));

    col.addAssign(spec);
    col.assign(mix(col, vec3(0.82, 0.88, 0.90), foam));

    const horizonFade = smoothstep(150, 290, dist);
    col.assign(mix(col, uHorizonColor, horizonFade));

    return vec4(col, 1);
  });

  // ----------------------------------------------------------------------------
  // SECTION 6 · TIME OF DAY (CPU palettes)
  // ----------------------------------------------------------------------------

  const DAY = {
    zenith: [0.07, 0.20, 0.42],
    horizon: [0.52, 0.68, 0.82],
    sun: [1.0, 0.93, 0.80],
    sunIntensity: 1.6,
    deep: [0.015, 0.09, 0.11],
    shallow: [0.06, 0.32, 0.36],
  };

  const DUSK = {
    zenith: [0.03, 0.05, 0.16],
    horizon: [0.85, 0.36, 0.16],
    sun: [1.0, 0.42, 0.14],
    sunIntensity: 2.6,
    deep: [0.02, 0.045, 0.075],
    shallow: [0.09, 0.15, 0.20],
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep01 = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const mixRGB = (target, dusk, day, t) => {
    target.set(lerp(dusk[0], day[0], t), lerp(dusk[1], day[1], t), lerp(dusk[2], day[2], t));
  };

  function applyTimeOfDay(t) {
    const elevation = lerp(-0.05, 0.62, t);
    const azimuth = lerp(-0.9, 0.9, t);
    const ce = Math.cos(elevation);
    const se = Math.sin(elevation);
    const sa = Math.sin(azimuth);
    const ca = Math.cos(azimuth);
    uSunDir.value.set(ce * sa, se, -ce * ca);

    const daylight = smoothstep01(0.0, 0.42, elevation);

    mixRGB(uZenithColor.value, DUSK.zenith, DAY.zenith, daylight);
    mixRGB(uHorizonColor.value, DUSK.horizon, DAY.horizon, daylight);
    mixRGB(uDeepColor.value, DUSK.deep, DAY.deep, daylight);
    mixRGB(uShallowColor.value, DUSK.shallow, DAY.shallow, daylight);

    const intensity = lerp(2.6, 1.6, daylight);
    uSunColor.value.set(
      lerp(DUSK.sun[0], DAY.sun[0], daylight) * intensity,
      lerp(DUSK.sun[1], DAY.sun[1], daylight) * intensity,
      lerp(DUSK.sun[2], DAY.sun[2], daylight) * intensity
    );
  }


  let renderer = null;
  let controls = null;
  let postProcessing = null;
  let scenePass = null;
  let bloomNode = null;
  let scene = null;
  let camera = null;
  let resizeObserver = null;
  let disposed = false;
  let released = false;
  let initialized = false;
  let initSettled = false;
  let running = false;
  let firstFrameShown = false;
  let error = null;
  let finishRelease;
  const releasedPromise = new Promise(resolve => { finishRelease = resolve; });
  let backendName = null;
  let needsFrame = true;
  let width = 1;
  let height = 1;
  let renderScale = 1;
  let pixelRatioCap = REDUCED_MOTION ? 0.9 : LOW_END_DEVICE ? 1 : 1.5;
  let frameRateCap = REDUCED_MOTION ? 20 : LOW_END_DEVICE ? 30 : 60;
  let targetFPS = REDUCED_MOTION ? 18 : LOW_END_DEVICE ? 28 : 40;
  let lastFrameAt = null;
  let fpsStart = 0;
  let fpsFrames = 0;
  const resources = new Set();
  const backends = new Set();
  const own = resource => { resources.add(resource); return resource; };

  function status() {
    return {
      state: disposed ? 'disposed' : error ? 'error' : firstFrameShown ? 'ready' : 'initializing',
      ready: firstFrameShown && !disposed && !error,
      paused: settings.paused,
      effectivePaused: settings.paused || doc.hidden || disposed || !!error,
      wave: settings.wave,
      daylight: settings.daylight,
      elapsed: uTime.value,
      renderScale,
      backend: backendName,
      reducedMotion: REDUCED_MOTION,
      lowEndDevice: LOW_END_DEVICE,
      error: error?.message || null,
    };
  }

  // User callbacks cannot interrupt GPU resource cleanup or the animation loop.
  function notify(callback, value) {
    try { callback?.(value); } catch (callbackError) {
      console.warn('[Open Sea] Callback failed:', callbackError);
    }
  }

  function attempt(callback) {
    try { callback(); } catch { /* Continue releasing the remaining owned resources. */ }
  }

  function stopLoop() {
    running = false;
    if (initialized && renderer) {
      Promise.resolve(renderer.setAnimationLoop(null)).catch(() => {});
    }
  }

  function detach() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    view.removeEventListener('resize', resize);
    doc.removeEventListener('visibilitychange', syncLoop);
    attempt(() => controls?.dispose());
    controls = null;
    renderer?.domElement.remove();
  }

  function release() {
    if (released) return;
    released = true;
    stopLoop();
    detach();
    // Three r178 BloomNode.dispose() only releases render targets, not materials.
    for (const material of [bloomNode?._compositeMaterial, bloomNode?._highPassFilterMaterial,
      ...(bloomNode?._separableBlurMaterials || [])]) {
      attempt(() => material?.dispose());
    }
    attempt(() => bloomNode?.dispose());
    attempt(() => scenePass?.dispose());
    attempt(() => postProcessing?.dispose());
    for (const resource of resources) attempt(() => resource.dispose());
    resources.clear();
    attempt(() => scene?.clear());
    const backend = renderer?.backend;
    if (backend) backends.add(backend);
    // This instance always creates its own device/context; neither is shared.
    if (initialized) attempt(() => renderer.dispose());
    for (const ownedBackend of backends) {
      if (!initialized || ownedBackend !== backend) attempt(() => ownedBackend.dispose());
      attempt(() => ownedBackend.context?.unconfigure?.());
      attempt(() => ownedBackend.device?.destroy?.());
    }
    backends.clear();
    if (!backend?.isWebGPUBackend) {
      attempt(() => renderer?.getContext()?.getExtension('WEBGL_lose_context')?.loseContext());
    }
    renderer = postProcessing = scenePass = bloomNode = scene = camera = null;
    finishRelease();
  }

  function fail(reason) {
    if (disposed || error) return;
    if (renderer) backendName = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    error = reason instanceof Error ? reason : new Error(String(reason));
    stopLoop();
    detach();
    if (initSettled) release();
    notify(onError, error);
  }

  function resize() {
    if (disposed || error || !renderer || !camera) return;
    const rect = element.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    try {
      renderer.setPixelRatio(Math.min(view.devicePixelRatio || 1, pixelRatioCap) * renderScale);
      renderer.setSize(width, height, false);
      needsFrame = true;
      syncLoop();
    } catch (resizeError) { fail(resizeError); }
  }

  function drawFrame() {
    if (!initialized || disposed || error || doc.hidden) return;
    try {
      postProcessing.render();
      needsFrame = false;
      if (!firstFrameShown) {
        firstFrameShown = true;
        notify(onReady, status());
      }
    } catch (renderError) { fail(renderError); }
  }

  function animate(now) {
    if (!running || disposed || error || settings.paused || doc.hidden) return;
    const frameMS = 1000 / frameRateCap;
    if (lastFrameAt !== null && now - lastFrameAt < frameMS - 0.5) return;
    const dt = lastFrameAt === null ? 0 : Math.min((now - lastFrameAt) / 1000, 0.1);
    lastFrameAt = now;
    uTime.value += dt * (REDUCED_MOTION ? 0.12 : 1);
    controls.update(dt);
    drawFrame();
    if (disposed || error) return;
    fpsFrames += 1;
    const span = (now - fpsStart) / 1000;
    if (span >= 2) {
      const fps = fpsFrames / span;
      fpsFrames = 0;
      fpsStart = now;
      const next = fps < targetFPS - 8 ? Math.max(0.5, +(renderScale * 0.92).toFixed(3))
        : fps > targetFPS + 8 ? Math.min(1, +(renderScale * 1.06).toFixed(3)) : renderScale;
      if (next !== renderScale) {
        renderScale = next;
        resize();
      }
    }
  }

  function syncLoop() {
    if (!initialized || disposed || error) return;
    if (doc.hidden) { stopLoop(); return; }
    // A paused surface can still display its initial frame and new settings.
    if (needsFrame) drawFrame();
    if (disposed || error) return;
    if (settings.paused) { stopLoop(); return; }
    if (!running) {
      running = true;
      lastFrameAt = null;
      fpsStart = view.performance.now();
      fpsFrames = 0;
      Promise.resolve(renderer.setAnimationLoop(animate)).catch(fail);
    }
  }

  function update(patch = {}) {
    if (disposed || error) return status();
    if (Object.hasOwn(patch, 'wave')) settings.wave = valueInRange(patch.wave, settings.wave);
    if (Object.hasOwn(patch, 'daylight')) settings.daylight = valueInRange(patch.daylight, settings.daylight);
    if (Object.hasOwn(patch, 'paused')) settings.paused = patch.paused === true;
    uSea.value = 0.25 + settings.wave / 100 * 1.5;
    applyTimeOfDay(settings.daylight / 100);
    needsFrame = true;
    syncLoop();
    return status();
  }

  function pause(paused) { return update({ paused: paused === true }); }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopLoop();
    detach();
    // init() may allocate backend resources after disposal was requested.
    // Remove DOM/listeners immediately, but release the renderer only on settlement.
    if (initSettled) release();
  }

  async function boot() {
    try {
      renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'low-power', forceWebGL });
      backends.add(renderer.backend);
      renderer.onDeviceLost = info => {
        if (!disposed && !error) fail(new Error(info?.message || 'Ocean graphics device was lost'));
      };
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      const canvas = renderer.domElement;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none;';
      container.appendChild(canvas);
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x05070a);
      camera = new THREE.PerspectiveCamera(55, 1, 0.5, 8000);
      camera.position.set(0, 5.5, 17);
      const segments = LOW_END_DEVICE || REDUCED_MOTION ? 160 : 256;
      const geometry = own(new THREE.PlaneGeometry(420, 420, segments, segments));
      geometry.rotateX(-Math.PI / 2);
      const material = own(new THREE.MeshBasicNodeMaterial());
      material.positionNode = wavePosition(positionLocal.xz, uTime, uSea);
      material.colorNode = oceanColor();
      const ocean = new THREE.Mesh(geometry, material);
      ocean.frustumCulled = false;
      scene.add(ocean);
      const skyMaterial = own(new THREE.MeshBasicNodeMaterial());
      skyMaterial.colorNode = skyColor(normalize(positionWorld), float(1));
      skyMaterial.side = THREE.BackSide;
      skyMaterial.depthWrite = false;
      const skyGeometry = own(new THREE.SphereGeometry(4000,
        LOW_END_DEVICE ? 32 : 48, LOW_END_DEVICE ? 16 : 24));
      const sky = new THREE.Mesh(skyGeometry, skyMaterial);
      sky.renderOrder = -1;
      sky.frustumCulled = false;
      scene.add(sky);
      postProcessing = new THREE.PostProcessing(renderer);
      scenePass = pass(scene, camera);
      const sceneColor = scenePass.getTextureNode('output');
      bloomNode = bloom(sceneColor, LOW_END_DEVICE ? 0.18 : 0.28, 0.3, 0.9);
      postProcessing.outputNode = sceneColor.add(bloomNode);
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.06;
      controls.minDistance = 4;
      controls.maxDistance = 120;
      controls.minPolarAngle = 0.15;
      controls.maxPolarAngle = Math.PI * 0.495;
      controls.target.set(0, 1.5, 0);
      controls.autoRotate = !REDUCED_MOTION;
      controls.autoRotateSpeed = 0.12;
      controls.enabled = false;
      controls.disconnect();
      controls.update(0);
      applyTimeOfDay(settings.daylight / 100);
      resize();
      if (error || disposed) {
        initSettled = true;
        release();
        return;
      }
      doc.addEventListener('visibilitychange', syncLoop);
      view.addEventListener('resize', resize);
      if (view.ResizeObserver) {
        resizeObserver = new view.ResizeObserver(resize);
        resizeObserver.observe(element);
      }
      await renderer.init();
      initialized = true;
      initSettled = true;
      backendName = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
      if (disposed || error) { release(); return; }
      if (renderer.backend.isWebGPUBackend !== true) {
        pixelRatioCap = Math.min(pixelRatioCap, 1);
        frameRateCap = Math.min(frameRateCap, 30);
        targetFPS = Math.min(targetFPS, 28);
        renderScale = 0.6;
      }
      resize();
      syncLoop();
    } catch (initError) {
      initSettled = true;
      if (disposed || error) release();
      else fail(initError);
    }
  }

  void boot();
  return { update, pause, dispose, status, released:releasedPromise };
}
