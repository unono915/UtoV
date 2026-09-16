'use strict';
/**
 * yt-dlp 실행기. 영상 정보 조회와 (구간 지정) 다운로드를 담당한다.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { ytdlpPath, ffmpegDir } = require('./paths');

const SENT = '@@UTOV@@';
const SENT_PP = '@@UTOVPP@@';

/** 실행 중인 작업들 */
const jobs = new Map();

/* --------------------------------------------------------------- 유틸 */

const nz = (v) => (v === 'NA' || v === '' || v == null ? null : v);
const num = (v) => {
  const n = Number(nz(v));
  return Number.isFinite(n) ? n : null;
};

/** 초 → 파일명에 쓸 수 있는 00-01-30 형태 */
function stamp(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h + '-' + m + '-' + ss;
}

/**
 * 모든 호출에 공통으로 붙는 인자.
 *
 * 유튜브가 429(요청 과다)를 돌려줄 때 곧바로 다시 두드리면 상황이 더 나빠진다.
 * 재시도 간격을 지수적으로 늘려서 물러섰다가 다가가게 한다.
 */
function commonArgs(settings = {}, { safeMode = false } = {}) {
  const args = [
    '--ignore-config', '--no-playlist', '--no-colors', '--no-warnings',
    '--extractor-retries', '3',
    '--retry-sleep', 'extractor:exp=2:60',
  ];
  const ff = ffmpegDir();
  if (ff) args.push('--ffmpeg-location', ff);
  if (settings.cookiesFrom && settings.cookiesFrom !== 'none') {
    args.push('--cookies-from-browser', settings.cookiesFrom);
  }
  // 안전 모드: 요청 사이를 띄워서 속도 제한에 걸리지 않게 한다
  if (safeMode) args.push('--sleep-requests', '1.5');
  return args;
}

/**
 * 자주 나오는 yt-dlp 오류를 사람이 읽을 수 있는 안내로 바꾼다.
 * 세 번째 값은 화면에서 어떤 조치를 권할지 고르기 위한 코드다.
 * 위에서부터 먼저 맞는 것을 쓰므로 구체적인 것을 앞에 둔다.
 */
const ERROR_TABLE = [
  [/Sign in to confirm|not a bot|cookies are no longer valid/i,
    '유튜브가 사람인지 확인을 요구했습니다. 설정에서 "브라우저 쿠키"를 Chrome 또는 Edge로 지정한 뒤 다시 시도해 보세요.',
    'bot-check'],
  [/Private video/i, '비공개 영상이라 받을 수 없습니다.', 'unavailable'],
  [/members.only|channel.s members/i, '채널 멤버십 전용 영상입니다.', 'unavailable'],
  [/age.?restricted|confirm your age|inappropriate for some users/i,
    '연령 제한 영상입니다. 설정에서 "브라우저 쿠키"를 지정하고, 해당 브라우저에 로그인한 상태로 시도하세요.',
    'bot-check'],
  [/Video unavailable|This video is not available/i,
    '영상을 찾을 수 없습니다. 삭제되었거나 지역 제한이 걸린 영상일 수 있습니다.', 'unavailable'],
  [/This live event will begin/i, '아직 시작하지 않은 예약 라이브입니다.', 'unavailable'],
  [/HTTP Error 429|Too Many Requests|rate.?limit/i,
    '유튜브가 요청 속도를 제한했습니다. 천천히 다시 시도하면 대개 풀립니다.',
    'rate-limit'],
  [/Unsupported URL|is not a valid URL/i,
    '지원하지 않는 주소입니다. 유튜브 영상 주소가 맞는지 확인해 주세요.', 'bad-url'],
  [/ffmpeg|ffprobe/i, 'ffmpeg 처리 중 문제가 생겼습니다. 설정에서 도구를 다시 받아 보세요.', 'tools'],
  [/Unable to download|Connection|timed out|getaddrinfo|ssl/i,
    '네트워크 연결에 문제가 있습니다. 인터넷 상태를 확인해 주세요.', 'network'],
];

/** @returns {{message:string, code:string}} */
function friendlyError(raw) {
  const text = (raw || '').toString();
  for (const [re, message, code] of ERROR_TABLE) {
    if (re.test(text)) return { message, code };
  }

  const errLine = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => /^ERROR/i.test(l));
  return {
    message: errLine ? errLine.replace(/^ERROR:\s*/i, '') : '알 수 없는 오류가 발생했습니다.',
    code: 'unknown',
  };
}

/** friendlyError 결과를 Error 객체로 (코드를 함께 실어 보낸다) */
function toError(raw) {
  const { message, code } = friendlyError(raw);
  const err = new Error(message);
  err.utovCode = code;
  return err;
}

/** 윈도우에서 ffmpeg 같은 자식 프로세스까지 확실히 종료 */
function killTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/* --------------------------------------------------------- 영상 정보 조회 */

function probe(url, settings = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [...commonArgs(settings, opts), '-J', url];
    const child = spawn(ytdlpPath(), args, { windowsHide: true });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error('영상 정보를 가져오는 데 시간이 너무 오래 걸립니다.'));
    }, 90000);

    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(
        e.code === 'ENOENT'
          ? 'yt-dlp 를 찾을 수 없습니다. 설정에서 도구 준비를 실행해 주세요.'
          : e.message
      ));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(toError(err || out));
      let info;
      try {
        info = JSON.parse(out);
      } catch {
        return reject(new Error('영상 정보를 해석하지 못했습니다.'));
      }
      resolve(shapeInfo(info));
    });
  });
}

/** yt-dlp 의 방대한 JSON 에서 화면에 필요한 것만 추린다 */
function shapeInfo(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = [...new Set(
    formats
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
      .map((f) => f.height)
  )].sort((a, b) => b - a);

  const thumb =
    info.thumbnail ||
    (Array.isArray(info.thumbnails) && info.thumbnails.length
      ? info.thumbnails[info.thumbnails.length - 1].url
      : null);

  return {
    id: info.id,
    title: info.title || '제목 없음',
    channel: info.uploader || info.channel || '',
    duration: Number(info.duration) || 0,
    thumbnail: thumb,
    webpageUrl: info.webpage_url || '',
    viewCount: info.view_count ?? null,
    uploadDate: info.upload_date || null,
    isLive: Boolean(info.is_live),
    heights,
    hasSubtitles: Object.keys(info.subtitles || {}).length > 0,
    hasAutoSubtitles: Object.keys(info.automatic_captions || {}).length > 0,
    chapters: Array.isArray(info.chapters)
      ? info.chapters.map((c) => ({
          title: c.title || '',
          start: Number(c.start_time) || 0,
          end: Number(c.end_time) || 0,
        }))
      : [],
  };
}

/* -------------------------------------------------------------- 다운로드 */

function formatSelector(mode, height) {
  if (mode === 'audio') return 'bestaudio/best';
  if (!height || height === 'best') return 'bv*+ba/b';
  const h = Number(height);
  return [
    'bv*[height<=' + h + '][ext=mp4]+ba[ext=m4a]',
    'bv*[height<=' + h + ']+ba',
    'b[height<=' + h + ']',
    'bv*+ba/b',
  ].join('/');
}

function buildArgs(job, settings, resultFile) {
  const trimming = Boolean(job.trim && job.trim.enabled);
  const safeMode = Boolean(job.safeMode);

  // 안전 모드에서는 한 번에 한 조각씩만, 그것도 사이를 띄워 가며 받는다
  const concurrency = safeMode ? 1 : Number(settings.concurrency) || 3;

  const args = [
    ...commonArgs(settings, { safeMode }),
    '--newline',
    '--progress',
    '--no-quiet',
    '--no-simulate',
    '--no-mtime',
    '--windows-filenames',
    '--retries', '10',
    '--retry-sleep', 'http:exp=2:120',
    '--fragment-retries', '10',
    '--retry-sleep', 'fragment:exp=1:60',
    '--concurrent-fragments', String(concurrency),
    '--print-to-file', 'after_move:filepath', resultFile,
    '--progress-template',
    'download:' + SENT +
      '|%(progress.status)s|%(progress.downloaded_bytes)s' +
      '|%(progress.total_bytes,progress.total_bytes_estimate)s' +
      '|%(progress.speed)s|%(progress.eta)s',
    '--progress-template',
    'postprocess:' + SENT_PP + '|%(progress.status)s|%(postprocessor)s',
  ];

  // 안전 모드에서는 각 파일을 받기 전에도 잠깐 쉬어 간다
  if (safeMode) args.push('--sleep-interval', '2', '--max-sleep-interval', '6');

  // 저장 이름 — 구간을 지정했으면 파일명에 남겨서 서로 겹치지 않게.
  // --trim-filenames 는 경로 전체를 자르기 때문에(저장 폴더가 길면 제목이 뭉개진다)
  // 쓰지 않고, 제목 자체를 80자로 제한한다.
  let nameTpl = '%(title).80s';
  if (trimming) nameTpl += ' [' + stamp(job.trim.start) + '~' + stamp(job.trim.end) + ']';
  args.push('-o', path.join(job.outDir, nameTpl + '.%(ext)s'));

  // 포맷
  args.push('-f', formatSelector(job.mode, job.height));
  if (job.mode === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata');
  } else {
    args.push('--merge-output-format', 'mp4');
  }

  // 구간 지정 — 영상 전체가 아니라 필요한 부분만 내려받는다
  if (trimming) {
    const start = Math.max(0, Number(job.trim.start) || 0);
    const end = Number(job.trim.end);
    const range =
      Number.isFinite(end) && end > start
        ? '*' + start.toFixed(2) + '-' + end.toFixed(2)
        : '*' + start.toFixed(2) + '-inf';
    args.push('--download-sections', range);
    if (job.precise !== false) args.push('--force-keyframes-at-cuts');
  }

  // 자막 (영상일 때만 의미가 있다)
  if (job.mode !== 'audio' && job.subs && job.subs !== 'none') {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'ko.*,en.*', '--convert-subs', 'srt');
    if (job.subs === 'embed') args.push('--embed-subs');
  }

  args.push(job.url);
  return args;
}

/**
 * ffmpeg 가 자르거나 합치는 동안 찍는 진행 줄.
 *   frame=  150 fps= 39 q=-1.0 Lsize=  405KiB time=00:00:05.00 bitrate=...
 * yt-dlp 의 진행률과 달리 이 단계는 시간 단위로만 알 수 있다.
 */
const FF_PROGRESS = /(?:^|\s)(?:frame|size)=.*?\btime=(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/;

const PP_LABELS = {
  Merger: '영상과 소리 합치는 중',
  VideoConvertor: '형식 변환 중',
  ExtractAudio: '소리 추출 중',
  EmbedSubtitle: '자막 넣는 중',
  FFmpegMetadata: '정보 기록 중',
  MoveFiles: '저장하는 중',
  ModifyChapters: '구간 다듬는 중',
  SubtitlesConvertor: '자막 변환 중',
};

/**
 * 다운로드를 시작한다.
 * @param {object} job   { url, outDir, mode, height, precise, subs, trim:{enabled,start,end} }
 * @param {object} settings
 * @param {(e:object)=>void} onEvent
 * @returns {string} jobId
 */
function start(job, settings, onEvent) {
  const jobId = randomUUID();
  const resultFile = path.join(os.tmpdir(), 'utov-' + jobId + '.txt');
  const startedAt = Date.now();

  fs.mkdirSync(job.outDir, { recursive: true });

  const args = buildArgs(job, settings, resultFile);
  const child = spawn(ytdlpPath(), args, { windowsHide: true });

  const state = {
    child,
    canceled: false,
    lastFile: null,
    alreadyHave: null,
    stderr: '',
    phaseLabel: null,
  };
  jobs.set(jobId, state);

  const emit = (e) => onEvent(Object.assign({ jobId }, e));
  emit({ type: 'started' });

  const handleLine = (line) => {
    if (!line) return;

    if (line.startsWith(SENT)) {
      const parts = line.split('|');
      const downloaded = num(parts[2]);
      const total = num(parts[3]);
      emit({
        type: 'progress',
        status: nz(parts[1]),
        downloaded,
        total,
        percent: downloaded != null && total ? Math.min(100, (downloaded / total) * 100) : null,
        speed: num(parts[4]),
        eta: num(parts[5]),
      });
      return;
    }

    if (line.startsWith(SENT_PP)) {
      const pp = nz(line.split('|')[2]);
      const label = PP_LABELS[pp] || '마무리 처리 중';
      if (state.phaseLabel !== label) {
        state.phaseLabel = label;
        emit({ type: 'phase', label });
      }
      return;
    }

    // 자르기 / 합치기 단계의 진행 상황
    const ff = line.match(FF_PROGRESS);
    if (ff) {
      const seconds =
        Number(ff[1]) * 3600 + Number(ff[2]) * 60 + Number(ff[3]) + (ff[4] ? Number('0.' + ff[4]) : 0);
      emit({ type: 'cutting', seconds });
      return;
    }

    // 최종 저장 경로를 알아내기 위한 보조 파싱
    let m;
    if ((m = line.match(/^\[download\]\s+(.+?)\s+has already been downloaded/))) {
      state.alreadyHave = m[1].trim();
    } else if ((m = line.match(/^\[Merger\] Merging formats into "(.+)"/))) {
      state.lastFile = m[1];
    } else if ((m = line.match(/^\[(?:ExtractAudio|VideoConvertor)\] Destination: (.+)/))) {
      state.lastFile = m[1];
    } else if ((m = line.match(/^\[download\] Destination: (.+)/))) {
      state.lastFile = m[1];
    }

    emit({ type: 'log', line });
  };

  // ffmpeg 는 진행 줄을 \r 로 덮어쓴다. \n 으로만 나누면 그 단계 내내
  // 한 줄이 계속 길어지기만 하고 진행 상황을 읽을 수 없다.
  const NEWLINE = /\r\n|\r|\n/;

  let outBuf = '';
  child.stdout.on('data', (chunk) => {
    outBuf += chunk.toString();
    const parts = outBuf.split(NEWLINE);
    outBuf = parts.pop();
    for (const l of parts) handleLine(l.trim());
  });

  let errBuf = '';
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    state.stderr += text;
    errBuf += text;
    const parts = errBuf.split(NEWLINE);
    errBuf = parts.pop();
    for (const l of parts) {
      const line = l.trim();
      if (!line) continue;
      // ffmpeg 진행 줄은 stderr 로도 온다
      if (FF_PROGRESS.test(line)) handleLine(line);
      else emit({ type: 'log', line, stderr: true });
    }
  });

  child.on('error', (e) => {
    jobs.delete(jobId);
    emit({
      type: 'error',
      message:
        e.code === 'ENOENT'
          ? 'yt-dlp 를 찾을 수 없습니다. 설정에서 도구 준비를 실행해 주세요.'
          : e.message,
    });
  });

  child.on('close', (code) => {
    jobs.delete(jobId);
    if (outBuf.trim()) handleLine(outBuf.trim());

    let finalPath = null;
    try {
      const printed = fs.readFileSync(resultFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      if (printed.length) finalPath = printed[printed.length - 1].trim();
    } catch {
      /* 못 읽으면 아래에서 파싱 결과로 대체 */
    }
    fs.rm(resultFile, { force: true }, () => {});
    if (!finalPath) finalPath = state.alreadyHave || state.lastFile;

    if (state.canceled) return emit({ type: 'canceled' });

    if (code === 0) {
      let size = null;
      try {
        if (finalPath) size = fs.statSync(finalPath).size;
      } catch {
        /* 파일을 못 찾아도 성공 처리는 유지 */
      }
      emit({
        type: 'done',
        file: finalPath,
        reused: Boolean(state.alreadyHave && !state.lastFile),
        elapsed: Date.now() - startedAt,
        size,
      });
    } else {
      const failure = friendlyError(state.stderr);
      emit({
        type: 'error',
        message: failure.message,
        code: failure.code,
        wasSafeMode: Boolean(job.safeMode),
        detail: state.stderr.slice(-4000),
      });
    }
  });

  return jobId;
}

function cancel(jobId) {
  const state = jobs.get(jobId);
  if (!state) return false;
  state.canceled = true;
  killTree(state.child);
  return true;
}

function cancelAll() {
  for (const id of [...jobs.keys()]) cancel(id);
}

module.exports = { probe, start, cancel, cancelAll, friendlyError, stamp, buildArgs };
