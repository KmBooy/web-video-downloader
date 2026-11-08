export const douyinHosts = ['www.douyin.com', 'jingxuan.douyin.com'];

function douyinCdn(media) {
  return media.hostname.endsWith('.douyinvod.com')
    || /^v\d+-dy-[a-z0-9-]+\.zjcdn\.com$/.test(media.hostname);
}

export const douyinDownload = {
  referer: 'https://www.douyin.com/',
  accepts(url) {
    const media = new URL(url);
    return media.protocol === 'https:' && douyinCdn(media) && media.pathname.includes('/video/tos/');
  },
};

function currentFeedItem(container, postId) {
  if (!container || !postId) return;
  const fiberKey = Object.keys(container).find(key => key.startsWith('__reactFiber$'));
  // The active slide owns the current item. Its ancestors can also expose
  // the original post that opened the modal, so require the current ID.
  for (let fiber = container[fiberKey], depth = 0; fiber && depth < 16; fiber = fiber.return, depth++) {
    const props = fiber.memoizedProps;
    const item = [props?.item, props?.slideData].find(value => value?.awemeId === postId && value.video);
    if (item) return item;
  }
}

function replaySources(players, episodeId) {
  for (const player of players) {
    for (let node = player, parents = 0; node && parents < 4; node = node.parentElement, parents++) {
      const key = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
      if (!key) continue;
      for (let fiber = node[key], depth = 0; fiber && depth < 16; fiber = fiber.return, depth++) {
        const item = fiber.memoizedProps?.awemeInfo;
        const media = item?.episodeId === episodeId && item.dashOpts?.dynamic_video;
        if (!media) continue;
        // The player owns this episode's tracks. Resource timings can be full
        // or still contain another replay after an in-page navigation.
        return [media.dynamic_video_list, media.dynamic_audio_list].flatMap(list =>
          (Array.isArray(list) ? list : []).flatMap(track =>
            [track.backup_url, track.main_url].flat().filter(url => typeof url === 'string' && url).map(name => ({
              name, contentType: 'video/mp4',
              height: Math.min(track.vwidth, track.vheight) || undefined,
              bitrate: Number(track.bitrate || track.avg_bitrate) || 0,
            }))));
      }
      break;
    }
  }
}

function completeFiles(sources) {
  const files = new Map();
  for (const source of sources) {
    if (!Array.isArray(source.urls)) continue;
    const addresses = new Set();
    for (const address of source.urls) {
      let media;
      try { media = new URL(address); } catch { continue; }
      if (media.protocol !== 'https:' || media.username || media.password
          || !douyinCdn(media) || !media.pathname.includes('/video/tos/')
          || media.searchParams.get('mime_type') !== 'video_mp4'
          || media.searchParams.has('range') || media.searchParams.has('bytestart')
          || /\/media-(?:audio|video)-[^/]+\/?$/.test(media.pathname)) continue;
      const expire = Number(media.searchParams.get('expire'));
      if (expire > 0 && expire <= Date.now() / 1000) continue;
      addresses.add(media.href);
    }
    const [url, ...mirrors] = addresses;
    if (!url) continue;
    const media = new URL(url);
    const key = media.pathname.split('/video/tos/')[1];
    const previous = files.get(key);
    if (previous) {
      addresses.delete(previous.url);
      if (addresses.size) previous.mirrors = [...new Set([...(previous.mirrors ?? []), ...addresses])];
      continue;
    }
    files.set(key, {
      url,
      ...(mirrors.length ? { mirrors } : {}),
      height: Math.min(source.width || source.height, source.height || source.width) || undefined,
      bitrate: Number(source.bitrate) || (Number(media.searchParams.get('br')) || 0) * 1000,
      bytes: Number(source.bytes) || 0,
    });
  }
  return [...files.values()];
}

function completeFeedFiles(video) {
  const sources = Array.isArray(video.bitRateList) ? [...video.bitRateList, video] : [video];
  return completeFiles(sources.map(source => ({
    ...source, urls: Array.isArray(source.playAddr) ? source.playAddr.map(address => address?.src) : [],
    bitrate: source.bitRate, bytes: source.playAddrSize ?? source.dataSize,
  })));
}

export async function refreshDouyinFiles(result, postId, page) {
  if (!postId || result.douyinPost !== postId) return;
  const api = new URL('/aweme/v1/web/aweme/detail', page);
  api.search = new URLSearchParams({ aid: '6383', version_code: '190500', aweme_id: postId });
  let detail;
  try {
    const response = await fetch(api.pathname + api.search, {
      credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    if (response.ok && /json/i.test(response.headers.get('content-type') ?? '')) {
      detail = (await response.json()).aweme_detail;
    }
  } catch {}
  if (detail?.aweme_id !== postId || !detail.video) return;

  const video = detail.video;
  const rendition = (address, bitrate) => ({
    width: address?.width || video.width, height: address?.height || video.height,
    bytes: address?.data_size, bitrate, urls: address?.url_list,
  });
  const variants = Array.isArray(video.bit_rate)
    ? video.bit_rate.filter(entry => entry.format === 'mp4').map(entry => rendition(entry.play_addr, entry.bit_rate))
    : [];
  const files = completeFiles([...variants, rendition(video.play_addr)]);
  if (!files.length) return;
  result.files = files;
  result.title = detail.item_title || (result.site === 'douyin-video' ? result.title : detail.desc) || result.title;
  result.site = 'douyin-video';
}

export function scanDouyin({ url, players = [], videos, recent, resourceSince, result }) {
  const replay = url.pathname.match(/^\/vsdetail\/(\d+)(?:\/|$)/)?.[1];
  const detail = url.pathname.match(/^\/(?:m\/)?video\/(\d+)(?:\/|$)/)?.[1];
  const modal = url.searchParams.get('modal_id')?.match(/^\d+$/)?.[0];
  const active = replay ? undefined : players.map(player => player.closest('[data-e2e="feed-active-video"]')).find(Boolean);
  const activeId = active?.className?.match(/(?:^|\s)video_(\d+)(?=\s|$)/)?.[1];
  const douyinPost = detail ?? modal ?? activeId;
  if (!replay && douyinPost) {
    if (activeId && activeId !== douyinPost) return;
    result.douyinPost = douyinPost;
    const item = currentFeedItem(active, douyinPost);
    const files = item ? completeFeedFiles(item.video) : [];
    if (files.length) {
      result.files = files;
      result.title = item.itemTitle || item.desc || result.title;
      result.site = 'douyin-video';
      return;
    }
  }
  if (replay || douyinPost) {
    const playback = videos.filter(video => video.url && video.duration > 0 && (!replay || video.url.startsWith('blob:')))
      .sort((a, b) => b.duration - a.duration)[0];
    const tracks = { video: new Map(), audio: new Map(), file: new Map() };
    const directSources = replay ? [] : videos.filter(item => /^https:\/\//.test(item.url)
        && ((!modal && !activeId && !resourceSince) || new URL(item.url).searchParams.get('__vid') === douyinPost))
      .map(item => ({ name: item.url, height: item.height }));
    const sources = replay ? replaySources(players, replay) : undefined;
    for (const entry of sources ?? [...recent, ...directSources]) {
      let media;
      try { media = new URL(entry.name, url); } catch { continue; }
      if (!replay && (modal || activeId) && media.searchParams.get('__vid') !== douyinPost) continue;
      const mp4 = media.searchParams.get('mime_type') === 'video_mp4'
        || entry.contentType?.split(';')[0] === 'video/mp4';
      if (media.protocol !== 'https:' || !douyinCdn(media) || !mp4 || !media.pathname.includes('/video/tos/')
          || media.searchParams.has('range') || media.searchParams.has('bytestart')) continue;
      const track = media.pathname.match(/\/media-(audio|video)-[^/]+\/?$/)?.[1];
      if (replay ? !track : track) continue;
      const variants = tracks[track ?? 'file'];
      const key = media.pathname.split('/video/tos/')[1];
      variants.set(key, {
        url: media.href,
        height: entry.height || variants.get(key)?.height,
        bitrate: entry.bitrate || (Number(media.searchParams.get('br')) || 0) * 1000,
      });
    }
    if (replay && tracks.video.size && tracks.audio.size) {
      result.variants = [...tracks.video.values()];
      if (result.variants.length === 1) result.variants[0].height ??= playback?.height;
      result.audio = [...tracks.audio.values()];
      result.duration = playback?.duration;
      result.site = 'douyin-replay';
    } else if (replay && (playback || tracks.video.size || tracks.audio.size)) {
      result.hint = '抖音回放的音视频分开加载。请播放几秒后再扫描。';
    } else if (douyinPost && tracks.file.size) {
      result.files = [...tracks.file.values()];
      if (result.files.length === 1 && playback?.height) result.files[0].height = playback.height;
      result.site = 'douyin-video';
    }
  }
}

export function isDouyinProbe(value) {
  try { return new URL(value).pathname.endsWith('/douyin-pc-web/uuu_265.mp4'); } catch { return false; }
}
