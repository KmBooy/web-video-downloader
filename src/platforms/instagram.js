import { classify, mediaUrl } from '../media.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const postPath = /\/(?:p|tv|reels?(?!\/audio(?:\/|$)))\/([\w-]+)(?:\/|$)/;

export function instagramCode(value, base) {
  try {
    const url = new URL(value, base);
    if (['www.instagram.com', 'instagram.com'].includes(url.hostname)) return url.pathname.match(postPath)?.[1];
  } catch {}
}

export function instagramMediaId(code) {
  let id = 0n;
  for (const character of code) id = id * 64n + BigInt(alphabet.indexOf(character));
  return String(id);
}

export function findInstagramMedia(root, codes) {
  const found = new Map();
  const stack = [root];
  for (let visited = 0; stack.length && visited < 50_000; visited++) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    const code = item.code ?? item.shortcode;
    if (codes.includes(code) && (item.video_versions || item.video_url || item.carousel_media)) {
      found.set(code, item);
      continue;
    }
    for (const value of Object.values(item)) if (value && typeof value === 'object') stack.push(value);
  }
  return found;
}

export function instagramVideos(item, code, clip) {
  const media = item.carousel_media ?? [item];
  const caption = item.caption?.text || item.title || 'Instagram 视频';
  return media.flatMap((video, index) => {
    const versions = video.video_versions ?? (video.video_url ? [{
      url: video.video_url, width: video.dimensions?.width, height: video.dimensions?.height,
    }] : []);
    const files = new Map();
    for (const version of versions) {
      const url = mediaUrl(version.url);
      if (!url || new URL(url).searchParams.has('byteend') || classify({ url, mime: 'video/mp4' }) !== 'file') continue;
      files.set(url, clip({ ...version, url }));
    }
    return files.size ? [{
      id: 'instagram:' + code + ':' + (video.pk ?? video.id ?? index),
      kind: 'files', site: 'instagram', files: [...files.values()], duration: video.video_duration,
      requiresAudio: (video.has_audio ?? item.has_audio) === true,
      posterPaths: (video.image_versions2?.candidates ?? []).flatMap(image => {
        try { return [new URL(image.url).pathname]; } catch { return []; }
      }),
      title: caption + (media.length > 1 ? ' · ' + (index + 1) : ''),
    }] : [];
  });
}

export async function scanInstagram({ url, players, result, clip, downloadPostId, contextTarget }) {
  result.site = 'instagram';
  result.instagramVideos = [];
  result.hint = '请播放当前 Instagram 帖子或 Reels，再重新扫描。';
  const current = contextTarget?.site === 'instagram' ? contextTarget.code : instagramCode(url.href);
  const codes = current ? [current] : [...new Set(players.flatMap(video => {
    const rect = video.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return [];
    return Array.from(video.closest('article')?.querySelectorAll('a[href]') ?? [],
      link => instagramCode(link.href, url)).filter(Boolean);
  }))].slice(0, 3);
  if (!codes.length) return;

  const media = new Map();
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const text = script.textContent;
    if (text.length > 8 * 1024 * 1024 || !codes.some(code => text.includes(code))) continue;
    try {
      for (const [code, item] of findInstagramMedia(JSON.parse(text), codes)) media.set(code, item);
    } catch {}
    if (codes.every(code => media.has(code))) break;
  }
  for (const code of codes) {
    if (media.has(code) && code !== downloadPostId) continue;
    try {
      const response = await fetch('/api/v1/media/' + instagramMediaId(code) + '/info/', {
        credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459' }, signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) continue;
      const item = (await response.json()).items?.find(item => item.code === code);
      if (item) media.set(code, item);
    } catch {}
  }
  result.instagramVideos = codes.flatMap(code => media.has(code) ? instagramVideos(media.get(code), code, clip) : []);
}
