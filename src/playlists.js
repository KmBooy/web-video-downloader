import { Parser } from 'm3u8-parser';
import { parse as parseMpd } from 'mpd-parser';
import { mediaUrl } from './media.js';

function resolve(value, base) {
  const url = value && mediaUrl(value, base);
  if (!url) throw new Error('媒体清单里有无效地址。');
  return url;
}

function quality(height, bitrate, index) {
  return [height ? height + 'p' : '画质 ' + (index + 1), bitrate ? Math.round(bitrate / 1000) + ' kbps' : '']
    .filter(Boolean).join(' · ');
}

export function hlsManifest(text, base) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('这个地址没有返回 HLS 清单。');
  if (/^#EXT-X-(?:SESSION-)?KEY:.*\bMETHOD=(?!NONE(?:,|\s|$))/mi.test(text)) {
    throw new Error('该 HLS 含加密媒体，当前版本无法保存。');
  }
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const manifest = parser.manifest;
  if (!manifest.playlists?.length) {
    if (!manifest.segments?.length) throw new Error('HLS 清单里没有完整片段。');
    if (!manifest.endList) throw new Error('已识别正在播的 HLS 直播。可以在回放生成后重新扫描。');
    const duration = manifest.segments.reduce((total, segment) => total + (segment.duration || 0), 0);
    return [{
      label: '原始画质', videoUrl: base, duration,
      dateTime: /^#EXT-X-PROGRAM-DATE-TIME:/m.test(text),
      discontinuous: /^#EXT-X-DISCONTINUITY\s*$/m.test(text),
    }];
  }

  return manifest.playlists.map((item, index) => {
      const group = Object.values(manifest.mediaGroups?.AUDIO?.[item.attributes?.AUDIO] ?? {});
      const audio = group.find(track => track.default) ?? group[0];
      return {
        label: quality(item.attributes?.RESOLUTION?.height, item.attributes?.BANDWIDTH, index),
        videoUrl: resolve(item.uri, base),
        audioUrl: audio?.uri ? resolve(audio.uri, base) : undefined,
        bitrate: item.attributes?.BANDWIDTH || 0,
        height: item.attributes?.RESOLUTION?.height,
      };
    }).sort((a, b) => b.bitrate - a.bitrate);
}

export function hlsChildren(text, url) {
  const list = hlsManifest(text, url);
  if (list.length !== 1 || list[0].videoUrl !== url || list[0].duration == null) {
    throw new Error('检测到多层 HLS 主清单，当前版本无法保存。');
  }
  return list[0];
}

function parts(list, manifestUrl) {
  const segmentUrl = segment => resolve(segment.resolvedUri ?? segment.uri, manifestUrl);
  if (list.sidx && (!list.sidx.map || segmentUrl(list.sidx.map) === segmentUrl(list.sidx))) {
    return { url: segmentUrl(list.sidx) };
  }
  const segments = list.segments ?? [];
  if (!segments.length || !segments[0].map) throw new Error('DASH 缺少可用的初始化片段。');
  if (segments.some(segment => segment.discontinuity || !segment.map
      || segmentUrl(segment.map) !== segmentUrl(segments[0].map)
      || JSON.stringify(segment.map.byterange) !== JSON.stringify(segments[0].map.byterange))) {
    throw new Error('当前版本支持使用同一初始化片段的 DASH 点播。');
  }
  return {
    segments: [segments[0].map, ...segments].map(segment => ({
      url: segmentUrl(segment), range: segment.byterange,
    })),
  };
}

export function dashManifest(text, url) {
  if (!/<(?:\w+:)?MPD[\s>]/i.test(text)) throw new Error('这个地址没有返回 DASH 清单。');
  if (/<(?:\w+:)?ContentProtection\b/i.test(text)) throw new Error('该 DASH 含内容保护，当前版本无法保存。');
  if (/<(?:\w+:)?MPD\b[^>]*\btype\s*=\s*["']dynamic["']/i.test(text)) {
    throw new Error('已识别正在播的 DASH 直播。可以在回放生成后重新扫描。');
  }
  if ((text.match(/<(?:\w+:)?Period[\s>]/g) ?? []).length > 1) {
    throw new Error('当前版本支持单时段 DASH 点播。');
  }
  const manifest = parseMpd(text, { manifestUri: url });
  const choices = (manifest.playlists ?? []).map((video, index) => {
    const attrs = video.attributes ?? {};
    const group = Object.values(manifest.mediaGroups?.AUDIO?.[attrs.AUDIO] ?? {});
    const preferred = group.find(track => track.default) ?? group[0];
    const audio = (preferred?.playlists ?? []).slice()
      .sort((a, b) => (b.attributes?.BANDWIDTH || 0) - (a.attributes?.BANDWIDTH || 0))[0];
    return {
      label: quality(attrs.RESOLUTION?.height, attrs.BANDWIDTH, index),
      video: parts(video, url),
      audio: audio ? parts(audio, url) : undefined,
      duration: manifest.totalDuration,
      bitrate: attrs.BANDWIDTH || 0,
      height: attrs.RESOLUTION?.height,
    };
  }).sort((a, b) => b.bitrate - a.bitrate);
  if (!choices.length) throw new Error('DASH 清单里没有可用的画质。');
  return choices;
}
