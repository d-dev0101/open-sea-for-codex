import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Only our bundled helper is executed, with separate arguments and a private
// temporary output. No shell, downloads, ffmpeg installation or system changes.
export async function convertMacWallpaper(input, { executable, signal, onProgress = () => {}, timeoutMs = 600000 } = {}) {
  if (signal?.aborted) throw new DOMException('Video conversion canceled.', 'AbortError');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-convert-'));
  await fs.chmod(directory, 0o700);
  const output = path.join(directory, 'wallpaper.mp4');
  const cleanup = () => fs.rm(directory, { recursive:true, force:true });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--input', input, '--output', output], {stdio:['ignore','pipe','pipe']});
      let partial = '', stopping = false, killTimer, cause;
      const stop = error => {
        if (stopping) return;
        stopping = true;cause = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        killTimer.unref();
      };
      const abort = () => stop(new DOMException('Video conversion canceled.', 'AbortError'));
      const timeout = setTimeout(() => stop(new Error('Video conversion timed out.')), timeoutMs);
      timeout.unref();
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => {
        partial = (partial + chunk).slice(-4096);
        const lines = partial.split('\n');partial = lines.pop();
        for (const line of lines) {
          try { const progress = JSON.parse(line).progress;if (Number.isFinite(progress)) onProgress(Math.max(0,Math.min(100,Math.round(progress)))); } catch { /* Non-progress output is ignored. */ }
        }
      });
      child.stderr.resume();
      child.once('error', error => { cause = new Error(error.code === 'ENOENT' ? 'The bundled Mac video converter is missing. Reinstall Open Sea.' : 'The local video converter could not start.'); });
      child.once('close', code => {
        clearTimeout(timeout);clearTimeout(killTimer);signal?.removeEventListener('abort', abort);
        if (cause) reject(cause);
        // Do not leak local source paths from AVFoundation diagnostics to UI.
        else if (code !== 0) reject(new Error(`Local video conversion failed (code ${code}).`));
        else resolve();
      });
    });
    return { filePath:output, cleanup };
  } catch (error) { await cleanup();throw error; }
}
