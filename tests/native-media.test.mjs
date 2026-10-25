import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { buildMacMedia } from '../scripts/build-mac-media.mjs';

const execute = promisify(execFile);
// Generated blue 32x32 H.264 clip, 60 fps for one second; no external/private media.
const fixture = gunzipSync(Buffer.from('H4sIAAAAAAAAE+1VT2hcRRj/Nk1DWjRYSVChlNHm5u5m3tvNWtcOZltiU6hWClZE4TFvZl72Ne9fZiab3V5apIh69FCxheQgYi21N+nBP/TQkx68GvWgCNJSUMFLrTQr8/bFfZtoEU8qDjs7M998v+833/e9+QYAkKc7ia/iEGAIzOir2KYtZoVJ1QKAUU8KATCyI+RUAwxdHtne7V78evbGx9+vzV05W/wCre394ce2XauiEmKxFMiqTSNZse0KwtV9mLkYldBc2a5Vp55+dvZQqYoaxw8iFnPBUAkdjJNOIDyNbIwrJRvb06iEmlon9amp5eXlcsvnIg5oVI7l/JRhKTd1GKASihPtx5GqI0ZdyoiFpPBIBXHhBjFbIFYd1zGiEQ06ShDcrtRx27IqKBSkKdpILbmhII+hRHWIZf4dyYlVxriOyxij0G8L7hiLFgqFI2k0L4hVQ6wp45A6oSAW0lIEga+Ihfa193GmiYXYYkgw4oLyk3EkiG0VLQt5VGknUQt+YjR6BhYTJ/Y8JTQp2Ug3paDcGArieIE2BeVOX6YCn4m+AKNIphzMD6k25/AjLWRAmeAEIzdYkrTjsDhMqCYYsThSWlI/EtzxIy2p0fEkDYUiFeQ6SUfS0OfERq5DOU2MF67j+tQwcV+K1K9l4c83tUssFCcicubjhOBMmBAbLYiOH2liT+Ns6oR+ROxppJiIBFvSpIpRym5CKoVqEowkc3531+xLRpj0UOhqKYxbTHrErpQxWjTOEFyuYbSYGMPpSNuk9jhaTJQWCakiP3Ek1X5MrHIVI7pIrLrJJpwGgIfEq2dgqrv+1Ys/Fy8ee/39sadu4zfuzPOX75jPu3FuMjjQXX8zna8caJ855TXMvLBC9aFuPNObsxOHurGRjzXONQ9faDTfOjLq9FA7GyuvzO4q7u1u4N7Rme5oYeXdE5mNsca5S4cvNIIB3KezEzncjRzfzRzup8241bE8brXU51ud6uPOV7fgjg3gFvt8qyqHa2/Bne3hMt0PcnxX+nE5/9EW3JcDfL/k+H7N4b7ZEpc9eb4VkovLk7k8TG7BHRiI593yF2zK38Q/OH/Pd9eP/538He2uH/3L+bu3cf7DDNddLwLAjsbq2uxE8dSG5u2MYQTCOG4BQBC2mhwG2rbraS+A+fVbYVBr83oG7tqGALY/qiVdAICX9ELKuW2rNcN9d54/5EVZB5gUXCsA2C0CpfsIY3coww6/HXKfGkTIN/u+P+3PXUsXpSYP5MaOecLymsfNkzZHIx4IozP8TOhHHgCMt8LUaP6Yk7y3t5tL4eXcuGdJBqg3Hx5T2g0A4BOlFc/pXDav+J+EwjiNYA4g7anGxBHaYjW7bFllC2MU+K55bnOIB7tdAKjSFjtY4LCz+y08MM9h56W1w8HwjMnJDMCebddeE6cLMNK8+d1nj1y9c+uWQd6XUJVkpzB93NUyCzEe3bCudBr+jdPuzw49rrTKy83HdZ31dZ/oyYay/e0wuN7AFf7f/1fsDwP079tupRUbzH16z4z+sNLqJPTbfoChz83N2NTvN0XxP7TeZYp1Nh9XmsW5+GAAoEtcmxL1QijS0bSH8+Uo5L6kSRLkYgdFv1fzJt/TcZyWG5qC0ywcoS2vZpcrpiz8BsRay34xDAAA', 'base64'));

// Generated blue 32x32 HEVC, 120 fps / one second, all-intra (no inter-frame
// dependencies). Temporal sample groups retain every fourth frame at level 0.
// This is synthetic test media, never a bundled Apple wallpaper.
const temporalFixture = gunzipSync(Buffer.from('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CZmQCZmQCZmQCZmQCZmQCZncmEMmZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImv2VCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJjfmkAmZkAmZkAmZkAmZzDIhEzIhEzIhEzIhEzKZZUImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImZEImfzGHTMiETMiETMiETMhklgmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkMlvmZAJmZAJmZAJmZAJmZAJmZAJmZAJmZAJmZAJmdyYQyZkQiZkQiZkQiZkMsuETMiETMiETMiETMhklgmZkAmZkAmZkAmZkMksEzIhEzIhEzIhEzIhEzIhEzIhEzIhEzIhEzK5MYdMyIRMyIRMyIRMyGSWCZmQCZmQCZmQCZmQCZnMMiETMiETMiETMiETMpllQiZkQiZkQiZkQiZkQiZkQiZkQiZkQiZkQiY35pAJmZAJmZAJmZAJmcwyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIZMbc8iETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMjkt0zIhEzIhEzIhEzIhEzIhEzIhEzIhEzIhEzI5MYcMiETMiETMiETMiGTWSZkQiZkQiZkQiZkQiazTMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMjkL+aQCZmQCZmQCZmQCZnMMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMiETMvktEzIhEzIhEzIhEzIhEzIhEzIhEzIhEzIhEzIhkxtzyIRMyIRMyIRMyIRMZpmQCZmQCZmQCZmQCZnMMiETMiETMiETMiETMpllQiZkQiZkQiZkQiZkQiZkQiZkQiZkQiZkQiY35pAJmZAJmZAJmZAJmcwyIRMyIRMyIRMyIRMyIZNZJmRCJmRCJmRCJmRCJrNMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyOTGHDIhEzIhEzIhEzIhk1kmZEImZEImZEImZEImZEImZEImZEImZEImZHJjDpmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZn8lgmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZkAmZ3JhDJmRCJmRCJmRCJmQyy4RMyIRMyIRMyIRMyGSWCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZmQCZn8xRwyIRMyIRMyIRMyIZNZJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJmRCJr9lQiZkQiZkQiZkQiZkQiZkQiZkQiZkQiZkQiZkcmMOmZAJmZAJmZAJmZDJLBMyIRMyIRMyIRMyIZNZJmRCJmRCJmRCJmRCJrNMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyOTGHDIhEzIhEzIhEzIhk1kmZEImZEImZEImZEImZDLLhEzIhEzIhEzIhEzIZJYJmZAJmZAJmZAJmZAJmZAJmZAJmZAJmZAJmdyYQyZkQiZkQiZkQiZkMsuETMiETMiETMiETMiETMiETMiETMiETMiETG7MIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIZPfMiETMiETMiETMiETMiETMiETMiETMiETMiGTG3PIhEzIhEzIhEzIhExmmZAJmZAJmZAJmZAJmcwyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMyIRMybcj00k9iTD6NncvV6aKK5ezH1/7939JzNrv24fTcmaX/l4+nNj67fW/2Kx/X4piPo/sfxPofjQ+mY/7G5THPS0vH/tXHeeZxs+1zNnt3jL6I5Y1yWR/Nnt53o+vbz6TV68+kvVpX4xDLL9XLYbw86rZu0/F//W9XVVOkd6yqZ7fft/51yj1fVMs+rawWyz4NYEXXLc/r/vl3QoTZ+3UUlX07DW5R8DdjUEkVunG6mgremd377iz9i8ed88KqKKyIQeRqYS9fKezdYiyy+8W6WtYp/6vVpswvVf22UTan8VIqY7P+4o+G8TDKevELwzhUl3le3FmclvOrTf/1r7//h1N/pmcW/+7H6v3zHF98rzgtb+/vzue787gIls1h4u2V/vqtJ09C7H8epb6zc/35SPjLv0nJr/x09un//OIXERTXvxfHefnezks7T56kDM9NOZ6LLP947d5fxb4vf21n5+kd3/va899Z/917P9hZTMnp5bkf3vt+5P21d3f+efjhn315tuNLgi8JviT4kuBLgi8JviT4kuBLwlNfEl5MFZ189/nI322xl573huOuSivjUCZs3pjkd0Xhr5zb7xlp8fjdcjhezS7fnx7Xt2Wn5ePf/J3EwmGczH3OzMfx/Fwia3C0vJJ+vi8tb8S+Tza7Xnhzmx5pZXsl/6v/C9Q65KP4XAQA', 'base64'));

function boxes(data) {
  const result = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    let size = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const header = size === 1 ? 16 : 8;
    if (size === 1) size = Number(data.readBigUInt64BE(offset + 8));
    if (size === 0) size = data.length - offset;
    assert.ok(size >= header && offset + size <= data.length, `invalid ${type} box`);
    result.push({ type, data: data.subarray(offset + header, offset + size) });
    offset += size;
  }
  return result;
}

function child(data, type) {
  const value = boxes(data).find((box) => box.type === type);
  assert.ok(value, `${type} box is present`);
  return value.data;
}

test('macOS native helper builds and performs safe local H.264 conversion', {
  skip: process.platform !== 'darwin' ? 'Requires Apple AVFoundation and the macOS SDK.' : false,
  timeout: 240000,
}, async (t) => {
  const executable = await buildMacMedia();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sea-native-media-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'source with spaces.mp4');
  await fs.writeFile(input, fixture);
  const output = path.join(root, 'result with spaces.mp4');
  const args = (source = input, target = output) => ['--input', source, '--output', target];
  async function rejects(argv, code, message) {
    await assert.rejects(execute(executable, argv, { timeout: 20000 }), (error) => {
      assert.equal(error.code, code);
      assert.match(error.stderr, message);
      return true;
    });
  }

  await t.test('compiled binary contains both architectures and a valid signature', async () => {
    await execute('/usr/bin/lipo', [executable, '-verify_arch', 'arm64', 'x86_64']);
    await execute('/usr/bin/codesign', ['--verify', '--strict', executable]);
  });

  await t.test('argument and input failures use stable statuses without creating output', async () => {
    await rejects([], 64, /usage:/u);
    await rejects(args('https://example.invalid/video.mov'), 64, /usage:/u);
    await rejects(args('relative.mov'), 64, /usage:/u);
    await rejects(args(path.join(root, 'missing.mov')), 66, /readable local regular file/u);
    await rejects(args(root), 66, /readable local regular file/u);
    await rejects(args(input, path.join(root, 'wrong.webm')), 64, /\.mp4 extension/u);
    await rejects(args(input, path.join(root, 'missing', 'video.mp4')), 73, /existing writable directory/u);
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
  });

  await t.test('existing files, broken symlinks, and work directories are preserved', async () => {
    await fs.writeFile(output, 'keep this file');
    await rejects(args(), 73, /already exists/u);
    assert.equal(await fs.readFile(output, 'utf8'), 'keep this file');
    await fs.unlink(output);
    await fs.symlink(path.join(root, 'missing-target'), output);
    await rejects(args(), 73, /already exists/u);
    assert.equal(await fs.readlink(output), path.join(root, 'missing-target'));
    await fs.unlink(output);
    await fs.mkdir(`${output}.open-sea-work`);
    await fs.writeFile(path.join(`${output}.open-sea-work`, 'keep'), 'owned elsewhere');
    await rejects(args(), 73, /exclusively create/u);
    assert.equal(await fs.readFile(path.join(`${output}.open-sea-work`, 'keep'), 'utf8'), 'owned elsewhere');
    await fs.rm(`${output}.open-sea-work`, { recursive: true });
  });

  await t.test('invalid media leaves the source and destination directory intact', async () => {
    const invalid = path.join(root, 'invalid.mov');
    await fs.writeFile(invalid, 'not a movie');
    await rejects(args(invalid), 65, /no readable video track/u);
    assert.equal(await fs.readFile(invalid, 'utf8'), 'not a movie');
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    await assert.rejects(fs.stat(`${output}.open-sea-work`), { code: 'ENOENT' });
  });

  await t.test('proven high-frame-rate HEVC is reduced before decode without losing time or audio isolation', async () => {
    const source = path.join(root, 'temporal.mov'), target = path.join(root, 'temporal-result.mp4');
    await fs.writeFile(source, temporalFixture);
    const { stdout, stderr } = await execute(executable, args(source, target), { timeout: 30000 });
    assert.match(stderr, /temporal optimization retained 30 of 120 frames/u);
    assert.doesNotMatch(stderr, /using full decode/u);
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { progress: 100, complete: true });
    const movie = child(await fs.readFile(target), 'moov');
    const tracks = boxes(movie).filter(box => box.type === 'trak');
    assert.equal(tracks.length, 1);
    const media = child(tracks[0].data, 'mdia');
    const samples = child(child(media, 'minf'), 'stbl');
    assert.equal(child(samples, 'stsd').toString('ascii', 12, 16), 'avc1');
    assert.equal(child(samples, 'stsz').readUInt32BE(8), 30);
    const timing = child(media, 'mdhd');
    assert.equal(timing.readUInt32BE(16) / timing.readUInt32BE(12), 1);
    assert.deepEqual(await fs.readFile(source), temporalFixture);
    await assert.rejects(fs.stat(`${target}.open-sea-work`), { code: 'ENOENT' });
  });

  await t.test('HEVC without explicit temporal dependency metadata uses the full-decode fallback', async () => {
    const source = path.join(root, 'unknown-hevc.mov'), target = path.join(root, 'fallback-result.mp4');
    const unknown = Buffer.from(temporalFixture);
    // Replace the valid generated sample-group boxes with free space; the HEVC
    // stream is unchanged, but no container dependency claims remain to trust.
    for (const type of ['sgpd', 'sbgp', 'csgm']) {
      for (let at = unknown.indexOf(type); at !== -1; at = unknown.indexOf(type, at + 4)) unknown.write('free', at, 'ascii');
    }
    await fs.writeFile(source, unknown);
    const { stderr } = await execute(executable, args(source, target), { timeout: 30000 });
    assert.doesNotMatch(stderr, /temporal optimization/u);
    const track = child(child(await fs.readFile(target), 'moov'), 'trak');
    const media = child(track, 'mdia');
    assert.equal(child(child(child(media, 'minf'), 'stbl'), 'stsz').readUInt32BE(8), 30);
    const timing = child(media, 'mdhd');
    assert.equal(timing.readUInt32BE(16) / timing.readUInt32BE(12), 1);
    assert.deepEqual(await fs.readFile(source), unknown);
    await assert.rejects(fs.stat(`${target}.open-sea-work`), { code: 'ENOENT' });
  });

  await t.test('real export contains H.264 video only at 30 fps and cleans its work directory', async () => {
    const { stdout } = await execute(executable, args(), { timeout: 30000 });
    const events = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.at(-1), { progress: 100, complete: true });
    const movie = child(await fs.readFile(output), 'moov');
    const tracks = boxes(movie).filter((box) => box.type === 'trak');
    assert.equal(tracks.length, 1, 'exactly one video track, no audio');
    const track = tracks[0].data;
    const header = child(track, 'tkhd');
    assert.equal(header.readUInt32BE(header.length - 8) / 65536, 32);
    assert.equal(header.readUInt32BE(header.length - 4) / 65536, 32);
    const media = child(track, 'mdia');
    assert.equal(child(media, 'hdlr').toString('ascii', 8, 12), 'vide');
    const samples = child(child(media, 'minf'), 'stbl');
    assert.equal(child(samples, 'stsd').toString('ascii', 12, 16), 'avc1');
    assert.equal(child(samples, 'stsz').readUInt32BE(8), 30, '60 input frames become 30 output frames');
    const timing = child(media, 'mdhd');
    assert.equal(timing[0], 0);
    assert.equal(timing.readUInt32BE(16) / timing.readUInt32BE(12), 1, 'duration is preserved');
    assert.deepEqual(await fs.readFile(input), fixture, 'input bytes are unchanged');
    await assert.rejects(fs.stat(`${output}.open-sea-work`), { code: 'ENOENT' });
  });
});
