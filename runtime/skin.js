import { createOcean } from './ocean.js';
import { normalizeSettings, DEFAULTS } from '../src/settings.mjs';
import preview from './ocean-preview.jpg';
import aurora from '../ui/presets/aurora.svg';
import dunes from '../ui/presets/dunes.svg';
import coast from '../ui/presets/coast.svg';

// Semantic adapters inspired by Codex Dream Skin, MIT. No hashed class names.
const PARTS = {
  main: 'main[data-app-shell-main-surface], main[class*="_MainContentSurface_"], main.main-surface',
  sidebar: 'aside.app-shell-left-panel',
  header: 'header[data-app-shell-header-edge-scroll], header.app-header-tint',
  composer: '[data-composer-surface-variant][data-composer-radius-variant], [class*="_ComposerLayoutRoot_"], .composer-surface-chrome',
  page: '[data-app-shell-page-surface="true"], .thread-scroll-container, [role="main"]:has([data-testid="home-icon"])',
  // A current shell frame also carries page-surface; frame paint takes priority.
  frame: '[data-app-shell-frame]',
  titlebar: 'header[data-app-shell-titlebar], [data-app-shell-main-titlebar], header[data-window-titlebar]',
};
const KEY = '__codexOpenSea';
const ATTR = 'data-open-sea-part';
const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="menu"],dialog,[aria-modal="true"],[data-radix-popper-content-wrapper]';
if (!window[KEY]) {
  let settings = { ...DEFAULTS }, ocean = null, video = null, host = null, shadow = null;
  let disposed = false, scheduled = false, state = 'waiting-shell', error = null;
  let active = false, backgroundDirty = true, oceanEpoch = 0, videoEpoch = 0;
  const marked = new Map();
  const sheet = new CSSStyleSheet();
  const originalRoot = document.documentElement.getAttribute('data-open-sea');
  const css = `
    html[data-open-sea="active"] { isolation:isolate; }
    html[data-open-sea="active"] body:not([data-open-sea-part="frame"]),
    html[data-open-sea="active"] #root:not([data-open-sea-part="frame"]) { background:transparent !important; }
    html[data-open-sea="active"] :is([data-open-sea-part="page"],[data-open-sea-part="frame-inner"],[data-open-sea-part="titlebar-inner"]) {
      background:transparent !important;
    }
    html[data-open-sea="active"] :is([data-open-sea-part="frame"],[data-open-sea-part="main"],[data-open-sea-part="sidebar"],[data-open-sea-part="titlebar"]) {
      background:rgb(var(--open-sea-rgb) / var(--open-sea-alpha)) !important;
      backdrop-filter:none !important;
    }
    /* Paint one continuous layer through the frame's padding and rounded gaps.
       Older shells without a frame keep the individual surface fallback above. */
    html[data-open-sea="active"] [data-open-sea-part="frame"] :is([data-open-sea-part="main"],[data-open-sea-part="sidebar"],[data-open-sea-part="titlebar"]) {
      background:transparent !important;
    }
    html[data-open-sea="active"] [data-open-sea-part="frame-inner"] { backdrop-filter:none !important; }
    html[data-open-sea="active"] :is([data-open-sea-part="titlebar"],[data-open-sea-part="titlebar-inner"]) {
      --codex-titlebar-tint:transparent !important;
      backdrop-filter:none !important;
    }
    html[data-open-sea="active"] [data-open-sea-part="sidebar"] :is(nav,.sidebar-navigation) { background:transparent !important; }
    /* Codex extends this inherited background underneath the main pane. Keep
       the extension and resize hit area, but draw only a one-pixel separator. */
    html[data-open-sea="active"] [data-open-sea-part="sidebar"]:not([data-app-shell-left-panel-appearance="content-surface"])::after {
      background:linear-gradient(to right,rgb(var(--open-sea-edge-rgb) / .14) 0 1px,transparent 1px) !important;
    }
    html[data-open-sea="active"] [data-open-sea-part="header"] { background:transparent !important; }
    /* Modern composers choose their own painted layer: home paints the rounded
       body, other layouts paint the root. Preserve those shapes and states. */
    html[data-open-sea="active"] [data-open-sea-part="composer"][data-composer-radius-variant]:is([data-composer-surface-variant="default"],[data-composer-surface-variant="opaque"],[data-composer-surface-variant="secondary"]):not([data-composer-drag-active]) {
      --composer-layout-surface-background:rgb(var(--open-sea-rgb) / max(.60,var(--open-sea-alpha))) !important;
      --composer-layout-surface-backdrop-filter:blur(12px) !important;
    }
    html[data-open-sea="active"] [data-open-sea-part="composer"]:not([data-composer-surface-variant][data-composer-radius-variant]) {
      background:rgb(var(--open-sea-rgb) / max(.60,var(--open-sea-alpha))) !important;
      backdrop-filter:blur(12px) !important;
    }
    html[data-open-sea="active"] [data-open-sea-part="composer"]:not([data-composer-surface-variant][data-composer-radius-variant]) :is([class*="_ComposerLayoutBody_"],[data-composer-footer-responsive]) { background:transparent !important; }
    html[data-open-sea="active"] [data-app-shell-main-content-top-fade]:not(:has(*)) { background:none !important; }
  `;
  sheet.replaceSync(css);
  const rootStyle = new CSSStyleSheet();
  const colorScheme = matchMedia('(prefers-color-scheme: light)');
  function videoStatus() {
    if (!active || disposed || settings.theme !== 'video') return null;
    return { state:video?.state || 'initializing', ready:video?.state === 'ready',
      playing:video?.playing === true && !video.element.paused && !settings.paused && !document.hidden,
      paused:settings.paused, effectivePaused:settings.paused || document.hidden || !!video?.error,
      videoId:settings.videoId, currentTime:video?.element.currentTime || 0,
      duration:Number.isFinite(video?.element.duration) ? video.element.duration : null,
      error:video?.error || null };
  }
  function status() {
    const oceanStatus = ocean?.status() ?? null;
    const currentVideo = videoStatus();
    // Recovery replaces a canvas inside Shadow DOM, outside the document observer.
    const currentState = active && settings.theme === 'ocean'
      ? oceanStatus?.state === 'ready' ? 'ready' : oceanStatus?.state === 'error' ? 'fallback' : 'initializing'
      : currentVideo ? currentVideo.state : state;
    return { state:currentState, theme:settings.theme, opacity:settings.opacity,
      error:currentVideo ? currentVideo.error : error, ocean:oceanStatus, video:currentVideo,
      parts: Object.fromEntries(Object.keys(PARTS).map(k => [k, document.querySelectorAll(`[${ATTR}="${k}"]`).length])) };
  }
  function appearance() {
    if (disposed) return;
    const light = document.documentElement.classList.contains('electron-light') ||
      (!document.documentElement.classList.contains('electron-dark') && colorScheme.matches);
    rootStyle.replaceSync(`html[data-open-sea="active"] { --open-sea-rgb:${light ? '245 248 249' : '17 23 29'}; --open-sea-edge-rgb:${light ? '17 23 29' : '245 248 249'}; --open-sea-alpha:${settings.opacity/100}; }`);
  }
  function restoreMark(element, previous) {
    if (element.getAttribute(ATTR) !== previous.assigned) return;
    if (previous.value === null) element.removeAttribute(ATTR);
    else element.setAttribute(ATTR, previous.value);
  }
  function restoreRoot() {
    if (!active) return;
    if (originalRoot === null) document.documentElement.removeAttribute('data-open-sea');
    else document.documentElement.setAttribute('data-open-sea', originalRoot);
    active = false;
  }
  function disposeOcean() {
    oceanEpoch++;
    ocean?.dispose();
    ocean = null;
  }
  function disposeVideo() {
    videoEpoch++;
    if (!video) return;
    const previous = video;
    video = null;
    previous.playEpoch++;
    for (const [type, listener] of previous.listeners) previous.element.removeEventListener(type, listener);
    previous.element.pause();
    previous.element.removeAttribute('src');
    previous.element.load();
    previous.element.remove();
  }
  function currentVideo(record) {
    return !disposed && active && settings.theme === 'video' && video === record && record.epoch === videoEpoch;
  }
  function failVideo(record, message) {
    if (!currentVideo(record) || record.state === 'error') return;
    record.error = message;
    record.state = 'error';
    record.playing = record.playPending = false;
    record.playEpoch++;
    record.element.pause();
  }
  function syncVideoPlayback() {
    const record = video;
    if (!record || !currentVideo(record) || record.state === 'error') return;
    if (settings.paused || document.hidden) {
      record.playEpoch++;
      record.playing = record.playPending = false;
      if (!record.element.paused) record.element.pause();
      record.state = record.hasFrame ? 'ready' : 'initializing';
      return;
    }
    if (record.playing || record.playPending) return;
    record.playPending = true;
    record.state = 'initializing';
    const request = ++record.playEpoch;
    try {
      Promise.resolve(record.element.play()).then(() => {
        if (!currentVideo(record) || request !== record.playEpoch) return;
        record.playPending = false;
        if (settings.paused || document.hidden) { syncVideoPlayback(); return; }
        if (!record.element.paused && record.element.readyState >= 2) {
          record.playing = record.hasFrame = true;
          record.state = 'ready';
          record.element.style.opacity = '1';
        }
      }).catch(() => {
        if (currentVideo(record) && request === record.playEpoch) failVideo(record, 'Local video playback could not start.');
      });
    } catch { failVideo(record, 'Local video playback could not start.'); }
  }
  function updateVideo() {
    if (video && (video.id !== settings.videoId || video.url !== settings.videoUrl || video.state === 'error')) disposeVideo();
    if (!video && settings.videoUrl) {
      const element = document.createElement('video');
      element.muted = element.defaultMuted = true;
      element.loop = element.playsInline = true;
      element.preload = 'auto';
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;opacity:0;';
      const record = video = { element, id:settings.videoId, url:settings.videoUrl, epoch:++videoEpoch,
        state:'initializing', error:null, hasFrame:false, playing:false, playPending:false, playEpoch:0, listeners:[] };
      const listen = (type, action) => {
        const listener = () => { if (currentVideo(record) && record.state !== 'error') action(); };
        record.listeners.push([type, listener]);
        element.addEventListener(type, listener);
      };
      listen('loadeddata', () => {
        record.hasFrame = element.readyState >= 2;
        if (record.hasFrame) element.style.opacity = '1';
        syncVideoPlayback();
      });
      listen('canplay', syncVideoPlayback);
      listen('playing', () => {
        record.hasFrame = element.readyState >= 2;
        if (settings.paused || document.hidden) { syncVideoPlayback(); return; }
        record.playing = record.hasFrame;
        record.state = record.hasFrame ? 'ready' : 'initializing';
        if (record.hasFrame) element.style.opacity = '1';
      });
      listen('pause', () => {
        record.playing = false;
        record.state = (settings.paused || document.hidden) && record.hasFrame ? 'ready' : 'initializing';
      });
      // A network `stalled` event can occur while buffered frames still play.
      // `waiting` is the media event that actually reports interrupted playback.
      listen('waiting', () => {
        record.playing = false;
        record.state = (settings.paused || document.hidden) && record.hasFrame ? 'ready' : 'initializing';
      });
      listen('error', () => failVideo(record, {
        1:'Local video loading was aborted.', 2:'Local video could not be read.',
        3:'Local video could not be decoded.', 4:'Local video format is not supported.',
      }[element.error?.code] || 'Local video could not be loaded.'));
      shadow.appendChild(element);
      try { element.src = settings.videoUrl; element.load(); }
      catch { failVideo(record, 'Local video could not be loaded.'); }
    }
    syncVideoPlayback();
  }
  function deactivate() {
    for (const [element, previous] of marked) restoreMark(element, previous);
    marked.clear();
    restoreRoot();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(item => item !== sheet && item !== rootStyle);
    if (host && !host.hidden) host.hidden = true;
    disposeOcean();
    disposeVideo();
    backgroundDirty = true;
    state = 'waiting-shell';
  }
  function shellMain() {
    return [...document.querySelectorAll(PARTS.main)].find(element => !element.closest(OVERLAY));
  }
  function markParts() {
    const desired = new Map();
    for (const [part, selector] of Object.entries(PARTS)) {
      for (const element of document.querySelectorAll(selector)) {
        if (element.closest(OVERLAY)) continue;
        // The titlebar contains another painted surface after scrolling. Tint
        // just the outer layer; preserve native drag regions and every control.
        const nestedTitlebar = part === 'titlebar' && element.parentElement?.closest(PARTS.titlebar);
        const nestedFrame = part === 'frame' && element.parentElement?.closest(PARTS.frame);
        desired.set(element, nestedTitlebar ? 'titlebar-inner' : nestedFrame ? 'frame-inner' : part);
      }
    }
    for (const [element, previous] of marked) {
      if (!desired.has(element)) {
        restoreMark(element, previous);
        marked.delete(element);
      }
    }
    for (const [element, part] of desired) {
      if (!marked.has(element)) marked.set(element, { value: element.getAttribute(ATTR), assigned: part });
      marked.get(element).assigned = part;
      if (element.getAttribute(ATTR) !== part) element.setAttribute(ATTR, part);
    }
  }
  function refresh() {
    scheduled = false;
    if (disposed) return;
    if (!document.body || !shellMain()) { deactivate(); return; }
    if (!host) {
      host = document.createElement('div'); host.id = 'codex-open-sea-backdrop';
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;';
      shadow = host.attachShadow({mode:'closed'});
      const shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(':host{display:block}:host([hidden]){display:none!important}canvas{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity .45s}');
      shadow.adoptedStyleSheets = [shadowSheet];
    }
    if (!host.isConnected) document.body.prepend(host);
    if (host.hidden) host.hidden = false;
    if (!active) {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet, rootStyle];
      document.documentElement.setAttribute('data-open-sea', 'active');
      active = true;
    }
    markParts();
    appearance();
    if (backgroundDirty) { backgroundDirty = false; updateBackground(); }
    let oceanStatus = ocean?.status();
    if (oceanStatus && oceanStatus.paused !== settings.paused) oceanStatus = ocean.pause(settings.paused);
    if (settings.theme === 'video') syncVideoPlayback();
    state = settings.theme === 'video' ? videoStatus().state : settings.theme !== 'ocean' ? 'ready' : oceanStatus?.state === 'ready' ? 'ready'
      : oceanStatus?.state === 'error' ? 'fallback' : 'initializing';
  }
  function schedule() {
    if (!scheduled && !disposed) { scheduled = true; queueMicrotask(refresh); }
  }
  function updateBackground() {
    if (!host || !active) return;
    if (settings.theme === 'video') {
      disposeOcean();
      error = null;
      host.style.background = 'none';
      updateVideo();
      return;
    }
    disposeVideo();
    const art = settings.theme === 'ocean' ? preview : settings.theme === 'custom' ? settings.imageData : {aurora,dunes,coast}[settings.theme];
    host.style.background = `center / cover no-repeat url(${JSON.stringify(art)})`;
    if (settings.theme === 'ocean') {
      if (ocean?.status().state === 'error') disposeOcean();
      if (!ocean) {
        error = null;
        state = 'initializing';
        const epoch = ++oceanEpoch;
        ocean = createOcean(shadow, settings, {
          onReady() {
            if (disposed || epoch !== oceanEpoch || settings.theme !== 'ocean') return;
            for (const canvas of shadow.querySelectorAll('canvas')) canvas.style.opacity = '1';
            schedule();
          },
          onError() {
            if (disposed || epoch !== oceanEpoch || settings.theme !== 'ocean') return;
            error = 'Ocean rendering unavailable; static ocean remains visible.';
            schedule();
          },
        });
      } else ocean.update(settings);
    } else { disposeOcean(); error = null; }
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList:true, subtree:true, attributes:true,
    attributeFilter:['class','role','aria-modal','data-app-shell-main-surface','data-app-shell-header-edge-scroll',
      'data-composer-surface-variant','data-composer-radius-variant','data-app-shell-page-surface','data-testid',
      'data-app-shell-frame','data-app-shell-titlebar','data-app-shell-main-titlebar','data-window-titlebar'] });
  const appearanceObserver = new MutationObserver(appearance);
  appearanceObserver.observe(document.documentElement, {attributes:true,attributeFilter:['class']});
  colorScheme.addEventListener('change', appearance);
  document.addEventListener('visibilitychange', syncVideoPlayback);
  window[KEY] = {
    apply(next) { if(disposed) throw new Error('Skin disposed.'); settings = normalizeSettings(next); error=null; backgroundDirty=true; refresh(); return status(); },
    status,
    dispose() {
      if(disposed) return {state:'disposed'};
      disposed=true; observer.disconnect(); appearanceObserver.disconnect(); colorScheme.removeEventListener('change', appearance);
      document.removeEventListener('visibilitychange', syncVideoPlayback);
      deactivate(); host?.remove(); host=null; shadow=null;
      delete window[KEY]; state='disposed'; return {state};
    },
  };
  refresh();
}
