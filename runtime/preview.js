import { createOcean } from './ocean.js';

// The controller uses the same ocean as the Codex skin, without changing its
// camera, material, palette or animation loop.
export function createPreview(container, initial = {}, onState = () => {}) {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  let settings = { theme:'ocean', wave:56, daylight:55, paused:false, ...initial };
  let ocean = null, epoch = 0, disposed = false, failure = null, lastNotice = '';
  let video = null, videoSource = null, videoEpoch = 0, videoReady = false, videoPlaying = false;
  let playPending = false, playEpoch = 0, videoStarted = false;
  let nativeVisible = true;
  const videoListeners = [];
  function status() {
    if (disposed) return { state:'disposed', theme:settings.theme };
    if (settings.theme === 'video') {
      const effectivePaused = settings.paused || !nativeVisible || doc.hidden || !!failure;
      const playing = videoPlaying && !failure && !effectivePaused && !video?.paused;
      // A decoded frame is enough while paused; active playback must leave
      // buffering before the preview claims it is ready.
      const ready = videoReady && !failure && (effectivePaused || playing);
      return {
        state:failure ? 'error' : ready ? 'ready' : 'initializing', theme:'video',
        ready, hasFrame:videoReady, playing, paused:settings.paused, effectivePaused,
        currentTime:video?.currentTime || 0, duration:Number.isFinite(video?.duration) ? video.duration : 0,
        error:failure,
      };
    }
    if (settings.theme !== 'ocean') return { state:'static', theme:settings.theme };
    return ocean ? { ...ocean.status(), paused:settings.paused, theme:'ocean' }
      : { state:failure ? 'error' : 'initializing', error:failure, theme:'ocean' };
  }
  function notify() {
    if (disposed) return;
    const value = status();
    const notice = JSON.stringify([value.state, value.theme, value.hasFrame, value.effectivePaused, value.playing, value.reducedMotion, value.error]);
    if (notice === lastNotice) return;
    lastNotice = notice;
    onState(value);
  }
  function releaseOcean() {
    epoch += 1;
    ocean?.dispose();
    ocean = null;
  }
  function startOcean() {
    const generation = ++epoch;
    failure = null;
    const changed = () => queueMicrotask(() => {
      if (!disposed && generation === epoch) notify();
    });
    try { ocean = createOcean(container, { ...settings, paused:settings.paused || !nativeVisible }, { onReady:changed, onError:changed }); }
    catch (error) { failure = error?.message || String(error); }
  }
  function releaseVideo() {
    videoEpoch += 1;
    playEpoch += 1;
    for (const [event, listener] of videoListeners) video?.removeEventListener(event, listener);
    videoListeners.length = 0;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    video = null;
    videoSource = null;
    videoReady = videoPlaying = playPending = false;
    videoStarted = false;
  }
  function failVideo(error) {
    failure = error?.message || String(error);
    videoPlaying = false;
    video?.pause();
    notify();
  }
  function syncVideo() {
    if (!video || disposed || failure) return;
    if (settings.paused || !nativeVisible || doc.hidden) {
      // pause() can reject a still-pending play() after a quick resume. Its
      // obsolete rejection must not fail the newly resumed preview.
      playEpoch += 1;
      playPending = false;
      video.pause();
      videoPlaying = false;
    } else if (video.paused && !playPending) {
      const current = video, generation = videoEpoch, request = ++playEpoch;
      playPending = true;
      Promise.resolve().then(() => {
        if (!disposed && generation === videoEpoch && request === playEpoch && !settings.paused && nativeVisible && !doc.hidden) return current.play();
      }).catch(error => {
        if (!disposed && generation === videoEpoch && request === playEpoch && !settings.paused && nativeVisible && !doc.hidden) failVideo(error);
      }).finally(() => {
        if (!disposed && generation === videoEpoch && request === playEpoch) {
          playPending = false;
          // A rapid hide/pause followed by resume may have canceled the queued play.
          if (!failure && !settings.paused && nativeVisible && !doc.hidden && current.paused) syncVideo();
          notify();
        }
      });
    }
  }
  function startVideo() {
    releaseVideo();
    videoStarted = true;
    failure = null;
    videoSource = settings.videoUrl;
    const match = typeof videoSource === 'string' && /^open-sea-media:\/\/([a-f\d]{32})\/([a-f\d]{32})$/i.exec(videoSource);
    if (!match || match[2] !== settings.videoId) {
      failure = 'The local video is unavailable. Import it again.';
      return;
    }
    const generation = videoEpoch;
    video = doc.createElement('video');
    video.muted = video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;pointer-events:none;';
    const listen = (event, action) => {
      const listener = () => { if (!disposed && generation === videoEpoch) action(); };
      video.addEventListener(event, listener);
      videoListeners.push([event, listener]);
    };
    listen('loadeddata', () => {
      videoReady = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
      syncVideo(); notify();
    });
    listen('playing', () => { videoReady = true; videoPlaying = true; notify(); });
    listen('pause', () => { videoPlaying = false; notify(); });
    listen('waiting', () => { videoPlaying = false; notify(); });
    listen('error', () => failVideo(new Error(`This video could not be loaded or decoded (media error ${video.error?.code || 'unknown'}).`)));
    container.appendChild(video);
    video.src = videoSource;
    video.load();
    syncVideo();
  }
  function update(next = {}) {
    if (disposed) return status();
    const previousTheme = settings.theme;
    const previousVideoId = settings.videoId;
    settings = { ...settings, ...next };
    if (settings.theme === 'ocean') {
      if (video || videoSource) releaseVideo();
      if (!ocean && (previousTheme !== 'ocean' || !failure)) startOcean();
      else ocean?.update({ wave:settings.wave, daylight:settings.daylight, paused:settings.paused || !nativeVisible });
    } else if (settings.theme === 'video') {
      if (ocean) releaseOcean();
      if (!videoStarted || previousTheme !== 'video' || videoSource !== settings.videoUrl || previousVideoId !== settings.videoId) startVideo();
      else syncVideo();
    } else {
      if (ocean) releaseOcean();
      if (video || videoSource) releaseVideo();
    }
    notify();
    return status();
  }
  // Recovery can replace the GPU backend without an onReady/onError event.
  const timer = view.setInterval(() => { if ((ocean || video) && nativeVisible && !doc.hidden) notify(); }, 500);
  const visibilityChanged = () => { syncVideo(); notify(); };
  doc.addEventListener('visibilitychange', visibilityChanged);
  update();
  return {
    update, status,
    setVisible(visible) {
      if (disposed || typeof visible !== 'boolean' || nativeVisible === visible) return status();
      // Native hide/minimize is separate from the user's pause setting, and
      // remains reliable when Electron keeps document.hidden false on macOS.
      nativeVisible = visible;
      ocean?.pause(settings.paused || !nativeVisible);
      syncVideo();
      notify();
      return status();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseOcean();
      releaseVideo();
      view.clearInterval(timer);
      doc.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}

window.openSeaPreview = Object.freeze({ create:createPreview });
