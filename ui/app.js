"use strict";

(() => {
  const DEFAULTS = Object.freeze({ theme: "ocean", wave: 56, daylight: 55, opacity: 40, paused: false, locale: "zh", imageData: null, videoId:null, videoName:null });
  const THEMES = ["ocean", "aurora", "dunes", "coast", "custom", "video"];
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const POLL_INTERVAL_MS = 2000;
  const STATUS_KEYS = { idle: "statusIdle", waiting: "statusWaiting", connected: "statusConnected", initializing: "statusInitializing", fallback: "statusFallback", ready: "statusReady", restored: "statusRestored" };
  const STATUS_DETAIL_KEYS = { waiting: "waitingDetail", initializing: "initializingDetail", fallback: "fallbackDetail" };
  const $ = (id) => document.getElementById(id);
  const writeText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const api = window.openSea;
  const native = Boolean(api && ["getState", "launch", "apply", "importImage", "restore"].every((key) => typeof api[key] === "function"));
  const words = {
    zh: {
      connecting: "正在连接", connected: "控制器已就绪", disconnected: "连接暂不可用", previewConnection: "界面预览", eyebrow: "A LITTLE ROOM TO BREATHE",
      heading: "把海，带到你的桌面。", intro: "为 Codex 换一片风景，\n让专注慢慢发生。", preview: "海洋实时预览", staticPreview: "图片预览", previewNote: "与 Codex 皮肤共用原版海洋渲染器。玻璃不透明度应用于客户端界面。",
      makeYours: "MAKE IT YOURS", controlsTitle: "刚刚好的氛围", wave: "波浪起伏", waveLow: "平静", waveHigh: "轻涌", daylight: "日光明暗", daylightLow: "暮色", daylightHigh: "晴昼", opacity: "玻璃不透明度", opacityLow: "更通透", opacityHigh: "更实",
      oceanOnly: "仅海洋背景使用此设置", previewPending: "海洋预览", videoPreviewPending: "视频预览", videoPreviewNote: "本地视频静音循环播放。玻璃不透明度应用于客户端界面。", staticPreviewNote: "当前背景为静态图片。玻璃不透明度应用于客户端界面。",
      pause: "暂停波浪", resume: "继续波浪", motionOn: "波浪流动中", motionOff: "波浪已暂停", motionReduced: "已跟随系统减少动态效果", motionStatic: "静态背景", previewLoading: "正在加载真实海洋…", previewFailed: "海洋预览未能启动", previewFailedDetail: "图形渲染暂不可用。切换到其他背景后再选海洋可重试。", previewMissing: "预览组件未加载，请重新构建或安装 Open Sea。", themesTitle: "或者，换一片风景", originalArtwork: "原创风景 · 为专注而作", chooseTheme: "选择背景",
      ocean: "海洋", aurora: "极光", dunes: "沙丘", coast: "海岸", custom: "你的风景", default: "默认", importImage: "导入自己的图片", replaceImage: "更换你的图片", dismiss: "知道了",
      video: "动态视频", importVideo: "导入动态视频", replaceVideo: "更换动态视频", importingVideo: "正在导入视频…", pauseDynamic: "暂停动态背景", resumeDynamic: "继续动态背景", videoPreview: "视频实时预览", videoDescription: "你的本地动态背景。", videoPlaying: "视频播放中 · 静音", videoPaused: "视频已暂停", videoLoading: "正在加载本地视频…", videoFailed: "视频预览未能播放", videoFailedDetail: "请尝试其他本地视频，或重新导入。", systemVideos: "本机系统动态壁纸", noSystemVideos: "未检测到已下载的视频。macOS 可先在系统设置中下载动态壁纸。", systemVideosPreview: "请打开 Open Sea 应用，查看本机已下载的动态壁纸。", videoPrivacy: "视频仅在本机使用；Apple 视频不随项目分发。",
      statusVideoInitializing: "已连接 Codex，正在加载本地视频。", statusVideoError: "已连接 Codex，但视频背景未能播放。请尝试其他视频，或切换背景。", statusMissingVideo: "上次导入的视频已不可用，已选择海洋。可重新导入视频。", videoInitializingDetail: "视频就绪后会自动显示，无需重复点击启动。",
      oceanDescription: "海风很轻，思绪很远。", auroraDescription: "在静夜里，等一束微光。", dunesDescription: "慢下来的光，留在沙丘上。", coastDescription: "沿着海岸，留一点空白。", customDescription: "把喜欢的风景，留在眼前。",
      launch: "启动带皮肤的 Codex", restore: "恢复原界面", statusDetail: "你的聊天内容不会出现在此面板。", previewStatus: "界面预览 · 未连接客户端", previewDetail: "调节仅在此页预览；请从 Open Sea 应用连接 Codex。",
      ready: "控制器已就绪，可调节皮肤或启动 Codex。", applying: "正在应用设置…", launching: "正在启动 Codex…", importing: "正在导入图片…", restoring: "正在恢复原界面…", missingNative: "请从 Open Sea 应用连接客户端。",
      statusIdle: "控制器已就绪。点击启动，在 Codex 中应用皮肤。", statusWaiting: "正在等待 Codex 主界面。如窗口显示登录页，请先完成登录。", statusConnected: "已连接 Codex，正在确认皮肤状态。", statusInitializing: "已连接 Codex，正在初始化海洋图形；静态海洋背景已显示。", statusFallback: "已连接 Codex。海洋动画暂不可用，静态海洋背景仍可用。", statusRenderError: "已连接 Codex，但皮肤渲染失败。请调节设置重试，或切换预设、导入图片。", statusReady: "皮肤已在 Codex 中显示。", statusRestored: "已移除皮肤。退出这个 Codex 窗口并正常启动，可关闭本机调试连接。", waitingDetail: "主界面就绪后会自动应用皮肤，无需重复点击启动。", initializingDetail: "图形就绪后会自动更新，无需重复点击启动。", fallbackDetail: "可以继续使用静态背景，或切换预设、导入自己的图片。", connectionErrorPrefix: "连接暂不可用，请确认 Codex 仍在运行：",
      errorPrefix: "操作未完成：", unknownError: "请稍后重试。", invalidResult: "客户端没有返回有效状态，请重试。", invalidImage: "请选择 PNG、JPEG 或 WebP 图片。", imageTooLarge: "图片不能超过 10 MiB，请选择较小的图片。", imageReadError: "无法读取这张图片，请选择其他图片。", previewAria: "{theme}皮肤效果预览", percent: "%"
    },
    en: {
      connecting: "Connecting", connected: "Controller ready", disconnected: "Connection unavailable", previewConnection: "UI preview", eyebrow: "A LITTLE ROOM TO BREATHE",
      heading: "A little ocean. A little space.", intro: "A fresh view for Codex.\nA quieter place to focus.", preview: "LIVE OCEAN PREVIEW", staticPreview: "IMAGE PREVIEW", previewNote: "The same original ocean renderer used by the Codex skin. Glass opacity applies to the client interface.",
      makeYours: "MAKE IT YOURS", controlsTitle: "Find your calm", wave: "Wave motion", waveLow: "Still", waveHigh: "Rolling", daylight: "Daylight", daylightLow: "Dusk", daylightHigh: "Day", opacity: "Glass opacity", opacityLow: "More transparent", opacityHigh: "More opaque",
      oceanOnly: "This setting applies to the ocean background", previewPending: "OCEAN PREVIEW", videoPreviewPending: "VIDEO PREVIEW", videoPreviewNote: "The local video loops with sound off. Glass opacity applies to the client interface.", staticPreviewNote: "This background is a still image. Glass opacity applies to the client interface.",
      pause: "Pause waves", resume: "Resume waves", motionOn: "Waves in motion", motionOff: "Waves paused", motionReduced: "Reduced motion follows your system", motionStatic: "Static background", previewLoading: "Loading the original ocean…", previewFailed: "Ocean preview could not start", previewFailedDetail: "Graphics rendering is unavailable. Choose another background, then Ocean to retry.", previewMissing: "The preview component did not load. Rebuild or reinstall Open Sea.", themesTitle: "Or, a change of scenery", originalArtwork: "Original artwork · made for focus", chooseTheme: "Choose a background",
      ocean: "Ocean", aurora: "Aurora", dunes: "Dunes", coast: "Coast", custom: "Your scenery", default: "Default", importImage: "Import your image", replaceImage: "Change your image", dismiss: "Dismiss",
      video: "Local video", importVideo: "Import a video", replaceVideo: "Change your video", importingVideo: "Importing video…", pauseDynamic: "Pause animated background", resumeDynamic: "Resume animated background", videoPreview: "LIVE VIDEO PREVIEW", videoDescription: "Your local animated background.", videoPlaying: "Video playing · muted", videoPaused: "Video paused", videoLoading: "Loading the local video…", videoFailed: "Video preview could not play", videoFailedDetail: "Try another local video, or import it again.", systemVideos: "Downloaded system wallpapers", noSystemVideos: "No downloaded videos found. On macOS, download a dynamic wallpaper in System Settings first.", systemVideosPreview: "Open the Open Sea app to see downloaded system wallpapers.", videoPrivacy: "Videos stay on this device. Apple videos are not distributed with this project.",
      statusVideoInitializing: "Connected to Codex. Loading the local video.", statusVideoError: "Codex is connected, but the video background could not play. Try another video or choose a different background.", statusMissingVideo: "The previously imported video is unavailable. Ocean is selected; you can import the video again.", videoInitializingDetail: "The video appears when it is ready. No need to launch again.",
      oceanDescription: "A soft breeze. A wandering thought.", auroraDescription: "A quiet night, a little light.", dunesDescription: "Where the light takes its time.", coastDescription: "A little room along the shore.", customDescription: "Keep a favorite view close.",
      launch: "Launch Codex with skin", restore: "Restore original", statusDetail: "Your conversations never appear in this panel.", previewStatus: "UI preview · not connected to a client", previewDetail: "Changes preview on this page. Open the Open Sea app to connect to Codex.",
      ready: "Controller ready. Adjust your skin or launch Codex.", applying: "Applying settings…", launching: "Launching Codex…", importing: "Importing image…", restoring: "Restoring the original interface…", missingNative: "Open the Open Sea app to connect to the client.",
      statusIdle: "Controller ready. Launch Codex to apply your skin.", statusWaiting: "Waiting for the Codex main interface. If a sign-in page is shown, sign in first.", statusConnected: "Connected to Codex. Checking your skin status.", statusInitializing: "Connected to Codex. Ocean graphics are initializing; the static ocean background is visible.", statusFallback: "Connected to Codex. Ocean animation is unavailable; the static ocean background is still available.", statusRenderError: "Codex is connected, but skin rendering failed. Adjust a setting to retry, choose a preset, or import an image.", statusReady: "Your skin is visible in Codex.", statusRestored: "Skin removed. Quit this Codex instance and start normally to close local debugging.", waitingDetail: "Your skin will appear when the main interface is ready. No need to launch again.", initializingDetail: "The view updates when graphics are ready. No need to launch again.", fallbackDetail: "Keep the static background, choose a preset, or import your own image.", connectionErrorPrefix: "Connection unavailable. Check that Codex is running: ",
      errorPrefix: "Action could not finish: ", unknownError: "Please try again shortly.", invalidResult: "The client did not return a valid state. Please try again.", invalidImage: "Choose a PNG, JPEG, or WebP image.", imageTooLarge: "Images must be 10 MiB or smaller. Choose a smaller image.", imageReadError: "This image could not be read. Please choose another.", previewAria: "{theme} skin preview", percent: "%"
    }
  };
  Object.assign(words.zh, {
    videoBuffering:"视频缓冲中 · 保留当前画面",
    eyebrow:"你的工作空间", heading:"让风景，留在专注里。", intro:"真实海洋 · 本地壁纸\n从菜单栏，随时换一片风景。",
    makeYours:"精细调节", controlsTitle:"光线与质感", themesTitle:"选择你的风景", originalArtwork:"动态海洋 / 图片 / 本地视频",
    previewNote:"Codex 布局示意，透明度实时预览；不读取真实对话。", staticPreviewNote:"静态壁纸 · Codex 布局示意，透明度实时预览。", videoPreviewNote:"本地视频循环播放 · Codex 布局示意，透明度实时预览。",
    layoutPreview:"CODEX 布局预览", mockNew:"新建任务", mockSearch:"搜索", mockAutomations:"自动化", mockSkills:"技能", mockProjects:"项目", mockTask:"我的新任务", mockExample:"预览工作区", mockSettings:"设置", mockWelcome:"下一步，想做什么？", mockWorkspace:"open-sea ⌄", mockPrompt:"描述一个任务，从这里开始。", mockModel:"默认模型", mockFootnote:"本地预览 · 示例内容",
    systemVideos:"Mac 动态壁纸", wallpaperHelp:"在系统墙纸设置中下载，回来后自动识别。", openWallpaperSettings:"去系统下载 ↗", refreshWallpapers:"刷新", refreshingWallpapers:"正在查找本机壁纸…", openingWallpaperSettings:"正在打开系统墙纸设置…", wallpaperCount:"已找到 {count} 款本机视频 · 点击即可应用", noSystemVideos:"暂未找到完整下载的视频。请先到系统墙纸设置下载，完成后返回刷新。", wallpaperUnsupported:"Windows 可通过「导入动态视频」选择自己的 MP4、MOV 或 WebM。", videoPrivacy:"Apple 壁纸保存在本机，不随项目上传或分发。"
  });
  Object.assign(words.en, {
    videoBuffering:"Buffering · keeping the current frame",
    eyebrow:"YOUR WORKSPACE", heading:"A better view. Room to focus.", intro:"Live ocean · Local wallpapers\nAlways within reach, in your menu bar.",
    makeYours:"FINE TUNE", controlsTitle:"Light & material", themesTitle:"Choose your scenery", originalArtwork:"Live ocean / Images / Local videos",
    previewNote:"Illustrative Codex layout with live opacity. No real conversations are read.", staticPreviewNote:"Still wallpaper · Illustrative Codex layout with live opacity.", videoPreviewNote:"Looping local video · Illustrative Codex layout with live opacity.",
    layoutPreview:"CODEX LAYOUT PREVIEW", mockNew:"New task", mockSearch:"Search", mockAutomations:"Automations", mockSkills:"Skills", mockProjects:"Projects", mockTask:"My new task", mockExample:"Preview workspace", mockSettings:"Settings", mockWelcome:"What shall we build next?", mockWorkspace:"open-sea ⌄", mockPrompt:"Describe a task to get started.", mockModel:"Default model", mockFootnote:"Local preview · Example content",
    systemVideos:"Mac dynamic wallpapers", wallpaperHelp:"Download in System Settings; return here to discover it.", openWallpaperSettings:"Download in Settings ↗", refreshWallpapers:"Refresh", refreshingWallpapers:"Looking for local wallpapers…", openingWallpaperSettings:"Opening Wallpaper settings…", wallpaperCount:"{count} local videos found · Click to apply", noSystemVideos:"No complete videos found. Download in Wallpaper settings, then return to refresh.", wallpaperUnsupported:"On Windows, use Import a video to choose your own MP4, MOV or WebM.", videoPrivacy:"Apple wallpapers stay on this Mac and are not uploaded or distributed."
  });
  let settings = { ...DEFAULTS };
  let status = { phase: native ? "connecting" : "preview", message: "", key: native ? "connecting" : "previewStatus" };
  let controllerReady = false;
  let clientConnected = false;
  let busyCount = 0;
  let pendingImports = 0;
  let revision = 0;
  const dirty = new Map();
  let media = { videoUrl:null, systemWallpapers:[] };
  let pushGeneration = 0;
  let latestPushedState = null;
  let unsubscribeState = null;
  let unsubscribePreviewVisibility = null;
  let nativePreviewVisible = true;
  let applyTimer = null;
  let queue = Promise.resolve();
  let operationEpoch = 0;
  let polling = false;
  let stopped = false;
  let currentError = null;
  let dismissedError = null;
  let previewEngine = null;
  let previewState = { state:"initializing" };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const t = (key) => words[settings.locale][key] || words.zh[key] || key;
  const readableNativeMessage = (message) => message
    .replace(/^(?:连接暂不可用，请确认 Codex 仍在运行：|Connection unavailable\. Check that Codex is running: )/, t("connectionErrorPrefix"))
    .replace(/^(?:操作未完成：|Action could not finish: )/, t("errorPrefix"));
  const isImageData = (value) => {
    if (typeof value !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=\r\n]+$/i.test(value)) return false;
    const payload = value.slice(value.indexOf(",") + 1).replace(/[\r\n]/g, "");
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.floor(payload.length * 3 / 4) - padding <= MAX_IMAGE_BYTES;
  };
  const bounded = (value, fallback, minimum = 0, maximum = 100) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(minimum, Math.min(maximum, value))) : fallback;

  function normalizeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    return {
      theme: THEMES.includes(input.theme) ? input.theme : DEFAULTS.theme,
      wave: bounded(input.wave, DEFAULTS.wave), daylight: bounded(input.daylight, DEFAULTS.daylight), opacity: bounded(input.opacity, DEFAULTS.opacity, 15, 90),
      paused: typeof input.paused === "boolean" ? input.paused : DEFAULTS.paused,
      locale: input.locale === "en" ? "en" : "zh",
      imageData: isImageData(input.imageData) ? input.imageData : null,
      videoId: typeof input.videoId === "string" && /^[a-f\d]{32}$/i.test(input.videoId) ? input.videoId : null,
      videoName: typeof input.videoName === "string" ? input.videoName.trim().slice(0, 120) || null : null
    };
  }

  function normalizeMedia(value, videoId) {
    const match = typeof value?.videoUrl === "string" && /^open-sea-media:\/\/([a-f\d]{32})\/([a-f\d]{32})$/i.exec(value.videoUrl);
    const systemWallpapers = Array.isArray(value?.systemWallpapers) ? value.systemWallpapers.filter(item => item && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 && typeof item.name === "string").map(item => ({ id:item.id, name:item.name.slice(0, 120), bytes:Number.isFinite(item.bytes) ? Math.max(0, item.bytes) : 0 })) : [];
    return { videoUrl:match && match[2] === videoId ? value.videoUrl : null, systemWallpapers, platform:typeof value?.platform==="string"?value.platform:"", systemWallpapersSupported:value?.systemWallpapersSupported===true };
  }

  function renderSystemVideos() {
    const list = $("system-wallpapers");
    document.body.dataset.platform=media.platform || "preview";
    const supported=native && media.systemWallpapersSupported;
    $("open-wallpaper-settings").hidden=!supported;
    $("refresh-wallpapers").hidden=!native || media.platform==='win32';
    $("wallpaper-help").textContent=t(media.platform==='win32'?"wallpaperUnsupported":"wallpaperHelp");
    $("system-wallpaper-status").textContent=media.systemWallpapers.length?t("wallpaperCount").replace("{count}",media.systemWallpapers.length):"";
    const signature = JSON.stringify([settings.locale, media.systemWallpapers]);
    if (list.dataset.items === signature) return;
    list.dataset.items = signature;
    list.replaceChildren();
    if (!media.systemWallpapers.length) {
      const empty = document.createElement("p");
      empty.className = "system-video-empty";
      empty.textContent = t(native ? "noSystemVideos" : "systemVideosPreview");
      list.append(empty);
      return;
    }
    for (const item of media.systemWallpapers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "system-video-button";
      button.dataset.systemVideo = item.id;
      button.textContent = item.name;
      if (item.bytes) button.title = `${(item.bytes / 1024 / 1024).toFixed(0)} MiB`;
      button.addEventListener("click", () => importVideo(item.id));
      list.append(button);
    }
  }

  function renderStatus() {
    const statusMessage = status.key ? t(status.key) : readableNativeMessage(status.message);
    const errorMessage = currentError ? readableNativeMessage(currentError.message) : status.phase === "error" ? statusMessage || t("unknownError") : "";
    $("connection").dataset.connected = String(clientConnected);
    $("connection-label").textContent = t(native ? (controllerReady ? "connected" : (status.phase === "connecting" ? "connecting" : "disconnected")) : "previewConnection");
    writeText($("status-message"), currentError && !errorMessage.startsWith(t("errorPrefix")) ? `${t("errorPrefix")}${errorMessage}` : currentError ? errorMessage : statusMessage);
    const detailKey = status.phase === "initializing" && settings.theme === "video" ? "videoInitializingDetail" : STATUS_DETAIL_KEYS[status.phase];
    writeText($("status-detail"), t(!native ? "previewDetail" : (!currentError && detailKey) || "statusDetail"));
    $("status-dot").dataset.phase = currentError ? "error" : status.phase;
    document.querySelector(".footer").dataset.phase = currentError ? "error" : status.phase;
    writeText($("error-message"), errorMessage);
    $("error-box").hidden = !errorMessage || dismissedError === errorMessage;
    for (const id of ["launch-button", "restore-button"]) {
      $(id).disabled = !native || busyCount > 0;
      $(id).title = native ? "" : t("missingNative");
    }
    $("import-button").disabled = busyCount > 0;
    for(const id of ["refresh-wallpapers","open-wallpaper-settings"]) $(id).disabled=busyCount>0 || !native;
    $("import-video-button").disabled = busyCount > 0 || !native || typeof api.importVideo !== "function";
    $("import-video-button").title = native ? "" : t("missingNative");
    document.querySelectorAll("[data-system-video]").forEach(button => { button.disabled = busyCount > 0 || !native || typeof api.importSystemVideo !== "function"; });
    const settingsLocked = pendingImports > 0;
    document.querySelectorAll('input[type="range"], input[name="theme"], [data-locale], #pause-button').forEach((control) => { control.disabled = settingsLocked; });
    for (const id of ["wave", "daylight"]) { $(id).disabled = settingsLocked || settings.theme !== "ocean"; $(id).title = settings.theme === "ocean" ? "" : t("oceanOnly"); }
    $("pause-button").disabled = settingsLocked || !["ocean", "video"].includes(settings.theme);
    $("theme-options").setAttribute("aria-busy", String(settingsLocked));
    $("launch-button").setAttribute("aria-busy", String(busyCount > 0));
  }

  function renderPreviewStatus() {
    const ocean = settings.theme === "ocean";
    const video = settings.theme === "video";
    const dynamic = ocean || video;
    const state = dynamic ? previewState.state : "static";
    const failed = state === "error";
    const retainedVideoFrame = video && previewState.hasFrame && !failed;
    $("scene").dataset.previewState = state;
    writeText($("preview-kind"), t(video ? state === "ready" || retainedVideoFrame ? "videoPreview" : "videoPreviewPending" : ocean ? state === "ready" ? "preview" : "previewPending" : "staticPreview"));
    writeText($("preview-note"), t(video ? "videoPreviewNote" : ocean ? "previewNote" : "staticPreviewNote"));
    const motion = !dynamic ? "motionStatic" : video ? failed ? "videoFailed" : state !== "ready" || (!previewState.playing && !previewState.effectivePaused) ? retainedVideoFrame ? "videoBuffering" : "videoLoading" : previewState.playing ? "videoPlaying" : "videoPaused" : failed ? "previewFailed" : state !== "ready" ? "previewLoading" : previewState.effectivePaused ? "motionOff" : previewState.reducedMotion ? "motionReduced" : "motionOn";
    writeText($("motion-label"), t(motion));
    // Loop boundaries can briefly buffer. Keep the decoded picture visible
    // instead of flashing a full-preview loading veil over every `waiting` event.
    $("preview-feedback").hidden = !dynamic || state === "ready" || retainedVideoFrame;
    writeText($("preview-feedback-title"), t(video ? failed ? "videoFailed" : "videoLoading" : failed ? "previewFailed" : "previewLoading"));
    const detail = failed ? `${t(previewState.missing ? "previewMissing" : video ? "videoFailedDetail" : "previewFailedDetail")}${previewState.error ? `\n${previewState.error}` : ""}` : "";
    writeText($("preview-feedback-detail"), detail);
  }

  function render() {
    document.documentElement.lang = settings.locale === "zh" ? "zh-CN" : "en";
    document.title = settings.locale === "zh" ? "Open Sea · Codex 海洋皮肤" : "Open Sea · a skin for Codex";
    document.querySelectorAll("[data-i18n]").forEach((element) => writeText(element, t(element.dataset.i18n)));
    document.querySelectorAll("[data-locale]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.locale === settings.locale)));
    for (const key of ["wave", "daylight", "opacity"]) {
      $(key).value = String(settings[key]);
      const fill = key === "opacity" ? (settings[key] - 15) / 75 * 100 : settings[key];
      $(key).style.setProperty("--range-fill", `${fill}%`);
      $(`${key}-value`).textContent = `${settings[key]}${key === "opacity" ? "%" : ""}`;
      $(key).setAttribute("aria-valuetext", `${settings[key]}${key === "opacity" ? "%" : " / 100"}`);
    }
    document.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === settings.theme; });
    const scene = $("scene");
    scene.dataset.theme = settings.theme;
    scene.style.setProperty("--preview-opacity", String(settings.opacity / 100));
    scene.setAttribute("aria-label", t("previewAria").replace("{theme}", t(settings.theme)));
    $("scene-image").style.backgroundImage = settings.theme === "custom" && settings.imageData ? `url("${settings.imageData}")` : ["aurora", "dunes", "coast"].includes(settings.theme) ? `url("./presets/${settings.theme}.svg")` : "none";
    $("preview-title").textContent = settings.theme === "video" && settings.videoName ? settings.videoName : t(settings.theme);
    $("preview-description").textContent = t(`${settings.theme}Description`);
    $("scene-index").textContent = ["custom", "video"].includes(settings.theme) ? "YOU" : String(THEMES.indexOf(settings.theme) + 1).padStart(2, "0");
    $("pause-button").setAttribute("aria-pressed", String(settings.paused));
    $("pause-label").textContent = t(settings.paused ? "resumeDynamic" : "pauseDynamic");
    $("pause-icon").textContent = settings.paused ? "▷" : "Ⅱ";
    previewEngine?.update({ ...settings, videoUrl:media.videoUrl });
    renderPreviewStatus();
    $("import-button").dataset.custom = String(settings.theme === "custom");
    $("import-label").textContent = t(settings.imageData ? "replaceImage" : "importImage");
    $("import-thumbnail").style.backgroundImage = settings.imageData ? `url("${settings.imageData}")` : "none";
    $("import-video-button").dataset.custom = String(settings.theme === "video");
    $("import-video-label").textContent = t(settings.videoId ? "replaceVideo" : "importVideo");
    renderSystemVideos();
    renderStatus();
  }

  function setStatus(phase, key, message = "") {
    status = { phase, key, message };
    renderStatus();
  }

  function showError(error, source = "operation") {
    const message = typeof error === "string" ? error : (error && typeof error.message === "string" ? error.message : t("unknownError"));
    const repeatedReadError = source === "read" && currentError?.source === "read" && currentError.message === message;
    currentError = { message, source };
    if (!repeatedReadError) dismissedError = null;
    if (source === "read" && !controllerReady) status = { phase: "unavailable", key: "disconnected", message: "" };
    renderStatus();
  }

  function receiveResult(result, requestRevision, statusOnly = false) {
    if (result && result.canceled === true) return;
    if (!result || !result.settings || !result.status || typeof result.status.phase !== "string") throw new Error(t("invalidResult"));
    controllerReady = true;
    const rendererFailed = result.status.phase === "error" && result.status.failed > 0;
    clientConnected = ["connected", "ready", "fallback", "initializing"].includes(result.status.phase) || rendererFailed;
    // Tray changes and UI edits share one settings store. Server updates may
    // replace clean fields, while every unacknowledged local field stays put.
    const incoming = normalizeSettings(result.settings);
    for (const [key, entry] of dirty) incoming[key] = entry.value;
    const nextMedia = normalizeMedia(result.media, incoming.videoId);
    const changedSettings = Object.keys(DEFAULTS).some(key => incoming[key] !== settings[key]);
    const changedMedia = nextMedia.videoUrl !== media.videoUrl || JSON.stringify(nextMedia) !== JSON.stringify(media);
    settings = incoming;
    media = nextMedia;
    status = {
      phase: result.status.phase,
      message: typeof result.status.message === "string" ? result.status.message : "",
      key: result.status.reason === "missing-video" ? "statusMissingVideo" : rendererFailed ? settings.theme === "video" ? "statusVideoError" : "statusRenderError" : result.status.phase === "initializing" && settings.theme === "video" ? "statusVideoInitializing" : STATUS_KEYS[result.status.phase] || (typeof result.status.message === "string" && result.status.message ? null : result.status.phase === "error" ? "unknownError" : "ready")
    };
    if (!statusOnly || currentError?.source === "read") currentError = null;
    if (!currentError && status.phase !== "error") dismissedError = null;
    if (statusOnly && !changedSettings && !changedMedia) renderStatus(); else render();
  }

  async function pollState() {
    if (!native || stopped || polling || document.hidden || busyCount > 0 || applyTimer !== null) return;
    polling = true;
    const requestEpoch = operationEpoch;
    const requestRevision = revision;
    const requestPush = pushGeneration;
    try {
      const result = await api.getState();
      // A read begun before an edit/operation must not replace its newer status.
      if (!stopped && requestEpoch === operationEpoch && requestRevision === revision && requestPush === pushGeneration && busyCount === 0) receiveResult(result, requestRevision, true);
    } catch (error) {
      if (!stopped && requestEpoch === operationEpoch && requestRevision === revision && requestPush === pushGeneration && busyCount === 0 && currentError?.source !== "operation") showError(error, "read");
    } finally {
      polling = false;
    }
  }

  // Serialize native mutations so a slow apply cannot overwrite a later launch or restore.
  function perform(task, key, requestRevision = revision, acknowledged = null) {
    operationEpoch += 1;
    busyCount += 1;
    const importing = key === "importing" || key === "importingVideo";
    if (importing) pendingImports += 1;
    renderStatus();
    queue = queue.then(async () => {
      const previousStatus = status;
      const requestPush = pushGeneration;
      setStatus("working", key);
      try {
        const result = await task();
        if (result && result.canceled === true) {
          if (requestPush !== pushGeneration) receiveResult(latestPushedState, requestRevision);
          else { status = previousStatus; renderStatus(); }
        } else {
          const latest = requestPush !== pushGeneration ? latestPushedState : result;
          if (!latest?.settings || !latest?.status || typeof latest.status.phase !== "string") throw new Error(t("invalidResult"));
          if (acknowledged) for (const [field, entry] of acknowledged) {
            if (dirty.get(field) === entry) dirty.delete(field);
          }
          receiveResult(latest, requestRevision);
        }
      } catch (error) {
        status = previousStatus;
        showError(error);
      } finally {
        busyCount -= 1;
        if (importing) pendingImports -= 1;
        renderStatus();
      }
    });
    return queue;
  }

  function applyNow() {
    if (applyTimer !== null) window.clearTimeout(applyTimer);
    applyTimer = null;
    if (!native || pendingImports > 0 || !dirty.size) return;
    const acknowledged = new Map(dirty);
    perform(() => {
      const patch = Object.fromEntries([...acknowledged].filter(([key, entry]) => dirty.get(key) === entry).map(([key, entry]) => [key, entry.value]));
      return Object.keys(patch).length ? api.apply(patch) : api.getState();
    }, "applying", revision, acknowledged);
  }

  function changed(patch) {
    // Import changes theme/imageData on the native side. Keep its entire
    // settings transaction exclusive so no stale apply can erase the image.
    if (pendingImports > 0) { render(); return; }
    settings = normalizeSettings({ ...settings, ...patch });
    revision += 1;
    if (native) for (const key of Object.keys(patch)) {
      if (Object.hasOwn(DEFAULTS, key)) dirty.set(key, { value:settings[key], revision });
    }
    render();
    if (native) {
      if (applyTimer !== null) window.clearTimeout(applyTimer);
      applyTimer = window.setTimeout(applyNow, 220);
    }
  }

  for (const key of ["wave", "daylight", "opacity"]) {
    $(key).addEventListener("input", (event) => changed({ [key]: Number(event.target.value) }));
    $(key).addEventListener("change", () => { if (native && applyTimer !== null) applyNow(); });
  }
  document.querySelectorAll('input[name="theme"]').forEach((input) => input.addEventListener("change", () => { if (input.checked) changed({ theme: input.value }); }));
  document.querySelectorAll("[data-locale]").forEach((button) => button.addEventListener("click", () => changed({ locale: button.dataset.locale })));
  $("pause-button").addEventListener("click", () => changed({ paused: !settings.paused }));
  $("dismiss-error").addEventListener("click", () => { dismissedError = $("error-message").textContent; renderStatus(); });
  $("launch-button").addEventListener("click", () => {
    if (!native || busyCount > 0) return;
    if (applyTimer !== null) applyNow();
    perform(() => api.launch(), "launching");
  });
  $("restore-button").addEventListener("click", () => {
    if (!native || busyCount > 0) return;
    if (applyTimer !== null) window.clearTimeout(applyTimer);
    applyTimer = null;
    dirty.clear();
    revision += 1;
    perform(() => api.restore(), "restoring");
  });
  $("import-button").addEventListener("click", () => {
    if (busyCount > 0) return;
    if (native) {
      if (applyTimer !== null) applyNow();
      perform(() => api.importImage(), "importing");
    } else {
      $("preview-file").click();
    }
  });
  function importVideo(systemId = null) {
    if (!native || busyCount > 0) return;
    const method = systemId === null ? api.importVideo : api.importSystemVideo;
    if (typeof method !== "function") return;
    if (applyTimer !== null) applyNow();
    perform(() => systemId === null ? api.importVideo() : api.importSystemVideo(systemId), "importingVideo");
  }
  $("refresh-wallpapers").addEventListener("click",()=>{
    if(native && !busyCount && typeof api.refreshSystemWallpapers==='function')perform(()=>api.refreshSystemWallpapers(),"refreshingWallpapers");
  });
  $("open-wallpaper-settings").addEventListener("click",()=>{
    if(native && !busyCount && typeof api.openWallpaperSettings==='function')perform(()=>api.openWallpaperSettings(),"openingWallpaperSettings");
  });
  $("import-video-button").addEventListener("click", () => importVideo());
  $("preview-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { showError(t("invalidImage")); return; }
    if (file.size > MAX_IMAGE_BYTES) { showError(t("imageTooLarge")); return; }
    try {
      const imageData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(t("imageReadError")));
        reader.readAsDataURL(file);
      });
      if (!isImageData(imageData)) throw new Error(t("invalidImage"));
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = resolve;
        image.onerror = () => reject(new Error(t("imageReadError")));
        image.src = imageData;
      });
      currentError = null;
      dismissedError = null;
      changed({ theme: "custom", imageData });
      setStatus("preview", "previewStatus");
    } catch (error) { showError(error); }
  });
  function startPreview() {
    if (typeof window.openSeaPreview?.create === "function") {
      previewEngine = window.openSeaPreview.create($("ocean-preview"), { ...settings, videoUrl:media.videoUrl }, (next) => { previewState = next; renderPreviewStatus(); });
      previewEngine.setVisible(nativePreviewVisible);
    } else previewState = { state:"error", missing:true };
  }
  startPreview();
  window.addEventListener("pagehide", () => { previewEngine?.dispose(); previewEngine = null; });
  window.addEventListener("pageshow", (event) => { if (event.persisted && !previewEngine) { startPreview(); renderPreviewStatus(); } });
  reducedMotion.addEventListener("change", () => { previewEngine?.dispose(); startPreview(); renderPreviewStatus(); });
  render();
  if (native) {
    if (typeof api.onPreviewVisibilityChanged === "function") unsubscribePreviewVisibility = api.onPreviewVisibilityChanged(visible => {
      if (stopped) return;
      nativePreviewVisible = visible;
      previewEngine?.setVisible(visible);
    });
    if (typeof api.onStateChanged === "function") unsubscribeState = api.onStateChanged(result => {
      if (stopped) return;
      try {
        receiveResult(result, revision, true);
        latestPushedState = result;
        pushGeneration += 1;
      } catch (error) { showError(error, "read"); }
    });
    busyCount += 1;
    renderStatus();
    queue = Promise.resolve().then(async () => {
      const requestPush = pushGeneration;
      const result = await api.getState();
      receiveResult(requestPush === pushGeneration ? result : latestPushedState, 0);
    }).catch((error) => showError(error, "read")).finally(() => { busyCount -= 1; renderStatus(); });
    const pollTimer = window.setInterval(pollState, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) pollState(); });
    window.addEventListener("pagehide", () => {
      stopped = true;
      unsubscribeState?.();
      unsubscribeState = null;
      unsubscribePreviewVisibility?.();
      unsubscribePreviewVisibility = null;
      window.clearInterval(pollTimer);
      if (applyTimer !== null) window.clearTimeout(applyTimer);
    });
  }
})();
