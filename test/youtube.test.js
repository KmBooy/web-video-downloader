import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientInfo, ReloadPlaybackContext, StreamerContext, UMPPartId, VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { CompositeBuffer, UmpWriter } from 'googlevideo/ump';
import { stageYouTube } from '../src/platforms/youtube-download.js';
import { matchesYouTubePlayback, readYouTubePlayback, rememberYouTubePlayback } from '../src/platforms/youtube-session.js';
import { scanYouTube } from '../src/platforms/youtube.js';

const empty = new Uint8Array();
const body = VideoPlaybackAbrRequest.encode({
  ...VideoPlaybackAbrRequest.decode(empty),
  videoPlaybackUstreamerConfig: Uint8Array.of(255, 254),
  streamerContext: {
    ...StreamerContext.decode(empty),
    clientInfo: { ...ClientInfo.decode(empty), clientName: 1, clientVersion: '2.0' },
    poToken: Uint8Array.of(1, 2),
    playbackCookie: Uint8Array.of(3, 4),
  },
}).finish();
const source = 'https://rr1.example.googlevideo.com/videoplayback?sabr=1&id=test';
const details = { url: source + '&rn=4', method: 'POST', initiator: 'https://www.youtube.com',
  tabId: 4, requestBody: { raw: [{ bytes: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }] } };

test('reuses only an active GoogleVideo request matching the selected player', () => {
  const session = readYouTubePlayback(details);
  assert.equal(session.clientInfo.clientName, 1);
  assert.equal(session.poToken, 'AQI=');
  assert.equal('playbackCookie' in session, false);
  assert.equal(matchesYouTubePlayback(session, { url: source, config: '__4' }), true);
  assert.equal(matchesYouTubePlayback(session, { url: source.replace('id=test', 'id=ad'), config: '__4' }), false);
  assert.equal(matchesYouTubePlayback(session, { url: source, config: 'AQI' }), false);
  assert.equal(matchesYouTubePlayback({ ...session, captured: 0 }, { url: source, config: '__4' }), false);
});

test('does not collect requests from unrelated pages or hosts', () => {
  assert.equal(readYouTubePlayback({ ...details, method: 'GET' }), null);
  assert.equal(readYouTubePlayback({ ...details, initiator: 'https://example.test' }), null);
  assert.equal(readYouTubePlayback({ ...details, url: source.replace('.googlevideo.com', '.googlevideo.com.example') }), null);
});

test('a preloaded Short keeps the current playback session and a new token replaces the old one', () => {
  const active = readYouTubePlayback(details);
  const nearby = { ...active, url: active.url.replace('id=test', 'id=next'), captured: active.captured + 10 };
  const sessions = rememberYouTubePlayback([active], nearby);
  assert.equal(sessions.find(item => matchesYouTubePlayback(item, { url: source, config: '__4' })), active);
  const updated = { ...active, poToken: 'AAI=', captured: nearby.captured + 10 };
  const current = rememberYouTubePlayback(sessions, updated);
  assert.deepEqual(current, [updated, nearby]);
  assert.equal(rememberYouTubePlayback(current, { ...updated, captured: updated.captured + 10 }), current);
  const more = Array.from({ length: 5 }, (_, index) => ({
    ...active, url: active.url.replace('id=test', 'id=short' + index), captured: active.captured + index + 30,
  })).reduce(rememberYouTubePlayback, current);
  assert.equal(more.length, 4);
});

test('Shorts use the active player instead of the first or preloaded player', t => {
  const response = id => ({
    videoDetails: { videoId: id, title: id, lengthSeconds: '10' },
    playabilityStatus: { status: 'OK' },
    streamingData: { serverAbrStreamingUrl: source, adaptiveFormats: [
      { itag: 137, mimeType: 'video/mp4', qualityLabel: '1080p' },
      { itag: 140, mimeType: 'audio/mp4', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
    ] },
    playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: '__4' } } },
  });
  const video = { readyState: 0, getBoundingClientRect: () => ({ top: 20, bottom: 30, left: 20, right: 30 }) };
  const player = id => ({
    classList: { contains: () => false }, getPlayerResponse: () => response(id),
  });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  t.after(() => {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  });
  globalThis.window = { ytInitialPlayerResponse: response('first'), innerHeight: 100, innerWidth: 100 };
  let activeId = 'current';
  globalThis.document = { querySelector: selector => player(selector === '#shorts-player' ? activeId : 'first') };
  const url = new URL('https://www.youtube.com/shorts/current');
  const pending = {};
  const inputs = { url, players: [video], clip: entry => entry };
  scanYouTube({ ...inputs, result: pending });
  assert.equal(pending.youtubeSabr, undefined);
  assert.match(pending.hint, /开始播放/);
  video.readyState = 2;
  const playing = {};
  scanYouTube({ ...inputs, result: playing });
  assert.equal(playing.title, 'current');
  assert.equal(playing.youtubeSabr.videoId, 'current');

  const next = { ...inputs, url: new URL('https://www.youtube.com/shorts/next') };
  const switching = {};
  scanYouTube({ ...next, result: switching });
  assert.equal(switching.youtubeSabr, undefined);
  activeId = 'next';
  const switched = {};
  scanYouTube({ ...next, result: switched });
  assert.equal(switched.youtubeSabr.videoId, 'next');
});

test('a reload directive before media falls back to the untagged AAC track with the same itag', async t => {
  const directive = new CompositeBuffer();
  new UmpWriter(directive).write(UMPPartId.RELOAD_PLAYER_RESPONSE, ReloadPlaybackContext.encode({
    reloadPlaybackParams: { token: 'fixture' },
  }).finish());
  const tags = [];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { selectedAudioFormatIds: [audio] } = VideoPlaybackAbrRequest.decode(body);
    tags.push(audio.xtags);
    return new Response(Buffer.concat(directive.chunks), { headers: { 'Content-Type': 'application/vnd.yt-ump' } });
  });
  const candidate = {
    videoId: 'current', duration: 10, session: readYouTubePlayback(details),
    video: [{ itag: 135, width: 480, height: 854, bitrate: 2000, mimeType: 'video/mp4; codecs="avc1.4d401f"', qualityLabel: '480p' }],
    audio: [
      { itag: 140, bitrate: 200, mimeType: 'audio/mp4', audioQuality: 'AUDIO_QUALITY_MEDIUM', xtags: 'CgcKAnZiEgEx' },
      { itag: 140, bitrate: 100, mimeType: 'audio/mp4', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
    ],
  };
  const scratch = { getFileHandle: async () => ({ createWritable: async () => ({ abort: async () => {} }) }) };
  await assert.rejects(stageYouTube(candidate, scratch, new AbortController().signal, () => {}, 480, Infinity),
    /YouTube 要求更新播放会话/);
  assert.deepEqual([...new Set(tags)], ['CgcKAnZiEgEx', undefined]);
});
