import assert from 'node:assert/strict';
import test from 'node:test';
import { xCandidates } from '../src/platforms/x.js';

function entry(path, kind = 'hls') {
  return { kind, url: 'https://video.twimg.com/amplify_video/' + path };
}

test('lists a captured X master without a poster and groups it apart from audio and child playlists', () => {
  const master = entry('123/pl/master.m3u8');
  const result = xCandidates([
    entry('123/pl/mp4a/128000/audio.m3u8'),
    entry('123/pl/avc1/960x624/video.m3u8'),
    entry('123/pl/s0/captions.m3u8'),
    entry('123/vid/960x624/file.mp4', 'file'),
    master,
  ], { xTitles: [], xMediaIds: [] });
  assert.deepEqual(result.map(item => [item.url, item.title]), [[master.url, 'X 视频（同页捕获）']]);
});

test('uses prior in-page X captures only for videos matched on the new page', () => {
  const matched = entry('123/pl/master.m3u8');
  const stale = entry('234/pl/stale.m3u8');
  const other = entry('345/pl/other.m3u8');
  const result = xCandidates([other], { xTitles: [['123', '帖子标题']], xMediaIds: ['123'] }, [matched, stale]);
  assert.deepEqual(result.map(item => [item.id, item.title]), [
    ['x:123', '帖子标题'],
    ['x:345', 'X 视频（同页捕获）'],
  ]);
});
