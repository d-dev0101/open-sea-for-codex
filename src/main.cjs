const { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, protocol, shell, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { prepareImage } = require('./images.cjs');
const { createTrayController, keepWindowInTray, revealSettingsWindow } = require('./tray.cjs');

// This protocol serves only imported videos inside this companion. It does not
// bypass CSP and never exposes a filesystem path to either renderer.
protocol.registerSchemesAsPrivileged([{scheme:'open-sea-media',privileges:{standard:true,secure:true,stream:true}}]);

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const { DEFAULTS, normalizeSettings, MAX_IMAGE_BYTES } = await import('./settings.mjs');
  const { discoverCodex, launchCodex, verifyEndpoint } = await import('./platform.mjs');
  const { CodexConnection } = await import('./cdp.mjs');
  const { SessionController } = await import('./controller.mjs');
  const { VideoLibrary } = await import('./videos.mjs');
  const { convertMacWallpaper } = await import('./mac-media.mjs');
  nativeTheme.themeSource = 'dark';
  const dataDir = app.getPath('userData');
  const converterPath=path.join(__dirname,'../dist/native/open-sea-convert-video').replace(`${path.sep}app.asar${path.sep}`,`${path.sep}app.asar.unpacked${path.sep}`);
  const videos = new VideoLibrary({directory:path.join(dataDir,'videos'),prepareSystemVideo:process.platform==='darwin'
    ?(input,options)=>convertMacWallpaper(input,{...options,executable:converterPath,onProgress:progress=>{
      status={phase:'working',message:message(`正在本机准备动态壁纸 ${progress}% · 首次转换需要一点时间，再次使用无需转换。`,`Preparing wallpaper locally ${progress}% · First-time conversion is cached for later use.`)};
      if(!quitting)publishState();
    }}) : undefined});
  await videos.init();
  const mediaAbort = new AbortController();
  let systemWallpapers = await videos.systemWallpapers();
  protocol.handle('open-sea-media',async request=>{
    try {
      const range=request.headers.get('range');
      const response=await videos.respond({url:request.url,method:request.method,
        headers:range===null?{}:{Range:range},signal:request.signal});
      return new Response(request.method==='HEAD'||!response.body?null:Buffer.from(response.body,'base64'),
        {status:response.responseCode,headers:response.responseHeaders.map(({name,value})=>[name,value])});
    } catch { return new Response(null,{status:500}); }
  });
  const settingsPath = path.join(dataDir, 'skin-settings.json');
  const instancePath = path.join(dataDir, 'managed-instance.json');
  let settings = {...DEFAULTS}, status = {phase:'idle',message:''};
  let quitting = false, quitReady = false, activeOperations = 0;
  let win = null, tray = null;
  let work = Promise.resolve(), pollPending = false;
  const serial = fn => { const next = work.then(fn); work = next.catch(() => {}); return next; };
  let payload = await fs.readFile(path.join(__dirname, '../dist/skin.js'), 'utf8');
  try {
    if ((await fs.stat(settingsPath)).size < MAX_IMAGE_BYTES * 1.4) settings=normalizeSettings({...JSON.parse(await fs.readFile(settingsPath,'utf8')),videoUrl:null});
  } catch { /* Missing/invalid preferences never prevent starting the controller. */ }
  const savedVideoURL=videos.rendererUrl(settings.videoId);
  const missingVideo=settings.theme==='video'&&(!savedVideoURL ||
    (await videos.respond({url:savedVideoURL,method:'HEAD'})).responseCode!==200);
  if(missingVideo)settings=normalizeSettings({...settings,theme:'ocean',videoId:null,videoName:null});
  // Preserve object identity between polls so playing videos are not restarted.
  let rendererSettings=normalizeSettings({...settings,videoUrl:videos.rendererUrl(settings.videoId)});
  const uiURL=pathToFileURL(path.join(__dirname,'../ui/index.html')).href;
  const state=()=>({settings,status,media:{platform:process.platform,systemWallpapersSupported:process.platform==='darwin',videoUrl:settings.theme==='video'?videos.previewUrl(settings.videoId):null,systemWallpapers}});
  const message=(zh,en)=>settings.locale==='en'?en:zh;
  status.message=missingVideo
    ?message('上次导入的视频已不可用，已选择海洋。可重新导入视频。','The previously imported video is unavailable. Ocean is selected; you can import the video again.')
    :message('准备好了。点击启动，在 Codex 中应用皮肤。','Ready. Launch Codex to apply your skin.');
  if(missingVideo)status.reason='missing-video';
  const refreshTray=()=>tray?.refresh();
  const publishPreviewVisibility=visible=>{
    if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('open-sea:preview-visibility',typeof visible==='boolean'?visible:win.isVisible()&&!win.isMinimized());
  };
  function publishState() {
    if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('open-sea:state-changed',state());
    refreshTray();
  }
  let wallpaperRefresh = null;
  async function refreshSystemWallpapers() {
    if(!wallpaperRefresh) wallpaperRefresh = videos.systemWallpapers(settings.locale).then(items=>{
      systemWallpapers=items;
      if(!quitting)publishState();
    }).finally(()=>{wallpaperRefresh=null;});
    await wallpaperRefresh;
    return state();
  }
  async function openWallpaperSettings() {
    if(process.platform!=='darwin')throw new Error(message('此入口仅适用于 macOS。Windows 可导入本地视频。','This shortcut is available on macOS. On Windows, import a local video.'));
    // Wallpaper.appex declares this identifier and x-apple.systempreferences support.
    // A constant destination prevents the renderer from opening arbitrary URLs.
    await shell.openExternal('x-apple.systempreferences:com.apple.Wallpaper-Settings.extension');
    return state();
  }
  async function openSettings() {
    if(quitting)return;
    systemWallpapers=await videos.systemWallpapers(settings.locale);
    if(quitting)return;
    if(!win||win.isDestroyed()) {
      const created=new BrowserWindow({width:1120,height:820,minWidth:760,minHeight:640,title:'Open Sea for Codex',backgroundColor:process.platform==='darwin'?'#00000000':'#171c20',...(process.platform==='darwin'?{vibrancy:'under-window',visualEffectState:'active',titleBarStyle:'hiddenInset'}:{}),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      win=created;
      for(const event of ['hide','minimize'])created.on(event,()=>publishPreviewVisibility(false));
      for(const event of ['show','restore'])created.on(event,()=>setImmediate(()=>publishPreviewVisibility()));
      created.on('close',()=>{if(!quitting)publishPreviewVisibility(false);});
      created.webContents.on('did-finish-load',()=>publishPreviewVisibility());
      created.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      created.webContents.on('will-navigate',event=>event.preventDefault());
      created.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
      keepWindowInTray(created,()=>quitting);
      created.on('focus',()=>{if(!quitting)void refreshSystemWallpapers().catch(error=>showFailure(error));});
      created.on('closed',()=>{if(win===created)win=null;});
      await created.loadURL(uiURL);
      if(quitting||created.isDestroyed())return;
    }
    revealSettingsWindow(win);
    publishPreviewVisibility();
    publishState();
  }
  function openSettingsFromMenu() {
    void openSettings().catch(error=>{showFailure(error);publishState();});
  }
  const controller = new SessionController({
    payload, getSettings:()=>rendererSettings, profileDir:path.join(dataDir,'codex-profile'),
    discoverCodex, launchCodex, verifyEndpoint,
    loadInstance:async()=>{
      try { if((await fs.stat(instancePath)).size<=4096)return JSON.parse(await fs.readFile(instancePath,'utf8')); }
      catch { /* A missing or invalid recovery record never authorizes attachment. */ }
      return null;
    },
    saveInstance:async record=>{
      const temporary=instancePath+'.tmp';
      await fs.writeFile(temporary,JSON.stringify(record),{mode:0o600});
      await fs.rename(temporary,instancePath);
    },
    removeInstance:()=>fs.rm(instancePath,{force:true}),
    processExists:pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}},
    createConnection:options=>new CodexConnection({...options,mediaBridge:{pattern:videos.pattern,respond:request=>videos.respond(request)}}),
    allocatePort:()=>new Promise((resolve,reject)=>{
      const server=net.createServer();server.on('error',reject);
      server.listen(0,'127.0.0.1',()=>{const chosen=server.address().port;server.close(()=>resolve(chosen));});
    }),
  });
  function showReport(report) {
    if (!report) return;
    const copy = report.phase === 'restored'
      ? message('已移除皮肤。退出这个 Codex 窗口并正常启动，可关闭本机调试连接。','Skin removed. Quit this Codex instance and start normally to close local debugging.')
      : report.phase === 'idle' ? message('没有已连接的 Codex 实例可恢复。','There is no connected Codex instance to restore.')
      : report.phase === 'ready' ? message('皮肤已在 Codex 中显示。','Your skin is visible in Codex.')
      : report.phase === 'fallback' ? message('海洋动态渲染不可用，已使用静态海洋背景；仍可切换预设或导入图片。','Ocean animation is unavailable; a static ocean background is visible. You can still choose a preset or import an image.')
      : report.phase === 'initializing' ? (settings.theme==='video'
        ?message('已连接 Codex，正在加载本地动态视频。','Connected to Codex. Loading your local video.')
        :message('已连接 Codex，正在初始化海洋图形；静态海洋背景已显示。','Connected to Codex. Ocean graphics are initializing; the static ocean background is visible.'))
      : report.phase === 'error' ? message('Codex 已连接，但皮肤渲染失败。请重新应用设置，或切换预设、导入图片。','Codex is connected, but skin rendering failed. Apply the settings again, choose a preset, or import an image.')
      : message('已连接。请在新打开的 Codex 完成首次登录，等待主界面。','Connected. Complete first sign-in in the new Codex window and wait for the main interface.');
    status={...report,version:report.version ?? controller.launch?.installation.version,message:copy};
    publishState();
  }
  function showFailure(error) {
    status={phase:'error',message:message('操作未完成：','Action could not finish: ')+error.message};
    publishState();
  }
  async function save(next) {
    const temporary=settingsPath+'.tmp';
    const {videoUrl:_ephemeralURL,...persistent}=next;
    await fs.writeFile(temporary,JSON.stringify(persistent),{mode:0o600});
    await fs.rename(temporary,settingsPath);
  }
  async function applySettings(patch) {
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('Invalid skin settings.');
    const next=normalizeSettings({...settings,...patch,videoUrl:null});
    if(next.theme==='video'&&!videos.rendererUrl(next.videoId))throw new Error(message('请先导入本地动态视频。','Import a local video first.'));
    await save(next);
    const localeChanged=settings.locale!==next.locale;
    settings=next;
    if(localeChanged)systemWallpapers=await videos.systemWallpapers(settings.locale);
    rendererSettings=normalizeSettings({...next,videoUrl:videos.rendererUrl(next.videoId)});
    if(status.reason==='missing-video')status={phase:'idle',message:message('准备好了。点击启动，在 Codex 中应用皮肤。','Ready. Launch Codex to apply your skin.')};
    if(controller.enabled)showReport(await controller.sync());
    return state();
  }
  async function enqueueAction(fn,{revealFailure=false}={}) {
    if(quitting)throw new Error('Open Sea is shutting down.');
    activeOperations++;refreshTray();
    try {
      return await serial(async()=>{
        if(quitting)throw new Error('Open Sea is shutting down.');
        try{return await fn();}
        catch(error){
          if(!quitting){showFailure(error);if(revealFailure)openSettingsFromMenu();}
          throw error;
        }
      });
    } finally {activeOperations--;publishState();}
  }
  const launch=async()=>{showReport(await controller.start());return state();};
  const restore=async()=>{showReport(await controller.restore());return state();};
  async function importVideo() {
    await openSettings();
    const result=await dialog.showOpenDialog(win,{title:message('选择本机动态视频','Choose a local video'),properties:['openFile'],
      filters:[{name:'Videos',extensions:['mp4','m4v','mov','webm']}]});
    if(result.canceled)return {canceled:true};
    const imported=await videos.importFile(result.filePaths[0],{signal:mediaAbort.signal});
    return applySettings({theme:'video',paused:false,...imported});
  }
  async function importSystemVideo(id) {
    const previousStatus=status;
    status={phase:'working',message:message('正在准备本机动态壁纸…','Preparing the local wallpaper…')};publishState();
    const imported=await videos.importSystemVideo(id,{signal:mediaAbort.signal,locale:settings.locale});
    status=previousStatus;
    return applySettings({theme:'video',paused:false,...imported});
  }
  const runTrayAction=fn=>{void enqueueAction(fn,{revealFailure:true}).catch(()=>{});};
  tray=createTrayController({Tray,Menu,nativeImage,
    getState:()=>({...state(),busy:activeOperations>0,quitting}),
    actions:{
      openSettings:openSettingsFromMenu,
      selectTheme:theme=>runTrayAction(()=>applySettings({theme})),
      togglePause:()=>runTrayAction(()=>applySettings({paused:!settings.paused})),
      importVideo:()=>runTrayAction(importVideo),
      importSystemVideo:id=>runTrayAction(()=>importSystemVideo(id)),
      launch:()=>runTrayAction(launch),
      restore:()=>runTrayAction(restore),
      quit:()=>app.quit(),
    },
  });
  async function sync() {
    if(!controller.enabled||quitting)return;
    try { showReport(await controller.sync()); }
    catch(error) { if(!quitting) showFailure(error); }
  }
  const timer=setInterval(()=>{
    if(pollPending||!controller.enabled||quitting)return;
    pollPending=true;
    void serial(sync).finally(()=>{pollPending=false;});
  },5000);
  function register(name,fn){ipcMain.handle('open-sea:'+name,async(event,...args)=>{
    if(!win||win.isDestroyed()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==uiURL)throw new Error('Untrusted UI request.');
    if(name==='state')return fn(...args);
    return enqueueAction(()=>fn(...args));
  });}
  register('state',()=>state());
  register('apply',applySettings);
  register('launch',launch);
  register('restore',restore);
  register('import-video',importVideo);
  register('import-system-video',importSystemVideo);
  register('refresh-wallpapers',refreshSystemWallpapers);
  register('open-wallpaper-settings',openWallpaperSettings);
  register('import',async()=>{
    await openSettings();
    const result=await dialog.showOpenDialog(win,{title:message('选择你的壁纸','Choose your wallpaper'),properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp']}]});
    if(result.canceled)return {canceled:true};
    const file=await fs.open(result.filePaths[0],'r');let buffer;
    try{if((await file.stat()).size>MAX_IMAGE_BYTES)throw new Error(message('图片不能超过10 MB。','Image must be under 10 MB.'));buffer=await file.readFile();}finally{await file.close();}
    const imageData=prepareImage(buffer,nativeImage);
    return applySettings({theme:'custom',imageData});
  });
  app.on('second-instance',openSettingsFromMenu);
  app.on('activate',openSettingsFromMenu);
  app.on('before-quit',event=>{
    if(quitReady)return;
    event.preventDefault();
    if(quitting)return;
    quitting=true;clearInterval(timer);mediaAbort.abort();controller.beginShutdown();publishState();
    void controller.shutdown({pending:work,timeoutMs:10000})
      .catch(error=>console.warn('[Open Sea] Exit cleanup could not confirm every window:',error.message))
      .finally(()=>{tray.destroy();protocol.unhandle('open-sea-media');quitReady=true;app.quit();});
  });
  // A hidden or closed settings window must not stop the menu bar controller.
  app.on('window-all-closed',()=>{});
  await openSettings();
}).catch(error=>{dialog.showErrorBox('Open Sea could not start',error.message);app.quit();});
