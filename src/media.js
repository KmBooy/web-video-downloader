export function mediaUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
      url.hash = '';
      return url.href;
    }
  } catch {}
  return null;
}

export function pageKey(value) {
  const url = mediaUrl(value);
  return url ? url + new URL(value).hash : '';
}

export function originPattern(url) {
  const { protocol, hostname } = new URL(url);
  return protocol + '//' + hostname + '/*';
}

export function classify({ url, mime = '', ranged = false, player = false }) {
  const { pathname, hostname, searchParams } = new URL(url);
  const type = mime.split(';')[0].trim().toLowerCase();
  if (/^(?:image\/|text\/html)/.test(type) || /\.(?:jpe?g|png|webp|avif|gif|svg|ico)$/i.test(pathname)) return null;
  if (/\.m3u8?$/i.test(pathname) || /(?:mpegurl|m3u8)/i.test(type)) return 'hls';
  if (/\.mpd$/i.test(pathname) || type === 'application/dash+xml') return 'dash';
  if (/\.(?:m4s|ts|cmfv|cmfa)$/i.test(pathname) || type === 'video/mp2t'
      || /(?:^|\.)googlevideo\.com$/i.test(hostname)
      || (searchParams.has('range') || searchParams.has('bytestart'))
      || (ranged && !player && !/\.(?:mp4|webm|mov|m4v|ogv|mkv)$/i.test(pathname))) return 'fragment';
  if (type.startsWith('video/') || /\.(?:mp4|webm|mov|m4v|ogv|mkv)$/i.test(pathname)) return 'file';
  if (player && !type.startsWith('audio/')) return 'file';
  return null;
}

const candidateRank = { fragment: 0, file: 1, hls: 2, dash: 2, files: 3, tracks: 3 };
const captureLimit = 100;

export function captureCandidate(entries, candidate) {
  const old = entries.find(entry => (entry.id ?? entry.url) === candidate.url);
  if (old) {
    if (candidateRank[old.kind] > candidateRank[candidate.kind]) return entries;
    if (old.kind === candidate.kind && old.mime === candidate.mime
        && (!candidate.bytes || old.bytes === candidate.bytes)
        && (!candidate.fileTitle || old.fileTitle === candidate.fileTitle)) return entries;
  } else if (entries.length === captureLimit && candidateRank[entries.at(-1).kind] >= candidateRank[candidate.kind]) {
    // Equal-rank arrivals follow existing entries and fall outside the retained list.
    return entries;
  }
  return combineCandidates(entries, [candidate]).slice(0, captureLimit);
}

export function combineCandidates(...lists) {
  const candidates = new Map();
  for (const item of lists.flat()) {
    const key = item.id ?? item.url;
    const old = candidates.get(key);
    if (old && candidateRank[old.kind] > candidateRank[item.kind]) continue;
    candidates.set(key, {
      ...old, ...item, bytes: item.bytes || old?.bytes || 0,
      site: item.site || old?.site,
      title: item.title || old?.title,
      fileTitle: item.fileTitle || old?.fileTitle,
    });
  }
  return [...candidates.values()].sort((a, b) => candidateRank[b.kind] - candidateRank[a.kind]);
}

export function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\s+[-–—|·]\s*(?:抖音(?:精选)?|哔哩哔哩(?:_bilibili)?|YouTube|小红书|X)$/i, '');
  return Array.from(normalized).slice(0, 350).join('');
}

function mediaStem(value) {
  const leaf = value.split(/[/\\]/).at(-1) ?? '';
  return cleanTitle(leaf.replace(/\.(?:mp4|webm|mov|m4v|ogv|mkv|m3u8?|mpd)$/i, ''));
}

export function dispositionTitle(header) {
  const extended = header.match(/(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)?.[1];
  if (extended) {
    try { return mediaStem(decodeURIComponent(extended.trim())); } catch {}
  }
  const ordinary = header.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  return ordinary ? mediaStem(ordinary[1] ?? ordinary[2]) : '';
}

function urlTitle(value) {
  if (!value) return '';
  const pathname = new URL(value).pathname;
  let leaf = pathname.split('/').filter(Boolean).at(-1) ?? '';
  try { leaf = decodeURIComponent(leaf); } catch {}
  const name = mediaStem(leaf);
  return /^(?:video|audio|master|index|playlist|manifest|play|videoplayback|\d+|[a-f\d-]{16,})$/i.test(name)
    ? '' : name;
}

export function titleCandidates(entries, pageTitle) {
  const fallback = cleanTitle(pageTitle) || '网页视频';
  const visible = entries.filter(entry => entry.kind !== 'fragment');
  const names = visible.map(entry => cleanTitle(entry.title) || cleanTitle(entry.fileTitle)
    || (visible.length > 1 ? urlTitle(entry.url) : '') || fallback);
  const totals = new Map();
  for (const name of names) totals.set(name, (totals.get(name) ?? 0) + 1);
  const counts = new Map();
  return visible.map((entry, index) => {
    const name = names[index];
    const number = (counts.get(name) ?? 0) + 1;
    counts.set(name, number);
    return { ...entry, title: totals.get(name) > 1 ? Array.from(name).slice(0, 330).join('') + ' · ' + number : name };
  });
}

export function safeFilename(title) {
  const name = cleanTitle(title).replace(/\.(?:mp4|webm|mov|m4v|ogv|mkv)$/i, '')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '') || '网页视频';
  const encoder = new TextEncoder();
  const ordinal = name.match(/ · \d+$/)?.[0] ?? '';
  const stem = ordinal ? name.slice(0, -ordinal.length) : name;
  const limit = 220 - encoder.encode(ordinal).length;
  let bytes = 0;
  let result = '';
  for (const character of stem) {
    bytes += encoder.encode(character).length;
    if (bytes > limit) break;
    result += character;
  }
  result = (result.replace(/[. ]+$/g, '') || '网页视频') + ordinal;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result) ? '_' + result : result;
}

export function headerValue(headers = [], name) {
  return headers.find(header => header.name.toLowerCase() === name)?.value ?? '';
}

export function chromeFilename(title, url, mime) {
  const extension = new URL(url).pathname.match(/\.(mp4|webm|mov|m4v|ogv|mkv)$/i)?.[1]
    ?? ({ 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-matroska': 'mkv' }[mime?.split(';')[0]])
    ?? 'mp4';
  return safeFilename(title) + '.' + extension.toLowerCase();
}

export function selectQuality(choices, maxHeight) {
  const ranked = choices.slice().sort((a, b) => (b.height || 0) - (a.height || 0)
    || (b.bitrate || 0) - (a.bitrate || 0));
  return maxHeight ? ranked.find(choice => choice.height > 0 && choice.height <= maxHeight)
    ?? ranked.find(choice => !choice.height) : ranked[0];
}
