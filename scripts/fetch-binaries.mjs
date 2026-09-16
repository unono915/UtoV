/**
 * yt-dlp.exe 와 ffmpeg/ffprobe 를 ./bin 으로 내려받는다.
 * 패키징 전에 한 번만 실행하면 되고, 이미 있으면 건너뛴다.
 *   node scripts/fetch-binaries.mjs          # 없는 것만 받기
 *   node scripts/fetch-binaries.mjs --force  # 전부 다시 받기
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin');
const FORCE = process.argv.includes('--force');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const FFMPEG_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

fs.mkdirSync(BIN, { recursive: true });

function human(n) {
  if (!n) return '? MB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function download(url, dest, label) {
  process.stdout.write(`  ↓ ${label} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (total) {
      process.stdout.write(
        `\r  ↓ ${label} ... ${((got / total) * 100).toFixed(0)}% (${human(total)})   `
      );
    }
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
  process.stdout.write(`\r  ✓ ${label}  ${human(got)}                    \n`);
}

function unzipWithPowerShell(zipPath, outDir) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ],
    { stdio: 'inherit' }
  );
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function main() {
  console.log('\n  UtoV — 실행에 필요한 도구를 준비합니다\n');

  // ---- yt-dlp -------------------------------------------------------------
  const ytdlp = path.join(BIN, 'yt-dlp.exe');
  if (FORCE || !fs.existsSync(ytdlp)) {
    await download(YTDLP_URL, ytdlp, 'yt-dlp.exe');
  } else {
    console.log('  · yt-dlp.exe 이미 있음 (건너뜀)');
  }

  // ---- ffmpeg / ffprobe ---------------------------------------------------
  const ffmpeg = path.join(BIN, 'ffmpeg.exe');
  const ffprobe = path.join(BIN, 'ffprobe.exe');
  if (FORCE || !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'utov-ff-'));
    const zip = path.join(tmp, 'ffmpeg.zip');
    try {
      await download(FFMPEG_URL, zip, 'ffmpeg (약 80MB, 조금 걸립니다)');
      process.stdout.write('  · 압축 푸는 중 ...\n');
      unzipWithPowerShell(zip, tmp);
      for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
        const src = findFile(tmp, name);
        if (!src) throw new Error(`압축 안에서 ${name} 를 찾지 못했습니다`);
        fs.copyFileSync(src, path.join(BIN, name));
        console.log(`  ✓ ${name}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    console.log('  · ffmpeg.exe / ffprobe.exe 이미 있음 (건너뜀)');
  }

  console.log('\n  준비 끝. `npm start` 로 실행하세요.\n');
}

main().catch((err) => {
  console.error('\n  ✗ 준비 실패:', err.message);
  console.error('    네트워크를 확인한 뒤 `npm run setup` 을 다시 실행하세요.\n');
  process.exitCode = 1;
});
