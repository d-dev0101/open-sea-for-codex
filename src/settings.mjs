export const DEFAULTS = Object.freeze({ theme: 'ocean', wave: 56, daylight: 55, opacity: 40, paused: false, locale: 'zh', imageData: null,
  videoId:null, videoName:null, videoUrl:null });
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_STORED_IMAGE_BYTES = 2 * 1024 * 1024;
export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skin settings.');
  const result = { ...DEFAULTS };
  for (const key of ['wave', 'daylight', 'opacity']) {
    const n = value[key] ?? DEFAULTS[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`Invalid ${key}.`);
    result[key] = Math.round(Math.min(key === 'opacity' ? 90 : 100, Math.max(key === 'opacity' ? 15 : 0, n)));
  }
  result.theme = ['ocean', 'aurora', 'dunes', 'coast', 'custom', 'video'].includes(value.theme) ? value.theme : DEFAULTS.theme;
  result.locale = value.locale === 'en' ? 'en' : 'zh';
  result.paused = value.paused === true;
  if (value.imageData != null) {
    if (typeof value.imageData !== 'string' || value.imageData.length > Math.ceil(MAX_STORED_IMAGE_BYTES / 3) * 4 + 32 ||
      !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.imageData)) {
      throw new Error('The prepared wallpaper is too large or invalid. Import the original image again.');
    }
    const encoded = value.imageData.slice(value.imageData.indexOf(',') + 1);
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.length % 4 !== 0 || encoded.length / 4 * 3 - padding > MAX_STORED_IMAGE_BYTES) throw new Error('The prepared wallpaper exceeds 2 MiB.');
    result.imageData = value.imageData;
  }
  if (result.theme === 'custom' && !result.imageData) result.theme = 'ocean';
  if (value.videoId != null) {
    if (typeof value.videoId !== 'string' || value.videoId.length !== 32 || !/^[a-fA-F0-9]{32}$/.test(value.videoId)) throw new Error('Invalid local video ID.');
    result.videoId = value.videoId;
  }
  if (value.videoName != null) {
    if (typeof value.videoName !== 'string' || value.videoName.length > 120) throw new Error('Invalid local video name.');
    result.videoName = value.videoName.trim() || null;
  }
  if (value.videoUrl != null) {
    const match = typeof value.videoUrl === 'string'
      && /^https:\/\/127\.0\.0\.1\/open-sea-media\/([a-fA-F0-9]{32})\/([a-fA-F0-9]{32})$/.exec(value.videoUrl);
    if (!match || match[0] !== value.videoUrl || match[2] !== result.videoId) throw new Error('Invalid local video URL.');
    result.videoUrl = value.videoUrl;
  }
  if (result.theme === 'video' && !result.videoId) result.theme = 'ocean';
  return result;
}

export function rasterMime(buffer) {
  if (buffer.length < 12 || buffer.length > MAX_IMAGE_BYTES) throw new Error('Image must be smaller than 10 MB.');
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Only real PNG, JPEG or WebP images are supported (not SVG or HTML).');
}
