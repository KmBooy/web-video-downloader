import { douyinHosts, isDouyinProbe, refreshDouyinFiles, scanDouyin } from './platforms/douyin.js';
import { scanBilibili } from './platforms/bilibili.js';
import { scanX, xHosts } from './platforms/x.js';
import { scanXiaohongshu } from './platforms/xiaohongshu.js';
import { scanYouTube } from './platforms/youtube.js';
import { scanInstagram } from './platforms/instagram.js';

const scanners = new Map([
  ...douyinHosts.map(host => [host, scanDouyin]),
  ...xHosts.map(host => [host, scanX]),
  ['www.bilibili.com', scanBilibili],
  ['www.xiaohongshu.com', scanXiaohongshu],
  ['www.youtube.com', scanYouTube],
  ['m.youtube.com', scanYouTube],
  ['www.instagram.com', scanInstagram],
  ['instagram.com', scanInstagram],
]);

export async function scanPage(resourceSince, downloadPostId, contextTarget) {
  const url = new URL(location.href);
  const videoTitle = video => {
    const label = video.getAttribute?.('title') || video.getAttribute?.('aria-label');
    if (label && !/^(?:视频|播放|播放器|播放视频|video|video player|play video)$/i.test(label.trim())) return label;
    const caption = video.closest?.('figure')?.querySelector('figcaption')?.textContent;
    if (caption?.trim()) return caption;
    if (xHosts.includes(url.hostname)) {
      return video.closest?.('article')?.querySelector('[data-testid="tweetText"]')?.textContent;
    }
    return '';
  };
  const players = Array.from(document.querySelectorAll('video')).slice(0, 30);
  const videos = players.map(video => ({
    title: videoTitle(video),
    url: video.currentSrc || video.src,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
  })).filter(video => !isDouyinProbe(video.url));
  const recent = performance.getEntriesByType('resource').slice(-800)
    .filter(entry => performance.timeOrigin + entry.startTime >= resourceSince);
  const resources = recent.filter(entry => ['video', 'audio'].includes(entry.initiatorType) ||
      /\.(?:m3u8?|mpd|mp4|webm|m4s|ts|mkv|ogv)(?:[?#]|$)/i.test(entry.name) ||
      /(?:googlevideo\.com\/videoplayback|\/x\/player\/(?:wbi\/)?playurl)/i.test(entry.name))
    .filter(entry => !isDouyinProbe(entry.name))
    .map(entry => ({ url: entry.name, mime: entry.contentType, ranged: entry.responseStatus === 206 }));
  const result = { url: url.href, title: document.title, resources,
    videos: resourceSince ? videos.filter(video => recent.some(item => item.name === video.url)) : videos };
  const clip = entry => ({
    url: entry.baseUrl ?? entry.base_url ?? entry.url,
    width: entry.width,
    height: entry.height,
    bitrate: entry.bandwidth ?? entry.bitrate,
    id: entry.id ?? entry.itag,
  });

  await scanners.get(url.hostname)?.({ url, players, videos, recent, resources, resourceSince, result, clip, downloadPostId, contextTarget });
  if (downloadPostId && douyinHosts.includes(url.hostname)) {
    await refreshDouyinFiles(result, downloadPostId, url);
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const activeId = active?.className?.match(/(?:^|\s)video_(\d+)(?=\s|$)/)?.[1];
    if (activeId && activeId !== downloadPostId) {
      delete result.douyinPost;
      delete result.files;
    }
  }
  return result;
}
