import { instagramCode } from './platforms/instagram.js';
import { thumbnailId, xHosts, xMedia } from './platforms/x.js';

export const contextHosts = [...xHosts, 'www.instagram.com', 'instagram.com'];

export function contextVideo(target, x, y) {
  if (!contextHosts.includes(location.hostname)) return null;
  const direct = target.closest?.('video');
  if (direct) return direct;
  const scope = target.closest?.('article, [role="dialog"]');
  const videos = scope ? Array.from(scope.querySelectorAll('video'))
    : document.elementsFromPoint(x, y).filter(element => element instanceof HTMLVideoElement);
  const pointed = videos.filter(video => {
    const rect = video.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
  if (pointed.length === 1) return pointed[0];
  return videos.length === 1 ? videos[0] : null;
}

export function describeContextVideo(video) {
  const scope = video.closest('article, [role="dialog"]') ?? video.parentElement;
  const src = video.currentSrc || video.src;
  const poster = video.poster || '';
  if (xHosts.includes(location.hostname)) {
    const mediaId = thumbnailId(poster) || xMedia({ url: src, kind: 'file' })?.id;
    return { page: location.href, site: 'x', mediaId, src, poster };
  }
  const links = Array.from(scope?.querySelectorAll('a[href]') ?? [], link => link.href);
  const codes = [...new Set(links.map(link => instagramCode(link)).filter(Boolean))];
  const code = codes.length === 1 ? codes[0] : codes.length === 0 ? instagramCode(location.href) : undefined;
  return { page: location.href, site: 'instagram', code, src, poster };
}

export function contextCandidate(entries, target) {
  let matches = entries.filter(entry => target.site === 'x'
    ? target.mediaId && entry.id === 'x:' + target.mediaId
    : target.code && entry.id?.startsWith('instagram:' + target.code + ':'));
  if (matches.length > 1) {
    const direct = matches.filter(entry => entry.files?.some(file => file.url === target.src));
    if (direct.length === 1) return direct[0];
    let posterPath;
    try { posterPath = new URL(target.poster).pathname; } catch {}
    matches = matches.filter(entry => posterPath && entry.posterPaths?.includes(posterPath));
  }
  if (matches.length !== 1) throw new Error('未能确定这条视频。请先播放后重新右键，或在扩展列表中选择。');
  return matches[0];
}
