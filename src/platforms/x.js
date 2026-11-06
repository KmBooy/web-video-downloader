export const xHosts = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'];

function thumbnailId(value) {
  if (!value) return;
  try {
    const url = new URL(value, location.href);
    if (url.hostname === 'pbs.twimg.com') {
      return url.pathname.match(/^\/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/([^/.]+)/)?.[1];
    }
  } catch {}
}

export function scanX({ url, players, result }) {
  const status = url.pathname.match(/^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/video\/(\d+))?\/?$/);
  const current = status?.[1];
  const articles = Array.from(document.querySelectorAll('article')).slice(0, 50);
  const titles = new Map();
  let mediaIds = [];
  for (const article of articles) {
    const images = Array.from(article.querySelectorAll('img'), image => image.currentSrc || image.src);
    const posters = players.filter(player => player.closest('article') === article).map(player => player.poster);
    const ids = [...new Set([...posters, ...images].map(thumbnailId).filter(Boolean))];
    if (!ids.length) continue;
    const title = article.querySelector('[data-testid="tweetText"]')?.textContent;
    for (const id of ids) if (title && !titles.has(id)) titles.set(id, title);
    if (current && Array.from(article.querySelectorAll('a[href*="/status/"]')).some(link => {
      const path = new URL(link.href, url).pathname;
      return path.endsWith('/status/' + current) || path.endsWith('/status/' + current + '/analytics');
    })) {
      mediaIds = ids;
      result.title = title || result.title;
    }
  }
  if (status?.[2]) {
    const overlay = players.filter(player => !player.closest('article')).map(player => thumbnailId(player.poster)).filter(Boolean);
    const index = Number(status[2]) - 1;
    mediaIds = overlay.length ? overlay : mediaIds.slice(index, index + 1);
    for (const id of mediaIds) titles.set(id, result.title);
  }
  result.site = 'x';
  result.xMediaIds = mediaIds;
  result.xTitles = [...titles];
  result.hint = '请播放网页里的 X 视频，扩展会列出播放器加载的完整视频或主清单。';
}

function xMedia(entry) {
  if (!entry.url || !['hls', 'file'].includes(entry.kind)) return;
  const url = new URL(entry.url);
  if (url.hostname !== 'video.twimg.com') return;
  const path = url.pathname.match(/^\/(?:(?:amplify_video|ext_tw_video)\/([^/]+)\/|tweet_video\/([^/.]+)\.)/);
  const id = path?.[1] ?? path?.[2];
  if (!id) return;
  const master = entry.kind === 'hls' && /\/pl\/[^/]+\.m3u8$/i.test(url.pathname);
  const file = entry.kind === 'file'
    && /\/(?:tweet_video\/[^/]+|vid\/(?:[^/]+\/)?\d+x\d+\/[^/]+)\.mp4$/i.test(url.pathname);
  if (!master && !file) return;
  const dimensions = url.pathname.match(/\/(\d+)x(\d+)\//);
  return { id, master, width: Number(dimensions?.[1]) || entry.width, height: Number(dimensions?.[2]) || entry.height };
}

export function carryXEntries(page, previous) {
  if (!previous || !xHosts.includes(new URL(page).hostname) || new URL(previous.page).origin !== new URL(page).origin) return [];
  return [...(previous.xEntries ?? []), ...previous.entries.filter(xMedia)].slice(-50);
}

export function xCandidates(entries, snapshot, previous = []) {
  const titles = new Map(snapshot.xTitles);
  const preferred = new Set(snapshot.xMediaIds);
  const groups = new Map();
  for (const entry of [...previous, ...entries]) {
    const media = xMedia(entry);
    if (!media || (previous.includes(entry) && !titles.has(media.id) && !preferred.has(media.id))) continue;
    if (!groups.has(media.id)) groups.set(media.id, { files: new Map() });
    const group = groups.get(media.id);
    if (media.master) group.master = entry;
    else group.files.set(new URL(entry.url).pathname, { ...entry, width: media.width, height: media.height });
  }
  return [...groups.entries()].sort(([a], [b]) => Number(preferred.has(b)) - Number(preferred.has(a)))
    .map(([id, group]) => {
      const files = [...group.files.values()];
      const candidate = group.master ?? (files.length === 1 ? files[0] : { kind: 'files', files });
      return {
        ...candidate, id: 'x:' + id, site: 'x',
        title: titles.get(id) || (preferred.has(id) ? snapshot.title : 'X 视频（同页捕获）'),
      };
    });
}
