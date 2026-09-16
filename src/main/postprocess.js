'use strict';
/**
 * 내려받은 뒤의 뒷정리와 검사.
 *
 *  - 구간을 잘라내면 자막은 원본 전체가 원본 시각 그대로 남는다.
 *    6초짜리 클립에 10분짜리 자막이 붙어 엉뚱한 대사가 보인다. 그래서
 *    자막 시각을 잘라낸 구간 기준으로 옮기고 범위 밖은 버린다.
 *  - 파일이 생겼다고 재생되는 것은 아니다. 실제로 열리는지, 스트림이
 *    들어 있는지, 흔한 재생기가 다룰 수 있는 코덱인지 확인한다.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { findExe } = require('./paths');

/* ------------------------------------------------------------- 자막 */

const TIME = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g;

const toMs = (h, m, s, ms) => ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;

function fromMs(ms) {
  const v = Math.max(0, Math.round(ms));
  const h = String(Math.floor(v / 3600000)).padStart(2, '0');
  const m = String(Math.floor((v % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((v % 60000) / 1000)).padStart(2, '0');
  const f = String(v % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${f}`;
}

/**
 * srt 의 시각을 구간 시작 기준으로 옮기고 범위 밖 자막은 버린다.
 * @returns {{kept:number, dropped:number}|null} 건드릴 것이 없으면 null
 */
async function retimeSrt(srtPath, startSec, spanSec) {
  let text;
  try {
    text = await fsp.readFile(srtPath, 'utf8');
  } catch {
    return null;
  }

  const offset = startSec * 1000;
  const limit = spanSec * 1000;
  const blocks = text.replace(/^﻿/, '').split(/\r?\n\r?\n/);

  const kept = [];
  let dropped = 0;

  for (const block of blocks) {
    if (!block.trim()) continue;
    const times = [...block.matchAll(TIME)];
    if (times.length < 2) continue;

    const from = toMs(times[0][1], times[0][2], times[0][3], times[0][4]) - offset;
    const to = toMs(times[1][1], times[1][2], times[1][3], times[1][4]) - offset;

    // 구간에 걸치지 않는 자막은 버린다
    if (to <= 0 || from >= limit) {
      dropped += 1;
      continue;
    }

    const body = block
      .split(/\r?\n/)
      .slice(times.length > 0 ? 2 : 1) // 번호 줄과 시각 줄을 뺀 나머지
      .join('\n')
      .trim();
    if (!body) continue;

    kept.push({
      from: Math.max(0, from),
      to: Math.min(limit, to),
      body,
    });
  }

  if (!kept.length && !dropped) return null;

  const out = kept
    .map((c, i) => `${i + 1}\n${fromMs(c.from)} --> ${fromMs(c.to)}\n${c.body}`)
    .join('\n\n');
  await fsp.writeFile(srtPath, out ? `${out}\n` : '', 'utf8');
  return { kept: kept.length, dropped };
}

/** 자막을 영상 안에 넣는다 (기존 자막 트랙은 버린다) */
function muxSubtitle(videoPath, srtPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = findExe('ffmpeg');
    if (!ffmpeg) return reject(new Error('ffmpeg 를 찾지 못했습니다'));

    const tmp = videoPath.replace(/\.mp4$/i, '.subbed.mp4');
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-i', srtPath,
      '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0',
      '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
      '-movflags', '+faststart',
      tmp,
    ];
    execFile(ffmpeg, args, { windowsHide: true, maxBuffer: 1 << 24 }, (err, _o, stderr) => {
      if (err) {
        fs.rm(tmp, { force: true }, () => {});
        return reject(new Error((stderr || err.message).trim().split('\n').slice(-1)[0]));
      }
      try {
        fs.rmSync(videoPath, { force: true });
        fs.renameSync(tmp, videoPath);
        resolve(videoPath);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/* ------------------------------------------------------------- 검사 */

/** 어느 재생기에서나 무난히 열리는 조합 */
const SAFE_VIDEO = /^(h264|avc1|mpeg4)$/i;
const SAFE_AUDIO = /^(aac|mp3|mp4a)$/i;

const CODEC_NAMES = {
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  opus: 'Opus',
  vorbis: 'Vorbis',
};
const niceName = (c) => CODEC_NAMES[String(c).toLowerCase()] || c;

function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = findExe('ffprobe');
    if (!ffprobe) return reject(new Error('ffprobe 를 찾지 못했습니다'));
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name:stream=index,codec_type,codec_name,duration',
      '-of', 'json', filePath,
    ];
    execFile(ffprobe, args, { windowsHide: true, timeout: 60000, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').slice(-1)[0]));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('파일 정보를 읽지 못했습니다'));
        }
      });
  });
}

/**
 * 받은 파일이 실제로 쓸 수 있는 상태인지 확인한다.
 * @param {string} filePath
 * @param {{mode:string, expectSeconds:number|null}} expect
 * @returns {Promise<{ok:boolean, fatal:string|null, warnings:string[], duration:number, codecs:object}>}
 */
async function verify(filePath, expect = {}) {
  const warnings = [];

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return { ok: false, fatal: '저장된 파일을 찾지 못했습니다.', warnings, duration: 0, codecs: {} };
  }
  if (stat.size < 1024) {
    return { ok: false, fatal: '파일이 비어 있습니다.', warnings, duration: 0, codecs: {} };
  }

  let info;
  try {
    info = await probeFile(filePath);
  } catch (err) {
    return {
      ok: false,
      fatal: `파일이 열리지 않습니다. 받는 도중 끊겼을 수 있습니다. (${err.message})`,
      warnings, duration: 0, codecs: {},
    };
  }

  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(info.format && info.format.duration) || 0;

  if (expect.mode === 'audio') {
    if (!audio) return { ok: false, fatal: '소리가 들어 있지 않습니다.', warnings, duration, codecs: {} };
  } else if (!video) {
    return { ok: false, fatal: '영상이 들어 있지 않습니다.', warnings, duration, codecs: {} };
  }

  if (duration <= 0.1) {
    return { ok: false, fatal: '길이가 없는 파일입니다. 받는 도중 끊긴 것으로 보입니다.', warnings, duration, codecs: {} };
  }

  // 요청한 구간과 길이가 크게 다르면 알린다
  if (expect.expectSeconds && expect.expectSeconds > 1) {
    const gap = Math.abs(duration - expect.expectSeconds);
    if (gap > Math.max(2, expect.expectSeconds * 0.25)) {
      warnings.push(`요청한 길이는 ${Math.round(expect.expectSeconds)}초인데 파일은 ${Math.round(duration)}초입니다.`);
    }
  }

  // 컨테이너 길이만 보면 놓치는 경우가 있다. 자막 같은 트랙 하나가 원본 전체
  // 길이로 남아 있으면, 재생기는 대개 가장 긴 트랙을 총 길이로 잡아서 짧은
  // 클립이 원본만큼 긴 영상으로 보인다. 그래서 스트림마다 따로 본다.
  const longest = streams.reduce(
    (worst, s) => {
      const d = Number(s.duration) || 0;
      return d > worst.d ? { d, type: s.codec_type } : worst;
    },
    { d: 0, type: null }
  );
  if (longest.d > duration + Math.max(2, duration * 0.25)) {
    const what = { subtitle: '자막', audio: '소리', video: '영상' }[longest.type] || longest.type;
    warnings.push(
      `${what} 트랙이 ${Math.round(longest.d)}초로 영상(${Math.round(duration)}초)보다 깁니다. ` +
      '재생기에 따라 전체 길이가 잘못 표시될 수 있습니다.'
    );
  }

  // 흔한 재생기에서 바로 열리는 코덱인지
  if (video && !SAFE_VIDEO.test(video.codec_name || '')) {
    warnings.push(`영상이 ${niceName(video.codec_name)} 코덱입니다. 윈도우 기본 재생기에서는 열리지 않을 수 있습니다.`);
  }
  if (audio && expect.mode !== 'audio' && !SAFE_AUDIO.test(audio.codec_name || '')) {
    warnings.push(`소리가 ${niceName(audio.codec_name)} 코덱입니다. 일부 재생기에서 소리가 안 날 수 있습니다.`);
  }

  return {
    ok: true,
    fatal: null,
    warnings,
    duration,
    codecs: {
      video: video ? video.codec_name : null,
      audio: audio ? audio.codec_name : null,
      subtitle: streams.some((s) => s.codec_type === 'subtitle'),
    },
  };
}

/** 영상 옆에 있는 자막 파일을 찾는다 */
async function findSubtitleNextTo(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith(base) && /\.srt$/i.test(n));
  return hit ? path.join(dir, hit) : null;
}

module.exports = { retimeSrt, muxSubtitle, verify, findSubtitleNextTo };
