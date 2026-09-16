'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  outDir: '',
  mode: 'video',        // video | audio
  height: '1080',       // best | 2160 | 1440 | 1080 | 720 | 480 | 360
  precise: true,        // 구간을 프레임 단위로 정확히 자름
  subs: 'none',         // none | file | embed
  cookiesFrom: 'none',  // none | chrome | edge | firefox | whale
  theme: 'dark',        // dark | light
  // 5 로 두면 유튜브가 속도 제한을 거는 일이 잦다. 3 이면 충분히 빠르면서 안전하다.
  concurrency: 3,
};

let cache = null;
let file = null;

function filePath() {
  if (!file) file = path.join(app.getPath('userData'), 'settings.json');
  return file;
}

function load() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch {
    /* 첫 실행이거나 파일이 깨졌으면 기본값 */
  }
  cache = { ...DEFAULTS, ...saved };
  if (!cache.outDir) {
    cache.outDir = path.join(app.getPath('videos') || app.getPath('downloads'), 'UtoV');
  }
  return cache;
}

function save(patch) {
  cache = { ...load(), ...patch };
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] 설정 저장 실패:', err.message);
  }
  return cache;
}

module.exports = { load, save, DEFAULTS };
