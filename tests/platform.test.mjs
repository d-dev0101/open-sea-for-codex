import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  assertPort, isPathInside, validateMacExecutableName, validateWindowsInstallation,
  parseLsofListeners, validateLoopbackListeners, validateProcessTree, validateCdpVersion, parseMacProcessIdentity, computerUseHelperPaths,
} from '../src/platform.mjs';

const port = 19491;
const mac = { platform: 'darwin', bundlePath: '/Applications/ChatGPT.app', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' };
const publisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';
const publisherId = '2p2nqsd0c76g0';
const family = `OpenAI.Codex_${publisherId}`;
const win = {
  platform: 'win32', bundlePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1',
  executable: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe', version: '26.1021.3705.0',
  identity: {
    name: 'OpenAI.Codex', signatureKind: 'Store', isDevelopmentMode: false, status: 'Ok',
    publisher, publisherId, architecture: 'x64', packageFullName: `OpenAI.Codex_26.1021.3705.0_x64__${publisherId}`,
    packageFamilyName: family, applicationId: 'App', appUserModelId: `${family}!App`,
  },
};

test('path validation rejects traversal, sibling prefixes, UNC and executable metadata attacks', () => {
  assert.equal(isPathInside('/Applications/ChatGPT.app', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', 'darwin'), true);
  for (const value of ['/Applications/ChatGPT.app-fake/Contents/MacOS/ChatGPT', '/Applications/ChatGPT.app/../evil', 'relative/file', '/Applications/ChatGPT.app/evil\0']) {
    assert.equal(isPathInside(mac.bundlePath, value, 'darwin'), false);
  }
  assert.equal(isPathInside(win.bundlePath, win.executable.toUpperCase(), 'win32'), true);
  assert.equal(isPathInside(win.bundlePath, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\..\\evil.exe', 'win32'), false);
  assert.equal(isPathInside('\\\\server\\app', '\\\\server\\app\\evil.exe', 'win32'), false);
  for (const name of ['../evil', '..', '/tmp/evil', 'foo\\evil', 'foo\nbar', 'foo\0bar']) assert.throws(() => validateMacExecutableName(name));
  assert.equal(validateMacExecutableName('ChatGPT'), 'ChatGPT');
});

test('Windows metadata binds the exact OpenAI publisher, package version and executable', () => {
  assert.equal(validateWindowsInstallation(win), win);
  const arm = { ...win, identity: { ...win.identity, architecture: 'arm64', packageFullName: `OpenAI.Codex_${win.version}_arm64__${publisherId}` } };
  assert.equal(validateWindowsInstallation(arm), arm);
  for (const value of [
    { ...win, executable: 'C:\\temp\\ChatGPT.exe' },
    { ...win, executable: `${win.executable}:stream` },
    { ...win, identity: { ...win.identity, signatureKind: 'Developer' } },
    { ...win, identity: { ...win.identity, isDevelopmentMode: true } },
    { ...win, identity: { ...win.identity, status: 'Modified' } },
    { ...win, identity: { ...win.identity, publisher: undefined } },
    { ...win, identity: { ...win.identity, publisher: 'CN=Unrelated Store Publisher' } },
    { ...win, identity: { ...win.identity, publisher: publisher.toLowerCase() } },
    { ...win, identity: { ...win.identity, publisher: `${publisher}, O=Other` } },
    { ...win, identity: { ...win.identity, publisherId: '88846570' } },
    { ...win, identity: { ...win.identity, packageFamilyName: `${family}.fake` } },
    { ...win, identity: { ...win.identity, packageFullName: `OpenAI.Codex_26.1021.3704.0_x64__${publisherId}` } },
    { ...win, identity: { ...win.identity, packageFullName: 'Other.Codex_26.1021.3705.0_x64__evil' } },
    { ...win, identity: { ...win.identity, architecture: 'x86' } },
    { ...win, version: '26.1021.3705' },
    { ...win, version: '26.1021.65536.0', identity: { ...win.identity, packageFullName: `OpenAI.Codex_26.1021.65536.0_x64__${publisherId}` } },
    { ...win, identity: { ...win.identity, appUserModelId: 'App; Start-Process evil' } },
    { ...win, identity: { ...win.identity, packageFamilyName: 'Other.App_pub' } },
    { ...win, identity: { ...win.identity, applicationId: 'AnotherApp' } },
    { ...win, identity: { ...win.identity, name: 'Another.Codex' } },
  ]) assert.throws(() => validateWindowsInstallation(value));
  // An unrelated Store publisher may use a plausible name and matching AUMID.
  // Those internally consistent strings do not establish OpenAI ownership.
  assert.throws(() => validateWindowsInstallation({
    ...win, identity: {
      ...win.identity, publisher: 'CN=Unrelated Store Publisher', publisherId: 'unrelated1234',
      packageFamilyName: 'OpenAI.Codex_unrelated1234', packageFullName: `OpenAI.Codex_${win.version}_x64__unrelated1234`,
      appUserModelId: 'OpenAI.Codex_unrelated1234!App',
    },
  }));
});

test('Windows discovery rejects impostor registrations and mismatched manifest identities', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell; no native Windows validation is inferred on other hosts.' : false,
}, async (t) => {
  // Exercise the real helper with fixture AppX cmdlets and temporary files.
  // This never queries, launches or changes any installed application.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-package-trust-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixtures = [];
  const manifest = {
    Name: 'OpenAI.Codex', Publisher: publisher, Version: win.version, ProcessorArchitecture: 'x64', ResourceId: '',
  };
  const registration = {
    Name: 'OpenAI.Codex', SignatureKind: 'Store', IsDevelopmentMode: false, Status: 'Ok',
    Publisher: publisher, PublisherId: publisherId, PackageFamilyName: family, ResourceId: '',
    Version: win.version, Architecture: 'X64', PackageFullName: win.identity.packageFullName,
  };
  async function fixture(label, packageChanges = {}, manifestChanges = {}) {
    const install = path.join(root, label);
    await fs.mkdir(path.join(install, 'app'), { recursive: true });
    await fs.writeFile(path.join(install, 'app', 'ChatGPT.exe'), 'fixture, not executable');
    fixtures.push({ ...registration, ...packageChanges, InstallLocation: install, ManifestIdentity: { ...manifest, ...manifestChanges } });
  }
  await fixture('valid-x64');
  await fixture('valid-arm64', { Architecture: 'Arm64', PackageFullName: `OpenAI.Codex_${win.version}_arm64__${publisherId}` }, { ProcessorArchitecture: 'arm64' });
  await fixture('unrelated-store-publisher', {
    Publisher: 'CN=Other', PublisherId: 'unrelated1234', PackageFamilyName: 'OpenAI.Codex_unrelated1234',
    PackageFullName: `OpenAI.Codex_${win.version}_x64__unrelated1234`,
  }, { Publisher: 'CN=Other' });
  await fixture('forged-family', { Publisher: 'CN=Other' });
  await fixture('modified', { Status: 'Modified' });
  await fixture('developer', { SignatureKind: 'Developer', IsDevelopmentMode: true });
  await fixture('wrong-full-name', { PackageFullName: `OpenAI.Codex_26.1021.3704.0_x64__${publisherId}` });
  await fixture('manifest-publisher', {}, { Publisher: 'CN=Other' });
  await fixture('manifest-name', {}, { Name: 'Other.Codex' });
  await fixture('manifest-version', {}, { Version: '26.1021.3704.0' });
  await fixture('manifest-architecture', {}, { ProcessorArchitecture: 'arm64' });
  await fixture('manifest-resource', {}, { ResourceId: 'other' });
  const fixturePath = path.join(root, 'fixtures.json');
  const scriptPath = path.join(root, 'discovery-test.ps1');
  const helper = fileURLToPath(new URL('../src/platform-windows.ps1', import.meta.url));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  await fs.writeFile(fixturePath, JSON.stringify(fixtures));
  await fs.writeFile(scriptPath, `
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 emits a top-level JSON array as one pipeline object.
# Capturing that pipeline directly in @() would create a nested fixture array.
$parsedFixtures = Get-Content -LiteralPath ${quote(fixturePath)} -Raw | ConvertFrom-Json
$script:fixtures = @($parsedFixtures)
if ($script:fixtures.Count -ne ${fixtures.length} -or
    @($script:fixtures | Where-Object { $_ -is [array] -or $_.Name -isnot [string] }).Count -ne 0) {
  throw 'The AppX fixtures must be a flat array of package records.'
}
function Get-AppxPackage { param([string]$Name) return $script:fixtures }
function Get-AppxPackageManifest {
  param($Package)
  $attributes = @($Package.ManifestIdentity.PSObject.Properties | ForEach-Object {
    $_.Name + '="' + [System.Security.SecurityElement]::Escape([string]$_.Value) + '"'
  }) -join ' '
  return [xml]('<Package><Identity ' + $attributes + '/><Applications><Application Id="App" Executable="app\\ChatGPT.exe"/></Applications></Package>')
}
. ${quote(helper)} -Operation discover
`);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath], { timeout: 15000, maxBuffer: 65536 });
  const values = JSON.parse(stdout.replace(/^\ufeff/u, '').trim());
  assert.equal(values.length, 2);
  assert.deepEqual(values.map((item) => path.basename(item.bundlePath)).sort(), ['valid-arm64', 'valid-x64']);
  values.forEach(validateWindowsInstallation);
});

test('listener parser handles IPv4 and IPv6 and refuses every broad binding', () => {
  const values = parseLsofListeners(`p101\nn127.0.0.1:${port}\nn[::1]:${port}\n`, port);
  assert.equal(values.length, 2);
  assert.equal(validateLoopbackListeners(values, port), values);
  for (const address of ['*', '0.0.0.0', '::', '[::]', '192.168.1.2', '127.0.0.2', 'localhost']) {
    assert.throws(() => validateLoopbackListeners([...values, { pid: 101, address, port }], port));
  }
  assert.throws(() => validateLoopbackListeners([], port));
  assert.throws(() => parseLsofListeners('p101\nnunexpected', port));
  assert.throws(() => parseLsofListeners(`p101\nn127.0.0.1:${port + 1}`, port));
  for (const invalid of [80, 65536, NaN, '19491', 19491.1]) assert.throws(() => assertPort(invalid));
});

test('a listener must reach the exact official main process, optionally the owned PID', () => {
  const processes = [
    { pid: 101, parentPid: 1, executable: mac.executable },
    { pid: 102, parentPid: 101, executable: `${mac.bundlePath}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper` },
  ];
  assert.equal(validateProcessTree(102, processes, mac, 101), true);
  assert.equal(validateProcessTree(101, processes, mac), true);
  assert.throws(() => validateProcessTree(102, processes, mac, 999));
  assert.throws(() => validateProcessTree(102, [{ ...processes[1], executable: '/tmp/ChatGPT' }, processes[0]], mac));
  assert.throws(() => validateProcessTree(102, [{ ...processes[1], parentPid: 102 }], mac));
  assert.throws(() => validateProcessTree(102, [processes[1]], mac));
  assert.throws(() => validateProcessTree(101, [{ ...processes[0], executable: '/Applications/ChatGPT.app-copy/Contents/MacOS/ChatGPT' }], mac));
});

test('macOS executable identity uses the exact kernel path, including helper names with spaces', () => {
  const helper = `${mac.bundlePath}/Contents/Frameworks/Codex Framework.framework/Versions/156/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)`;
  assert.deepEqual(parseMacProcessIdentity(JSON.stringify({ pid: 102, executable: helper }), '  101\n', 102), {
    pid: 102, parentPid: 101, executable: helper,
  });
  assert.deepEqual(parseMacProcessIdentity(JSON.stringify({ pid: 101, executable: mac.executable }), '1\n', 101), {
    pid: 101, parentPid: 1, executable: mac.executable,
  });
  // Mapped txt files cannot stand in for kernel metadata, regardless of order.
  assert.throws(() => parseMacProcessIdentity(`p101\nftxt\nn/private/var/db/timezone/data\nftxt\nn${mac.executable}\n`, '1', 101));
  for (const record of [
    { pid: 999, executable: mac.executable },
    { pid: 101, executable: 'ChatGPT' },
    { pid: 101, executable: `${mac.executable}\n/tmp/other` },
    { pid: 101, executable: `${mac.executable}\0` },
    { pid: 101 },
  ]) assert.throws(() => parseMacProcessIdentity(JSON.stringify(record), '1', 101));
  for (const parent of ['', 'not-a-pid', '101', '-1', '3.14']) {
    assert.throws(() => parseMacProcessIdentity(JSON.stringify({ pid: 101, executable: mac.executable }), parent, 101));
  }
});

test('an external signed helper exception is exact and still requires the owned main ancestry', () => {
  const { executable } = computerUseHelperPaths('/private/tmp/owned/home');
  assert.equal(executable, '/private/tmp/owned/home/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService');
  const processes = [
    { pid: 101, parentPid: 1, executable: mac.executable },
    { pid: 102, parentPid: 101, executable },
  ];
  assert.equal(validateProcessTree(102, processes, mac, 101, [executable]), true);
  assert.throws(() => validateProcessTree(102, processes, mac, 101));
  assert.throws(() => validateProcessTree(102, processes, mac, null, [executable]));
  assert.throws(() => validateProcessTree(102, processes, mac, 999, [executable]));
  assert.throws(() => validateProcessTree(102, [processes[0], { ...processes[1], parentPid: 1 }], mac, 101, [executable]));
  assert.throws(() => validateProcessTree(102, [processes[0], { ...processes[1], executable: `${executable}.fake` }], mac, 101, [executable]));
  assert.throws(() => validateProcessTree(102, [processes[0], { ...processes[1], executable: executable.replace('/owned/', '/someone-else/') }], mac, 101, [executable]));
  assert.throws(() => computerUseHelperPaths('relative/home'));
});

test('CDP version identity refuses redirects, credentials, wrong ports, paths and remote URLs', () => {
  const valid = { Browser: 'Chrome/154.0.0.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-id` };
  assert.equal(validateCdpVersion(valid, port).browserId, 'test-id');
  for (const url of [
    `wss://127.0.0.1:${port}/devtools/browser/id`,
    `ws://user:secret@127.0.0.1:${port}/devtools/browser/id`,
    `ws://127.0.0.1:${port + 1}/devtools/browser/id`,
    `ws://127.0.0.1:${port}/devtools/page/id`,
    `ws://127.0.0.1:${port}/devtools/browser/id?next=http://evil`,
    `ws://127.0.0.1:${port}/devtools/browser/id#fragment`,
    `ws://example.com:${port}/devtools/browser/id`,
    `ws://127.0.0.1:${port}/devtools/browser/a%2Fb`,
  ]) assert.throws(() => validateCdpVersion({ ...valid, webSocketDebuggerUrl: url }, port));
  assert.throws(() => validateCdpVersion({ ...valid, Browser: '<script>' }, port));
});
