'use strict';
/**
 * yt-dlp / ffmpeg 준비와 갱신.
 * 유튜브가 자주 바뀌기 때문에 yt-dlp 는 최신으로 유지하는 것이 중요하다.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const { userBinDir, findExe } = require('./paths');

const YTDLP_URL =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
// 유튜브 서명 해독용 자바스크립트 런타임.
// yt-dlp 는 런타임 없는 추출을 지원 중단 예정이라고 경고한다.
const DENO_URL =
  'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip';

/* ------------------------------------------------------------------ 상태 */

async function versionOf(exe, args) {
  if (!exe) return null;
  try {
    const { stdout } = await execFileAsync(exe, args, {
      timeout: 15000,
      windowsHide: true,
    });
    return stdout.trim().split('\n')[0].trim();
  } catch {
    return null;
  }
}

async function status() {
  const ytdlp = findExe('yt-dlp');
  const ffmpeg = findExe('ffmpeg');
  const deno = findExe('deno');
  const [ytdlpVersion, ffmpegVersion, denoVersion] = await Promise.all([
    versionOf(ytdlp, ['--version']),
    versionOf(ffmpeg, ['-version']),
    versionOf(deno, ['--version']),
  ]);
  return {
    ytdlp: { path: ytdlp, version: ytdlpVersion, ok: Boolean(ytdlpVersion) },
    ffmpeg: {
      path: ffmpeg,
      version: ffmpegVersion ? ffmpegVersion.replace(/^ffmpeg version /, '').split(' ')[0] : null,
      ok: Boolean(ffmpegVersion),
    },
    deno: {
      path: deno,
      version: denoVersion ? denoVersion.replace(/^deno\s*/i, '').split(' ')[0] : null,
      ok: Boolean(denoVersion),
    },
    // deno 가 없어도 당장은 돌아가므로 실행 가능 여부에는 넣지 않는다
    ready: Boolean(ytdlpVersion) && Boolean(ffmpegVersion),
    binDir: userBinDir(),
  };
}

/* ----------------------------------------------------------- 다운로드 */

async function downloadTo(url, destFile, label, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} 내려받기 실패 (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${destFile}.part`;
  await fsp.mkdir(path.dirname(destFile), { recursive: true });
  await fsp.rm(tmp, { force: true });

  const handle = await fsp.open(tmp, 'w');
  let received = 0;
  let lastTick = 0;
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk);
      received += chunk.length;
      const now = Date.now();
      if (onProgress && (now - lastTick > 120 || received === total)) {
        lastTick = now;
        onProgress({
          label,
          received,
          total,
          percent: total ? (received / total) * 100 : null,
        });
      }
    }
  } finally {
    await handle.close();
  }

  // 실행 중인 파일은 덮어쓸 수 없으므로 한 번 비켜둔다
  try {
    await fsp.rm(destFile, { force: true });
  } catch {
    const stale = `${destFile}.old-${Date.now()}`;
    await fsp.rename(destFile, stale).catch(() => {});
  }
  await fsp.rename(tmp, destFile);
  return destFile;
}

function unzip(zipFile, outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath "${zipFile}" -DestinationPath "${outDir}" -Force`,
      ],
      { windowsHide: true }
    );
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`압축 해제 실패: ${err.trim() || code}`))
    );
  });
}

async function findInTree(dir, filename) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findInTree(full, filename);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/* -------------------------------------------------------------- 공개 API */

/**
 * 없는 도구만 채워 넣는다.
 * @param {(e:{stage:string,label:string,percent:number|null,received?:number,total?:number})=>void} onProgress
 */
async function ensure(onProgress = () => {}, { force = false } = {}) {
  const bin = userBinDir();
  await fsp.mkdir(bin, { recursive: true });
  const report = (stage) => (p) => onProgress({ stage, ...p });

  if (force || !findExe('yt-dlp')) {
    onProgress({ stage: 'ytdlp', label: 'yt-dlp', percent: 0 });
    await downloadTo(YTDLP_URL, path.join(bin, 'yt-dlp.exe'), 'yt-dlp', report('ytdlp'));
  }

  if (!findExe('ffmpeg') || !findExe('ffprobe')) {
    onProgress({ stage: 'ffmpeg', label: 'ffmpeg', percent: 0 });
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'utov-ff-'));
    const zip = path.join(tmp, 'ffmpeg.zip');
    try {
      await downloadTo(FFMPEG_URL, zip, 'ffmpeg', report('ffmpeg'));
      onProgress({ stage: 'extract', label: '압축 푸는 중', percent: null });
      await unzip(zip, tmp);
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        const src = await findInTree(tmp, name);
        if (!src) throw new Error(`압축 안에서 ${name} 를 찾지 못했습니다`);
        await fsp.copyFile(src, path.join(bin, name));
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  // 자바스크립트 런타임. 없어도 당장은 돌지만 yt-dlp 가 지원 중단을 예고했고,
  // 없으면 일부 포맷을 가져오지 못한다. 실패해도 나머지는 쓸 수 있게 둔다.
  if (!findExe('deno')) {
    onProgress({ stage: 'deno', label: 'deno', percent: 0 });
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'utov-deno-'));
    const zip = path.join(tmp, 'deno.zip');
    try {
      await downloadTo(DENO_URL, zip, 'deno', report('deno'));
      onProgress({ stage: 'extract', label: '압축 푸는 중', percent: null });
      await unzip(zip, tmp);
      const src = await findInTree(tmp, 'deno.exe');
      if (src) await fsp.copyFile(src, path.join(bin, 'deno.exe'));
    } catch (err) {
      console.error('[tools] deno 준비 실패 (계속 진행):', err.message);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  onProgress({ stage: 'done', label: '준비 완료', percent: 100 });
  return status();
}

/** yt-dlp 만 최신으로 다시 받는다 */
async function updateYtdlp(onProgress = () => {}) {
  const before = (await status()).ytdlp.version;
  await downloadTo(
    YTDLP_URL,
    path.join(userBinDir(), 'yt-dlp.exe'),
    'yt-dlp',
    (p) => onProgress({ stage: 'ytdlp', ...p })
  );
  const after = await status();
  return { before, after: after.ytdlp.version, status: after };
}

/** 예전에 밀어둔 .old-* 찌꺼기 정리 */
async function cleanup() {
  try {
    const bin = userBinDir();
    for (const name of await fsp.readdir(bin)) {
      if (/\.old-\d+$/.test(name) || name.endsWith('.part')) {
        await fsp.rm(path.join(bin, name), { force: true }).catch(() => {});
      }
    }
  } catch {
    /* 폴더가 아직 없으면 할 일 없음 */
  }
}

module.exports = { status, ensure, updateYtdlp, cleanup, YTDLP_URL, FFMPEG_URL };
