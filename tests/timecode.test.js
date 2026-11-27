'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roundMs, hmsMs, parseTime, stepFrame, previewTime, fpsFor } = require('../src/renderer/timecode.js');

test('times are shown with milliseconds', () => {
  assert.equal(hmsMs(0), '00:00:00.000');
  assert.equal(hmsMs(83.456), '00:01:23.456');
  assert.equal(hmsMs(3723.5), '01:02:03.500');
  // 반올림이 자리 올림으로 이어져도 60초가 되지 않는다
  assert.equal(hmsMs(59.9996), '00:01:00.000');
  assert.equal(hmsMs(-3), '00:00:00.000');
});

test('typed times keep milliseconds', () => {
  assert.equal(parseTime('1:23.456'), 83.456);
  assert.equal(parseTime('1:23,456'), 83.456);
  assert.equal(parseTime('00:01:23.5'), 83.5);
  assert.equal(parseTime('90'), 90);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('2.3456'), 2.346);
  assert.equal(parseTime(hmsMs(521.29)), 521.29);
});

test('unreadable times are rejected', () => {
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime('1:75'), null);
  assert.equal(parseTime('1:2:3:4'), null);
  assert.equal(parseTime('1.2.3'), null);
});

test('roundMs trims floating point noise', () => {
  assert.equal(roundMs(83.46999999), 83.47);
  assert.equal(roundMs(2.3456), 2.346);
  assert.equal(roundMs('x'), 0);
});

test('frame steps always move the cut by exactly one frame', () => {
  // 30fps: 2.345 에서 자르면 71번(2.367) 프레임부터. 한 칸 뒤는 72번, 앞은 70번.
  assert.equal(stepFrame(2.345, 30, 1), 2.4);
  assert.equal(stepFrame(2.345, 30, -1), 2.333);
  // 밀리초를 버린 값(2.366)은 71번 프레임 위로 본다
  assert.equal(stepFrame(2.366, 30, 1), 2.4);
  assert.equal(stepFrame(2.366, 30, -1), 2.333);
  // 프레임 바로 뒤(2.3675)는 ffmpeg 가 72번부터 자르므로 72번 기준으로 옮긴다
  assert.equal(stepFrame(2.3675, 30, 1), 2.433);
  assert.equal(stepFrame(2.3675, 30, -1), 2.366);
  // 25fps: 1.234 는 31번(1.24) 프레임부터. 앞으로 누르면 반드시 바뀐다.
  assert.equal(stepFrame(1.234, 25, 1), 1.28);
  // 백 번 앞으로 가도 정확히 백 프레임 뒤
  let t = 0;
  for (let i = 0; i < 100; i += 1) t = stepFrame(t, 30, 1);
  assert.equal(t, Math.floor((100 / 30) * 1000) / 1000);
  for (let i = 0; i < 100; i += 1) t = stepFrame(t, 30, -1);
  assert.equal(t, 0);
  assert.equal(stepFrame(0, 30, -1), 0);
  assert.equal(stepFrame(1, 60, 1), 1.016);
  // 프레임 수가 정수 밀리초가 아닌 경우에도 흐트러지지 않는다
  for (const fps of [23.976, 29.97, 59.94]) {
    let v = 0;
    for (let i = 0; i < 1000; i += 1) v = stepFrame(v, fps, 1);
    assert.equal(v, Math.floor((1000 / fps) * 1000 + 1e-6) / 1000, `${fps}fps`);
  }
});

test('the preview shows the frame the cut actually uses', () => {
  // 2.366 에서 시작하면 71번 프레임(2.3667~2.4)부터. 그 한가운데를 보여 준다.
  assert.ok(Math.abs(previewTime(2.366, 30, 'start') - 71.5 / 30) < 1e-9);
  // 끝이 2.4(72번 경계)면 마지막으로 들어가는 것은 71번 프레임
  assert.ok(Math.abs(previewTime(2.4, 30, 'end') - 71.5 / 30) < 1e-9);
  // 미리보기 시각을 다시 경계로 써도 같은 프레임을 가리킨다
  const shown = previewTime(2.366, 30, 'start');
  assert.equal(Math.floor(shown * 30), 71);
  assert.equal(previewTime(0, 30, 'end'), 0);
});

test('frame rate follows the chosen quality', () => {
  const info = { fpsByHeight: { 1080: 60, 720: 60, 480: 30, 360: 30, 2160: 60 }, fpsBest: 60 };
  assert.equal(fpsFor(info, 'best'), 60);
  assert.equal(fpsFor(info, '480'), 30);
  // 세로 영상: 가장 좋은 화질은 1920 높이의 60fps
  assert.equal(fpsFor({ fpsByHeight: { 1920: 60, 854: 30 }, fpsBest: 60 }, 'best'), 60);
  assert.equal(fpsFor({}, 'best'), 30);
  assert.equal(fpsFor(undefined, '720'), 30);
});
