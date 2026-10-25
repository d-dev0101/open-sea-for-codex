import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS } from '../src/settings.mjs';

const require = createRequire(import.meta.url);
const { buildTrayMenu, trayStatus, createTrayController, keepWindowInTray, revealSettingsWindow } = require('../src/tray.cjs');
const state = (settings = {}, extra = {}) => ({ settings: { ...DEFAULTS, ...settings }, status: { phase: 'ready' }, ...extra });
function actions() {
  const calls = [];
  return { calls, handlers: Object.fromEntries(['openSettings', 'selectTheme', 'importVideo', 'importSystemVideo', 'togglePause', 'launch', 'restore', 'quit'].map(name => [name, (...args) => { calls.push([name, ...args]); }])) };
}
const item = (menu, id) => menu.find(entry => entry.id === id);

test('background and pause commands never launch Codex implicitly', () => {
  const { calls, handlers } = actions();
  const menu = buildTrayMenu(state({ imageData: 'saved-local-image', videoId:'a'.repeat(32) }), handlers);
  const backgrounds = item(menu, 'background').submenu;
  assert.deepEqual(backgrounds.map(entry => entry.id), ['theme-ocean', 'theme-aurora', 'theme-dunes', 'theme-coast', 'theme-custom', 'theme-video']);
  assert.equal(backgrounds.find(entry => entry.checked).id, 'theme-ocean');
  for (const entry of backgrounds) entry.click();
  item(menu, 'paused').click();
  item(menu, 'settings').click();
  item(menu, 'restore').click();
  assert.deepEqual(calls, [
    ['selectTheme', 'ocean'], ['selectTheme', 'aurora'], ['selectTheme', 'dunes'], ['selectTheme', 'coast'], ['selectTheme', 'custom'], ['selectTheme', 'video'],
    ['togglePause'], ['openSettings'], ['restore'],
  ]);
  item(menu, 'launch').click();
  assert.deepEqual(calls.at(-1), ['launch']);
  item(menu, 'quit').click();
  assert.deepEqual(calls.at(-1), ['quit']);
});

test('menus reflect saved backgrounds, animation pause availability, locale, and pending work', () => {
  const { handlers } = actions();
  let menu = buildTrayMenu(state(), handlers);
  assert.equal(item(item(menu, 'background').submenu, 'theme-custom').enabled, false);
  assert.equal(item(item(menu, 'background').submenu, 'theme-video').enabled, false);
  assert.equal(item(menu, 'settings').label, '打开设置…');
  assert.equal(item(menu, 'paused').label, '暂停动态背景');
  assert.equal(item(menu, 'paused').enabled, true);
  menu = buildTrayMenu(state({ locale: 'en', theme: 'coast', paused: true }), handlers);
  assert.equal(item(menu, 'settings').label, 'Open settings…');
  assert.equal(item(menu, 'paused').enabled, false);
  assert.equal(item(menu, 'paused').checked, true);
  assert.equal(item(menu, 'paused').label, 'Pause animated background');
  assert.equal(item(item(menu, 'background').submenu, 'theme-coast').checked, true);
  menu = buildTrayMenu(state({}, { busy: true }), handlers);
  for (const id of ['background', 'import-video', 'paused', 'launch', 'restore']) assert.equal(item(menu, id).enabled, false);
  assert.equal(item(menu, 'settings').enabled, true);
  assert.equal(item(menu, 'quit').enabled, true, 'explicit quit must remain available during an operation');
  menu = buildTrayMenu(state({}, { busy: true, quitting: true }), handlers);
  assert.equal(item(menu, 'quit').enabled, false);
  assert.equal(item(menu, 'settings').enabled, false);
  assert.equal(item(menu, 'status').label, '正在退出…');
});

test('saved video can be selected again and only a video with an ID enables pause', () => {
  const { calls, handlers } = actions();
  let menu = buildTrayMenu(state({ theme:'coast', videoId:'a'.repeat(32), videoName:'My local clip.mov' }), handlers);
  const saved = item(item(menu, 'background').submenu, 'theme-video');
  assert.equal(saved.enabled, true);
  assert.equal(saved.checked, false);
  assert.equal(saved.label, '本地动态视频 · My local clip.mov');
  saved.click();
  assert.deepEqual(calls, [['selectTheme','video']]);
  menu = buildTrayMenu(state({ theme:'video', videoId:'a'.repeat(32), paused:true }), handlers);
  assert.equal(item(item(menu, 'background').submenu, 'theme-video').checked, true);
  assert.equal(item(menu, 'paused').enabled, true);
  assert.equal(item(menu, 'paused').checked, true);
  item(menu, 'paused').click();
  assert.deepEqual(calls.at(-1), ['togglePause']);
  menu = buildTrayMenu(state({ theme:'video', videoId:null }), handlers);
  assert.equal(item(menu, 'paused').enabled, false);
  assert.equal(item(item(menu, 'background').submenu, 'theme-video').enabled, false);
  assert.equal(trayStatus(state({theme:'video'}, {status:{phase:'initializing'}})), '正在加载动态背景');
  assert.equal(trayStatus(state({theme:'video',locale:'en'}, {status:{phase:'initializing'}})), 'Loading animated background');
});

test('video import actions use discovered system IDs without launching Codex and omit an empty submenu', () => {
  const { calls, handlers } = actions();
  const media = { systemWallpapers:[{id:'wallpaper-one',name:'本机墙纸一',bytes:1234},{id:'wallpaper-two',name:'本机墙纸二',bytes:5678}] };
  let menu = buildTrayMenu(state({}, {media}), handlers);
  assert.equal(item(menu, 'import-video').label, '导入动态视频…');
  item(menu, 'import-video').click();
  const system = item(menu, 'system-wallpapers');
  assert.equal(system.label, '本机系统动态墙纸');
  assert.deepEqual(system.submenu.map(entry => entry.label), ['本机墙纸一','本机墙纸二']);
  system.submenu[1].click();
  assert.deepEqual(calls, [['importVideo'],['importSystemVideo','wallpaper-two']]);
  for (const extra of [{busy:true},{quitting:true}]) {
    menu = buildTrayMenu(state({}, {media,...extra}), handlers);
    assert.equal(item(menu, 'import-video').enabled, false);
    assert.equal(item(menu, 'system-wallpapers').enabled, false);
    assert.ok(item(menu, 'system-wallpapers').submenu.every(entry => !entry.enabled));
  }
  assert.equal(item(buildTrayMenu(state(), handlers), 'system-wallpapers'), undefined);
  assert.equal(item(buildTrayMenu(state({}, {media:{systemWallpapers:[]}}), handlers), 'system-wallpapers'), undefined);
});

test('tray text never includes raw error details, page titles, or conversation content', () => {
  const privateDetail = 'private title and a path /Users/someone/secret';
  const input = state({ locale: 'en' }, { status: { phase: 'error', message: privateDetail, rendererErrors: [{ message: privateDetail }] } });
  assert.equal(trayStatus(input), 'Action failed; open settings for details');
  assert.doesNotMatch(JSON.stringify(buildTrayMenu(input, actions().handlers)), /private title|secret/);
});

function trayFixture(platform = 'win32') {
  let current = state();
  let instance;
  const image = { template: false, isEmpty: () => false, setTemplateImage: value => { image.template = value; } };
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.destroyed = false; this.menus = []; this.popups = 0; instance = this; }
    isDestroyed() { return this.destroyed; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menus.push(value); }
    popUpContextMenu() { this.popups++; }
    destroy() { this.destroyed = true; }
  }
  const controller = createTrayController({
    Tray, Menu: { buildFromTemplate: template => template }, nativeImage: { createFromPath: () => image }, platform,
    getState: () => current, actions: actions().handlers,
  });
  return { controller, image, instance, setState: value => { current = value; } };
}

test('Windows left-click opens the current native menu and refreshed state uses current locale', () => {
  const { controller, instance, setState } = trayFixture();
  assert.match(instance.icon, /tray-icon\.ico$/);
  assert.equal(instance.menus.length, 1);
  controller.refresh();
  assert.equal(instance.menus.length, 1, 'unchanged polling must not replace an open native menu');
  setState(state({ locale: 'en', theme: 'aurora' }));
  instance.emit('click');
  assert.equal(instance.popups, 1);
  assert.equal(item(instance.menus.at(-1), 'settings').label, 'Open settings…');
  assert.equal(item(item(instance.menus.at(-1), 'background').submenu, 'theme-aurora').checked, true);
  assert.equal(instance.tooltip, 'Open Sea · Skin applied');
  controller.destroy();
  controller.destroy();
  controller.refresh();
  assert.equal(instance.isDestroyed(), true);
});

test('tray refresh tracks selected video and discovered wallpaper identity without rebuilding unchanged menus', () => {
  const { controller, instance, setState } = trayFixture();
  const withMedia = (videoId, videoName, wallpaperId, name) => state({videoId,videoName}, {
    media:{systemWallpapers:[{id:wallpaperId,name,bytes:100}]},
  });
  setState(withMedia('a'.repeat(32),'First.mov','first','First wallpaper'));
  controller.refresh();
  assert.equal(instance.menus.length,2);
  controller.refresh();
  assert.equal(instance.menus.length,2);
  setState(withMedia('b'.repeat(32),'Second.mov','second','Second wallpaper'));
  controller.refresh();
  const menu=instance.menus.at(-1);
  assert.equal(instance.menus.length,3);
  assert.match(item(item(menu,'background').submenu,'theme-video').label,/Second\.mov$/);
  assert.equal(item(menu,'system-wallpapers').submenu[0].id,'system-wallpaper-second');
  setState(state());
  controller.refresh();
  assert.equal(item(instance.menus.at(-1),'system-wallpapers'),undefined);
  assert.equal(item(item(instance.menus.at(-1),'background').submenu,'theme-video').enabled,false);
  controller.destroy();
});

test('macOS uses the native template icon and its native menu activation', () => {
  const { image, instance } = trayFixture('darwin');
  assert.equal(image.template, true);
  assert.equal(instance.icon, image);
  assert.equal(instance.listenerCount('click'), 0);
});

test('closing settings hides it without quitting; explicit shutdown permits close and activate reveals it', () => {
  const window = new EventEmitter();
  const calls = [];
  let quitting = false;
  Object.assign(window, {
    hide: () => calls.push('hide'), show: () => calls.push('show'), focus: () => calls.push('focus'),
    isMinimized: () => true, restore: () => calls.push('restore'),
  });
  keepWindowInTray(window, () => quitting);
  window.emit('close', { preventDefault: () => calls.push('prevent') });
  assert.deepEqual(calls, ['prevent', 'hide']);
  calls.length = 0;
  revealSettingsWindow(window);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  calls.length = 0;
  quitting = true;
  window.emit('close', { preventDefault: () => calls.push('prevent') });
  assert.deepEqual(calls, [], 'explicit quit must not be intercepted by close-to-hide');
});

test('preload subscriptions expose state only and unsubscribe without exposing Electron objects', async () => {
  let api;
  const ipcRenderer = new EventEmitter();
  const source = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'openSea'); api = value; } } };
  } });
  assert.equal(Object.isFrozen(api), true);
  assert.throws(() => api.onStateChanged(null), /listener must be a function/);
  const received = [];
  const unsubscribe = api.onStateChanged((...args) => received.push(args));
  const snapshot = state({ theme: 'dunes' });
  ipcRenderer.emit('open-sea:state-changed', { sender: 'private ipc handle' }, snapshot);
  assert.deepEqual(received, [[snapshot]]);
  assert.equal(unsubscribe(), undefined);
  assert.equal(unsubscribe(), undefined);
  assert.equal(ipcRenderer.listenerCount('open-sea:state-changed'), 0);
  ipcRenderer.emit('open-sea:state-changed', {}, state());
  assert.equal(received.length, 1);
});
