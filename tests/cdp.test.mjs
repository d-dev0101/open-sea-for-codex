import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  validatePageWebSocket, sanitizeTarget, selectTargets, assertSameBrowser,
  buildInstallExpressions, CDPSession, CodexConnection,
  validateMediaBridge, validateMediaRequest, validateMediaResponse,
} from '../src/cdp.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const port = 19491;
const target = {
  id: 'page-1', type: 'page', url: 'app://-/index.html?initialRoute=%2Fthread%2Fprivate-id',
  title: 'Private conversation', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`,
};

test('target allowlist excludes remote pages, workers, subviews and avatar surfaces', () => {
  const safe = sanitizeTarget(target, port);
  assert.deepEqual(Object.keys(safe).sort(), ['id', 'type', 'url', 'webSocketDebuggerUrl']);
  assert.equal(safe.url, 'app://-/index.html');
  assert.equal(JSON.stringify(safe).includes('Private'), false);
  assert.equal(JSON.stringify(safe).includes('private-id'), false);
  for (const value of [
    { ...target, type: 'worker' }, { ...target, id: '../bad' },
    { ...target, url: 'https://chatgpt.com/' },
    { ...target, url: 'app://other/index.html' },
    { ...target, url: 'app://-/browser.html' },
    { ...target, url: 'app://-/avatar-overlay-composition-surface.html' },
    { ...target, url: 'app://-/index.html?initialRoute=%2Favatar-overlay%2Fpet' },
    { ...target, url: 'app://-/index.html?initialRoute=%252Favatar-overlay' },
    { ...target, url: 'app://-/index.html#/avatar-overlay' },
    { ...target, url: 'app://user@-/index.html' },
  ]) assert.equal(sanitizeTarget(value, port), null);
});

test('page websocket identity rejects credentials, extra URL fields and browser endpoints', () => {
  assert.equal(validatePageWebSocket(target.webSocketDebuggerUrl, port, target.id), target.webSocketDebuggerUrl);
  for (const url of [
    `ws://127.0.0.1:${port}/devtools/page/another`,
    `ws://127.0.0.1:${port}/devtools/browser/page-1`,
    `ws://127.0.0.1:${port + 1}/devtools/page/page-1`,
    `ws://evil.example:${port}/devtools/page/page-1`,
    `ws://user@127.0.0.1:${port}/devtools/page/page-1`,
    `${target.webSocketDebuggerUrl}?x=1`, `${target.webSocketDebuggerUrl}#x`,
    target.webSocketDebuggerUrl.replace('ws:', 'wss:'),
  ]) assert.throws(() => validatePageWebSocket(url, port, target.id));
});

test('target count, duplicate IDs and browser identity changes fail closed', () => {
  assert.equal(selectTargets([target, { ...target, type: 'service_worker' }], port).length, 1);
  assert.throws(() => selectTargets(Array(129).fill(target), port));
  assert.throws(() => selectTargets([target, target], port));
  assert.throws(() => selectTargets({}, port));
  const identity = { port, browserId: 'browser-1' };
  assert.equal(assertSameBrowser(identity, { ...identity }).browserId, 'browser-1');
  assert.throws(() => assertSameBrowser(identity, { port, browserId: 'browser-2' }));
  assert.throws(() => assertSameBrowser(identity, { port: port + 1, browserId: 'browser-1' }));
});

test('installer cannot execute a payload before the correct shell is present', async () => {
  const source = 'window.executed = true; window.__codexOpenSea = { apply(value) { window.settings = value; }, dispose() {}, status() { return { active: true }; } };';
  const settings = { text: '$& </script> " \\ unsafe-looking text' };
  const { immediate } = buildInstallExpressions(source, settings);
  const window = {};
  const context = { window, URLSearchParams, location: { protocol: 'app:', hostname: '-', pathname: '/index.html', search: '' }, document: { querySelector: () => null } };
  const skipped = await runInNewContext(immediate, context);
  assert.equal(skipped.applied, false);
  assert.equal(window.executed, undefined);
  context.document.querySelector = (selector) => selector.startsWith('main[') || selector === 'aside.app-shell-left-panel' ? {} : null;
  const applied = await runInNewContext(immediate, context);
  assert.equal(applied.applied, true);
  assert.equal(window.settings.text, settings.text);
  const otherWindow = {};
  context.window = otherWindow;
  context.location.search = '?initialRoute=/avatar-overlay/pet';
  assert.equal((await runInNewContext(immediate, context)).applied, false);
  assert.equal(otherWindow.executed, undefined);
  assert.throws(() => buildInstallExpressions('this is invalid javascript !!', {}));
  assert.throws(() => buildInstallExpressions(source, { text: 'x'.repeat(3 * 1024 * 1024) }), /3 MiB/u);
  assert.throws(() => buildInstallExpressions('x'.repeat(2 * 1024 * 1024 + 1), {}), /2 MiB/u);
});

class FakeWebSocket extends EventTarget {
  static instances = [];
  constructor() {
    super(); this.readyState = 0; this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } });
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  respond(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

const mediaPattern = `https://127.0.0.1/open-sea-media/${'a'.repeat(32)}/*`;
const mediaUrl = mediaPattern.slice(0, -1) + 'b'.repeat(32);
const mediaResponse = () => ({ responseCode: 206, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }], body: Buffer.from('video fixture').toString('base64') });
const mediaSource = 'window.__codexOpenSea = { apply() {}, dispose() {}, status() { return {}; } };';
class MediaWebSocket extends FakeWebSocket {
  send(value) {
    super.send(value);
    const message = this.sent.at(-1);
    if (this.blocked?.has(message.method)) return;
    let result = {};
    if (message.method === 'Page.addScriptToEvaluateOnNewDocument') result = { identifier: `script-${message.id}` };
    if (message.method === 'Runtime.evaluate') result = { result: { value: message.params.expression.includes('return { disposed,') ? { disposed: true } : { applied: true } } };
    queueMicrotask(() => {
      if (this.rejected?.has(message.method)) this.respond({ id: message.id, error: { code: -32000, message: 'private fixture error' } });
      else this.respond({ id: message.id, result });
    });
  }
  pause(requestId, request = {}) {
    this.respond({ method: 'Fetch.requestPaused', params: { requestId, request: { url: mediaUrl, method: 'GET', headers: {}, ...request }, resourceType: 'Media' } });
  }
}

test('media interception accepts only a private token path and sends only the necessary request fields', () => {
  const respond = async () => mediaResponse();
  assert.equal(validateMediaBridge({ pattern: mediaPattern, respond }).pattern, mediaPattern);
  for (const pattern of ['*', 'app://-/*', 'https://127.0.0.1/open-sea-media/*',
    ...['http://127.0.0.1', 'app://-', 'https://localhost', 'https://127.0.0.2', 'https://[::1]', 'https://127.0.0.1:443', 'https://127.0.0.1:8443', 'https://user@127.0.0.1']
      .map(origin => mediaPattern.replace('https://127.0.0.1', origin)),
    mediaPattern + '*', mediaPattern.replace('/aaaa', '/AAAA')]) {
    assert.throws(() => validateMediaBridge({ pattern, respond }));
    assert.throws(() => new CodexConnection({ identity: { port, browserId: 'fixture' }, verify: async () => {}, mediaBridge: { pattern, respond } }));
  }
  const clean = validateMediaRequest({ url: mediaUrl, method: 'GET', headers: { range: 'bytes=0-999', Cookie: 'private', Authorization: 'private' }, postData: 'private' }, mediaPattern);
  assert.deepEqual(clean, { url: mediaUrl, method: 'GET', headers: { Range: 'bytes=0-999' } });
  for (const url of [
    'app://-/index.html', mediaUrl.replace('a'.repeat(32), 'b'.repeat(32)),
    ...['http://127.0.0.1', 'app://-', 'https://localhost', 'https://127.0.0.2', 'https://[::1]', 'https://127.0.0.1:443', 'https://127.0.0.1:8443', 'https://user@127.0.0.1']
      .map(origin => mediaUrl.replace('https://127.0.0.1', origin)),
    mediaUrl + '?', mediaUrl + '#', mediaUrl + '?key=value', mediaUrl + '#fragment', mediaPattern.slice(0, -1) + 'video.mp4',
    mediaPattern.slice(0, -1) + '../video.mp4', mediaPattern.slice(0, -1) + '%2e%2e/video.mp4', mediaUrl + '\\extra', mediaUrl + '\n',
  ]) assert.throws(() => validateMediaRequest({ url, method: 'GET' }, mediaPattern));
  assert.throws(() => validateMediaRequest({ url: mediaUrl, method: 'POST' }, mediaPattern));
  assert.throws(() => validateMediaRequest({ url: mediaUrl, method: 'GET', headers: { Range: 'bytes=0-1\r\nCookie:bad' } }, mediaPattern));
});

test('media responses are bounded and cannot change CSP, set cookies, or redirect', () => {
  const maximum = Buffer.alloc(2 * 1024 * 1024).toString('base64');
  assert.equal(validateMediaResponse({ ...mediaResponse(), body: maximum }).body, maximum);
  assert.deepEqual(validateMediaResponse({ responseCode: 416, responseHeaders: [{ name: 'Content-Range', value: 'bytes */9000' }] }), { responseCode: 416, responseHeaders: [{ name: 'Content-Range', value: 'bytes */9000' }] });
  for (const value of [
    { ...mediaResponse(), body: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
    { ...mediaResponse(), body: 'not base64' }, { ...mediaResponse(), body: 'AAAA=' },
    { ...mediaResponse(), responseCode: 302 }, { ...mediaResponse(), responseCode: 999 },
    ...['Content-Security-Policy', 'Location', 'Set-Cookie', 'Refresh'].map(name => ({ ...mediaResponse(), responseHeaders: [{ name, value: 'forbidden' }] })),
    { ...mediaResponse(), responseHeaders: [{ name: 'Content-Type', value: 'video/mp4\r\nInjected:bad' }] },
    { ...mediaResponse(), responseHeaders: Array(33).fill({ name: 'X-Fixture', value: 'test' }) },
  ]) assert.throws(() => validateMediaResponse(value));
});

test('install enables only its private media pattern before the skin and restore can re-enable it later', async () => {
  const session = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: { pattern: mediaPattern, respond: async () => mediaResponse() } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  const enabled = socket.sent.find(message => message.method === 'Fetch.enable');
  assert.deepEqual(enabled.params, { patterns: [{ urlPattern: mediaPattern, requestStage: 'Request' }], handleAuthRequests: false });
  assert.ok(socket.sent.findIndex(message => message.method === 'Fetch.enable') < socket.sent.findIndex(message => message.method === 'Runtime.evaluate'));
  await session.install(mediaSource, { theme: 'coast' });
  assert.equal(socket.sent.filter(message => message.method === 'Fetch.enable').length, 1);
  assert.deepEqual(await session.uninstall(), { disposed: true });
  assert.equal(session.mediaEnabled, false);
  assert.equal(socket.sent.filter(message => message.method === 'Fetch.disable').length, 1);
  assert.equal(socket.sent.at(-2).method, 'Runtime.evaluate');
  assert.match(socket.sent.at(-2).params.expression, /await api\.dispose\(\)/);
  assert.equal(socket.sent.at(-1).method, 'Fetch.disable');
  await session.install(mediaSource, {});
  assert.equal(socket.sent.filter(message => message.method === 'Fetch.enable').length, 2);
  session.close();
  assert.equal(socket.sent.filter(message => message.method === 'Fetch.disable').length, 2);
});

test('a valid range is fulfilled at the 2 MiB boundary; foreign requests are aborted without reaching the provider', async () => {
  const requests = [];
  const body = Buffer.alloc(2 * 1024 * 1024, 0x7f).toString('base64');
  const session = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: {
    pattern: mediaPattern, respond: async request => { requests.push(request); return { ...mediaResponse(), body }; },
  } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  socket.pause('range-1', { headers: { Range: 'bytes=0-2097151', Cookie: 'private conversation cookie' } });
  await flush();
  const fulfilled = socket.sent.find(message => message.method === 'Fetch.fulfillRequest');
  assert.equal(fulfilled.params.body, body);
  assert.equal(fulfilled.params.requestId, 'range-1');
  assert.deepEqual(requests[0].headers, { Range: 'bytes=0-2097151' });
  assert.equal(session.mediaRequests.size, 0);
  assert.equal(session.pending.size, 0);
  socket.pause('foreign-1', { url: 'app://-/index.html' });
  socket.pause('foreign-2', { url: mediaUrl.replace('a'.repeat(32), 'b'.repeat(32)) });
  socket.pause('foreign-3', { method: 'POST' });
  socket.respond({ method: 'Network.requestWillBeSent', params: { request: { url: 'https://example.invalid/' } } });
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(socket.sent.filter(message => message.method === 'Fetch.failRequest').map(message => message.params.requestId), ['foreign-1', 'foreign-2', 'foreign-3']);
  assert.equal(socket.sent.some(message => message.method === 'Fetch.continueRequest' || message.method === 'Network.enable'), false);
  session.close();
});

test('provider failures and invalid chunks abort without leaking local paths', async () => {
  let mode = 'throw';
  const session = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: {
    pattern: mediaPattern, respond: async () => {
      if (mode === 'throw') throw new Error('/Users/private-name/private-video.mp4');
      return { ...mediaResponse(), body: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') };
    },
  } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  socket.pause('failure-1');await flush();
  mode = 'large';socket.pause('failure-2');await flush();
  assert.equal(socket.sent.filter(message => message.method === 'Fetch.failRequest').length, 2);
  assert.equal(socket.sent.some(message => message.method === 'Fetch.fulfillRequest'), false);
  assert.doesNotMatch(JSON.stringify(socket.sent), /private-name|private-video/);
  assert.equal(session.mediaRequests.size, 0);
  session.close();
});

test('media requests time out and release their provider signal and pending state', async () => {
  let aborted;
  const stopped = new Promise(resolve => { aborted = resolve; });
  const session = await new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: MediaWebSocket, mediaBridge: {
    pattern: mediaPattern, respond: request => { request.signal.addEventListener('abort', aborted, { once: true }); return new Promise(() => {}); },
  } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  socket.pause('timeout-1');
  await stopped;await flush();
  assert.equal(session.mediaRequests.size, 0);
  assert.equal(session.pending.size, 0);
  assert.equal(socket.sent.find(message => message.method === 'Fetch.failRequest').params.errorReason, 'Aborted');
  session.close();
});

test('close aborts the bounded in-flight media queue and ignores late provider results', async () => {
  let resolve;
  const gate = new Promise(yes => { resolve = yes; });
  const requests = [];
  const session = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: {
    pattern: mediaPattern, respond: request => { requests.push(request); return gate; },
  } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  for (let i = 0; i < 17; i++) socket.pause(`pending-${i}`);
  await flush();
  assert.equal(requests.length, 16);
  assert.equal(session.mediaRequests.size, 16);
  assert.equal(socket.sent.find(message => message.method === 'Fetch.failRequest').params.requestId, 'pending-16');
  session.close();
  assert.equal(requests.every(request => request.signal.aborted), true);
  assert.equal(session.mediaRequests.size, 0);
  assert.equal(session.pending.size, 0);
  assert.equal(socket.sent.at(-1).method, 'Fetch.disable');
  assert.equal(socket.sent.filter(message => message.method === 'Fetch.failRequest').length, 17);
  resolve(mediaResponse());await flush();
  socket.pause('after-close');await flush();
  assert.equal(socket.sent.some(message => message.method === 'Fetch.fulfillRequest'), false);
  assert.equal(requests.length, 16);
});

test('close before a queued provider starts never reads media, including during Fetch enable', async () => {
  let calls = 0;
  const session = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: {
    pattern: mediaPattern, respond: async () => { calls++; return mediaResponse(); },
  } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  socket.pause('immediate-close');session.close();await flush();
  assert.equal(calls, 0);
  const pendingSession = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: { pattern: mediaPattern, respond: async () => mediaResponse() } }).open();
  const pendingSocket = FakeWebSocket.instances.at(-1);
  pendingSocket.blocked = new Set(['Fetch.enable']);
  const installed = assert.rejects(pendingSession.install(mediaSource, {}), /closed|stopped/);
  await flush();pendingSession.close();await installed;
  assert.equal(pendingSession.mediaEnabled, false);
  assert.equal(pendingSession.pending.size, 0);
  assert.equal(pendingSocket.sent.at(-1).method, 'Fetch.disable');
});

test('restore cancels pending fulfill acknowledgements and still disposes if Fetch disable fails', async () => {
  const session = await new CDPSession({ target, port, WebSocketClass: MediaWebSocket, mediaBridge: { pattern: mediaPattern, respond: async () => mediaResponse() } }).open();
  const socket = FakeWebSocket.instances.at(-1);
  await session.install(mediaSource, {});
  socket.blocked = new Set(['Fetch.fulfillRequest']);
  socket.pause('unacknowledged');await flush();
  assert.equal(session.pending.size, 1);
  assert.deepEqual(await session.uninstall(), { disposed: true });
  assert.equal(session.pending.size, 0);
  assert.equal(session.mediaRequests.size, 0);
  await session.install(mediaSource, {});
  socket.rejected = new Set(['Fetch.disable']);
  await assert.rejects(session.uninstall(), /Fetch.disable failed/);
  assert.equal(socket.sent.at(-1).method, 'Fetch.disable');
  assert.equal(socket.sent.at(-2).method, 'Runtime.evaluate');
  assert.match(socket.sent.at(-2).params.expression, /await api\.dispose\(\)/);
  session.close();
});

test('restore still disposes and disables media after bootstrap failure or a bounded renderer timeout', async () => {
  for (const failure of ['Page.removeScriptToEvaluateOnNewDocument', 'Runtime.evaluate']) {
    const session = await new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: MediaWebSocket,
      mediaBridge: { pattern: mediaPattern, respond: async () => mediaResponse() } }).open();
    const socket = FakeWebSocket.instances.at(-1);
    await session.install(mediaSource, {});
    if (failure === 'Runtime.evaluate') socket.blocked = new Set([failure]);
    else socket.rejected = new Set([failure]);
    const before = socket.sent.length;
    const began = Date.now();
    await assert.rejects(session.uninstall(), failure === 'Runtime.evaluate' ? /timed out/ : /removeScriptToEvaluateOnNewDocument failed/);
    assert.ok(Date.now() - began < 1000, 'cleanup must not wait indefinitely on a renderer');
    const cleanup = socket.sent.slice(before);
    assert.ok(cleanup.some(message => message.method === 'Runtime.evaluate' && /await api\.dispose\(\)/.test(message.params.expression)));
    assert.equal(cleanup.at(-1).method, 'Fetch.disable');
    assert.equal(session.mediaEnabled, false);
    assert.equal(session.mediaRequests.size, 0);
    assert.equal(session.pending.size, 0);
    if (failure === 'Page.removeScriptToEvaluateOnNewDocument') assert.equal(session.scriptIds.size, 1);
    session.close();
  }
});

test('RPC routes responses, times out, and rejects all pending calls on close', async () => {
  const session = await new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: FakeWebSocket }).open();
  const socket = FakeWebSocket.instances.at(-1);
  const request = session.send('Page.enable');
  await flush();
  socket.respond({ id: socket.sent.at(-1).id, result: { ready: true } });
  assert.deepEqual(await request, { ready: true });
  await assert.rejects(session.send('Page.getFrameTree'), /timed out/u);
  assert.equal(session.pending.size, 0);
  const first = session.send('Runtime.evaluate', { expression: '1' });
  const second = session.send('Runtime.evaluate', { expression: '2' });
  const results = Promise.allSettled([first, second]);
  await flush();
  session.close();
  assert.equal((await results).every((entry) => entry.status === 'rejected'), true);
  assert.equal(session.pending.size, 0);
});

test('invalid WebSocket messages terminate the session and redact protocol errors', async () => {
  const session = await new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: FakeWebSocket }).open();
  const socket = FakeWebSocket.instances.at(-1);
  const failed = session.send('Page.enable');
  await flush();
  socket.respond({ id: socket.sent.at(-1).id, error: { code: -32000, message: 'Private page content' } });
  await assert.rejects(failed, (error) => error.message.includes('-32000') && !error.message.includes('Private'));
  const pending = session.send('Page.enable');
  const rejection = assert.rejects(pending, /invalid or oversized/u);
  await flush();
  socket.dispatchEvent(new MessageEvent('message', { data: '{bad json' }));
  await rejection;
  assert.equal(session.closed, true);
  assert.equal(session.pending.size, 0);
});

test('oversized WebSocket messages release pending requests', async () => {
  const session = await new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: FakeWebSocket }).open();
  const pending = session.send('Page.enable');
  const rejection = assert.rejects(pending, /invalid or oversized/u);
  await flush();
  FakeWebSocket.instances.at(-1).dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(10 * 1024 * 1024 + 1) }));
  await rejection;
  assert.equal(session.closed, true);
  assert.equal(session.pending.size, 0);
});

test('WebSocket opening timeout and errors reject without leaving an active session', async () => {
  class SilentWebSocket extends EventTarget {
    constructor() { super(); this.readyState = 0; }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const session = new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: SilentWebSocket });
  await assert.rejects(session.open(), /timed out/u);
  assert.equal(session.closed, true);
  assert.equal(session.pending.size, 0);
  class FailingWebSocket extends SilentWebSocket {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
  }
  const failed = new CDPSession({ target, port, timeoutMs: 50, WebSocketClass: FailingWebSocket });
  await assert.rejects(failed.open(), /failed/u);
  assert.equal(failed.closed, true);
});

test('HTTP discovery verifies both sides and rejects redirects and oversized responses', async (t) => {
  let mode = 'valid';
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/json/list');
    if (mode === 'redirect') { response.writeHead(302, { Location: 'http://example.invalid/' }); response.end(); return; }
    if (mode === 'large') { response.end('x'.repeat(65537)); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${target.id}` }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const identity = { port: server.address().port, browserId: 'test-browser' };
  let verified = 0;
  const connection = new CodexConnection({ identity, verify: async () => { verified += 1; return identity; }, timeoutMs: 500 });
  const values = await connection.targets();
  assert.equal(verified, 2);
  assert.equal(values[0].title, undefined);
  assert.equal(values[0].url, 'app://-/index.html');
  mode = 'redirect';
  await assert.rejects(connection.targets(), /failed/u);
  mode = 'large';
  await assert.rejects(connection.targets(), /64 KiB/u);
  connection.close();
});

// Minimal RFC 6455 server for this transport-only fixture: no new dependency,
// no official application, and all input consists of our own generated data.
function websocketTextFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = payload.length;
  else if (payload.length <= 65535) { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

test('a 2 MiB encoded wallpaper crosses real WebSocket install and evaluate intact', async (t) => {
  const sockets = new Set();
  const received = [];
  const page = {
    window: {}, URLSearchParams,
    location: { protocol: 'app:', hostname: '-', pathname: '/index.html', search: '', hash: '' },
    document: { querySelector: (selector) => selector.startsWith('main[') || selector === 'aside.app-shell-left-panel' ? {} : null },
  };
  const server = http.createServer();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    let fragments = [];
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const final = Boolean(buffered[0] & 0x80);
        const opcode = buffered[0] & 0x0f;
        const masked = Boolean(buffered[1] & 0x80);
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        if (length > 8 * 1024 * 1024 || !masked) { socket.destroy(); return; }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        buffered = buffered.subarray(offset + 4 + length);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 0 && opcode !== 1) continue;
        fragments.push(payload);
        if (!final) continue;
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        void (async () => {
          const message = JSON.parse(text);
          received.push({ method: message.method, bytes: Buffer.byteLength(text) });
          let result = {};
          if (message.method === 'Page.addScriptToEvaluateOnNewDocument') result = { identifier: 'fixture-script' };
          if (message.method === 'Runtime.evaluate') result = { result: { type: 'object', value: await runInNewContext(message.params.expression, page) } };
          socket.write(websocketTextFrame({ id: message.id, result }));
        })().catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  const fixturePort = server.address().port;
  const session = await new CDPSession({ target: { ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${fixturePort}/devtools/page/${target.id}` }, port: fixturePort }).open();
  t.after(() => session.close());
  // Raster validation is covered by the importer tests. Here the base64 byte
  // payload checks transport fidelity at the importer's maximum stored size.
  const imageData = `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024, 0x7f).toString('base64')}`;
  const source = 'window.__codexOpenSea = { apply(value) { window.settings = value; }, dispose() {}, status() { return { active: true, imageLength: window.settings.imageData.length }; } };';
  const installed = await session.install(source, { theme: 'custom', imageData });
  assert.equal(installed.applied, true);
  assert.equal(installed.status.imageLength, imageData.length);
  assert.equal(page.window.settings.imageData, imageData);
  assert.equal(received.filter((entry) => ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate'].includes(entry.method)).every((entry) => entry.bytes > 65536), true);
  assert.equal(await session.evaluate('window.settings.imageData.length'), imageData.length);
  await assert.rejects(session.install(source, { imageData: `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}` }), /3 MiB/u);
  await assert.rejects(session.evaluate(' '.repeat(6 * 1024 * 1024 + 1)), /6 MiB/u);
  await assert.rejects(session.send('Runtime.evaluate', { expression: 'x'.repeat(8 * 1024 * 1024) }), /8 MiB/u);
  assert.equal(session.pending.size, 0);
});
