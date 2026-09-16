/* 개발용 임시 목업 — 브라우저에서 화면만 확인할 때 쓴다. 배포본에는 넣지 않는다. */
if (!window.utov) {
  const noop = () => {};
  const settings = {
    outDir: 'C:\\Users\\yhji915\\Videos\\UtoV',
    mode: 'video', height: '1080', precise: true, subs: 'none',
    cookiesFrom: 'none', theme: 'light', concurrency: 5,
  };
  window.utov = {
    win: { minimize: noop, maximize: noop, close: noop, isMaximized: async () => false, onState: noop },
    settings: { get: async () => settings, set: async (p) => Object.assign(settings, p) },
    tools: {
      status: async () => ({
        ytdlp: { ok: true, version: '2026.08.19' },
        ffmpeg: { ok: true, version: 'N-126575' },
        ready: true, binDir: 'C:\\Users\\yhji915\\AppData\\Roaming\\UtoV\\bin',
      }),
      ensure: async () => ({ ok: true }), update: async () => ({ ok: true }), onProgress: noop,
    },
    yt: {
      probe: async () => ({
        ok: true,
        info: {
          id: 'aqz-KE-bpKQ',
          title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
          channel: 'Blender Foundation', duration: 635,
          thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg',
          webpageUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
          uploadDate: '20141110', isLive: false,
          heights: [2160, 1440, 1080, 720, 480, 360],
          hasSubtitles: true, hasAutoSubtitles: true,
          chapters: [
            { title: '오프닝', start: 0, end: 90 },
            { title: '나비와 만남', start: 90, end: 240 },
            { title: '추격', start: 240, end: 470 },
            { title: '마무리', start: 470, end: 635 },
          ],
        },
      }),
      download: async () => ({ ok: true, jobId: 'mock-' + Math.random().toString(36).slice(2, 7) }),
      cancel: noop, onEvent: noop,
    },
    fs: { chooseFolder: async () => null, reveal: noop, open: noop, external: noop, exists: async () => true },
    info: async () => ({ version: '1.0.0', electron: '44.4.1', binDir: 'C:\\Users\\yhji915\\AppData\\Roaming\\UtoV\\bin' }),
  };
}
