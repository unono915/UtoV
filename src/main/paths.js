'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

/**
 * 도구(yt-dlp, ffmpeg)를 찾는 순서
 *   1. userData/bin  — 앱이 내려받아 최신으로 유지하는 곳 (항상 쓰기 가능)
 *   2. resources/bin — 빌드에 함께 넣은 경우 (오프라인 배포용)
 *   3. 시스템 PATH   — 개발자가 직접 설치한 경우
 */
function userBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

function bundledBinDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', '..', 'bin');
}

function searchDirs() {
  return [userBinDir(), bundledBinDir()];
}

/** bin 폴더들에서 실행 파일을 찾는다. 못 찾으면 null */
function findExe(name) {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of searchDirs()) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** 찾은 경로, 없으면 PATH 에 맡기고 이름만 반환 */
function resolveExe(name) {
  return findExe(name) || (process.platform === 'win32' ? `${name}.exe` : name);
}

const ytdlpPath = () => resolveExe('yt-dlp');

/** yt-dlp 에게 알려줄 ffmpeg 폴더 (번들/다운로드된 것이 있을 때만) */
function ffmpegDir() {
  const found = findExe('ffmpeg');
  return found ? path.dirname(found) : null;
}

/**
 * 유튜브의 서명을 풀려면 자바스크립트 런타임이 필요하다.
 * yt-dlp 는 런타임 없는 추출을 지원 중단 예정이라고 경고한다.
 * @returns {{name:string, path:string}|null}
 */
function jsRuntime() {
  const deno = findExe('deno');
  return deno ? { name: 'deno', path: deno } : null;
}

const rendererDir = () => path.join(__dirname, '..', 'renderer');

module.exports = {
  userBinDir,
  bundledBinDir,
  searchDirs,
  findExe,
  resolveExe,
  ytdlpPath,
  ffmpegDir,
  jsRuntime,
  rendererDir,
};
