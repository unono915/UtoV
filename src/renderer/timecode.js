'use strict';
/**
 * 구간 시각을 밀리초 단위로 다루는 순수 함수들.
 *
 * 화면(app.js)과 테스트가 함께 쓴다. 브라우저에서는 window.UtovTime 으로,
 * node 에서는 module.exports 로 내보낸다.
 *
 * 유튜브 주소의 ?t= 는 초 단위뿐이지만, UtoV 는 원본을 다 받은 뒤 PC 의
 * ffmpeg 로 자르므로 밀리초까지 지정할 수 있다. 다만 영상은 프레임 단위가
 * 최소라서(30fps 면 약 33ms) 지정한 시각 바로 다음 프레임부터 시작한다.
 */
(function (root) {
  /** 소수점 셋째 자리(밀리초)로 맞춘다 */
  function roundMs(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
  }

  /** 초 → 00:01:23.456 */
  function hmsMs(sec) {
    const total = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const ms = total % 1000;
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':') + '.' + String(ms).padStart(3, '0');
  }

  /**
   * "1:23", "01:02:03", "90", "1:23.5", "1:23,456" → 초 (밀리초까지). 못 읽으면 null.
   * 소수점은 쉼표로 써도 된다. 밀리초보다 잘게 적으면 반올림한다.
   */
  function parseTime(text) {
    const raw = String(text ?? '').trim().replace(/\s/g, '').replace(',', '.');
    if (!raw) return null;
    if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d+)?$/.test(raw)) return null;
    const parts = raw.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    // 분과 초 자리는 60 을 넘을 수 없다 (맨 앞 자리는 90초처럼 그대로 받는다)
    if (parts.slice(1).some((n) => n >= 60)) return null;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return roundMs(sec);
  }

  const rateOf = (fps) => (Number(fps) > 0 ? Number(fps) : 30);

  /**
   * 이 시각을 경계로 삼았을 때 ffmpeg 가 고르는 프레임 번호.
   * 시작이면 첫 프레임, 끝이면 빠지는 첫 프레임이다 (지정한 시각 이후의 첫 프레임).
   * 1e-6 은 부동소수점 잡음만 흡수한다.
   */
  function frameAt(sec, fps) {
    return Math.max(0, Math.ceil(Math.max(0, Number(sec) || 0) * rateOf(fps) - 1e-6));
  }

  /** 프레임 번호 → 그 프레임에서 바로 자르게 하는 시각 (밀리초 아래를 버린다) */
  function frameStart(k, fps) {
    return Math.max(0, Math.floor((k / rateOf(fps)) * 1000 + 1e-6) / 1000);
  }

  /**
   * 한 프레임 앞이나 뒤의 시각.
   *
   * ffmpeg 는 지정한 시각 이후의 첫 프레임부터 자르므로, 그 규칙으로 지금
   * 프레임을 정한 뒤 한 칸 옮긴다. 그래서 프레임 사이에 놓인 값에서 눌러도
   * 결과가 반드시 한 프레임 바뀐다. 결과는 밀리초 아래를 버려서 그 프레임에서
   * 바로 시작하게 한다 (반올림하면 1ms 차이로 다음 프레임부터 잘릴 수 있다).
   */
  function stepFrame(sec, fps, dir) {
    return frameStart(Math.max(0, frameAt(sec, fps) + (dir > 0 ? 1 : -1)), fps);
  }

  /**
   * 미리보기에서 보여 줄 시각. 저장된 경계값은 프레임 직전이라 그대로 찾아가면
   * 한 프레임 앞 장면이 보인다. 시작은 첫 프레임의, 끝은 마지막으로 들어가는
   * 프레임의 한가운데로 찾아간다.
   */
  function previewTime(sec, fps, which) {
    const k = frameAt(sec, fps);
    const mid = which === 'end' ? k - 0.5 : k + 0.5;
    return Math.max(0, mid / rateOf(fps));
  }

  /**
   * 고른 화질에서 받게 될 영상의 초당 프레임 수.
   * @param {{fpsByHeight?: Record<string, number>, fpsBest?: number}} info
   * @param {string} quality  'best' 또는 '720' 같은 높이 상한
   */
  function fpsFor(info, quality) {
    if (!quality || quality === 'best') return Number(info && info.fpsBest) || 30;
    let best = 0;
    for (const [h, f] of Object.entries((info && info.fpsByHeight) || {})) {
      if (Number(h) <= Number(quality) && Number(f) > best) best = Number(f);
    }
    return best || 30;
  }

  const api = { roundMs, hmsMs, parseTime, stepFrame, previewTime, fpsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UtovTime = api;
})(typeof window !== 'undefined' ? window : globalThis);
