import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const localizationCache = new Map();

export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_VIDEO_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_VIDEOS = 4096;
const ID = /^[a-f0-9]{32}$/u;
const MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const SYSTEM_ID = /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/iu;
const SYSTEM_VIDEOS = Object.freeze([
  { id: '4C108785-A7BA-422E-9C79-B0129F1D5550', name: '太浩湖' },
  { id: 'FE876489-CBD5-479B-A8F0-1B67F0741CEA', name: '索诺马地平线' },
  { id: 'D7950C0A-27B9-4034-AB5B-EDB89D41341A', name: '冰岛湖' },
  { id: '4F881F8B-A7D9-4FDB-A917-17BF6AC5A589', name: '加勒比' },
]);

function safeError(message, code = 'VIDEO_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}
function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  const error = safeError('The video operation was canceled.', 'ABORT_ERR');
  error.name = 'AbortError';
  throw error;
}
function publicError(error, fallback) {
  return error?.code === 'VIDEO_ERROR' || error?.code === 'ABORT_ERR' || error?.name === 'AbortError' ? error : safeError(fallback);
}
function displayName(value) {
  const leaf = String(value || '').split(/[\\/]/u).at(-1);
  const name = leaf.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 120);
  return !name || name === '.' || name === '..' ? 'Local video' : name;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameVersion(a, b) { return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function validSize(size) { return Number.isSafeInteger(size) && size >= 12 && size <= MAX_VIDEO_BYTES; }

function systemMetadataDirectories(root) {
  return [path.join(root, '..', 'manifest'), path.join(root, '..')];
}

async function systemNames(metadata, locale) {
  if (process.platform !== 'darwin') return {};
  const file = path.join(metadata, 'TVIdleScreenStrings.bundle/Contents/Resources/Localizable.nocache.loctable');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return {};
    const cached = localizationCache.get(file);
    let names = cached?.mtime === stat.mtimeMs ? cached.names : null;
    if (!names) {
      const {stdout} = await execFileAsync('/usr/bin/plutil', ['-convert','json','-o','-',file], {timeout:2000,maxBuffer:16*1024*1024});
      names = JSON.parse(stdout);
      localizationCache.set(file, {mtime:stat.mtimeMs,names});
    }
    return locale === 'en' ? names.en || names.en_US || {} : names.zh_CN || names['zh-Hans'] || {};
  } catch { return {}; }
}

async function openRegular(filePath, { managed = false, maximum = MAX_VIDEO_BYTES } = {}) {
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile() || managed && before.nlink !== 1) throw safeError('The video file is not an allowed regular file.');
  if (before.size > maximum) throw safeError(maximum === MAX_VIDEO_BYTES ? 'Video must be no larger than 2 GiB.' : 'The local video catalog exceeds its size limit.');
  const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    const after = await fs.lstat(filePath);
    if (!stat.isFile() || !after.isFile() || after.isSymbolicLink() || !sameFile(before, stat) || !sameFile(stat, after)
        || stat.size > maximum || managed && stat.nlink !== 1) throw safeError('The video file changed while being opened.');
    return { file, stat };
  } catch (error) { await file.close(); throw error; }
}

async function readInto(file, buffer, position, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    abortIfNeeded(signal);
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
    abortIfNeeded(signal);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset;
}

async function videoMime(file, size, signal) {
  abortIfNeeded(signal);
  const head = Buffer.alloc(Math.min(4096, size));
  const bytesRead = await readInto(file, head, 0, signal);
  abortIfNeeded(signal);
  if (bytesRead >= 16 && head.subarray(4, 8).equals(Buffer.from('ftyp'))) {
    const boxSize = head.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= size && /^[\x20-\x7e]{4}$/u.test(head.toString('latin1', 8, 12))) {
      return head.toString('latin1', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    }
  }
  // WebM's EBML DocType must explicitly identify webm, not another EBML format.
  if (bytesRead >= 12 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const docType = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    if (head.subarray(4, bytesRead).includes(docType)) return 'video/webm';
  }
  throw safeError('Choose a real MP4, MOV, or WebM video.');
}

// A download can already have a valid ftyp header while most of its data is
// missing. Walk only top-level box headers, never load the movie into memory.
async function completeMovie(file, size) {
  let position = 0, movie = false, media = false;
  const header = Buffer.alloc(16);
  for (let boxes = 0; position < size && boxes < 4096; boxes++) {
    if (size - position < 8 || await readInto(file, header.subarray(0, 8), position) !== 8) return false;
    let length = header.readUInt32BE(0), minimum = 8;
    const type = header.toString('ascii', 4, 8);
    if (length === 1) {
      if (size - position < 16 || await readInto(file, header.subarray(8), position + 8) !== 8) return false;
      const extended = header.readBigUInt64BE(8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      length = Number(extended);minimum = 16;
    } else if (length === 0) length = size - position;
    if (length < minimum || length > size - position) return false;
    movie ||= type === 'moov' && length > minimum;
    media ||= type === 'mdat' && length > minimum;
    position += length;
  }
  return position === size && movie && media;
}

function parseCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'videos'].includes(key))
      || value.version !== 1 || !Array.isArray(value.videos) || value.videos.length > MAX_VIDEOS) throw safeError('The local video catalog is invalid.');
  const entries = new Map();
  for (const item of value.videos) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => !['id', 'name', 'bytes', 'mime', 'source'].includes(key))
        || typeof item.id !== 'string' || !ID.test(item.id) || entries.has(item.id)
        || typeof item.name !== 'string' || displayName(item.name) !== item.name || !validSize(item.bytes) || !MIME_TYPES.has(item.mime)
        || item.source !== undefined && (typeof item.source !== 'string' || !/^[a-f0-9]{64}$/u.test(item.source))) throw safeError('The local video catalog is invalid.');
    entries.set(item.id, Object.freeze({ ...item }));
  }
  return entries;
}

function readRange(headers, size) {
  let value;
  if (headers && typeof headers.get === 'function') value = headers.get('range') ?? undefined;
  else if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== 'range') continue;
      if (value !== undefined) return null;
      value = headers[key];
    }
  }
  if (value === undefined) return { start: 0, end: Math.min(size, MAX_VIDEO_CHUNK_BYTES) - 1 };
  if (typeof value !== 'string' || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (!match || !match[1] && !match[2]) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);end = size - 1;
  } else {
    start = Number(match[1]);end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end: Math.min(end, start + MAX_VIDEO_CHUNK_BYTES - 1) };
}

function emptyResponse(responseCode, headers = []) {
  return { responseCode, responseHeaders: [{ name: 'Content-Length', value: '0' }, { name: 'Cache-Control', value: 'no-store' }, ...headers] };
}

export class VideoLibrary {
  constructor({ directory, token = randomBytes(16).toString('hex'), systemRoots, prepareSystemVideo } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || typeof token !== 'string' || !ID.test(token)) throw safeError('Invalid local video library configuration.');
    const defaults = process.platform === 'darwin' ? [
      path.join(os.homedir(), 'Library/Application Support/com.apple.wallpaper/aerials/videos'),
      '/Library/Application Support/com.apple.idleassetsd/Customer/4KSDR240FPS',
    ] : [];
    const roots = systemRoots ?? defaults;
    if (!Array.isArray(roots) || roots.length > 8 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))) throw safeError('Invalid system video locations.');
    this.directory = path.resolve(directory);
    this.token = token;
    this.systemRoots = [...roots];
    if (prepareSystemVideo !== undefined && typeof prepareSystemVideo !== 'function') throw safeError('Invalid system video converter.');
    this.prepareSystemVideo = prepareSystemVideo;
    this._entries = new Map();
    this._initializing = null;
    this._work = Promise.resolve();
  }

  get pattern() { return `https://127.0.0.1/open-sea-media/${this.token}/*`; }
  previewUrl(id) { return typeof id === 'string' && ID.test(id) && this._entries.has(id) ? `open-sea-media://${this.token}/${id}` : null; }
  rendererUrl(id) { return typeof id === 'string' && ID.test(id) && this._entries.has(id) ? `https://127.0.0.1/open-sea-media/${this.token}/${id}` : null; }

  async init() {
    if (this._initializing) return this._initializing;
    this._initializing = (async () => {
      try {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError('The local video directory must not be a link.');
        this.directory = await fs.realpath(this.directory);
        this._directoryIdentity = stat;
        await this._assertDirectory();
        let opened;
        try { opened = await openRegular(path.join(this.directory, 'catalog.json'), { managed: true, maximum: MAX_CATALOG_BYTES - 1 }); }
        catch (error) { if (error.code === 'ENOENT') return this; throw error; }
        try {
          const data = Buffer.alloc(opened.stat.size);
          const bytesRead = await readInto(opened.file, data, 0);
          if (bytesRead !== data.length) throw safeError('The local video catalog changed while reading.');
          this._entries = parseCatalog(JSON.parse(data.toString('utf8')));
        } finally { await opened.file.close(); }
        return this;
      } catch (error) { throw publicError(error, 'The local video library could not be opened.'); }
    })();
    try { return await this._initializing; }
    catch (error) { this._initializing = null; throw error; }
  }

  async _assertDirectory() {
    const stat = await fs.lstat(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFile(stat, this._directoryIdentity) || await fs.realpath(this.directory) !== this.directory) throw safeError('The local video directory changed.');
  }

  _mutate(action) {
    const next = this._work.then(action);
    this._work = next.catch(() => {});
    return next;
  }

  async _writeCatalog(entries, signal) {
    const data = JSON.stringify({ version: 1, videos: [...entries.values()] });
    if (entries.size > MAX_VIDEOS || Buffer.byteLength(data) >= MAX_CATALOG_BYTES) throw safeError('The local video library has reached its catalog limit.');
    await this._assertDirectory();
    const temporary = path.join(this.directory, `.catalog-${randomBytes(16).toString('hex')}.tmp`);
    let output, created = false;
    try {
      abortIfNeeded(signal);output = await fs.open(temporary, 'wx', 0o600);created = true;
      await output.writeFile(data, 'utf8');await output.sync();await output.close();output = null;
      await this._assertDirectory();abortIfNeeded(signal);
      await fs.rename(temporary, path.join(this.directory, 'catalog.json'));
    } finally { await output?.close().catch(() => {});if (created) await fs.rm(temporary, { force: true }); }
  }

  async _openManaged(entry, signal) {
    await this._assertDirectory();abortIfNeeded(signal);
    const opened = await openRegular(path.join(this.directory, `${entry.id}.video`), { managed: true });
    try {
      if (opened.stat.size !== entry.bytes || await videoMime(opened.file, opened.stat.size, signal) !== entry.mime) throw safeError('The saved video is no longer available.');
      return opened;
    } catch (error) { await opened.file.close();throw error; }
  }

  async importFile(filePath, { name, sourceKey, signal, prepare } = {}) {
    try {
      abortIfNeeded(signal);
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) throw safeError('Choose a local video file.');
      if (sourceKey !== undefined && (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 1024)) throw safeError('Invalid video source identity.');
      await this.init();
      return await this._mutate(async () => {
        let source, originalSource, prepared, output, destination, created = false, committed = false;
        try {
          abortIfNeeded(signal);await this._assertDirectory();
          source = await openRegular(filePath);
          if (!validSize(source.stat.size)) throw safeError('Video must be a regular file no larger than 2 GiB.');
          let mime = await videoMime(source.file, source.stat.size, signal);
          const sourceId = sourceKey === undefined ? undefined : createHash('sha256').update(JSON.stringify([sourceKey, source.stat.size, source.stat.mtimeMs])).digest('hex');
          if (sourceId) {
            for (const entry of this._entries.values()) if (entry.source === sourceId) {
              try {
                const existing = await this._openManaged(entry, signal);await existing.file.close();
                return { videoId: entry.id, videoName: name === undefined ? entry.name : displayName(name) };
              } catch (error) { abortIfNeeded(signal); }
            }
          }
          if (prepare) {
            prepared = await prepare(filePath, { signal });
            abortIfNeeded(signal);
            originalSource = source;
            source = await openRegular(prepared.filePath);
            if (!validSize(source.stat.size)) throw safeError('The converted video exceeds its size limit.');
            mime = await videoMime(source.file, source.stat.size, signal);
            const currentSource = await fs.lstat(filePath);
            if (currentSource.isSymbolicLink() || !currentSource.isFile() || !sameVersion(originalSource.stat, currentSource)
              || !sameVersion(originalSource.stat, await originalSource.file.stat())) throw safeError('The original video changed during conversion.');
          }
          const id = randomBytes(16).toString('hex');
          destination = path.join(this.directory, `${id}.video`);
          await this._assertDirectory();
          output = await fs.open(destination, 'wx', 0o600);created = true;
          const chunk = Buffer.alloc(1024 * 1024);
          for (let position = 0; position < source.stat.size;) {
            abortIfNeeded(signal);
            const length = Math.min(chunk.length, source.stat.size - position);
            const { bytesRead } = await source.file.read(chunk, 0, length, position);
            abortIfNeeded(signal);
            if (!bytesRead) throw safeError('The source video changed during import.');
            let written = 0;
            while (written < bytesRead) {
              abortIfNeeded(signal);
              const { bytesWritten } = await output.write(chunk, written, bytesRead - written, position + written);
              if (!bytesWritten) throw safeError('The local video copy could not be completed.');
              written += bytesWritten;
            }
            position += bytesRead;
          }
          if (!sameVersion(source.stat, await source.file.stat())) throw safeError('The source video changed during import.');
          abortIfNeeded(signal);await output.sync();await output.close();output = null;
          await this._assertDirectory();abortIfNeeded(signal);
          const entry = Object.freeze({ id, name: displayName(name ?? path.basename(filePath)), bytes: source.stat.size, mime, ...(sourceId ? { source: sourceId } : {}) });
          const entries = new Map(this._entries);entries.set(id, entry);
          await this._writeCatalog(entries, signal);
          this._entries = entries;committed = true;
          return { videoId: id, videoName: entry.name };
        } finally {
          await source?.file.close().catch(() => {});await originalSource?.file.close().catch(() => {});await output?.close().catch(() => {});
          if (created && !committed) await fs.rm(destination, { force: true });
          await prepared?.cleanup?.().catch(() => {});
        }
      });
    } catch (error) { throw publicError(error, 'The video could not be imported.'); }
  }

  async _systemFile(item) {
    for (const root of this.systemRoots) {
      let opened;
      try {
        const stat = await fs.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const filePath = path.join(root, `${item.id}.mov`);
        opened = await openRegular(filePath);
        if (!validSize(opened.stat.size)) continue;
        await videoMime(opened.file, opened.stat.size);
        if (!await completeMovie(opened.file, opened.stat.size) || !sameVersion(opened.stat, await opened.file.stat())) continue;
        return { filePath, bytes: opened.stat.size };
      } catch { /* Unavailable/download-incomplete system files are not offered. */ }
      finally { await opened?.file.close().catch(() => {}); }
    }
    return null;
  }

  async _systemItems(locale = 'zh') {
    const names = new Map(SYSTEM_VIDEOS.map(item => [item.id, item.name]));
    const manifestNames = new Set();
    const present = new Set();
    for (const root of this.systemRoots) {
      for (const metadata of systemMetadataDirectories(root)) {
        const localized = await systemNames(metadata, locale);
        let opened;
        try {
          // Read names from Apple's local manifest only. Its remote URLs are not
          // used, requested or passed to the renderer.
          const manifest = path.join(metadata, 'entries.json');
          opened = await openRegular(manifest, { maximum: 8 * 1024 * 1024 });
          const document = JSON.parse(await opened.file.readFile('utf8'));
          for (const item of (Array.isArray(document.assets) ? document.assets : []).slice(0, 4096)) {
            if (typeof item.id !== 'string' || !SYSTEM_ID.test(item.id)) continue;
            const id = item.id.toUpperCase();
            const name = localized[item.localizedNameKey] || item.accessibilityLabel;
            if (typeof name === 'string' && name.trim() && !manifestNames.has(id)) {
              names.set(id, displayName(name));
              manifestNames.add(id);
            }
          }
        } catch { /* Missing manifests do not prevent known/local UUID discovery. */ }
        finally { await opened?.file.close().catch(() => {}); }
      }
      try {
        const stat = await fs.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        for (const entry of (await fs.readdir(root, { withFileTypes: true })).slice(0, 4096)) {
          if (!entry.isFile() || !entry.name.endsWith('.mov')) continue;
          const id = entry.name.slice(0, -4);
          if (SYSTEM_ID.test(id)) present.add(id);
        }
      } catch { /* No downloaded wallpaper folder on this machine. */ }
    }
    const order = SYSTEM_VIDEOS.map(item=>item.id);
    const items = [...present].map(id => ({ id, name:names.get(id.toUpperCase()) || `Mac wallpaper · ${id.slice(0, 8)}` }));
    const counts = new Map();
    for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + 1);
    for (const item of items) if (counts.get(item.name) > 1) item.name = displayName(`${item.name.slice(0, 105)} · ${item.id.slice(0, 8)}`);
    return items.sort((a,b) => {
      const aIndex = order.indexOf(a.id.toUpperCase()), bIndex = order.indexOf(b.id.toUpperCase());
      if (aIndex >= 0 || bIndex >= 0) return (aIndex < 0 ? Infinity : aIndex) - (bIndex < 0 ? Infinity : bIndex);
      return a.name.localeCompare(b.name, locale === 'en' ? 'en' : 'zh-CN');
    });
  }

  async systemWallpapers(locale = 'zh') {
    const result = [];
    for (const item of await this._systemItems(locale)) {
      const available = await this._systemFile(item);
      if (available) result.push({ id: item.id, name: item.name, bytes: available.bytes });
    }
    return result;
  }

  async importSystemVideo(id, { signal, locale = 'zh' } = {}) {
    abortIfNeeded(signal);
    const item = typeof id === 'string' && SYSTEM_ID.test(id) && (await this._systemItems(locale)).find(candidate => candidate.id === id);
    if (!item) throw safeError('That system wallpaper is not in the local wallpaper list.');
    const available = await this._systemFile(item);
    abortIfNeeded(signal);
    if (!available) throw safeError('That system wallpaper has not been downloaded on this Mac.');
    return this.importFile(available.filePath, { name: item.name, sourceKey: `system:${this.prepareSystemVideo ? 'h264-v1:' : ''}${id}`, signal, prepare:this.prepareSystemVideo });
  }

  async respond({ url, method, headers, signal } = {}) {
    let opened;
    try {
      abortIfNeeded(signal);
      if (typeof url !== 'string') return emptyResponse(404);
      const prefixes = [`open-sea-media://${this.token}/`, `https://127.0.0.1/open-sea-media/${this.token}/`];
      const prefix = prefixes.find(value => url.startsWith(value));
      const id = prefix ? url.slice(prefix.length) : '';
      if (!ID.test(id)) return emptyResponse(404);
      if (method !== 'GET' && method !== 'HEAD') return emptyResponse(405);
      await this.init();abortIfNeeded(signal);
      const entry = this._entries.get(id);
      if (!entry) return emptyResponse(404);
      try { opened = await this._openManaged(entry, signal); }
      catch (error) { abortIfNeeded(signal);return emptyResponse(404); }
      const responseHeaders = [
        { name: 'Content-Type', value: entry.mime }, { name: 'Accept-Ranges', value: 'bytes' }, { name: 'Cache-Control', value: 'no-store' },
      ];
      if (method === 'HEAD') return { responseCode: 200, responseHeaders: [...responseHeaders, { name: 'Content-Length', value: String(entry.bytes) }] };
      const range = readRange(headers, entry.bytes);
      if (!range) return emptyResponse(416, [{ name: 'Content-Range', value: `bytes */${entry.bytes}` }, { name: 'Accept-Ranges', value: 'bytes' }]);
      const buffer = Buffer.alloc(range.end - range.start + 1);
      if (await readInto(opened.file, buffer, range.start, signal) !== buffer.length) return emptyResponse(500);
      return { responseCode: 206, responseHeaders: [...responseHeaders,
        { name: 'Content-Length', value: String(buffer.length) }, { name: 'Content-Range', value: `bytes ${range.start}-${range.end}/${entry.bytes}` },
      ], body: buffer.toString('base64') };
    } catch (error) {
      if (error?.code === 'ABORT_ERR') throw error;
      return emptyResponse(500);
    } finally { await opened?.file.close().catch(() => {}); }
  }
}
