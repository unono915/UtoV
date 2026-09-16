'use strict';
/* eslint-env browser */

const $ = (id) => document.getElementById(id);

/* ══════════════════════════════════════════════════════ 값 다듬기 */

/** 초 → 00:01:23 */
function hms(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 초 → 3분 21초 (사람이 읽는 길이) */
function humanDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h}시간 ${m}분`;
  if (m) return `${m}분 ${ss}초`;
  return `${ss}초`;
}

/** "1:23", "01:02:03", "90", "1:23.5" → 초. 못 읽으면 null */
function parseTime(text) {
  const raw = String(text ?? '').trim().replace(/\s/g, '');
  if (!raw) return null;
  if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?$/.test(raw)) return null;
  const parts = raw.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function bytes(n) {
  if (n == null || !Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function speed(bps) {
  return bps ? `${bytes(bps)}/s` : '';
}

function eta(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  if (sec < 60) return `${Math.round(sec)}초 남음`;
  return `${Math.floor(sec / 60)}분 ${Math.round(sec % 60)}초 남음`;
}

function ymd(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return '—';
  return `${yyyymmdd.slice(0, 4)}. ${yyyymmdd.slice(4, 6)}. ${yyyymmdd.slice(6, 8)}`;
}

/** 여러 형태의 유튜브 주소에서 영상 id 를 뽑는다 */
function videoIdOf(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let u;
  try {
    u = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(u.hostname)) return null;
  if (u.hostname.toLowerCase().endsWith('youtu.be')) {
    return u.pathname.slice(1).split('/')[0] || null;
  }
  const v = u.searchParams.get('v');
  if (v) return v;
  const m = u.pathname.match(/\/(shorts|embed|live|v)\/([\w-]{6,})/);
  return m ? m[2] : null;
}

/* ══════════════════════════════════════════════════════════ 상태 */

const state = {
  settings: null,
  info: null,
  start: 0,
  end: 0,
  mode: 'video',
  player: null,
  playerReady: false,
  previewUntil: null,
  probeAttempt: 0,
  strategies: [{ label: '기본' }],
  jobs: new Map(),
};

/**
 * 속도 제한에 걸렸을 때 실제로 도움이 되는 안내.
 * 쿠키를 쓰면 로그인된 요청으로 취급되어 제한이 훨씬 덜하다.
 */
function rateLimitHint() {
  // 실제로 가장 잦은 원인은 자막이다. 유튜브의 자막 엔드포인트는 제한이 빡빡해서
  // 연달아 몇 번만 요청해도 막힌다.
  if ($('subs') && $('subs').value !== 'none') {
    return ' 자막을 "없음"으로 두고 받으면 대개 해결됩니다.';
  }
  if (state.settings && Number(state.settings.concurrency) > 3) {
    return ' 설정에서 "동시 조각 수"를 1이나 3으로 낮춰 보세요.';
  }
  return ' 잠시 뒤 다시 시도하거나, 학교망이라면 여러 사람이 함께 쓰는 탓일 수 있습니다.';
}

const setStatus = (text) => {
  $('statusLeft').textContent = text;
};

function notice(text, kind, raw) {
  const el = $('intakeMsg');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.dataset.kind = kind || 'info';
  el.hidden = false;

  // 실제 yt-dlp 출력을 감추지 않는다. 원인을 모르면 고칠 수 없다.
  if (raw) {
    const pre = document.createElement('pre');
    pre.className = 'q-raw';
    pre.textContent = raw;
    el.append(pre);
  }
}

/* ══════════════════════════════════════════════════ 창 · 테마 · 설정 */

$('winMin').onclick = () => window.utov.win.minimize();
$('winMax').onclick = () => window.utov.win.maximize();
$('winClose').onclick = () => window.utov.win.close();
window.utov.win.onState(({ maximized }) => {
  $('app').dataset.max = maximized ? '1' : '0';
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

$('themeBtn').onclick = async () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  state.settings = await window.utov.settings.set({ theme });
};

$('settingsBtn').onclick = () => {
  const drawer = $('drawer');
  const open = drawer.hidden;
  drawer.hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', String(open));
};

function paintSettings() {
  const s = state.settings;
  $('outDir').textContent = s.outDir;
  $('outDir').title = s.outDir;
  $('concurrency').value = String(s.concurrency);
  $('precise').checked = s.precise !== false;
}

$('outDirBtn').onclick = async () => {
  const dir = await window.utov.fs.chooseFolder(state.settings.outDir);
  if (!dir) return;
  state.settings = await window.utov.settings.set({ outDir: dir });
  paintSettings();
};

$('outDirOpen').onclick = () => window.utov.fs.open(state.settings.outDir);

$('concurrency').onchange = async (e) => {
  state.settings = await window.utov.settings.set({ concurrency: Number(e.target.value) });
};

$('precise').onchange = async (e) => {
  state.settings = await window.utov.settings.set({ precise: e.target.checked });
};

/* ══════════════════════════════════════════════════════ 도구 준비 */

function paintTools(status) {
  const set = (el, label, ok, version) => {
    el.dataset.ok = ok ? '1' : '0';
    el.textContent = '';
    el.append(`${label} `);
    const b = document.createElement('b');
    b.textContent = ok ? version || '있음' : '없음';
    el.append(b);
  };
  set($('chipYtdlp'), 'yt-dlp', status.ytdlp.ok, status.ytdlp.version);
  set($('chipFfmpeg'), 'ffmpeg', status.ffmpeg.ok, status.ffmpeg.version);
  const deno = status.deno || { ok: false };
  set($('chipDeno'), 'deno', deno.ok, deno.version);
  $('chipDeno').title = deno.ok
    ? '유튜브 서명을 푸는 자바스크립트 런타임'
    : '없어도 지금은 돌아가지만, 일부 포맷을 가져오지 못할 수 있습니다';
  $('statusRight').textContent = status.ytdlp.version ? `yt-dlp ${status.ytdlp.version}` : '';
}

window.utov.tools.onProgress((p) => {
  const bar = $('setupBar');
  const fill = $('setupFill');
  const label = {
    ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', deno: 'deno',
    extract: '압축 푸는 중', done: '완료',
  }[p.stage] || p.label;
  bar.hidden = false;
  bar.querySelector('.bar').classList.toggle('indet', p.percent == null);
  fill.style.width = p.percent == null ? '' : `${p.percent.toFixed(1)}%`;
  $('setupStatus').textContent =
    p.percent == null
      ? `${label}…`
      : `${label} 내려받는 중 ${p.percent.toFixed(0)}% (${bytes(p.received)} / ${bytes(p.total)})`;
  setStatus(`${label} 준비 중…`);
});

$('setupGo').onclick = async () => {
  $('setupGo').disabled = true;
  $('setupError').hidden = true;
  const result = await window.utov.tools.ensure();
  if (result.ok && result.status.ready) {
    paintTools(result.status);
    $('setup').hidden = true;
    $('stage').hidden = false;
    setStatus('준비됨');
    $('url').focus();
  } else {
    $('setupError').textContent = result.error || '도구를 준비하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
    $('setupError').hidden = false;
    $('setupGo').disabled = false;
    $('setupGo').textContent = '다시 시도';
  }
};

$('toolEnsure').onclick = async () => {
  const btn = $('toolEnsure');
  btn.disabled = true;
  btn.textContent = '받는 중…';
  const r = await window.utov.tools.ensure();
  btn.disabled = false;
  btn.textContent = '빠진 도구 받기';
  if (r.ok) {
    paintTools(r.status);
    setStatus('도구를 확인했습니다');
  } else {
    setStatus(`도구 준비 실패: ${r.error}`);
  }
};

$('toolUpdate').onclick = async () => {
  const btn = $('toolUpdate');
  btn.disabled = true;
  btn.textContent = '갱신 중…';
  const r = await window.utov.tools.update();
  btn.disabled = false;
  btn.textContent = 'yt-dlp 갱신';
  if (r.ok) {
    paintTools(r.status);
    setStatus(r.before === r.after ? `yt-dlp ${r.after} 이미 최신입니다` : `yt-dlp ${r.after} 으로 갱신했습니다`);
  } else {
    setStatus(`갱신 실패: ${r.error}`);
  }
};

/* ══════════════════════════════════════════ 유튜브 미리보기 플레이어 */

let ytApiPromise = null;

function ytApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const timer = setTimeout(() => reject(new Error('시간 초과')), 15000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('불러오기 실패'));
    };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

async function mountPlayer(videoId) {
  state.playerReady = false;
  try {
    const YT = await ytApi();
    if (state.player) {
      state.player.loadVideoById(videoId);
      state.player.pauseVideo();
      state.playerReady = true;
      return;
    }
    state.player = new YT.Player('player', {
      videoId,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
      events: {
        onReady: () => {
          state.playerReady = true;
        },
      },
    });
  } catch {
    $('previewFallback').hidden = false;
  }
}

const currentTime = () => {
  try {
    return state.playerReady && state.player ? state.player.getCurrentTime() || 0 : null;
  } catch {
    return null;
  }
};

/** 재생 위치 표시와 구간 미리듣기 종료를 매 프레임 살핀다 */
function tick() {
  const t = currentTime();
  const head = $('playhead');
  if (t != null && state.info && state.info.duration > 0) {
    head.hidden = false;
    head.style.setProperty('--p', `${(t / state.info.duration) * 100}%`);
    if (state.previewUntil != null && t >= state.previewUntil) {
      state.previewUntil = null;
      try {
        state.player.pauseVideo();
      } catch { /* 플레이어가 사라졌으면 무시 */ }
    }
  } else {
    head.hidden = true;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ══════════════════════════════════════════════════ 구간 선택 트랙 */

const track = $('track');

function clampRange() {
  const dur = state.info ? state.info.duration : 0;
  const MIN = 0.5;
  state.start = Math.min(Math.max(0, state.start), Math.max(0, dur - MIN));
  state.end = Math.max(Math.min(dur, state.end), state.start + MIN);
  if (state.end > dur) state.end = dur;
}

function paintRange({ skipInputs } = {}) {
  const dur = state.info ? state.info.duration : 0;
  if (!dur) return;
  const a = (state.start / dur) * 100;
  const b = (state.end / dur) * 100;

  for (const el of [$('dimA'), $('dimB'), $('trackSel'), $('hStart'), $('hEnd')]) {
    el.style.setProperty('--a', `${a}%`);
    el.style.setProperty('--b', `${b}%`);
  }

  const span = state.end - state.start;
  const whole = state.start <= 0.01 && state.end >= dur - 0.01;
  $('trackSelLabel').textContent = b - a > 14 ? (whole ? '전체' : humanDur(span)) : '';
  $('segLength').textContent = whole ? `전체 ${humanDur(dur)}` : `${humanDur(span)} 선택`;

  if (!skipInputs) {
    $('tStart').value = hms(state.start);
    $('tEnd').value = hms(state.end);
  }

  $('hStart').setAttribute('aria-valuemax', String(Math.round(dur)));
  $('hStart').setAttribute('aria-valuenow', String(Math.round(state.start)));
  $('hStart').setAttribute('aria-valuetext', hms(state.start));
  $('hEnd').setAttribute('aria-valuemax', String(Math.round(dur)));
  $('hEnd').setAttribute('aria-valuenow', String(Math.round(state.end)));
  $('hEnd').setAttribute('aria-valuetext', hms(state.end));

  paintGoNote();
}

/**
 * 받을 자막 트랙 하나를 고른다.
 * 목록은 메인 쪽에서 이미 쓸 만한 순서로 정렬해 보내 준다.
 */
function bestSubLang() {
  const langs = (state.info && state.info.subLangs) || [];
  return langs.length ? langs[0].code : null;
}

function labelOfLang(code) {
  if (/^ko/i.test(code)) return /-orig$/i.test(code) ? '한국어(원본)' : '한국어';
  if (/^en/i.test(code)) return /-orig$/i.test(code) ? '영어(원본)' : '영어';
  return code;
}

/** 썸네일을 트랙 배경으로. 주소는 https 만 받아들인다. */
function setTrackArt(url) {
  let safe = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') safe = u.href;
  } catch { /* 썸네일이 없으면 배경도 없다 */ }
  $('trackArt').style.backgroundImage = safe ? `url(${JSON.stringify(safe)})` : '';
}

function timeAtClientX(clientX) {
  const rect = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * (state.info ? state.info.duration : 0);
}

function drawTicks() {
  const holder = $('ticks');
  holder.textContent = '';
  const dur = state.info ? state.info.duration : 0;
  if (!dur) return;
  const candidates = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = candidates.find((c) => dur / c <= 24) || 3600;
  for (let t = step; t < dur; t += step) {
    const i = document.createElement('i');
    i.style.left = `${(t / dur) * 100}%`;
    if (t % (step * 5) === 0) i.dataset.major = '1';
    holder.append(i);
  }
}

/* 손잡이 끌기 */
function bindHandle(el, which) {
  el.addEventListener('pointerdown', (e) => {
    if (!state.info) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    track.dataset.dragging = '1';

    const move = (ev) => {
      const t = timeAtClientX(ev.clientX);
      if (which === 'start') state.start = t;
      else state.end = t;
      clampRange();
      paintRange();
    };
    const up = (ev) => {
      el.releasePointerCapture(ev.pointerId);
      delete track.dataset.dragging;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });

  el.addEventListener('keydown', (e) => {
    if (!state.info) return;
    const dur = state.info.duration;
    const step = e.shiftKey ? 10 : e.ctrlKey ? 0.1 : 1;
    let handled = true;
    const move = (delta) => {
      if (which === 'start') state.start += delta;
      else state.end += delta;
    };
    switch (e.key) {
      case 'ArrowLeft': move(-step); break;
      case 'ArrowRight': move(step); break;
      case 'Home': if (which === 'start') state.start = 0; else state.end = state.start + 1; break;
      case 'End': if (which === 'end') state.end = dur; else state.start = dur - 1; break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    clampRange();
    paintRange();
  });
}
bindHandle($('hStart'), 'start');
bindHandle($('hEnd'), 'end');

/* 트랙을 누르면 그 지점으로 재생 위치 이동 */
track.addEventListener('pointerdown', (e) => {
  if (!state.info || !state.playerReady) return;
  const t = timeAtClientX(e.clientX);
  try {
    state.player.seekTo(t, true);
    state.previewUntil = null;
  } catch { /* 플레이어 준비 전이면 무시 */ }
});

/* 시간 직접 입력 */
function bindTimeInput(input, which) {
  const commit = () => {
    const sec = parseTime(input.value);
    if (sec == null) {
      input.value = hms(which === 'start' ? state.start : state.end);
      return;
    }
    if (which === 'start') state.start = sec;
    else state.end = sec;
    clampRange();
    paintRange();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    }
  });
}
bindTimeInput($('tStart'), 'start');
bindTimeInput($('tEnd'), 'end');

$('segAll').onclick = () => {
  state.start = 0;
  state.end = state.info ? state.info.duration : 0;
  paintRange();
};

$('markStart').onclick = () => {
  const t = currentTime();
  if (t == null) return setStatus('미리보기가 준비되면 쓸 수 있습니다');
  state.start = t;
  clampRange();
  paintRange();
};

$('markEnd').onclick = () => {
  const t = currentTime();
  if (t == null) return setStatus('미리보기가 준비되면 쓸 수 있습니다');
  state.end = t;
  clampRange();
  paintRange();
};

$('playSeg').onclick = () => {
  if (!state.playerReady) return setStatus('미리보기가 준비되면 쓸 수 있습니다');
  try {
    state.player.seekTo(state.start, true);
    state.player.playVideo();
    state.previewUntil = state.end;
  } catch { /* 무시 */ }
};

/* ══════════════════════════════════════════════════════ 옵션 화면 */

for (const btn of document.querySelectorAll('.segmented button')) {
  btn.onclick = async () => {
    state.mode = btn.dataset.mode;
    for (const other of document.querySelectorAll('.segmented button')) {
      other.setAttribute('aria-checked', String(other === btn));
    }
    const isAudio = state.mode === 'audio';
    $('rowQuality').hidden = isAudio;
    $('rowSubs').hidden = isAudio;
    paintGoNote();
    state.settings = await window.utov.settings.set({ mode: state.mode });
  };
}

$('quality').onchange = async (e) => {
  state.settings = await window.utov.settings.set({ height: e.target.value });
};

function paintQualityOptions(heights) {
  const sel = $('quality');
  sel.textContent = '';
  const add = (value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.append(o);
  };
  // 유튜브에서 어디서나 재생되는 H.264 는 1080p 까지다. 그 위 화질은
  // AV1 이나 VP9 뿐이라 받아도 윈도우 기본 재생기에서 열리지 않는다.
  // 열리지 않는 4K 보다 확실히 열리는 1080p 가 낫다.
  add('best', '가장 좋은 화질 (최대 1080p)');
  const ladder = [1080, 720, 480, 360];
  const top = heights && heights.length ? heights[0] : 1080;
  for (const h of ladder) {
    if (h <= top) add(String(h), `${h}p 이하`);
  }
  const want = state.settings.height;
  sel.value = [...sel.options].some((o) => o.value === want) ? want : 'best';
}

function paintGoNote() {
  if (!state.info) return;
  const dur = state.info.duration;
  const whole = state.start <= 0.01 && state.end >= dur - 0.01;
  const note = $('goNote');
  note.textContent = '';
  if (state.mode === 'audio') {
    note.append(whole ? '전체를 MP3 로 저장합니다.' : '선택한 구간을 MP3 로 저장합니다: ');
  } else {
    note.append(whole ? '전체를 MP4 로 저장합니다.' : '선택한 구간만 내려받습니다: ');
  }
  if (!whole) {
    const b = document.createElement('b');
    b.textContent = `${hms(state.start)} – ${hms(state.end)}`;
    note.append(b, ` (${humanDur(state.end - state.start)})`);
  }
}

/* ══════════════════════════════════════════════════════ 영상 불러오기 */

async function loadVideo() {
  const raw = $('url').value.trim();
  if (!raw) return;
  const id = videoIdOf(raw);
  if (!id) {
    notice('유튜브 영상 주소로 보이지 않습니다. 주소를 다시 확인해 주세요.', 'error');
    return;
  }

  const strat = state.strategies[state.probeAttempt] || {};
  $('load').disabled = true;
  $('load').textContent = '불러오는 중';
  notice(state.probeAttempt ? `${strat.label} 방식으로 확인하고 있습니다…` : '영상 정보를 확인하고 있습니다…');
  setStatus('영상 정보 확인 중…');

  const res = await window.utov.yt.probe(raw, {
    safeMode: Boolean(strat.safeMode),
    client: strat.client || null,
  });

  $('load').disabled = false;

  if (!res.ok) {
    const blocked = res.code === 'rate-limit' || res.code === 'bot-check' || res.code === 'unknown';
    const nextStrat = blocked ? state.strategies[state.probeAttempt + 1] : null;
    const hint = res.code === 'rate-limit' ? rateLimitHint() : '';

    if (nextStrat) {
      // 유튜브는 접속 경로마다 막는 기준이 다르다. 다음 경로로 바꿔 본다.
      state.probeAttempt += 1;
      $('load').textContent = '다른 방법으로';
      $('load').title = `${nextStrat.label} 방식으로 다시 시도합니다`;
    } else {
      $('load').textContent = '불러오기';
    }
    notice(res.error + hint, 'error', res.raw);
    setStatus('준비됨');
    return;
  }

  state.probeAttempt = 0;
  $('load').textContent = '불러오기';
  $('load').title = '';
  notice(null);
  setStatus('준비됨');
  state.info = res.info;
  state.start = 0;
  state.end = res.info.duration;

  $('vTitle').textContent = res.info.title;
  $('vChannel').textContent = res.info.channel || '';
  $('vDuration').textContent = res.info.duration ? hms(res.info.duration) : '—';
  $('vDate').textContent = ymd(res.info.uploadDate);
  $('vBest').textContent = res.info.heights && res.info.heights.length ? `${res.info.heights[0]}p` : '—';
  $('vOpen').onclick = () => window.utov.fs.external(res.info.webpageUrl);

  const lang = bestSubLang();
  $('subsNote').textContent = !lang
    ? '이 영상에는 쓸 만한 자막이 없습니다.'
    : `${labelOfLang(lang)} 자막을 넣습니다.`;
  $('subs').disabled = !lang;
  if (!lang) $('subs').value = 'none';

  setTrackArt(res.info.thumbnail);

  paintQualityOptions(res.info.heights);
  paintChapters(res.info.chapters);
  drawTicks();
  paintRange();

  $('primer').hidden = true;
  $('work').hidden = false;
  $('previewFallback').hidden = true;
  mountPlayer(res.info.id);

  if (res.info.isLive) {
    notice('진행 중인 라이브 방송입니다. 구간 지정이 정확하지 않을 수 있습니다.', 'error');
  }
}

function paintChapters(chapters) {
  const wrap = $('chapters');
  const holder = $('chapterChips');
  holder.textContent = '';
  if (!chapters || chapters.length < 2) {
    wrap.hidden = true;
    return;
  }
  for (const c of chapters) {
    const b = document.createElement('button');
    b.textContent = `${hms(c.start)} ${c.title}`.trim();
    b.title = c.title;
    b.onclick = () => {
      state.start = c.start;
      state.end = c.end || state.info.duration;
      clampRange();
      paintRange();
      if (state.playerReady) {
        try {
          state.player.seekTo(c.start, true);
        } catch { /* 무시 */ }
      }
    };
    holder.append(b);
  }
  wrap.hidden = false;
}

$('load').onclick = loadVideo;
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadVideo();
});

/* ══════════════════════════════════════════════════════════ 내려받기 */

$('go').onclick = async () => {
  if (!state.info) return;
  const dur = state.info.duration;
  const whole = state.start <= 0.01 && state.end >= dur - 0.01;

  const job = {
    url: state.info.webpageUrl || $('url').value.trim(),
    mode: state.mode,
    height: $('quality').value,
    subs: state.mode === 'audio' ? 'none' : $('subs').value,
    // 트랙을 하나만 받는다. 여러 개를 연달아 받으면 유튜브가 막는다.
    subLang: bestSubLang(),
    precise: $('precise').checked,
    trim: { enabled: !whole, start: state.start, end: state.end },
  };

  const res = await window.utov.yt.download(job);
  if (!res.ok) {
    notice(res.error, 'error');
    return;
  }

  addQueueItem(res.jobId, {
    title: state.info.title,
    whole,
    start: state.start,
    end: state.end,
    mode: state.mode,
    job,
  });
  $('queue').hidden = false;
  $('queue').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

function addQueueItem(jobId, meta) {
  const node = $('tplQueueItem').content.firstElementChild.cloneNode(true);
  const el = {
    root: node,
    title: node.querySelector('.q-title'),
    sub: node.querySelector('.q-sub'),
    pct: node.querySelector('.q-pct'),
    action: node.querySelector('.q-action'),
    dismiss: node.querySelector('.q-dismiss'),
    fill: node.querySelector('.q-bar > i'),
    detail: node.querySelector('.q-detail'),
    raw: node.querySelector('.q-raw'),
    copy: node.querySelector('.q-copy'),
  };

  el.copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.raw.textContent);
      el.copy.textContent = '복사했습니다';
      setTimeout(() => { el.copy.textContent = '오류 내용 복사'; }, 1800);
    } catch {
      el.copy.textContent = '복사하지 못했습니다';
    }
  };

  const range =
    (meta.whole ? '전체' : `${hms(meta.start)} – ${hms(meta.end)}`) +
    (meta.attempt ? ` · ${meta.stratLabel || '다른 방법'}` : '');
  el.title.textContent = meta.title;
  el.title.title = meta.title;
  el.sub.textContent = `${range} · 시작하는 중…`;
  el.pct.textContent = '';
  node.dataset.state = 'running';
  node.dataset.indet = '1';

  el.action.textContent = '취소';
  el.action.onclick = () => {
    const entry = state.jobs.get(jobId);
    if (entry && entry.state === 'running') {
      window.utov.yt.cancel(jobId);
      el.action.disabled = true;
      el.sub.textContent = `${range} · 멈추는 중…`;
    }
  };

  el.dismiss.onclick = () => {
    const entry = state.jobs.get(jobId);
    if (entry && entry.state === 'running') window.utov.yt.cancel(jobId);
    node.remove();
    state.jobs.delete(jobId);
    if (!$('queueList').children.length) $('queue').hidden = true;
  };

  $('queueList').prepend(node);
  state.jobs.set(jobId, { el, meta, range, state: 'running', streams: 0 });
  setStatus('내려받는 중…');
}

window.utov.yt.onEvent((evt) => {
  const entry = state.jobs.get(evt.jobId);
  if (!entry) return;
  const { el, range } = entry;

  switch (evt.type) {
    case 'log': {
      // 영상 스트림과 소리 스트림을 차례로 받는다. 어느 쪽인지 알려 준다.
      if (/^\[download\] Destination:/.test(evt.line)) entry.streams += 1;
      break;
    }

    case 'progress': {
      el.root.dataset.state = 'running';
      const phase =
        entry.meta.mode === 'audio'
          ? '소리 받는 중'
          : entry.streams <= 1
            ? '영상 받는 중'
            : '소리 받는 중';
      if (evt.percent == null) {
        el.root.dataset.indet = '1';
        el.pct.textContent = '';
        el.sub.textContent = `${range} · ${phase} ${bytes(evt.downloaded)}`;
      } else {
        delete el.root.dataset.indet;
        el.fill.style.width = `${evt.percent.toFixed(1)}%`;
        el.pct.textContent = `${evt.percent.toFixed(0)}%`;
        const bits = [range, phase, speed(evt.speed), eta(evt.eta)].filter(Boolean);
        el.sub.textContent = bits.join(' · ');
      }
      break;
    }

    case 'cutting': {
      // 받은 뒤 ffmpeg 가 자르거나 합치는 단계. 시간 기준으로만 진행을 알 수 있다.
      const span = Math.max(0.5, entry.meta.end - entry.meta.start);
      const pct = Math.min(100, (evt.seconds / span) * 100);
      el.root.dataset.state = 'running';
      delete el.root.dataset.indet;
      el.fill.style.width = `${pct.toFixed(1)}%`;
      el.pct.textContent = `${pct.toFixed(0)}%`;
      el.sub.textContent =
        `${range} · ${entry.meta.whole ? '합치는 중' : '잘라내는 중'} ${hms(evt.seconds)} / ${hms(span)}`;
      break;
    }

    case 'phase': {
      el.root.dataset.indet = '1';
      el.pct.textContent = '';
      el.sub.textContent = `${range} · ${evt.label}`;
      break;
    }

    case 'done': {
      entry.state = 'done';
      el.root.dataset.state = 'done';
      delete el.root.dataset.indet;
      el.fill.style.width = '100%';
      el.pct.textContent = '';
      const took = evt.elapsed ? `${Math.max(1, Math.round(evt.elapsed / 1000))}초` : '';
      const warns = Array.isArray(evt.warnings) ? evt.warnings : [];
      el.sub.textContent = [
        range,
        evt.reused ? '이미 받아 둔 파일입니다' : warns.length ? '저장했지만 확인할 점이 있습니다' : '저장 완료 · 재생 확인됨',
        evt.duration ? hms(evt.duration) : '',
        bytes(evt.size),
        took && `${took} 걸림`,
      ].filter(Boolean).join(' · ');

      // 파일은 생겼지만 그대로 두면 곤란한 점이 있으면 감추지 않는다
      if (warns.length) {
        el.root.dataset.state = 'warn';
        el.raw.textContent = warns.join('\n');
        el.detail.hidden = false;
        el.copy.hidden = true;
      }

      el.action.disabled = false;
      el.action.textContent = '폴더 열기';
      el.action.onclick = () => window.utov.fs.reveal(evt.file);
      if (evt.file) {
        el.title.style.cursor = 'pointer';
        el.title.title = `${evt.file}\n(눌러서 재생)`;
        el.title.onclick = () => window.utov.fs.open(evt.file);
      }
      setStatus('저장했습니다');
      break;
    }

    case 'canceled': {
      entry.state = 'canceled';
      el.root.dataset.state = 'canceled';
      delete el.root.dataset.indet;
      el.fill.style.width = '0%';
      el.pct.textContent = '';
      el.sub.textContent = `${range} · 취소했습니다`;
      el.action.disabled = false;
      el.action.textContent = '다시';
      el.action.onclick = () => retry(evt.jobId);
      setStatus('취소했습니다');
      break;
    }

    case 'error': {
      entry.state = 'error';
      el.root.dataset.state = 'error';
      delete el.root.dataset.indet;
      el.fill.style.width = '100%';
      el.pct.textContent = '';
      el.action.disabled = false;

      const blocked = evt.code === 'rate-limit' || evt.code === 'bot-check' || evt.code === 'unknown';
      const text = evt.code === 'rate-limit' ? evt.message + rateLimitHint() : evt.message;
      el.sub.textContent = text;
      el.sub.title = text;

      // 무엇이 실제로 잘못됐는지 감추지 않는다
      if (evt.raw) {
        el.raw.textContent = evt.raw;
        el.detail.hidden = false;
      }

      // 유튜브는 접속 경로마다 막는 기준이 다르다. 차례로 바꿔 본다.
      const next = (entry.meta.attempt || 0) + 1;
      const strat = blocked ? state.strategies[next] : null;
      if (strat) {
        el.action.textContent = '다른 방법으로 다시';
        el.action.title = `${strat.label} 방식으로 다시 시도합니다`;
        el.action.onclick = () => retry(evt.jobId, next);
      } else {
        el.action.textContent = '다시';
        el.action.onclick = () => retry(evt.jobId, entry.meta.attempt || 0);
      }
      setStatus(evt.code === 'rate-limit' ? '유튜브가 속도를 제한했습니다' : '오류가 났습니다');
      break;
    }
    default:
      break;
  }
});

/** attempt 는 state.strategies 의 인덱스. 막힐 때마다 다음 방법으로 넘어간다. */
async function retry(oldJobId, attempt = 0) {
  const entry = state.jobs.get(oldJobId);
  if (!entry) return;

  const strat = state.strategies[attempt] || state.strategies[0] || {};
  const job = Object.assign({}, entry.meta.job, {
    safeMode: Boolean(strat.safeMode),
    client: strat.client || null,
  });

  const res = await window.utov.yt.download(job);
  if (!res.ok) {
    entry.el.sub.textContent = res.error;
    return;
  }
  entry.el.root.remove();
  state.jobs.delete(oldJobId);
  addQueueItem(res.jobId, Object.assign({}, entry.meta, {
    job,
    attempt,
    stratLabel: strat.label,
  }));
}

$('clearDone').onclick = () => {
  for (const [id, entry] of [...state.jobs]) {
    if (entry.state !== 'running') {
      entry.el.root.remove();
      state.jobs.delete(id);
    }
  }
  if (!$('queueList').children.length) $('queue').hidden = true;
};

/* ══════════════════════════════════════════════════════════ 시작 */

(async function boot() {
  state.settings = await window.utov.settings.get();
  applyTheme(state.settings.theme);
  paintSettings();

  state.mode = state.settings.mode === 'audio' ? 'audio' : 'video';
  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === state.mode));
  }
  $('rowQuality').hidden = state.mode === 'audio';
  $('rowSubs').hidden = state.mode === 'audio';

  const info = await window.utov.info();
  state.strategies = Array.isArray(info.strategies) && info.strategies.length
    ? info.strategies
    : [{ label: '기본' }];
  $('version').textContent = `UtoV ${info.version} · Electron ${info.electron} · 도구 폴더 ${info.binDir}`;

  const status = await window.utov.tools.status();
  paintTools(status);

  if (!status.ready) {
    $('stage').hidden = true;
    $('setup').hidden = false;
    setStatus('도구 준비가 필요합니다');
  } else {
    setStatus('준비됨');
    $('url').focus();
    // 예전 버전에서 올라온 경우 yt-dlp 와 ffmpeg 는 있지만 deno 가 없다.
    // 준비 화면이 뜨지 않으므로 여기서 조용히 채워 넣는다.
    if (!status.deno || !status.deno.ok) topUpTools();
  }
})();

/** 빠진 도구를 화면을 막지 않고 뒤에서 채운다 */
async function topUpTools() {
  const r = await window.utov.tools.ensure();
  if (r.ok) paintTools(r.status);
  setStatus('준비됨');
}
