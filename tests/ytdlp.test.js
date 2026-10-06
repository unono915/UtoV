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

test('full downloads do not receive FFmpeg HTTP-only options', () => {
  const { api } = load();
  assert.equal(api.buildArgs({ ...job, trim: { enabled: false } }, {}, 'result.txt').includes('--downloader-args'), false);
});

test('a second job targeting the same output is rejected until the first exits', () => {
  const { api, children } = load();
  api.start(job, {}, () => {});
  assert.throws(() => api.start({ ...job, height: '720', trim: { ...job.trim, start: 521.8 } }, {}, () => {}), /진행 중/);
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
  const name = 'fixture [00-08-41~00-15-45]';
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
