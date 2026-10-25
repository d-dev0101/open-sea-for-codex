import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VideoLibrary, MAX_VIDEO_BYTES, MAX_VIDEO_CHUNK_BYTES } from '../src/videos.mjs';
import { validateMediaResponse } from '../src/cdp.mjs';

const token = 'a'.repeat(32);
function mp4(size = 4096, brand = 'isom') {
  const data = Buffer.alloc(size, 0x5a);
  data.writeUInt32BE(24, 0);data.write('ftyp', 4);data.write(brand, 8);
  data.writeUInt32BE(0, 12);data.write('isommp42', 16);
  return data;
}
function completeMP4(size=4096, brand='qt  ') {
  const data=mp4(size,brand);
  data.writeUInt32BE(16,24);data.write('moov',28);
  data.writeUInt32BE(size-40,40);data.write('mdat',44);
  return data;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-videos-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'library');
  const library = new VideoLibrary({ directory, token, systemRoots: [] });
  await library.init();
  const source = path.join(root, 'source.mp4');
  return { root, directory, library, source };
}
function headers(response) { return Object.fromEntries(response.responseHeaders.map(header => [header.name.toLowerCase(), header.value])); }
function contents(response) { return Buffer.from(response.body || '', 'base64'); }

test('imports copy to private random IDs, persist a path-free catalog, and reopen with a new token', async t => {
  const { directory, library, source } = await fixture(t);
  const data = mp4();await fs.writeFile(source, data);
  const imported = await library.importFile(source, { name: '../My video.mp4', sourceKey: '/private/source-key' });
  assert.match(imported.videoId, /^[a-f0-9]{32}$/);
  assert.equal(imported.videoName, 'My video.mp4');
  assert.equal(library.pattern, `https://127.0.0.1/open-sea-media/${token}/*`);
  assert.equal(library.previewUrl(imported.videoId), `open-sea-media://${token}/${imported.videoId}`);
  assert.equal(library.rendererUrl(imported.videoId), `https://127.0.0.1/open-sea-media/${token}/${imported.videoId}`);
  assert.equal(library.rendererUrl('../source.mp4'), null);
  assert.equal(library.previewUrl('b'.repeat(32)), null);
  assert.deepEqual(await fs.readFile(source), data);
  const saved = path.join(directory, `${imported.videoId}.video`);
  assert.deepEqual(await fs.readFile(saved), data);
  const catalog = await fs.readFile(path.join(directory, 'catalog.json'), 'utf8');
  assert.ok(Buffer.byteLength(catalog) < 1024 * 1024);
  assert.equal(catalog.includes(source), false);
  assert.equal(catalog.includes('/private/source-key'), false);
  assert.equal(Object.hasOwn(JSON.parse(catalog).videos[0], 'path'), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(saved)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(directory, 'catalog.json'))).mode & 0o777, 0o600);
  }
  const reopened = await new VideoLibrary({ directory, token: 'c'.repeat(32), systemRoots: [] }).init();
  assert.equal(reopened.rendererUrl(imported.videoId), `https://127.0.0.1/open-sea-media/${'c'.repeat(32)}/${imported.videoId}`);
  const response = await reopened.respond({ url: reopened.previewUrl(imported.videoId), method: 'GET' });
  assert.equal(response.responseCode, 206);
  assert.deepEqual(contents(response), data);
  assert.deepEqual(validateMediaResponse(response), response);
});

test('video headers identify MP4, QuickTime, and WebM and reject renamed non-video data', async t => {
  const { root, library } = await fixture(t);
  const webm = Buffer.from('1a45dfa3874282847765626d00000000', 'hex');
  for (const [name, data, mime] of [['clip.mp4', mp4(), 'video/mp4'], ['clip.mov', mp4(4096, 'qt  '), 'video/quicktime'], ['clip.webm', webm, 'video/webm']]) {
    const input = path.join(root, name);await fs.writeFile(input, data);
    const imported = await library.importFile(input);
    const response = await library.respond({ url: library.rendererUrl(imported.videoId), method: 'HEAD' });
    assert.equal(headers(response)['content-type'], mime);
  }
  const highBits = mp4();for (let i = 4; i < 8; i++) highBits[i] |= 0x80;
  for (const data of [Buffer.from('<html>This is not a video at all</html>'), Buffer.from('1a45dfa3874282886d6174726f736b6100', 'hex'), highBits, Buffer.alloc(2)]) {
    const input = path.join(root, 'fake.mov');await fs.writeFile(input, data);
    await assert.rejects(library.importFile(input), error => !error.message.includes(root));
  }
  assert.equal((await fs.readdir(library.directory)).filter(name => name.endsWith('.video')).length, 3);
});

test('video display names stay within the settings contract and never retain path segments', async t => {
  const { library, source } = await fixture(t);await fs.writeFile(source, mp4());
  const imported = await library.importFile(source, { name: `C:\\private\\${'海'.repeat(150)}` });
  assert.equal(imported.videoName, '海'.repeat(120));
  const catalog = JSON.parse(await fs.readFile(path.join(library.directory, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos[0].name.length, 120);
  const reopened = await new VideoLibrary({ directory: library.directory, systemRoots: [] }).init();
  assert.ok(reopened.previewUrl(imported.videoId));
});

test('range reads cap each chunk, support suffix and open ranges, and preserve full HEAD size', async t => {
  const { library, source } = await fixture(t);
  const data = mp4(MAX_VIDEO_CHUNK_BYTES + 1000);await fs.writeFile(source, data);
  const { videoId } = await library.importFile(source);
  const url = library.rendererUrl(videoId);
  for (const [range, start, end] of [
    [undefined, 0, MAX_VIDEO_CHUNK_BYTES - 1], ['bytes=10-25', 10, 25], ['bytes=0-0', 0, 0],
    ['bytes=100-', 100, 100 + MAX_VIDEO_CHUNK_BYTES - 1], ['bytes=-17', data.length - 17, data.length - 1],
    [`bytes=${data.length - 50}-${data.length + 999}`, data.length - 50, data.length - 1],
    [`bytes=-${data.length + 999}`, 0, MAX_VIDEO_CHUNK_BYTES - 1],
  ]) {
    const response = await library.respond({ url, method: 'GET', headers: range ? { Range: range } : {} });
    assert.equal(response.responseCode, 206);
    assert.equal(headers(response)['content-range'], `bytes ${start}-${end}/${data.length}`);
    assert.equal(Number(headers(response)['content-length']), end - start + 1);
    assert.deepEqual(contents(response), data.subarray(start, end + 1));
    assert.ok(contents(response).length <= MAX_VIDEO_CHUNK_BYTES);
    assert.deepEqual(validateMediaResponse(response), response);
  }
  const head = await library.respond({ url, method: 'HEAD', headers: { Range: 'bad range' } });
  assert.equal(head.responseCode, 200);
  assert.equal(head.body, undefined);
  assert.equal(headers(head)['content-length'], String(data.length));
  assert.equal(headers(head)['accept-ranges'], 'bytes');
  const standardHeaders = await library.respond({ url, method: 'GET', headers: new Headers({ range: 'bytes=1-2' }) });
  assert.deepEqual(contents(standardHeaders), data.subarray(1, 3));
});

test('unknown IDs, URLs, methods and malformed ranges cannot access external files', async t => {
  const { library, source } = await fixture(t);
  await fs.writeFile(source, mp4());
  const { videoId } = await library.importFile(source);
  const url = library.rendererUrl(videoId);
  for (const malformed of [
    source, `file://${source}`, 'https://example.invalid/video', url.replace(token, 'f'.repeat(32)), url + '?x=1', url + '#',
    ...['http://127.0.0.1', 'app://-', 'https://localhost', 'https://127.0.0.2', 'https://[::1]', 'https://127.0.0.1:443', 'https://127.0.0.1:8443', 'https://user@127.0.0.1']
      .map(origin => url.replace('https://127.0.0.1', origin)), url + '\n',
    url.replace(videoId, '../catalog.json'), url.replace(videoId, '%2e%2e/catalog.json'), url.replace(videoId, 'b'.repeat(32)),
    `open-sea-media://user@${token}/${videoId}`, `open-sea-media://${token}:80/${videoId}`, library.previewUrl(videoId) + '?',
  ]) assert.equal((await library.respond({ url: malformed, method: 'GET' })).responseCode, 404);
  for (const method of ['POST', 'PUT', 'DELETE', 'get', undefined]) assert.equal((await library.respond({ url, method })).responseCode, 405);
  for (const range of ['bytes=9000-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=0-1,2-3', 'bytes=0-1\r\nInjected:yes', 'bytes=999999999999999999999-', 'not bytes', 23, 'x'.repeat(129)]) {
    const response = await library.respond({ url, method: 'GET', headers: { Range: range } });
    assert.equal(response.responseCode, 416);
    assert.equal(headers(response)['content-range'], 'bytes */4096');
    assert.equal(response.body, undefined);
  }
  assert.equal((await library.respond({ url, method: 'GET', headers: { Range: 'bytes=0-1', range: 'bytes=2-3' } })).responseCode, 416);
});

test('catalog records cannot supply paths or exceed bounds', async t => {
  const { root } = await fixture(t);
  const entry = { id: 'b'.repeat(32), name: 'Clip', bytes: 4096, mime: 'video/mp4' };
  const records = [
    { version: 1, videos: [{ ...entry, path: '../../secret.mp4' }] },
    { version: 1, videos: [{ ...entry, id: '../secret' }] },
    { version: 1, videos: [{ ...entry, name: '../secret' }] },
    { version: 1, videos: [{ ...entry, bytes: MAX_VIDEO_BYTES + 1 }] },
    { version: 1, videos: [{ ...entry, mime: 'text/html' }] },
    { version: 1, videos: [entry, entry] },
    { version: 1, videos: [], directory: root },
    { version: 1, videos: [{ ...entry, source: '../../secret' }] },
  ];
  for (let i = 0; i < records.length; i++) {
    const directory = path.join(root, `invalid-${i}`);await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify(records[i]));
    await assert.rejects(new VideoLibrary({ directory }).init(), error => !error.message.includes(root));
  }
  const oversized = path.join(root, 'oversized');await fs.mkdir(oversized);
  await fs.writeFile(path.join(oversized, 'catalog.json'), Buffer.alloc(1024 * 1024, 0x20));
  await assert.rejects(new VideoLibrary({ directory: oversized }).init());
  assert.throws(() => new VideoLibrary({ directory: '../relative' }));
  assert.throws(() => new VideoLibrary({ directory: root, token: 'not-a-token' }));
  assert.throws(() => new VideoLibrary({ directory: root, systemRoots: ['../outside'] }));
});

test('symlinks in imports, catalog, managed media and the library root are refused', async t => {
  const { root, library, source, directory } = await fixture(t);
  await fs.writeFile(source, mp4());
  const linkedSource = path.join(root, 'linked.mp4');
  try { await fs.symlink(source, linkedSource, 'file'); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('This Windows account cannot create test symlinks.'); throw error; }
  await assert.rejects(library.importFile(linkedSource));
  const { videoId } = await library.importFile(source);
  const managed = path.join(directory, `${videoId}.video`);await fs.unlink(managed);await fs.symlink(source, managed, 'file');
  assert.equal((await library.respond({ url: library.rendererUrl(videoId), method: 'GET' })).responseCode, 404);
  const linkedCatalog = path.join(root, 'linked-catalog');await fs.mkdir(linkedCatalog);
  await fs.symlink(path.join(directory, 'catalog.json'), path.join(linkedCatalog, 'catalog.json'), 'file');
  await assert.rejects(new VideoLibrary({ directory: linkedCatalog }).init());
  const linkedDirectory = path.join(root, 'linked-directory');await fs.symlink(directory, linkedDirectory, 'junction');
  await assert.rejects(new VideoLibrary({ directory: linkedDirectory }).init());
  const moved = path.join(root, 'moved-library');await fs.rename(directory, moved);await fs.symlink(root, directory, 'junction');
  assert.equal((await library.respond({ url: library.rendererUrl(videoId), method: 'GET' })).responseCode, 404);
  await assert.rejects(library.importFile(source));
});

test('a video beyond 2 GiB is rejected before any copy is created', async t => {
  const { library, source, directory } = await fixture(t);
  const file = await fs.open(source, 'wx');
  try {
    await file.write(mp4());
    // POSIX truncation produces a tiny sparse fixture. NTFS needs an explicit
    // sparse-file control call, so mock only its size to avoid a 2 GiB allocation.
    if (process.platform !== 'win32') await file.truncate(MAX_VIDEO_BYTES + 1);
  } finally { await file.close(); }
  if (process.platform === 'win32') {
    const lstat = fs.lstat.bind(fs);
    t.mock.method(fs, 'lstat', async filePath => {
      const stat = await lstat(filePath);
      if (filePath === source) stat.size = MAX_VIDEO_BYTES + 1;
      return stat;
    });
  }
  await assert.rejects(library.importFile(source), error => error.message.includes('2 GiB') && !error.message.includes(source));
  assert.deepEqual(await fs.readdir(directory), []);
});

test('failed persistence and canceled imports remove the new copy while preserving existing records', async t => {
  const { library, source, directory } = await fixture(t);
  await fs.writeFile(source, mp4());
  const existing = await library.importFile(source);
  const before = await fs.readFile(path.join(directory, 'catalog.json'), 'utf8');
  const persist = library._writeCatalog;
  library._writeCatalog = async () => { throw new Error('/private/location/disk error'); };
  await assert.rejects(library.importFile(source), error => !error.message.includes('/private/location'));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['catalog.json', `${existing.videoId}.video`].sort());
  assert.equal(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'), before);
  const abort = new AbortController();
  library._writeCatalog = async function(entries, signal) {
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.video')).length, 2);
    abort.abort();
    return persist.call(this, entries, signal);
  };
  await assert.rejects(library.importFile(source, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['catalog.json', `${existing.videoId}.video`].sort());
  assert.equal(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'), before);
  library._writeCatalog = persist;
  const retry = await library.importFile(source);
  assert.notEqual(retry.videoId, existing.videoId, 'a failed import must not poison the mutation queue');
});

test('abort before and after opening a response releases its file without returning a body', async t => {
  const { library, source } = await fixture(t);await fs.writeFile(source, mp4());
  const { videoId } = await library.importFile(source);
  const url = library.rendererUrl(videoId);
  await assert.rejects(library.respond({ url, method: 'GET', signal: AbortSignal.abort() }), { name: 'AbortError' });
  let file;
  const original = library._openManaged;
  const abort = new AbortController();
  library._openManaged = async function(...args) {
    const opened = await original.apply(this, args);file = opened.file;abort.abort();return opened;
  };
  await assert.rejects(library.respond({ url, method: 'GET', signal: abort.signal }), { name: 'AbortError' });
  assert.equal(file.fd, -1);
});

test('concurrent imports preserve both records and source identity deduplicates a stable downloaded file', async t => {
  const { library, source } = await fixture(t);await fs.writeFile(source, mp4());
  const results = await Promise.all([library.importFile(source, { sourceKey: 'fixture' }), library.importFile(source, { sourceKey: 'fixture' }), library.importFile(source, { name: 'Another clip' })]);
  assert.equal(results[0].videoId, results[1].videoId);
  assert.notEqual(results[0].videoId, results[2].videoId);
  const later = new Date(Date.now() + 10000);await fs.utimes(source, later, later);
  const changed = await library.importFile(source, { sourceKey: 'fixture' });
  assert.notEqual(changed.videoId, results[0].videoId);
  assert.equal((await fs.readdir(library.directory)).filter(name => name.endsWith('.video')).length, 3);
});

test('system wallpaper discovery offers complete downloaded files and never returns their paths', async t => {
  const { root, directory } = await fixture(t);
  const firstRoot = path.join(root, 'wallpapers-a'), secondRoot = path.join(root, 'wallpapers-b');
  await fs.mkdir(firstRoot);await fs.mkdir(secondRoot);
  const first = '4C108785-A7BA-422E-9C79-B0129F1D5550', second = 'D7950C0A-27B9-4034-AB5B-EDB89D41341A';
  await fs.writeFile(path.join(firstRoot, `${first}.mov`), completeMP4(4096, 'qt  '));
  await fs.writeFile(path.join(secondRoot, `${second}.mov`), completeMP4(8192, 'qt  '));
  await fs.writeFile(path.join(firstRoot, 'FE876489-CBD5-479B-A8F0-1B67F0741CEA.mov'), 'incomplete download');
  await fs.writeFile(path.join(firstRoot, 'unknown.mov'), mp4());
  const library = await new VideoLibrary({ directory, token, systemRoots: [firstRoot, secondRoot] }).init();
  const available = await library.systemWallpapers();
  assert.deepEqual(available, [{ id: first, name: '太浩湖', bytes: 4096 }, { id: second, name: '冰岛湖', bytes: 8192 }]);
  assert.equal(JSON.stringify(available).includes(root), false);
  const imported = await library.importSystemVideo(first);
  assert.equal(imported.videoName, '太浩湖');
  assert.deepEqual(await library.importSystemVideo(first), imported);
  await assert.rejects(library.importSystemVideo('../unknown.mov'));
  await assert.rejects(library.importSystemVideo('4F881F8B-A7D9-4FDB-A917-17BF6AC5A589'));
  assert.deepEqual(await fs.readFile(path.join(firstRoot, `${first}.mov`)), completeMP4(4096, 'qt  '));
});

test('system imports honor shutdown before discovery and cancel the actual copy transaction', async t => {
  const { root, directory } = await fixture(t);
  const systemRoot = path.join(root, 'system');await fs.mkdir(systemRoot);
  const id = '4C108785-A7BA-422E-9C79-B0129F1D5550';
  const source = path.join(systemRoot, `${id}.mov`);await fs.writeFile(source, completeMP4(4096, 'qt  '));
  const library = await new VideoLibrary({ directory, systemRoots: [systemRoot] }).init();
  let discoveries = 0;
  const discover = library._systemFile;
  library._systemFile = async function(...args) { discoveries++;return discover.apply(this, args); };
  await assert.rejects(library.importSystemVideo(id, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(discoveries, 0, 'a canceled system import must not inspect system files');
  const abort = new AbortController();
  const persist = library._writeCatalog;
  library._writeCatalog = async function(entries, signal) {
    assert.equal(signal, abort.signal);
    abort.abort();
    return persist.call(this, entries, signal);
  };
  await assert.rejects(library.importSystemVideo(id, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(discoveries, 1);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.deepEqual(await fs.readFile(source), completeMP4(4096, 'qt  '));
});


test('system wallpaper refresh discovers new UUID movies and rejects partial containers', async t => {
  const {root,directory}=await fixture(t);
  const systemRoot=path.join(root,'aerials','videos'),manifest=path.join(root,'aerials','manifest');
  await fs.mkdir(systemRoot,{recursive:true});await fs.mkdir(manifest);
  const id='11111111-1111-1111-1111-111111111111';
  const library=await new VideoLibrary({directory,systemRoots:[systemRoot]}).init();
  assert.deepEqual(await library.systemWallpapers(),[]);
  await fs.writeFile(path.join(manifest,'entries.json'),JSON.stringify({assets:[{id,accessibilityLabel:'Local landscape',previewImage:'https://example.invalid/unused'}]}));
  const movie=completeMP4();
  await fs.writeFile(path.join(systemRoot,id+'.mov'),movie.subarray(0,90));
  assert.deepEqual(await library.systemWallpapers(),[], 'ftyp with partial mdat must not be offered');
  await fs.writeFile(path.join(systemRoot,id+'.mov'),movie);
  assert.deepEqual(await library.systemWallpapers(),[{id,name:'Local landscape',bytes:4096}]);
  assert.equal((await library.importSystemVideo(id)).videoName,'Local landscape');
});


test('legacy system metadata labels downloads and import respects the requested locale on reuse', async t => {
  const {root,directory}=await fixture(t);
  const systemRoot=path.join(root,'Customer','4KSDR240FPS');
  await fs.mkdir(systemRoot,{recursive:true});
  const id='22222222-2222-2222-2222-222222222222';
  await fs.writeFile(path.join(root,'Customer','entries.json'),JSON.stringify({assets:[{id,accessibilityLabel:'Legacy landscape'}]}));
  await fs.writeFile(path.join(systemRoot,id+'.mov'),completeMP4());
  const library=await new VideoLibrary({directory,systemRoots:[systemRoot]}).init();
  assert.deepEqual(await library.systemWallpapers(),[{id,name:'Legacy landscape',bytes:4096}]);
  // Isolate the locale selection from macOS-only plutil localization.
  library._systemItems=async locale=>[{id,name:locale==='en'?'Local landscape':'本地风景'}];
  const zh=await library.importSystemVideo(id,{locale:'zh'});
  const en=await library.importSystemVideo(id,{locale:'en'});
  assert.equal(en.videoId,zh.videoId,'language switches must not duplicate large videos');
  assert.equal(zh.videoName,'本地风景');assert.equal(en.videoName,'Local landscape');
});


test('system import prepares a playback copy once, caches it, and cleans temporary conversion files', async t => {
  const {root,directory}=await fixture(t);
  const systemRoot=path.join(root,'system');await fs.mkdir(systemRoot);
  const id='4C108785-A7BA-422E-9C79-B0129F1D5550';
  const original=completeMP4(8192),converted=mp4(4096);
  await fs.writeFile(path.join(systemRoot,id+'.mov'),original);
  let preparations=0,cleanups=0;
  const library=await new VideoLibrary({directory,systemRoots:[systemRoot],prepareSystemVideo:async()=>{
    preparations++;
    const temporary=path.join(root,'converted.mp4');await fs.writeFile(temporary,converted);
    return {filePath:temporary,cleanup:async()=>{cleanups++;await fs.rm(temporary);}};
  }}).init();
  const first=await library.importSystemVideo(id),second=await library.importSystemVideo(id);
  assert.deepEqual(first,second);assert.equal(preparations,1);assert.equal(cleanups,1);
  assert.deepEqual(await fs.readFile(path.join(directory,first.videoId+'.video')),converted);
  assert.deepEqual(await fs.readFile(path.join(systemRoot,id+'.mov')),original);
  const reopened = await new VideoLibrary({directory,systemRoots:[systemRoot],prepareSystemVideo:async()=>{
    throw new Error('A newer converter must not invalidate a playable existing H.264 cache.');
  }}).init();
  assert.deepEqual(await reopened.importSystemVideo(id),first,'converter upgrades reuse the persisted h264-v1 cache');
});


test('system conversion rejects a replaced source path and preserves cancellation', async t => {
  const {root,directory}=await fixture(t);
  const systemRoot=path.join(root,'system');await fs.mkdir(systemRoot);
  const id='4C108785-A7BA-422E-9C79-B0129F1D5550',source=path.join(systemRoot,id+'.mov');
  await fs.writeFile(source,completeMP4());
  let cleaned=false;
  const library=await new VideoLibrary({directory,systemRoots:[systemRoot],prepareSystemVideo:async()=>{
    await fs.rename(source,source+'.original');
    await fs.writeFile(source,completeMP4());
    const output=path.join(root,'converted.mp4');await fs.writeFile(output,mp4());
    return {filePath:output,cleanup:async()=>{cleaned=true;await fs.rm(output);}};
  }}).init();
  await assert.rejects(library.importSystemVideo(id),/changed during conversion/);
  assert.equal(cleaned,true);assert.deepEqual(await fs.readdir(directory),[]);
  library.prepareSystemVideo=async()=>{throw new DOMException('Canceled','AbortError');};
  await assert.rejects(library.importSystemVideo(id),{name:'AbortError'});
});
