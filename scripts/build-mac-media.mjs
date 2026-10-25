// Package-time build only. The distributed app executes this signed universal
// helper directly and never invokes Xcode, Swift, a shell, or a downloaded codec.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildMacMedia({ outputDirectory = path.join(root, 'dist/native') } = {}) {
  if (process.platform !== 'darwin') {
    console.log('Skipped macOS video helper: Apple SDK build requires a macOS host.');
    return null;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-native-build-'));
  try {
    const { stdout } = await execute('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { timeout: 30000 });
    const sdk = stdout.trim();
    if (!path.isAbsolute(sdk)) throw new Error('xcrun did not return an absolute macOS SDK path.');
    const source = path.join(root, 'src/native/convert-video.swift');
    const slices = [];
    for (const architecture of ['arm64', 'x86_64']) {
      const slice = path.join(directory, architecture);
      await execute('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '5', '-sdk', sdk,
        '-target', `${architecture}-apple-macosx12.0`, '-module-cache-path', path.join(directory, 'module-cache'),
        '-framework', 'AVFoundation', source, '-o', slice], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      slices.push(slice);
    }
    const universal = path.join(directory, 'open-sea-convert-video');
    await execute('/usr/bin/lipo', ['-create', ...slices, '-output', universal], { timeout: 30000 });
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'io.github.ddev0101.codexopensea.convert-video', universal], { timeout: 30000 });
    await execute('/usr/bin/lipo', [universal, '-verify_arch', 'arm64', 'x86_64'], { timeout: 30000 });
    await execute('/usr/bin/codesign', ['--verify', '--strict', universal], { timeout: 30000 });
    await fs.mkdir(outputDirectory, { recursive: true });
    const output = path.join(outputDirectory, 'open-sea-convert-video');
    await fs.copyFile(universal, output);
    await fs.chmod(output, 0o755);
    console.log('Built and verified universal arm64/x86_64 macOS video helper.');
    return output;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildMacMedia().catch((error) => {
    console.error(error.message);
    if (error.stderr) console.error(error.stderr);
    process.exitCode = 1;
  });
}
