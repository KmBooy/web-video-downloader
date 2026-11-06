import { VideoPlaybackAbrRequest } from 'googlevideo/protos';

export const playbackKey = tabId => 'youtube-playback:' + tabId;

export function googleVideoUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') &&
        url.pathname === '/videoplayback' && !url.username && !url.password) return url;
  } catch {}
  return null;
}

function base64(bytes) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}

function canonicalBase64(value) {
  return value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
}

export function readYouTubePlayback(details) {
  if (details.method !== 'POST' || details.tabId < 0) return null;
  if (!['https://www.youtube.com', 'https://m.youtube.com', 'https://youtube.com'].includes(details.initiator)) return null;
  const url = googleVideoUrl(details.url);
  if (!url?.searchParams.has('sabr') || !url.searchParams.get('id')) return null;
  const parts = details.requestBody?.raw;
  const size = parts?.reduce((total, part) => total + (part.bytes?.byteLength ?? 0), 0);
  if (!size || size > 64 * 1024 || parts.some(part => !part.bytes)) return null;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(new Uint8Array(part.bytes), offset);
      offset += part.bytes.byteLength;
    }
    const request = VideoPlaybackAbrRequest.decode(bytes);
    const { clientInfo, poToken } = request.streamerContext ?? {};
    const config = request.videoPlaybackUstreamerConfig;
    if (!clientInfo || !poToken?.length || !config?.length) return null;
    return { url: url.href, clientInfo, poToken: base64(poToken), config: base64(config), captured: Date.now() };
  } catch {
    return null;
  }
}

export function matchesYouTubePlayback(session, source) {
  if (!session || !source || Date.now() - session.captured > 12 * 60_000) return false;
  const actual = googleVideoUrl(session.url);
  const original = googleVideoUrl(source.url);
  const expires = Number(actual?.searchParams.get('expire'));
  return Boolean(actual && original && actual.searchParams.get('id') === original.searchParams.get('id')
    && (!expires || expires * 1000 > Date.now()) && canonicalBase64(session.config) === canonicalBase64(source.config));
}
