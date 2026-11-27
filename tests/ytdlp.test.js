'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function load(postprocess = {}) {
  const children = [];
  const filename = path.resolve('src/main/ytdlp.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
    require(id) {
      if (id === './paths') return { ytdlpPath: () => 'yt-dlp', ffmpegDir: () => null, jsRuntime: () => null };
      if (id === './postprocess') return postprocess;
      if (id === 'node:child_process') return {
        spawn(_exe, args) {
          const child = new EventEmitter();
          child.args = args;
          child.stdout = new PassThrough(); child.stderr = new PassThrough();
          children.push(child);
          return child;
        },
        execFile() {},
      };
      return require(id);
    },
  }, { filename });
  return { api: module.exports, children };
}
const job = { url: 'https://www.youtube.com/watch?v=example', outDir: os.tmpdir(), mode: 'video', trim: { enabled: true, start: 521.29, end: 945 } };

test('trim jobs download through the native downloader before local cutting', () => {
  const { api } = load();
  const args = api.buildArgs(job, {}, 'result.txt');
  assert.equal(args.includes('--download-sections'), false);
  assert.equal(args.includes('--force-keyframes-at-cuts'), false);
  assert.ok(Number(args[args.indexOf('--socket-timeout') + 1]) > 0);
});

test('file name stamps keep milliseconds only when there are some', () => {
  const { api } = load();
  assert.equal(api.stamp(83), '00-01-23');
  assert.equal(api.stamp(83.456), '00-01-23.456');
  assert.equal(api.stamp(83.5), '00-01-23.500');
  assert.equal(api.stamp(3599.9996), '01-00-00');
  const args = api.buildArgs({ ...job, trim: { enabled: true, start: 1.25, end: 2.5 } }, {}, 'result.txt');
  assert.match(args[args.indexOf('-o') + 1], /\[00-00-01\.250~00-00-02\.500\]\.%\(ext\)s$/);
});

test('sub-second ranges are separate jobs, not duplicates', () => {
  const { api } = load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utov-ms-'));
  try {
    const a = api.start({ ...job, outDir: dir, trim: { enabled: true, start: 1.2, end: 3 } }, {}, () => {});
    const b = api.start({ ...job, outDir: dir, trim: { enabled: true, start: 1.7, end: 3 } }, {}, () => {});
    assert.notEqual(a, b);
    api.cancelAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video info reports frame rate per height', () => {
  const { api } = load();
  const info = api.shapeInfo({
    id: 'x', duration: 10,
    formats: [
      { height: 1080, fps: 60, vcodec: 'avc1' },
      { height: 1080, fps: 30, vcodec: 'vp9' },
      { height: 360, fps: 30, vcodec: 'avc1' },
      { height: null, fps: null, vcodec: 'none', acodec: 'mp4a' },
    ],
  });
  assert.deepEqual({ ...info.fpsByHeight }, { 1080: 60, 360: 30 });
  assert.equal(info.fpsBest, 60);
  // 세로 영상(쇼츠)은 가장 큰 H.264 가 1920 높이
  const short = api.shapeInfo({
    id: 'y', duration: 10,
    formats: [
      { height: 1920, fps: 60, vcodec: 'avc1.640032' },
      { height: 854, fps: 30, vcodec: 'avc1.4d401f' },
      { height: 2560, fps: 60, vcodec: 'vp09' },
    ],
  });
  assert.equal(short.fpsBest, 60);
});

test('full downloads do not receive FFmpeg HTTP-only options', () => {
  const { api } = load();
  assert.equal(api.buildArgs({ ...job, trim: { enabled: false } }, {}, 'result.txt').includes('--downloader-args'), false);
});

test('a second job targeting the same output is rejected until the first exits', () => {
  const { api, children } = load();
  api.start(job, {}, () => {});
  // 화질만 달라도 같은 이름의 파일이 생기므로 막는다
  assert.throws(() => api.start({ ...job, height: '720', trim: { ...job.trim } }, {}, () => {}), /진행 중/);
  // 1ms 미만 차이는 같은 파일이름이 되므로 역시 막는다
  assert.throws(() => api.start({ ...job, trim: { ...job.trim, start: 521.2901 } }, {}, () => {}), /진행 중/);
  children[0].emit('close', 1);
  assert.doesNotThrow(() => api.start(job, {}, () => {}));
  children.at(-1).emit('close', 1);
});

test('duplicate protection and cancellation remain active during local cutting', async () => {
  let abortCut;
  const events = [];
  const { api, children } = load({
    trimFile: () => new Promise((_resolve, reject) => { abortCut = reject; }),
  });
  const id = api.start(job, {}, e => events.push(e));
  const args = children[0].args;
  const output = args[args.indexOf('-o') + 1].replace('%(title).80s', 'fixture').replace('%(ext)s', 'mp4');
  fs.writeFileSync(output, 'downloaded source');
  children[0].stdout.write('[download] Destination: ' + output + '\n');
  children[0].emit('close', 0);
  assert.throws(() => api.start(job, {}, () => {}), /진행 중/);
  assert.equal(api.cancel(id), true);
  abortCut(new Error('cut interrupted'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).type, 'canceled');
  assert.equal(events.some(e => e.type === 'done'), false);
  assert.equal(api.cancel(id), false);
});

test('completed clips preserve existing outputs and publish their sidecar subtitles', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utov-publish-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'fixture [00-08-41.290~00-15-45]';
  fs.writeFileSync(path.join(dir, name + '.mp4'), 'existing clip');
  const { api, children } = load({
    async trimFile(source, target) { fs.copyFileSync(source, target); },
    async findSubtitleNextTo(file) {
      const srt = file.replace(/\.mp4$/, '.en.srt');
      return fs.existsSync(srt) ? srt : null;
    },
    async retimeSrt() {},
    async verify() { return { ok: true, duration: 423.7, codecs: { video: 'h264', audio: 'aac' }, warnings: [] }; },
  });
  let terminal;
  const completed = new Promise(resolve => { terminal = resolve; });
  api.start({ ...job, outDir: dir, subs: 'file', subLang: 'en' }, {}, e => {
    if (['done', 'error'].includes(e.type)) terminal(e);
  });
  const args = children[0].args;
  const source = args[args.indexOf('-o') + 1].replace('%(title).80s', 'fixture').replace('%(ext)s', 'mp4');
  fs.writeFileSync(source, 'new clip');
  fs.writeFileSync(source.replace(/\.mp4$/, '.en.srt'), 'subtitle');
  children[0].stdout.write('[download] Destination: ' + source + '\n');
  children[0].emit('close', 0);
  const event = await completed;
  assert.equal(event.type, 'done');
  assert.equal(fs.readFileSync(path.join(dir, name + '.mp4'), 'utf8'), 'existing clip');
  assert.equal(path.basename(event.file), name + ' (1).mp4');
  assert.equal(fs.readFileSync(event.file, 'utf8'), 'new clip');
  assert.equal(fs.readFileSync(path.join(dir, name + ' (1).srt'), 'utf8'), 'subtitle');
});
