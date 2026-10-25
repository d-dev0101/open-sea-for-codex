const path = require('node:path');

const labels = {
  zh: {
    settings: '打开设置…', background: '选择背景', ocean: '海洋', aurora: '极光', dunes: '沙丘', coast: '海岸', custom: '已有自定义背景', video: '本地动态视频',
    importVideo: '导入动态视频…', systemWallpapers: '本机系统动态墙纸',
    paused: '暂停动态背景', launch: '启动带皮肤的 Codex', restore: '恢复原界面', quit: '退出 Open Sea',
    idle: '控制器已就绪', ready: '皮肤已应用', waiting: '等待 Codex 主界面', initializing: '正在加载动态背景',
    fallback: '正在使用静态海洋', error: '操作未完成，请打开设置查看', restored: '已恢复原界面', busy: '正在处理…', quitting: '正在退出…',
  },
  en: {
    settings: 'Open settings…', background: 'Choose background', ocean: 'Ocean', aurora: 'Aurora', dunes: 'Dunes', coast: 'Coast', custom: 'Saved custom background', video: 'Local video',
    importVideo: 'Import animated video…', systemWallpapers: 'System animated wallpapers on this Mac',
    paused: 'Pause animated background', launch: 'Launch Codex with skin', restore: 'Restore original', quit: 'Quit Open Sea',
    idle: 'Controller ready', ready: 'Skin applied', waiting: 'Waiting for the Codex main interface', initializing: 'Loading animated background',
    fallback: 'Static ocean background', error: 'Action failed; open settings for details', restored: 'Original interface restored', busy: 'Working…', quitting: 'Quitting…',
  },
};

function trayStatus(state) {
  const words = labels[state.settings.locale === 'en' ? 'en' : 'zh'];
  return words[state.quitting ? 'quitting' : state.busy ? 'busy' : state.status.phase] || words.idle;
}

function buildTrayMenu(state, actions) {
  const { settings, busy = false, quitting = false } = state;
  const words = labels[settings.locale === 'en' ? 'en' : 'zh'];
  const available = !busy && !quitting;
  const systemWallpapers = state.media?.systemWallpapers || [];
  return [
    { id: 'settings', label: words.settings, enabled: !quitting, click: () => actions.openSettings() },
    { id: 'status', label: trayStatus(state), enabled: false },
    { type: 'separator' },
    { id: 'background', label: words.background, enabled: available, submenu: ['ocean', 'aurora', 'dunes', 'coast', 'custom', 'video'].map(theme => ({
      id: `theme-${theme}`, label: words[theme] + (theme === 'video' && settings.videoName ? ` · ${settings.videoName}` : ''), type: 'radio', checked: settings.theme === theme,
      enabled: available && (theme !== 'custom' || !!settings.imageData) && (theme !== 'video' || !!settings.videoId), click: () => actions.selectTheme(theme),
    })) },
    { id: 'import-video', label: words.importVideo, enabled: available, click: () => actions.importVideo() },
    ...(systemWallpapers.length ? [{ id: 'system-wallpapers', label: words.systemWallpapers, enabled: available, submenu: systemWallpapers.map(wallpaper => ({
      id: `system-wallpaper-${wallpaper.id}`, label: wallpaper.name, enabled: available, click: () => actions.importSystemVideo(wallpaper.id),
    })) }] : []),
    { id: 'paused', label: words.paused, type: 'checkbox', checked: settings.paused,
      enabled: available && (settings.theme === 'ocean' || (settings.theme === 'video' && !!settings.videoId)), click: () => actions.togglePause() },
    { type: 'separator' },
    { id: 'launch', label: words.launch, enabled: available, click: () => actions.launch() },
    { id: 'restore', label: words.restore, enabled: available, click: () => actions.restore() },
    { type: 'separator' },
    { id: 'quit', label: words.quit, enabled: !quitting, click: () => actions.quit() },
  ];
}

function createTrayController({ Tray, Menu, nativeImage, platform = process.platform, getState, actions }) {
  let icon;
  if (platform === 'darwin') {
    icon = nativeImage.createFromPath(path.join(__dirname, 'tray-iconTemplate.png'));
    if (icon.isEmpty()) throw new Error('The menu bar icon could not be loaded.');
    icon.setTemplateImage(true);
  } else icon = path.join(__dirname, 'tray-icon.ico');
  const tray = new Tray(icon);
  let previous;
  function refresh() {
    if (tray.isDestroyed()) return;
    const state = getState();
    const fingerprint = JSON.stringify([state.settings.locale, state.settings.theme, state.settings.paused,
      !!state.settings.imageData, state.settings.videoId, state.settings.videoName,
      state.media?.systemWallpapers?.map(({ id, name }) => [id, name]), state.status.phase, !!state.busy, !!state.quitting]);
    if (fingerprint === previous) return;
    previous = fingerprint;
    tray.setToolTip(`Open Sea · ${trayStatus(state)}`);
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, actions)));
  }
  // macOS opens an assigned context menu itself. Windows needs an explicit
  // left-click handler; right-click continues using the native context menu.
  if (platform === 'win32') tray.on('click', () => { refresh(); tray.popUpContextMenu(); });
  refresh();
  return { refresh, destroy: () => { if (!tray.isDestroyed()) tray.destroy(); } };
}

function keepWindowInTray(window, isQuitting) {
  window.on('close', event => {
    if (isQuitting()) return;
    event.preventDefault();
    window.hide();
  });
}

function revealSettingsWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

module.exports = { buildTrayMenu, trayStatus, createTrayController, keepWindowInTray, revealSettingsWindow };
