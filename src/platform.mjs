import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// Identity and lifecycle design informed by Codex Dream Skin, MIT:
// Fei-Away/Codex-Dream-Skin @ 6fc42df48a6a5365011f55cc349e20c038e56d1d.
// This module is an independent implementation; it never edits or stops an app.
const exec = promisify(execFile);
const TEAM_ID = '2DC432GLL2';
const BUNDLE_ID = 'com.openai.codex';
const COMPUTER_USE_BUNDLE_ID = 'com.openai.sky.CUAService';
const COMPUTER_USE_EXECUTABLE = 'SkyComputerUseService';
// Microsoft Store's official product identity, checked 2026-10-24:
// https://displaycatalog.mp.microsoft.com/v7.0/products/9PLM9XGG6VKS?market=US&languages=en-us
// Store signing alone identifies the distributor, not this app's publisher.
const WINDOWS_PACKAGE_NAME = 'OpenAI.Codex';
const WINDOWS_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';
const WINDOWS_PUBLISHER_ID = '2p2nqsd0c76g0';
const WINDOWS_PACKAGE_FAMILY = `${WINDOWS_PACKAGE_NAME}_${WINDOWS_PUBLISHER_ID}`;
const WINDOWS_HELPER = fileURLToPath(new URL('./platform-windows.ps1', import.meta.url))
  .replace(/([/\\])app\.asar([/\\])/u, '$1app.asar.unpacked$2');
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// lsof's `txt` records include mapped resources and libraries, not just the
// executable. Obtain its authoritative path from the kernel's libproc API.
// JXA is supplied by macOS; this needs neither Python nor developer tools.
const MAC_PROCESS_PATH_SCRIPT = `
ObjC.import('Foundation');
ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'unsigned int']]);
function run(argv) {
  const pid = Number(argv[0]);
  if (!Number.isInteger(pid) || pid <= 1 || pid > 2147483647) throw new Error('Invalid process ID');
  const data = $.NSMutableData.dataWithLength(4096);
  const size = $.proc_pidpath(pid, data.mutableBytes, 4096);
  if (size <= 0 || size >= 4096) throw new Error('Process path unavailable');
  data.length = size;
  const executable = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  return JSON.stringify({ pid, executable });
}`;

export function assertPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('The debugging port must be an integer between 1024 and 65535.');
  }
  return port;
}

function cleanPath(value, label) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is not a valid local path.`);
  }
  return value;
}

export function isPathInside(parent, candidate, platform = process.platform) {
  try {
    cleanPath(parent, 'Parent');
    cleanPath(candidate, 'Candidate');
    const api = platform === 'win32' ? path.win32 : path.posix;
    if (!api.isAbsolute(parent) || !api.isAbsolute(candidate)) return false;
    if (platform === 'win32' && (!/^[a-z]:\\/iu.test(parent) || !/^[a-z]:\\/iu.test(candidate))) return false;
    const from = platform === 'win32' ? parent.toLowerCase() : parent;
    const to = platform === 'win32' ? candidate.toLowerCase() : candidate;
    const relative = api.relative(from, to);
    return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
  } catch { return false; }
}

export function validateMacExecutableName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
      || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('The official app declares an invalid executable name.');
  }
  return name;
}

function samePath(left, right, platform = process.platform) {
  return isPathInside(left, right, platform) && isPathInside(right, left, platform);
}

function timeoutLeft(deadline, maximum = 5000) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Official app verification timed out.');
  return Math.max(1, Math.min(maximum, remaining));
}

async function command(file, args, { timeout = 10000, allowEmptyFailure = false } = {}) {
  try {
    return await exec(file, args, {
      timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
  } catch (error) {
    if (allowEmptyFailure && error.code === 1 && !error.stdout?.trim()) return { stdout: '', stderr: '' };
    // Avoid propagating stderr or complete invocation arguments/private paths.
    throw new Error(`${path.basename(file)} could not complete official app verification (${error.killed ? 'timeout' : error.code || 'failed'}).`);
  }
}

async function validateMacBundle(bundlePath, { deep = false, deadline = Date.now() + 20000 } = {}) {
  cleanPath(bundlePath, 'Application');
  if (!path.isAbsolute(bundlePath)) throw new Error('The application path must be absolute.');
  const canonical = await fs.realpath(bundlePath);
  if (!canonical.endsWith('.app')) throw new Error('The application must be an app bundle.');
  const infoPath = path.join(canonical, 'Contents', 'Info.plist');
  const infoRealPath = await fs.realpath(infoPath);
  if (!isPathInside(canonical, infoRealPath, 'darwin')) throw new Error('The application metadata escapes its bundle.');
  const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoRealPath], { timeout: timeoutLeft(deadline) });
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== BUNDLE_ID) throw new Error('The selected application is not the official Codex app.');
  const name = validateMacExecutableName(info.CFBundleExecutable);
  const executable = await fs.realpath(path.join(canonical, 'Contents', 'MacOS', name));
  if (!isPathInside(canonical, executable, 'darwin')) throw new Error('The application executable escapes its bundle.');
  await fs.access(executable, fs.constants.X_OK);
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}" and identifier "${BUNDLE_ID}"`;
  await command('/usr/bin/codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', '--test-requirement', requirement, canonical], { timeout: timeoutLeft(deadline, 15000) });
  return {
    platform: 'darwin', bundlePath: canonical, executable,
    version: String(info.CFBundleShortVersionString || info.CFBundleVersion || 'unknown'),
    identity: { bundleId: BUNDLE_ID, teamId: TEAM_ID, buildVersion: String(info.CFBundleVersion || '') },
  };
}

async function windowsOperation(operation, args = [], deadline = Date.now() + 15000) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await command(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', WINDOWS_HELPER, '-Operation', operation, ...args], { timeout: timeoutLeft(deadline, 15000) });
  try { return JSON.parse(stdout.replace(/^\ufeff/u, '').trim()); }
  catch { throw new Error('Windows returned invalid official app metadata.'); }
}

export function validateWindowsInstallation(value) {
  const identity = value?.identity;
  const validVersion = typeof value?.version === 'string' && /^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){3}$/u.test(value.version)
    && value.version.split('.').every((part) => Number(part) <= 65535);
  if (!value || value.platform !== 'win32' || identity?.name !== WINDOWS_PACKAGE_NAME
      || value.identity?.signatureKind !== 'Store' || value.identity?.isDevelopmentMode !== false
      || identity.status !== 'Ok' || identity.publisher !== WINDOWS_PUBLISHER
      || identity.publisherId !== WINDOWS_PUBLISHER_ID || identity.packageFamilyName !== WINDOWS_PACKAGE_FAMILY
      || !validVersion || !['x64', 'arm64'].includes(identity.architecture)
      || identity.packageFullName !== `${WINDOWS_PACKAGE_NAME}_${value.version}_${identity.architecture}__${WINDOWS_PUBLISHER_ID}`
      || !/^[A-Za-z0-9._-]{1,64}$/u.test(value.identity?.applicationId || '')
      || value.identity.appUserModelId !== `${value.identity.packageFamilyName}!${value.identity.applicationId}`) {
    throw new Error('The installed Codex package identity could not be verified.');
  }
  const expected = path.win32.join(cleanPath(value.bundlePath, 'Package'), 'app', 'ChatGPT.exe');
  if (!isPathInside(value.bundlePath, value.executable, 'win32') || !samePath(value.executable, expected, 'win32')) {
    throw new Error('The Codex executable is outside the verified Store package.');
  }
  return value;
}

function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number(part) || 0);
  const right = String(b).split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

export async function discoverCodex({ bundlePath = process.env.CODEX_APP_BUNDLE } = {}) {
  if (process.platform === 'darwin') {
    if (bundlePath) return validateMacBundle(bundlePath, { deep: true });
    const candidates = new Set([
      '/Applications/ChatGPT.app', '/Applications/Codex.app',
      path.join(os.homedir(), 'Applications', 'ChatGPT.app'),
      path.join(os.homedir(), 'Applications', 'Codex.app'),
    ]);
    try {
      const { stdout } = await command('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "com.openai.codex"'], { timeout: 2500 });
      for (const value of stdout.trim().split('\n').slice(0, 64)) if (value) candidates.add(value);
    } catch { /* Spotlight is optional; verified standard locations remain usable. */ }
    const found = await Promise.allSettled([...candidates].map((candidate) => validateMacBundle(candidate, { deep: true })));
    const installations = found.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    installations.sort((a, b) => compareVersions(b.version, a.version) || compareVersions(b.identity.buildVersion, a.identity.buildVersion));
    if (!installations.length) throw new Error('No valid, officially signed Codex/ChatGPT app (com.openai.codex) was found.');
    return installations[0];
  }
  if (process.platform === 'win32') {
    const installs = await windowsOperation('discover');
    const values = (Array.isArray(installs) ? installs : [installs]).map(validateWindowsInstallation);
    if (bundlePath) {
      const selected = values.find((item) => samePath(item.bundlePath, bundlePath, 'win32'));
      if (!selected) throw new Error('The selected path does not identify a registered official Codex Store package.');
      return selected;
    }
    if (!values.length) throw new Error('The official OpenAI.Codex Store package was not found.');
    return values[0];
  }
  throw new Error('Open Sea currently supports macOS and Windows.');
}

async function revalidateInstallation(installation, deadline = Date.now() + 15000) {
  if (!installation || installation.platform !== process.platform) throw new Error('The installation does not match this platform.');
  let current;
  if (process.platform === 'darwin') current = await validateMacBundle(installation.bundlePath, { deadline });
  else if (process.platform === 'win32') {
    validateWindowsInstallation(installation);
    const discovered = await windowsOperation('discover', [], deadline);
    const values = Array.isArray(discovered) ? discovered : [discovered];
    current = values.map(validateWindowsInstallation).find((item) => item.identity.packageFullName === installation.identity.packageFullName && samePath(item.bundlePath, installation.bundlePath, 'win32'));
  }
  if (!current || !samePath(current.executable, installation.executable)) throw new Error('The official installation changed; rediscover it before continuing.');
  return current;
}

async function isolatedDirectory(value, label, forbidden = [], forbiddenTrees = []) {
  cleanPath(value, label);
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute directory.`);
  const normalized = path.resolve(value);
  const roots = [path.parse(normalized).root, os.homedir(), ...forbidden].map((item) => path.resolve(item));
  if (roots.some((root) => samePath(root, normalized))) throw new Error(`${label} must be a dedicated directory.`);
  // Resolve the closest existing ancestor before creating anything. A caller's
  // symlink must never cause profile creation inside an official application.
  let ancestor = normalized;
  const missing = [];
  while (true) {
    try {
      const existing = await fs.lstat(ancestor);
      if (ancestor === normalized && existing.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const canonical = path.join(await fs.realpath(ancestor), ...missing);
  if (roots.some((root) => samePath(root, canonical)) || forbiddenTrees.some((root) => isPathInside(root, canonical))) {
    throw new Error(`${label} cannot use the official application or its existing data directory.`);
  }
  await fs.mkdir(canonical, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(canonical, await fs.realpath(canonical))) {
    throw new Error(`${label} must be a dedicated directory without path redirection.`);
  }
  return canonical;
}

export async function launchCodex({ installation, profileDir, codexHome, port }) {
  assertPort(port);
  const verified = await revalidateInstallation(installation);
  const officialProfile = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Codex')
    : path.join(process.env.APPDATA || os.homedir(), 'Codex');
  const profile = await isolatedDirectory(profileDir, 'The debug profile', [officialProfile, path.join(os.homedir(), '.codex')], [verified.bundlePath]);
  const home = codexHome === undefined ? undefined : await isolatedDirectory(codexHome, 'CODEX_HOME', [path.join(os.homedir(), '.codex'), profile], [verified.bundlePath]);
  const args = [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
  const env = { ...process.env };
  if (home) env.CODEX_HOME = home;
  const startedAt = Date.now();
  // Direct execution preserves the explicit environment and raw Chromium args.
  // In particular, a Windows package broker may not inherit CODEX_HOME.
  const child = spawn(verified.executable, args, { env, shell: false, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('The official app could not be started. Windows Store permissions may prohibit direct isolated launch.')));
  });
  const effectiveCodexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return { process: child, pid: child.pid, startedAt, installation: verified, profileDir: profile, codexHome: home, effectiveCodexHome, port, args };
}

export function parseLsofListeners(output, port) {
  assertPort(port);
  let pid = null;
  const listeners = [];
  for (const line of String(output).split('\n')) {
    if (/^p\d+$/u.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const value = line.slice(1);
      const match = value.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/u);
      if (!match || Number(match[2]) !== port) throw new Error('An unexpected debugging listener was found.');
      listeners.push({ pid, address: match[1], port });
    }
  }
  return listeners;
}

export function validateLoopbackListeners(listeners, port) {
  assertPort(port);
  if (!Array.isArray(listeners) || !listeners.length) throw new Error('No debugging listener is available.');
  for (const listener of listeners) {
    if (!Number.isInteger(listener.pid) || listener.pid <= 0 || listener.port !== port || !LOOPBACK.has(listener.address)) {
      throw new Error('The debugging port is not exclusively bound to local loopback.');
    }
  }
  return listeners;
}

export function validateProcessTree(listenerPid, processes, installation, expectedPid = null, verifiedHelpers = []) {
  const table = new Map(processes.map((item) => [item.pid, item]));
  const seen = new Set();
  let current = table.get(listenerPid);
  let foundMain = false;
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (seen.has(current.pid)) break;
    seen.add(current.pid);
    // External helpers are admitted only after exact-path and official-signature
    // validation below, and still must reach this launch's owned main process.
    const verifiedHelper = expectedPid && installation.platform === 'darwin'
      && verifiedHelpers.some((helper) => samePath(helper, current.executable, 'darwin'));
    if (!isPathInside(installation.bundlePath, current.executable, installation.platform) && !verifiedHelper) break;
    if (samePath(current.executable, installation.executable, installation.platform)) foundMain = true;
    if (foundMain && (!expectedPid || current.pid === expectedPid)) return true;
    current = table.get(current.parentPid);
  }
  throw new Error('The debugging listener does not belong to the verified official app process tree.');
}

export function validateCdpVersion(value, port) {
  assertPort(port);
  if (!value || typeof value.webSocketDebuggerUrl !== 'string' || typeof value.Browser !== 'string' || !/^(?:Chrome|Chromium|HeadlessChrome)\/[0-9.]+$/u.test(value.Browser)) {
    throw new Error('The debugging endpoint returned an invalid browser identity.');
  }
  let url;
  try { url = new URL(value.webSocketDebuggerUrl); } catch { throw new Error('Invalid CDP browser URL.'); }
  const id = /^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/u.exec(url.pathname)?.[1];
  if (url.protocol !== 'ws:' || !LOOPBACK.has(url.hostname) || Number(url.port) !== port
      || url.username || url.password || url.search || url.hash || !id) {
    throw new Error('The CDP browser URL is outside the verified local endpoint.');
  }
  return { port, browserId: id, browserWebSocketDebuggerUrl: url.href, browser: value.Browser };
}

export function parseMacProcessIdentity(metadata, parentOutput, expectedPid) {
  let record;
  try { record = JSON.parse(metadata); } catch { throw new Error('The kernel process identity is unavailable.'); }
  const parentPid = Number(String(parentOutput).trim());
  if (!Number.isInteger(expectedPid) || expectedPid <= 1 || record?.pid !== expectedPid
      || !Number.isInteger(parentPid) || parentPid <= 0 || parentPid === expectedPid
      || typeof record.executable !== 'string' || !path.posix.isAbsolute(record.executable)
      || /[\u0000-\u001f\u007f]/u.test(record.executable)) {
    throw new Error('The kernel process identity is invalid or changed.');
  }
  return { pid: expectedPid, parentPid, executable: record.executable };
}

async function macProcess(pid, deadline) {
  const [{ stdout: metadata }, { stdout: parent }] = await Promise.all([
    command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_PROCESS_PATH_SCRIPT, String(pid)], { timeout: timeoutLeft(deadline, 1800) }),
    command('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { timeout: timeoutLeft(deadline, 1000) }),
  ]);
  const identity = parseMacProcessIdentity(metadata, parent, pid);
  return { ...identity, executable: await fs.realpath(identity.executable) };
}

export function computerUseHelperPaths(codexHome) {
  cleanPath(codexHome, 'The owned Codex home');
  if (!path.posix.isAbsolute(codexHome)) throw new Error('The owned Codex home must be absolute.');
  const bundlePath = path.posix.join(codexHome, 'computer-use', 'Codex Computer Use.app');
  return { bundlePath, executable: path.posix.join(bundlePath, 'Contents', 'MacOS', COMPUTER_USE_EXECUTABLE) };
}

async function verifyMacComputerUseHelper(executable, owned, expectedPid, deadline) {
  const codexHome = owned?.codexHome || owned?.effectiveCodexHome;
  if (!expectedPid || typeof codexHome !== 'string') return false;
  const canonicalHome = await fs.realpath(codexHome);
  const expected = computerUseHelperPaths(canonicalHome);
  if (!samePath(executable, expected.executable, 'darwin')) return false;
  // Do not allow a redirected bundle or a linked executable to expand this
  // exception to arbitrary signed software elsewhere on the machine.
  if (await fs.realpath(expected.bundlePath) !== expected.bundlePath
      || await fs.realpath(expected.executable) !== expected.executable) return false;
  const infoPath = path.join(expected.bundlePath, 'Contents', 'Info.plist');
  if (await fs.realpath(infoPath) !== infoPath) return false;
  const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], { timeout: timeoutLeft(deadline, 1500) });
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== COMPUTER_USE_BUNDLE_ID || info.CFBundleExecutable !== COMPUTER_USE_EXECUTABLE) return false;
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}" and identifier "${COMPUTER_USE_BUNDLE_ID}"`;
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', requirement, expected.bundlePath], { timeout: timeoutLeft(deadline, 3000) });
  return true;
}

async function listenerSnapshot(port, installation, expectedPid, deadline, owned) {
  let listeners;
  let processes;
  const verifiedHelpers = new Set();
  if (process.platform === 'win32') {
    const snapshot = await windowsOperation('listeners', ['-Port', String(port)], deadline);
    listeners = snapshot.listeners;
    processes = snapshot.processes;
  } else {
    const { stdout } = await command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: timeoutLeft(deadline, 2000), allowEmptyFailure: true });
    listeners = parseLsofListeners(stdout, port);
    validateLoopbackListeners(listeners, port);
    const table = new Map();
    for (const listener of listeners) {
      let pid = listener.pid;
      for (let depth = 0; pid > 1 && depth < 32; depth += 1) {
        if (table.has(pid)) break;
        const item = await macProcess(pid, deadline);
        table.set(pid, item);
        if (samePath(item.executable, installation.executable) && (!expectedPid || pid === expectedPid)) break;
        if (!isPathInside(installation.bundlePath, item.executable)) {
          if (!await verifyMacComputerUseHelper(item.executable, owned, expectedPid, deadline)) break;
          verifiedHelpers.add(item.executable);
        }
        pid = item.parentPid;
      }
    }
    processes = [...table.values()];
    for (const executable of new Set(processes.map((item) => item.executable))) {
      if (!isPathInside(installation.bundlePath, executable)) continue;
      const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;
      await command('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', requirement, executable], { timeout: timeoutLeft(deadline, 3000) });
    }
  }
  validateLoopbackListeners(listeners, port);
  for (const listener of listeners) validateProcessTree(listener.pid, processes, installation, expectedPid, [...verifiedHelpers]);
  return { listeners, processes };
}

function readCdpVersion(port, timeout) {
  return new Promise((resolve, reject) => {
    let timer;
    const succeed = (value) => { clearTimeout(timer); resolve(value); };
    const fail = (error) => { clearTimeout(timer); reject(error); };
    // node:http avoids environment proxies and never follows redirects.
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/version', agent: false }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); fail(new Error('The local debugging endpoint rejected the identity request.')); return; }
      let length = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 65536) { response.destroy(new Error('The CDP identity response is too large.')); return; }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        try { succeed(validateCdpVersion(JSON.parse(Buffer.concat(chunks).toString('utf8')), port)); }
        catch (error) { fail(error); }
      });
    });
    timer = setTimeout(() => request.destroy(new Error('The local debugging identity request timed out.')), timeout);
    request.on('error', fail);
  });
}

export async function verifyEndpoint({ installation, port, process: owned, timeoutMs = 10000 }) {
  assertPort(port);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Endpoint verification requires a timeout between 100 and 30000 ms.');
  const deadline = Date.now() + timeoutMs;
  const verified = await revalidateInstallation(installation, deadline);
  const child = owned?.process || owned;
  const expectedPid = child?.pid ?? null;
  if (owned && (!Number.isInteger(expectedPid) || expectedPid <= 0)) throw new Error('The owned app process is invalid.');
  let lastError;
  while (Date.now() < deadline) {
    if (child && (child.exitCode != null || child.signalCode != null)) throw new Error('The isolated app process exited before verification.');
    try {
      const before = await listenerSnapshot(port, verified, expectedPid, deadline, owned);
      const browser = await readCdpVersion(port, timeoutLeft(deadline, 1500));
      const after = await listenerSnapshot(port, verified, expectedPid, deadline, owned);
      const fingerprint = (snapshot) => JSON.stringify({
        listeners: snapshot.listeners.map((item) => `${item.pid}:${item.address}:${item.port}`).sort(),
        processes: snapshot.processes.map((item) => `${item.pid}:${item.parentPid}:${item.executable}`).sort(),
      });
      if (fingerprint(before) !== fingerprint(after)) throw new Error('The verified debugging listener set changed during verification.');
      const repeated = await readCdpVersion(port, timeoutLeft(deadline, 1500));
      if (repeated.browserId !== browser.browserId) throw new Error('The debugging browser identity changed during verification.');
      return { ...browser, listeners: after.listeners, installation: verified, ownedPid: expectedPid };
    } catch (error) {
      lastError = error;
      // An occupied, untrusted port is never waited into becoming acceptable.
      if (!/No debugging listener|ECONNREFUSED|could not complete|The verified debugging listener set changed/u.test(error.message)) throw error;
    }
    await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`A verified local Codex endpoint was not available before timeout: ${lastError?.message || 'no response'}`);
}
