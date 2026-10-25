// Rebuild packaging assets from the existing Open Sea vector mark.
// Usage: node scripts/build-icons.mjs
// Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const assetsDir = path.join(projectRoot, 'assets');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const iconsetEntries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

async function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (executablePath) return chromium.launch({ executablePath, headless: true });
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    try {
      return await chromium.launch({ headless: true });
    } catch (cause) {
      throw new Error('No usable Chrome/Chromium was found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to an installed browser; this script does not download one.', { cause });
    }
  }
}

function makeIco(images) {
  // ICONDIR followed by ICONDIRENTRY records and PNG-compressed image payloads.
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    // Palette and reserved bytes remain zero for RGBA PNG entries.
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Building icons requires Node.js 22 or later.');
  const svg = await fs.readFile(path.join(assetsDir, 'icon.svg'), 'utf8');
  if (!/<svg\b/u.test(svg)) throw new Error('assets/icon.svg does not contain an SVG element.');

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-open-sea-icons-'));
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1024, height: 1024 } });
    // Rendering is entirely local; block any accidental external SVG resource.
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
      body>svg{display:block;width:100%;height:100%}
      </style></head><body>${svg}</body></html>`, { waitUntil: 'load' });
    const rendered = new Map();
    async function render(size) {
      if (rendered.has(size)) return rendered.get(size);
      await page.setViewportSize({ width: size, height: size });
      const png = await page.screenshot({ type: 'png', omitBackground: true, animations: 'disabled', scale: 'css' });
      rendered.set(size, png);
      return png;
    }

    await fs.writeFile(path.join(temporary, 'icon.png'), await render(1024));
    const icoImages = [];
    for (const size of icoSizes) icoImages.push({ size, png: await render(size) });
    await fs.writeFile(path.join(temporary, 'icon.ico'), makeIco(icoImages));

    const outputNames = ['icon.png', 'icon.ico'];
    if (process.platform === 'darwin') {
      const iconsetDir = path.join(temporary, 'OpenSea.iconset');
      await fs.mkdir(iconsetDir);
      for (const [name, size] of iconsetEntries) await fs.writeFile(path.join(iconsetDir, name), await render(size));
      try {
        await execFileAsync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(temporary, 'icon.icns')], { timeout: 30000 });
      } catch (cause) {
        throw new Error('macOS iconutil could not create icon.icns; packaging icons were not updated.', { cause });
      }
      outputNames.push('icon.icns');
    }

    // Stage all formats before replacing assets, so conversion failure preserves
    // the last usable set rather than silently leaving mixed icon generations.
    for (const name of outputNames) await fs.copyFile(path.join(temporary, name), path.join(assetsDir, name));
    console.log(`Generated ${outputNames.map((name) => `assets/${name}`).join(', ')}.`);
    if (process.platform !== 'darwin') console.log('Skipped ICNS generation: macOS iconutil is required. Any existing assets/icon.icns was left unchanged.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
