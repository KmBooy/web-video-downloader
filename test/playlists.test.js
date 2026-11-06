import assert from 'node:assert/strict';
import test from 'node:test';
import { chromeFilename, classify, combineCandidates, dispositionTitle, originPattern, safeFilename, selectQuality, titleCandidates } from '../src/media.js';
import { dashManifest, hlsChildren, hlsManifest } from '../src/playlists.js';

const base = 'https://video.example/media/master.m3u8';

test('does not present a range or YouTube playback request as a complete file', () => {
  assert.equal(classify({ url: 'https://a.googlevideo.com/videoplayback', mime: 'video/mp4' }), 'fragment');
  assert.equal(classify({ url: 'https://v.example/v.mp4?range=0-40', player: true }), 'fragment');
  assert.equal(classify({ url: 'https://v.example/v.mp4', mime: 'video/mp4', ranged: true }), 'file');
  assert.equal(classify({ url: 'https://v.example/v', mime: 'application/dash+xml' }), 'dash');
  assert.equal(classify({ url: 'https://pbs.twimg.com/amplify_video_thumb/poster.jpg', player: true }), null);
  assert.equal(originPattern('https://v.example:1234/a'), 'https://v.example/*');
});

test('groups duplicate URLs and keeps the full media hint', () => {
  assert.deepEqual(combineCandidates(
    [{ url: base, kind: 'hls', bytes: 100, fileTitle: '真实媒体标题' }],
    [{ url: base, kind: 'fragment', bytes: 40 }],
  ), [{ url: base, kind: 'hls', bytes: 100, site: undefined, title: undefined, fileTitle: '真实媒体标题' }]);
});

test('HLS picks the default audio group, distinguishes live and rejects encrypted input', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="zh",DEFAULT=YES,URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,AUDIO="a"',
    'video.m3u8',
  ].join('\n');
  assert.equal(hlsManifest(master, base)[0].audioUrl, 'https://video.example/media/audio.m3u8');
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nclip.ts\n';
  assert.throws(() => hlsChildren(media, base), /正在播/);
  assert.equal(hlsChildren(media + '#EXT-X-ENDLIST\n', base).duration, 4);
  assert.throws(() => hlsChildren(media.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF'), base), /加密/);
});

test('DASH distinguishes dynamic and protected manifests before parsing', () => {
  assert.throws(() => dashManifest('<MPD type="dynamic"></MPD>', base), /正在播/);
  assert.throws(() => dashManifest('<MPD><ContentProtection/></MPD>', base), /内容保护/);
});

test('uses a distinct title for every visible video and decodes server filenames', () => {
  const header = "attachment; filename=fallback.mp4; filename*=UTF-8''%E5%9B%9E%E6%94%BE.mp4";
  assert.equal(dispositionTitle(header), '回放');
  const items = titleCandidates([
    { kind: 'file', url: 'https://v.example/a.mp4', title: '第一集' },
    { kind: 'file', url: 'https://v.example/b.mp4', fileTitle: '第二集' },
    { kind: 'hls', url: 'https://v.example/master.m3u8' },
    { kind: 'hls', url: 'https://v.example/index.m3u8' },
    { kind: 'fragment', url: 'https://v.example/video.m4s' },
  ], '课程 - YouTube');
  assert.deepEqual(items.map(item => item.title), ['第一集', '第二集', '课程 · 1', '课程 · 2']);
});

test('uses the selected title and preserves the actual file extension within byte limits', () => {
  assert.equal(chromeFilename('选中/片段.webm', 'https://v.example/video.webm'), '选中_片段.webm');
  assert.equal(safeFilename('CON'), '_CON');
  const [first, second] = titleCandidates([
    { kind: 'file', title: '中文🎬'.repeat(180) },
    { kind: 'file', title: '中文🎬'.repeat(180) },
  ], '网页');
  const name = chromeFilename(second.title, 'https://v.example/video.mp4');
  assert.notEqual(safeFilename(first.title), safeFilename(second.title));
  assert.ok(Buffer.byteLength(name) <= 224);
  assert.ok(name.endsWith(' · 2.mp4'));
  assert.ok(!name.includes('�'));
});

test('uses the highest known quality within the saved resolution limit', () => {
  const original = [{ height: 1080 }, { height: 480 }, { height: 720 }];
  assert.equal(selectQuality(original, 0).height, 1080);
  assert.equal(selectQuality(original, 720).height, 720);
  assert.equal(selectQuality([{ height: 1080 }], 720), undefined);
  const unknown = { bitrate: 150000 };
  assert.equal(selectQuality([{ height: 1080 }, unknown], 720), unknown);
});
