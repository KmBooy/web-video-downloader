import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientInfo, StreamerContext, VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { matchesYouTubePlayback, readYouTubePlayback } from '../src/platforms/youtube-session.js';

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
