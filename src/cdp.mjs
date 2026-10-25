import http from 'node:http';
import { Script } from 'node:vm';
import { assertPort } from './platform.mjs';

const MAX_HTTP_BYTES = 64 * 1024;
const MAX_TARGETS = 128;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 3 * 1024 * 1024;
const MAX_EXPRESSION_BYTES = 6 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_REQUESTS = 16;
// Synthetic HTTPS reaches Chromium's Fetch request stage before any network
// connection. Electron's native app: protocol bypasses that stage entirely.
const MEDIA_PATTERN = /^https:\/\/127\.0\.0\.1\/open-sea-media\/[a-f0-9]{32}\/\*$/u;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1']);
const ID = /^[A-Za-z0-9._-]{1,200}$/u;

export function validateMediaBridge(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || typeof value.pattern !== 'string' || !MEDIA_PATTERN.test(value.pattern) || typeof value.respond !== 'function') {
    throw new Error('A media bridge requires an exact private loopback media pattern and responder.');
  }
  return Object.freeze({ pattern: value.pattern, respond: value.respond });
}

export function validateMediaRequest(request, pattern) {
  if (typeof pattern !== 'string' || !MEDIA_PATTERN.test(pattern) || !request || typeof request.url !== 'string' || request.url.length > 2048
      || !['GET', 'HEAD'].includes(request.method)) throw new Error('Invalid local media request.');
  let url;
  try { url = new URL(request.url); } catch { throw new Error('Invalid local media request.'); }
  const prefix = pattern.slice(0, -1);
  if (url.href !== request.url || !url.href.startsWith(prefix) || !/^[a-f0-9]{32}$/u.test(url.href.slice(prefix.length))
      || url.username || url.password || url.port || url.search || url.hash
      || /[%\\?#\u0000-\u0020\u007f]/u.test(request.url)) throw new Error('The media request is outside its private loopback path.');
  const headers = {};
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (name.toLowerCase() !== 'range') continue;
    if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value) || headers.Range !== undefined) {
      throw new Error('Invalid local media range.');
    }
    headers.Range = value;
  }
  // The provider receives no credentials, cookies, post data, or page metadata.
  return { url: url.href, method: request.method, headers };
}

export function validateMediaResponse(value) {
  if (!value || !Number.isInteger(value.responseCode) || value.responseCode < 200 || value.responseCode > 599
      || value.responseCode >= 300 && value.responseCode < 400 || !Array.isArray(value.responseHeaders) || value.responseHeaders.length > 32) {
    throw new Error('Invalid local media response.');
  }
  let headerBytes = 0;
  const responseHeaders = value.responseHeaders.map(header => {
    if (!header || typeof header.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u.test(header.name)
        || typeof header.value !== 'string' || header.value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(header.value)
        || ['location', 'set-cookie', 'refresh', 'content-security-policy', 'content-security-policy-report-only'].includes(header.name.toLowerCase())) {
      throw new Error('Invalid local media response headers.');
    }
    headerBytes += Buffer.byteLength(header.name) + Buffer.byteLength(header.value);
    return { name: header.name, value: header.value };
  });
  if (headerBytes > 16 * 1024) throw new Error('Local media response headers exceed their limit.');
  const result = { responseCode: value.responseCode, responseHeaders };
  if (value.body !== undefined) {
    const body = value.body;
    if (typeof body !== 'string' || body.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || body.length % 4 !== 0
        || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body)) throw new Error('The local media chunk is invalid or exceeds 2 MiB.');
    const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
    if (body.length / 4 * 3 - padding > MAX_MEDIA_BYTES) throw new Error('The local media chunk exceeds 2 MiB.');
    result.body = body;
  }
  return result;
}

function boundedTimeout(value, fallback = 8000) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 50 || result > 30000) throw new Error('CDP timeout must be between 50 and 30000 ms.');
  return result;
}

export function validatePageWebSocket(value, port, id) {
  assertPort(port);
  if (typeof value !== 'string' || !ID.test(id || '')) throw new Error('Invalid CDP page identity.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid CDP page WebSocket URL.'); }
  if (url.protocol !== 'ws:' || !LOOPBACK.has(url.hostname) || Number(url.port) !== port
      || url.username || url.password || url.search || url.hash
      || url.pathname !== `/devtools/page/${id}`) {
    throw new Error('The page WebSocket is outside the verified loopback endpoint.');
  }
  return url.href;
}

function isAvatarRoute(value) {
  let route = String(value || '').replace(/^#/u, '');
  for (let i = 0; i < 2; i += 1) {
    if (route === '/avatar-overlay' || route.startsWith('/avatar-overlay/')) return true;
    try { route = decodeURIComponent(route); } catch { break; }
  }
  return false;
}

export function sanitizeTarget(target, port) {
  if (!target || target.type !== 'page' || typeof target.id !== 'string' || !ID.test(target.id)
      || typeof target.url !== 'string' || /[\u0000-\u001f\u007f]/u.test(target.url)) return null;
  let appUrl;
  try { appUrl = new URL(target.url); } catch { return null; }
  if (appUrl.protocol !== 'app:' || appUrl.hostname !== '-' || appUrl.port || appUrl.username || appUrl.password
      || appUrl.pathname !== '/index.html' || isAvatarRoute(appUrl.searchParams.get('initialRoute'))
      || isAvatarRoute(appUrl.hash)) return null;
  try {
    return {
      id: target.id, type: 'page', url: 'app://-/index.html',
      webSocketDebuggerUrl: validatePageWebSocket(target.webSocketDebuggerUrl, port, target.id),
    };
  } catch { return null; }
}

export function selectTargets(value, port) {
  assertPort(port);
  if (!Array.isArray(value) || value.length > MAX_TARGETS) throw new Error('The CDP target list is invalid or exceeds its limit.');
  const selected = value.map((target) => sanitizeTarget(target, port)).filter(Boolean);
  if (new Set(selected.map((target) => target.id)).size !== selected.length) throw new Error('The CDP target list contains ambiguous page identities.');
  return selected;
}

function readTargetList(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => { clearTimeout(timer); callback(value); };
    // The fixed literal IP and node:http avoid environment proxies. Redirects
    // are rejected, and neither page titles nor raw target records escape.
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list', agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        finish(reject, new Error('The local CDP target request failed.'));
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_HTTP_BYTES) {
          finish(reject, new Error('The CDP target response exceeds 64 KiB.'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) => finish(reject, error));
      response.on('end', () => {
        try { finish(resolve, selectTargets(JSON.parse(Buffer.concat(chunks).toString('utf8')), port)); }
        catch { finish(reject, new Error('The local CDP target response is invalid or exceeds its limits.')); }
      });
    });
    timer = setTimeout(() => request.destroy(new Error('The local CDP target request timed out.')), timeoutMs);
    request.on('error', () => finish(reject, new Error('The local CDP target request failed or timed out.')));
  });
}

export function assertSameBrowser(expected, actual) {
  if (!actual || !ID.test(actual.browserId || '') || expected.port !== actual.port || expected.browserId !== actual.browserId) {
    throw new Error('The verified Codex browser identity changed.');
  }
  return actual;
}

// The expression inspects only structural anchors, never text or input values.
const SHELL_PROBE = `() => {
  if (location.protocol !== 'app:' || location.hostname !== '-' || location.pathname !== '/index.html') return false;
  const initialRoute = new URLSearchParams(location.search).get('initialRoute') || '';
  const avatar = (input) => {
    let route = String(input || '').replace(/^#/, '');
    for (let i = 0; i < 2; i += 1) {
      if (route === '/avatar-overlay' || route.startsWith('/avatar-overlay/')) return true;
      try { route = decodeURIComponent(route); } catch { break; }
    }
    return false;
  };
  if (avatar(initialRoute) || avatar(location.hash)) return false;
  const main = document.querySelector('main[data-app-shell-main-surface], main[class*="_MainContentSurface_"], main.main-surface');
  const sidebar = document.querySelector('aside.app-shell-left-panel');
  const branded = document.querySelector('[data-testid="app-shell-header-context-menu-surface"]');
  const composer = document.querySelector('[class*="_ComposerLayoutRoot_"], .composer-surface-chrome, [data-composer-surface-variant]');
  const home = document.querySelector('[role="main"] [data-testid="home-icon"]');
  return Boolean((main && sidebar) || (main && (branded || composer)) || (home && (sidebar || branded)));
}`;

export function buildInstallExpressions(source, settings = {}) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new Error('The renderer source is missing or exceeds 2 MiB.');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Renderer settings must be an object.');
  let json;
  try { json = JSON.stringify(settings); } catch { throw new Error('Renderer settings must be serializable.'); }
  if (Buffer.byteLength(json) > MAX_SETTINGS_BYTES) throw new Error('Renderer settings exceed 3 MiB.');
  const apply = `async () => {
    if (!(${SHELL_PROBE})()) return { applied: false, reason: 'shell-not-ready' };
    ${source}\n
    const api = window.__codexOpenSea;
    if (!api || typeof api.apply !== 'function' || typeof api.dispose !== 'function' || typeof api.status !== 'function') throw new Error('Invalid Open Sea renderer contract');
    await api.apply(${json});
    return { applied: true, status: await api.status() };
  }`;
  const immediate = `(${apply})()`;
  const early = `(() => {
    const key = '__codexOpenSeaBootstrap';
    window[key]?.stop?.();
    let interval = null;
    let timeout = null;
    let running = false;
    const stop = () => {
      clearInterval(interval); clearTimeout(timeout);
      document.removeEventListener('DOMContentLoaded', run);
      if (window[key]?.stop === stop) delete window[key];
    };
    const run = async () => {
      if (running || !(${SHELL_PROBE})()) return;
      running = true; stop();
      try { await (${apply})(); } catch { /* Caller verifies applied state separately. */ }
    };
    window[key] = { stop };
    document.addEventListener('DOMContentLoaded', run, { once: true });
    interval = setInterval(run, 150);
    timeout = setTimeout(stop, 10000);
    void run();
  })()`;
  try { new Script(immediate); new Script(early); } catch { throw new Error('The renderer source is not a valid self-contained script.'); }
  return { immediate, early };
}

export class CDPSession {
  constructor({ target, port, timeoutMs = 8000, WebSocketClass = globalThis.WebSocket, mediaBridge }) {
    this.url = validatePageWebSocket(target.webSocketDebuggerUrl, port, target.id);
    this.targetId = target.id;
    this.timeoutMs = boundedTimeout(timeoutMs);
    if (typeof WebSocketClass !== 'function') throw new Error('This runtime requires the standard WebSocket API (Node.js 22+).');
    this.WebSocketClass = WebSocketClass;
    this.pending = new Map();
    this.scriptIds = new Set();
    this.sequence = 0;
    this.closed = false;
    this.socket = null;
    this.opening = null;
    this.mediaBridge = validateMediaBridge(mediaBridge);
    this.mediaEnabled = false;
    this.mediaEnabling = null;
    this.mediaGeneration = 0;
    this.mediaRequests = new Map();
  }

  async open() {
    if (this.closed) throw new Error('The CDP connection is closed.');
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let timer;
      let finished = false;
      const complete = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.rejectOpening = null;
        if (error) reject(error); else resolve(this);
      };
      this.rejectOpening = (error) => complete(error);
      try { this.socket = new this.WebSocketClass(this.url); }
      catch { complete(new Error('The local CDP WebSocket could not be opened.')); this.closed = true; return; }
      this.socket.addEventListener('open', () => complete());
      this.socket.addEventListener('message', (event) => { void this.handleMessage(event.data); });
      this.socket.addEventListener('error', () => this.fail(new Error('The local CDP WebSocket failed.')));
      this.socket.addEventListener('close', () => this.fail(new Error('The local CDP WebSocket closed.')));
      timer = setTimeout(() => this.fail(new Error('The local CDP WebSocket timed out.')), this.timeoutMs);
    });
    return this.opening;
  }

  fail(error) {
    if (this.closed) return;
    if (this.stopMediaRequests()) this.sendCleanup('Fetch.disable');
    this.closed = true;
    this.rejectOpening?.(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    try { this.socket?.close(); } catch { /* Already closed. */ }
  }

  async handleMessage(data) {
    if (this.closed) return;
    try {
      let text;
      if (typeof data === 'string') {
        if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) throw new Error('large');
        text = data;
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        if (data.byteLength > MAX_MESSAGE_BYTES) throw new Error('large');
        text = Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset || 0, data.byteLength).toString('utf8');
      } else if (data && typeof data.arrayBuffer === 'function') {
        if (!Number.isFinite(data.size) || data.size > MAX_MESSAGE_BYTES) throw new Error('large');
        text = Buffer.from(await data.arrayBuffer()).toString('utf8');
      } else throw new Error('type');
      const message = JSON.parse(text);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('shape');
      if (!Object.hasOwn(message, 'id')) {
        if (message.method === 'Fetch.requestPaused' && this.mediaBridge) void this.handleMediaRequest(message.params);
        return; // All unrelated protocol notifications remain ignored.
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${entry.method} failed (${Number(message.error.code) || 'protocol error'}).`));
      else entry.resolve(message.result ?? {});
    } catch {
      this.fail(new Error('The local CDP WebSocket sent an invalid or oversized response.'));
    }
  }

  async send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/u.test(method)) throw new Error('Invalid CDP method.');
    const timeout = boundedTimeout(timeoutMs);
    await this.open();
    if (this.closed || this.socket.readyState !== 1) throw new Error('The CDP connection is closed.');
    if (this.pending.size >= 128) throw new Error('Too many pending CDP requests.');
    const id = ++this.sequence;
    let body;
    try { body = JSON.stringify({ id, method, params }); } catch { throw new Error('CDP parameters must be serializable.'); }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error('The CDP request exceeds 8 MiB.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method,
        mediaRequestId: method === 'Fetch.fulfillRequest' ? params.requestId : null });
      try { this.socket.send(body); }
      catch { this.fail(new Error('The local CDP request could not be sent.')); }
    });
  }

  // These bounded, acknowledgement-free messages only release our own paused
  // requests during teardown. Closing the socket must not wait on another RPC.
  sendCleanup(method, params = {}) {
    if (this.closed || this.socket?.readyState !== 1) return;
    try { this.socket.send(JSON.stringify({ id: ++this.sequence, method, params })); }
    catch { /* Teardown still closes the transport and releases local state. */ }
  }

  async enableMedia() {
    if (!this.mediaBridge) return;
    if (this.mediaEnabling) return this.mediaEnabling;
    if (this.mediaEnabled) return;
    const generation = this.mediaGeneration;
    this.mediaEnabled = true;
    const enabling = this.send('Fetch.enable', {
      patterns: [{ urlPattern: this.mediaBridge.pattern, requestStage: 'Request' }], handleAuthRequests: false,
    }).then(() => {
      if (this.closed || generation !== this.mediaGeneration) throw new Error('Local media interception was stopped.');
    }).catch(error => {
      if (generation === this.mediaGeneration && this.stopMediaRequests()) this.sendCleanup('Fetch.disable');
      throw error;
    });
    this.mediaEnabling = enabling;
    try { await enabling; }
    finally { if (this.mediaEnabling === enabling) this.mediaEnabling = null; }
  }

  stopMediaRequests() {
    const enabled = this.mediaEnabled || this.mediaEnabling !== null;
    this.mediaEnabled = false;
    this.mediaGeneration++;
    for (const [requestId, request] of this.mediaRequests) {
      clearTimeout(request.timer);
      request.abort.abort();
      request.reject(new Error('Local media request was stopped.'));
      this.sendCleanup('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      this.clearMediaAcknowledgement(requestId);
    }
    this.mediaRequests.clear();
    return enabled;
  }

  clearMediaAcknowledgement(requestId) {
    // A restore also releases pending fulfill acknowledgements without waiting
    // for an unresponsive media request to consume the whole cleanup deadline.
    for (const [id, entry] of this.pending) {
      if (entry.mediaRequestId !== requestId) continue;
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new Error('Local media request was stopped.'));
    }
  }

  async disableMedia(options) {
    if (this.stopMediaRequests() && !this.closed) await this.send('Fetch.disable', {}, options);
  }

  async handleMediaRequest(params) {
    const requestId = params?.requestId;
    if (typeof requestId !== 'string' || !ID.test(requestId)) {
      this.fail(new Error('The local CDP WebSocket sent an invalid media request.'));
      return;
    }
    if (this.closed) return;
    const previous = this.mediaRequests.get(requestId);
    if (previous) {
      previous.abort.abort();
      previous.reject(new Error('Duplicate local media request.'));
      return;
    }
    let request;
    try {
      if (!this.mediaEnabled || !this.mediaBridge || this.mediaRequests.size >= MAX_MEDIA_REQUESTS
          || params.responseStatusCode !== undefined || params.responseErrorReason !== undefined) throw new Error('Media unavailable.');
      request = validateMediaRequest(params.request, this.mediaBridge.pattern);
    } catch {
      this.sendCleanup('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      return;
    }
    const entry = { abort: new AbortController(), generation: this.mediaGeneration };
    const deadline = new Promise((_, reject) => {
      entry.reject = reject;
      entry.timer = setTimeout(() => reject(new Error('Local media request timed out.')), this.timeoutMs);
    });
    this.mediaRequests.set(requestId, entry);
    const current = () => !this.closed && this.mediaEnabled && entry.generation === this.mediaGeneration && this.mediaRequests.get(requestId) === entry;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => {
          if (!current()) throw new Error('Local media request was stopped.');
          return this.mediaBridge.respond({ ...request, signal: entry.abort.signal });
        }), deadline,
      ]);
      if (!current()) return;
      const result = validateMediaResponse(response);
      await Promise.race([this.send('Fetch.fulfillRequest', { requestId, ...result }), deadline]);
    } catch {
      if (current()) this.sendCleanup('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
    } finally {
      clearTimeout(entry.timer);
      entry.abort.abort();
      this.clearMediaAcknowledgement(requestId);
      if (this.mediaRequests.get(requestId) === entry) this.mediaRequests.delete(requestId);
    }
  }

  async evaluate(expression, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof expression !== 'string' || Buffer.byteLength(expression) > MAX_EXPRESSION_BYTES) throw new Error('Renderer expression is invalid or exceeds 6 MiB.');
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: false,
      timeout: boundedTimeout(timeoutMs),
    }, { timeoutMs });
    if (result.exceptionDetails) throw new Error('The renderer expression failed.');
    return result.result?.value;
  }

  async install(source, settings = {}) {
    const { immediate, early } = buildInstallExpressions(source, settings);
    await this.send('Page.enable');
    await this.enableMedia();
    // Replace this session's previous bootstrap, so theme updates do not stack.
    for (const identifier of this.scriptIds) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    this.scriptIds.clear();
    const result = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: early });
    if (typeof result.identifier !== 'string' || !result.identifier || result.identifier.length > 200) throw new Error('CDP did not acknowledge the renderer bootstrap.');
    this.scriptIds.add(result.identifier);
    try { return await this.evaluate(immediate); }
    catch (error) {
      try {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: result.identifier });
        this.scriptIds.delete(result.identifier);
      } catch { /* Preserve the registration for the caller's recovery attempt. */ }
      throw error;
    }
  }

  async uninstall() {
    let cleanupError, result;
    const deadline = Date.now() + this.timeoutMs;
    const options = () => ({ timeoutMs: Math.max(50, deadline - Date.now()) });
    // Retain failed bootstrap registrations for a later recovery attempt. A
    // registration error must never prevent disposal or release of Fetch.
    for (const identifier of this.scriptIds) {
      try {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, options());
        this.scriptIds.delete(identifier);
      } catch (error) { cleanupError ??= error; }
    }
    try {
      // Remove the video src while interception is still active. Disabling
      // Fetch first could let a pending media retry escape to loopback HTTPS.
      result = await this.evaluate(`(async () => {
        window.__codexOpenSeaBootstrap?.stop?.();
        const api = window.__codexOpenSea;
        const disposed = typeof api?.dispose === 'function';
        if (disposed) await api.dispose();
        return { disposed, status: typeof api?.status === 'function' ? await api.status() : null };
      })()`, options());
    } catch (error) { cleanupError ??= error; }
    try { await this.disableMedia(options()); } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
    return result;
  }

  // Closing transport alone does not undo renderer state. Use uninstall first
  // for a live restore, then close; only the launcher owns process lifecycle.
  close() { this.fail(new Error('The CDP connection was closed.')); }
}

export class CodexConnection {
  constructor({ identity, verify, timeoutMs = 8000, mediaBridge }) {
    assertPort(identity?.port);
    if (!ID.test(identity?.browserId || '') || typeof verify !== 'function') throw new Error('A verified browser identity and verifier are required.');
    this.identity = { port: identity.port, browserId: identity.browserId };
    this.verify = verify;
    this.timeoutMs = boundedTimeout(timeoutMs);
    this.sessions = new Set();
    this.closed = false;
    this.mediaBridge = validateMediaBridge(mediaBridge);
  }

  async verifyIdentity() {
    if (this.closed) throw new Error('The Codex connection is closed.');
    let timer;
    try {
      return assertSameBrowser(this.identity, await Promise.race([
        Promise.resolve().then(() => this.verify()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex identity verification timed out.')), this.timeoutMs); }),
      ]));
    } finally { clearTimeout(timer); }
  }

  async targets() {
    await this.verifyIdentity();
    const targets = await readTargetList(this.identity.port, this.timeoutMs);
    await this.verifyIdentity();
    return targets;
  }

  async attach(target) {
    const accepted = sanitizeTarget(target, this.identity.port);
    if (!accepted) throw new Error('Only a verified Codex shell page can be attached.');
    const current = (await this.targets()).find((candidate) => candidate.id === accepted.id && candidate.webSocketDebuggerUrl === accepted.webSocketDebuggerUrl);
    if (!current) throw new Error('The Codex shell target is no longer available.');
    const session = new CDPSession({ target: current, port: this.identity.port, timeoutMs: this.timeoutMs, mediaBridge: this.mediaBridge });
    try { await session.open(); await this.verifyIdentity(); }
    catch (error) { session.close(); throw error; }
    this.sessions.add(session);
    return session;
  }

  close() {
    this.closed = true;
    for (const session of this.sessions) session.close();
    this.sessions.clear();
  }
}
