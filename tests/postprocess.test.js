'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const bin = process.env.UTOV_TEST_BIN || path.join(process.env.APPDATA || '', 'UtoV', 'bin');
const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const moduleStub = { exports: {} };
vm.runInNewContext(fs.readFileSync('src/main/postprocess.js', 'utf8'), {
  module: moduleStub, process, Buffer,
  require: id => id === './paths' ? { findExe: exe } : require(id),
});
const api = moduleStub.exports;

test('local precise cut produces the requested duration with video and audio', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utov-cut-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  execFileSync(exe('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '5', '-c:v', 'libx264', '-c:a', 'aac', source]);
  const output = path.join(dir, 'clip.mp4');
  const progress = [];
  await api.trimFile(source, output, { mode: 'video', precise: true, trim: { start: 1.25, end: 3.75 } }, () => {}, seconds => progress.push(seconds));
  const result = await api.verify(output, { mode: 'video', expectSeconds: 2.5 });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.duration - 2.5) < 0.15);
  assert.equal(result.codecs.video, 'h264');
  assert.equal(result.codecs.audio, 'aac');
  assert.ok(progress.some(seconds => seconds > 0));
  assert.ok(fs.existsSync(source));

  await t.test('millisecond starts begin at the first frame after that time', async () => {
    // 25fps 라 프레임은 0.04초 간격. 1.234 는 30번(1.20)과 31번(1.24) 사이다.
    const ms = path.join(dir, 'ms.mp4');
    await api.trimFile(source, ms, { mode: 'video', precise: true, trim: { start: 1.234, end: 2.5 } }, () => {}, () => {});
    const compare = (frame) => execFileSync(exe('ffmpeg'), ['-v', 'error', '-i', ms, '-i', source, '-lavfi',
      `[0:v]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=${frame}:end_frame=${frame + 1},setpts=PTS-STARTPTS[b];[a][b]psnr=stats_file=-`,
      '-f', 'null', '-'], { encoding: 'utf8' }).match(/psnr_avg:([\d.]+|inf)/)[1];
    const psnr = (frame) => { const v = compare(frame); return v === 'inf' ? Infinity : Number(v); };
    // 첫 장면은 31번 프레임과 거의 같고, 30번과는 다르다
    assert.ok(psnr(31) > psnr(30) + 10, `31번 ${psnr(31)} / 30번 ${psnr(30)}`);
    const result = await api.verify(ms, { mode: 'video', expectSeconds: 1.266 });
    assert.ok(Math.abs(result.duration - 1.266) < 0.05, `길이 ${result.duration}`);
  });
  await t.test('ffmpeg receives clean millisecond values', () => {
    assert.equal(api.secondsArg(2.345 - 1), '1.345');
    assert.equal(api.secondsArg(83.46999999), '83.470');
    assert.equal(api.secondsArg(5), '5.000');
  });
  await t.test('audio-only cuts remain playable MP3', async () => {
    const audio = path.join(dir, 'clip.mp3');
    await api.trimFile(source, audio, { mode: 'audio', trim: { start: 1, end: 3 } }, () => {}, () => {});
    const result = await api.verify(audio, { mode: 'audio', expectSeconds: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.codecs.audio, 'mp3');
    assert.ok(Math.abs(result.duration - 2) < 0.15);
  });
  await t.test('fast cuts preserve playable video and audio', async () => {
    const fast = path.join(dir, 'fast.mp4');
    await api.trimFile(source, fast, { mode: 'video', precise: false, trim: { start: 0, end: 3 } }, () => {}, () => {});
    const result = await api.verify(fast, { mode: 'video', expectSeconds: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.codecs.audio, 'aac');
  });
  await t.test('the registered cutting process can actually be terminated', async () => {
    let processHandle;
    await assert.rejects(api.trimFile(source, path.join(dir, 'canceled.mp4'),
      { mode: 'video', trim: { start: 0, end: 5 } },
      child => { processHandle = child; child.kill(); }, () => {}));
    assert.equal(processHandle.killed, true);
  });
});
