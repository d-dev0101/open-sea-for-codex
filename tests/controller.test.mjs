import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionController } from '../src/controller.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve=yes; reject=no; });
  return {promise,resolve,reject};
}

function fixture(ids = ['a']) {
  const state = { settings:{theme:'ocean',wave:56,daylight:55,paused:false}, pages:new Map(ids.map(id=>[id,{current:null,bootstrap:null}])),
    launches:[],connections:[],sessions:[],record:null,failVerify:false,failIdentity:false,failUninstall:new Set(),
    hangUninstall:new Set(),failEvaluate:new Set(),attachGate:null,installGate:null,processExists:true };
  class Session {
    constructor(target) { this.id=target.id;this.closed=false;this.installs=0;this.uninstalls=0;state.sessions.push(this); }
    page() { if(this.closed)throw new Error('closed session');return state.pages.get(this.id); }
    async install(_payload,settings) {
      const page=this.page();this.installs++;
      page.bootstrap={...settings};page.owner=this;
      if(page.shellReady===false)return {applied:false,reason:'shell-not-ready'};
      page.current={...settings};
      if(state.installGate){const gate=state.installGate;state.installGate=null;await gate.promise;}
      return {applied:true};
    }
    async evaluate() {
      const page=this.page();
      if(state.failEvaluate.delete(this.id))throw new Error('temporary transport failure');
      return page.current ? {state:'ready',...page.current,...page.rendererStatus} : null;
    }
    async uninstall() {
      const page=this.page();this.uninstalls++;
      if(state.hangUninstall.has(this.id))return new Promise(()=>{});
      if(state.failUninstall.has(this.id))throw new Error('fixture restore failure');
      const disposed=!!page.current;page.current=null;page.bootstrap=null;
      return {disposed};
    }
    close() {
      this.closed=true;
      const page=state.pages.get(this.id);
      if(page?.owner===this)page.bootstrap=null;
    }
  }
  class Connection {
    constructor() { this.closed=false;this.sessions=new Set();state.connections.push(this); }
    async verifyIdentity() { if(this.closed||state.failIdentity)throw new Error('old connection is invalid'); }
    async targets() { if(this.closed)throw new Error('connection closed');return [...state.pages.keys()].map(id=>({id})); }
    async attach(target) {
      const session=new Session(target);this.sessions.add(session);
      if(state.attachGate){const gate=state.attachGate;state.attachGate=null;await gate.promise;}
      return session;
    }
    close() { this.closed=true;for(const session of this.sessions)session.close();this.sessions.clear(); }
  }
  const create = () => new SessionController({
    payload:'fixture payload', getSettings:()=>state.settings, profileDir:'/fixture/profile',
    discoverCodex:async()=>({version:'fixture'}), allocatePort:async()=>19371,
    launchCodex:async options=>{const launch={...options,process:{pid:101,exitCode:null,signalCode:null}};state.launches.push(launch);return launch;},
    verifyEndpoint:async()=>{if(state.failVerify)throw new Error('not listening yet');return {port:19371,browserId:'fixture-browser'};},
    createConnection:()=>new Connection(),
    loadInstance:async()=>state.record, saveInstance:async record=>{state.record={...record};},
    removeInstance:async()=>{state.record=null;}, processExists:()=>state.processExists,
  });
  return {state,create,controller:create()};
}

test('settings changes replace the future-document bootstrap as well as the current page', async () => {
  const {controller,state}=fixture();
  assert.equal((await controller.start()).phase,'ready');
  state.settings={...state.settings,theme:'coast',wave:81};
  await controller.sync();
  const page=state.pages.get('a');
  assert.equal(page.bootstrap.theme,'coast');
  assert.equal(state.sessions[0].installs,2);
  page.current={...page.bootstrap};
  await controller.sync();
  assert.equal(page.current.theme,'coast');
  assert.equal(state.sessions[0].installs,2,'status polling must not keep reinstalling an unchanged theme');
  await controller.shutdown();
});

test('ocean initialization and static fallback remain connected renderer states, never sign-in waiting', async () => {
  const {controller,state}=fixture();
  const page=state.pages.get('a');
  page.rendererStatus={state:'initializing'};
  assert.equal((await controller.start()).phase,'initializing');
  page.rendererStatus={state:'fallback',error:'Static ocean remains visible.',ocean:{state:'error',error:'WebGPU and WebGL failed.'}};
  const report=await controller.sync();
  assert.equal(report.phase,'fallback');
  assert.equal(report.fallback,1);
  assert.equal(report.waiting,0);
  assert.equal(report.failed,0);
  assert.equal(controller.enabled,true);
  assert.equal(state.sessions[0].installs,1,'a static fallback must not trigger repeated ocean initialization');
  state.settings={...state.settings,theme:'custom',imageData:'fixture image'};
  page.rendererStatus={state:'ready'};
  assert.equal((await controller.sync()).phase,'ready');
  assert.equal(page.current.theme,'custom');
  assert.equal(page.current.imageData,'fixture image');
  await controller.shutdown();
});

test('renderer failures and unexpected states are reported without retrying a healthy transport', async () => {
  const {controller,state}=fixture();
  const page=state.pages.get('a');
  page.rendererStatus={state:'error',error:'Graphics initialization failed.'};
  const report=await controller.start();
  assert.equal(report.phase,'error');
  assert.equal(report.failed,1);
  assert.equal(report.waiting,0);
  assert.deepEqual(report.rendererErrors,[{targetId:'a',message:'Graphics initialization failed.'}]);
  page.rendererStatus={state:'unexpected'};
  assert.equal((await controller.sync()).phase,'error');
  assert.equal(state.sessions.length,1);
  assert.equal(state.sessions[0].installs,1);
  await controller.shutdown();
});

test('only a missing app shell or no target reports waiting, and mixed windows retain failures', async () => {
  const {controller,state}=fixture(['a','b']);
  state.pages.get('a').rendererStatus={state:'waiting-shell'};
  state.pages.get('b').rendererStatus={state:'waiting-shell'};
  const waiting=await controller.start();
  assert.equal(waiting.phase,'waiting');
  assert.equal(waiting.waiting,2);
  state.pages.get('a').rendererStatus={state:'ready'};
  state.pages.get('b').rendererStatus={state:'initializing'};
  assert.equal((await controller.sync()).phase,'initializing');
  state.pages.get('b').rendererStatus={state:'fallback'};
  const fallback=await controller.sync();
  assert.equal(fallback.phase,'fallback');
  assert.equal(fallback.ready,1);
  assert.equal(fallback.fallback,1);
  state.pages.get('b').rendererStatus={state:'error'};
  assert.equal((await controller.sync()).phase,'error');
  state.pages.clear();
  const empty=await controller.sync();
  assert.equal(empty.phase,'waiting');
  assert.equal(empty.total,0);
  await controller.shutdown();
});

test('the installer waiting on the welcome page is distinct from a failed graphics renderer', async () => {
  const {controller,state}=fixture();
  const page=state.pages.get('a');
  page.shellReady=false;
  const report=await controller.start();
  assert.equal(report.phase,'waiting');
  assert.equal(report.waiting,1);
  assert.equal(report.failed,0);
  assert.equal(page.current,null,'the welcome page must not receive a renderer');
  page.shellReady=true;
  assert.equal((await controller.sync()).phase,'ready');
  await controller.shutdown();
});

test('closed sessions and a transient evaluate failure reattach to the same verified target', async () => {
  const {controller,state}=fixture();await controller.start();
  state.sessions[0].close();
  assert.equal((await controller.sync()).phase,'ready');
  assert.equal(state.sessions.length,2);
  state.failEvaluate.add('a');
  assert.equal((await controller.sync()).phase,'ready');
  assert.equal(state.sessions.length,3);
  assert.equal(controller.sessions.size,1);
  await controller.shutdown();
});

test('startup verification failure retries the owned process and a stale connection is rebuilt', async () => {
  const {controller,state}=fixture();state.failVerify=true;
  await assert.rejects(controller.start(),/not listening yet/);
  state.failVerify=false;
  assert.equal((await controller.start()).phase,'ready');
  assert.equal(state.launches.length,1);
  state.failIdentity=true;
  assert.equal((await controller.start()).phase,'ready');
  assert.equal(state.connections.length,2);
  state.failIdentity=false;
  await controller.shutdown();
});

test('restore attempts every window, reconnects dead sessions, and reports any remaining failure', async () => {
  const {controller,state}=fixture(['a','b']);await controller.start();
  state.sessions[0].close();state.failUninstall.add('a');
  await assert.rejects(controller.restore(),error=>error.failures?.length===1&&error.failures[0].targetId==='a');
  assert.equal(controller.enabled,false);
  assert.equal(state.pages.get('b').current,null);
  assert.equal(state.pages.get('a').current.theme,'ocean');
  state.failUninstall.clear();
  assert.equal((await controller.restore()).phase,'restored');
  assert.equal(state.pages.get('a').current,null);
  await controller.shutdown();
});

test('restore without a managed instance reports idle instead of claiming a restore', async () => {
  const {controller,state}=fixture();
  assert.equal((await controller.restore()).phase,'idle');
  assert.equal(state.sessions.length,0);
  assert.equal(state.launches.length,0);
  await controller.shutdown();
});

test('clean exit removes the skin and a reopened helper recovers the same verified live process', async () => {
  const {controller,state,create}=fixture();await controller.start();
  await controller.shutdown();
  assert.equal(state.pages.get('a').current,null);
  assert.equal(state.connections[0].closed,true);
  assert.equal(state.launches[0].process.exitCode,null,'shutdown must never terminate Codex');
  const reopened=create();
  assert.equal((await reopened.start()).phase,'ready');
  assert.equal(state.launches.length,1,'recover the original profile instead of spawning a duplicate');
  assert.equal(reopened.launch.recovered,true);
  await reopened.shutdown();
});

test('recovery rejects a changed browser identity and clears a dead process record', async () => {
  const {controller,state,create}=fixture();
  state.record={pid:101,port:19371,profileDir:'/fixture/profile',browserId:'different-browser'};
  await assert.rejects(controller.start(),/identity changed/);
  assert.equal(state.sessions.length,0);
  assert.equal(state.launches.length,0);
  state.processExists=false;
  const recovered=create();await recovered.start();
  assert.equal(state.launches.length,1);
  assert.equal(state.record.browserId,'fixture-browser');
  await recovered.shutdown();
});

test('shutdown reserves time for cleanup even when earlier queued work never settles', async () => {
  const {controller,state}=fixture();await controller.start();
  const started=Date.now();
  await controller.shutdown({pending:new Promise(()=>{}),timeoutMs:90});
  assert.ok(Date.now()-started<500);
  assert.equal(state.pages.get('a').current,null);
  assert.equal(controller.closed,true);
  await assert.rejects(controller.start(),/shutting down/);
});

test('shutdown timeout still restores responsive windows and closes every transport', async () => {
  const {controller,state}=fixture(['a','b']);await controller.start();
  state.hangUninstall.add('a');
  const started=Date.now();
  await assert.rejects(controller.shutdown({timeoutMs:75}),/cleanup timed out/);
  assert.ok(Date.now()-started<500);
  assert.equal(state.pages.get('b').current,null);
  assert.equal(controller.closed,true);
  assert.ok(state.sessions.every(session=>session.closed));
  assert.equal(state.launches[0].process.exitCode,null);
});

test('an attachment completing after shutdown cannot install a skin or leak a session', async () => {
  const {controller,state}=fixture();const gate=deferred();state.attachGate=gate;
  const pending=controller.start();
  const observed=pending.catch(error=>error);
  while(state.sessions.length===0)await new Promise(resolve=>setImmediate(resolve));
  await controller.shutdown({pending:observed,timeoutMs:90});
  gate.resolve();await observed;
  assert.ok(state.sessions.every(session=>session.closed));
  assert.equal(state.sessions[0].installs,0);
  assert.equal(controller.sessions.size,0);
});
