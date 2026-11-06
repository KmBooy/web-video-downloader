import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const nas = process.env.WEB_VIDEO_TEST_DIR;
if (!nas) throw new Error('Set WEB_VIDEO_TEST_DIR to an existing writable directory for test media.');
const media = await mkdtemp(path.join(nas, '.web-video-check-'));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'web-video-browser-'));
const dist = path.join(scratch, 'dist');
const ffmpeg = args => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
let browser;
let server;
const longXTitle = 'X 第一条，' + '👩‍💻内容与标点，'.repeat(5) + '结尾';
const reads = new Set();
const biliVideoRequests = new Set();

function videoFixture(name, duration, args) {
  ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x2866aa:size=160x90:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-c:a', 'aac', '-b:a', '36k',
    ...args, path.join(media, name),
  ]);
}

function verify(filename, seconds, hasAudio = true) {
  const info = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', filename,
  ]));
  assert.deepEqual(info.streams.map(item => item.codec_type).sort(), hasAudio ? ['audio', 'video'] : ['video']);
  assert.ok(Math.abs(Number(info.format.duration) - seconds) < 1.5, JSON.stringify(info.format));
  ffmpeg(['-sseof', '-1', '-i', filename, '-t', '0.9', '-map', '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0'] : []), '-f', 'null', '-']);
  console.log('保存、时长、音视频轨和末尾解码通过:', path.basename(filename), Number(info.format.duration));
}

try {
  videoFixture('direct.mp4', 6, ['-movflags', '+faststart']);
  videoFixture('replay.m3u8', 720, ['-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod']);
  videoFixture('separated.mpd', 6, ['-f', 'dash', '-seg_duration', '2']);
  const input = path.join(media, 'direct.mp4');
  ffmpeg(['-i', input, '-an', '-c', 'copy', '-movflags', '+faststart', path.join(media, 'silent.mp4')]);
  ffmpeg(['-i', input, '-an', '-c', 'copy', path.join(media, 'replay-video.mp4')]);
  ffmpeg(['-i', input, '-vn', '-c', 'copy', path.join(media, 'replay-audio.mp4')]);
  const hls = ['-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod'];
  ffmpeg(['-i', input, '-an', ...hls, path.join(media, 'split-video.m3u8')]);
  ffmpeg(['-i', input, '-vn', ...hls, path.join(media, 'split-audio.m3u8')]);
  ffmpeg(['-i', input, '-an', ...hls, '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'x-silent-init.mp4',
    path.join(media, 'x-silent.m3u8')]);
  await writeFile(path.join(media, 'x-silent-master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x90,CODECS="avc1.42c00a"\nx-silent.m3u8\n');
  await writeFile(path.join(media, 'split.m3u8'), [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",DEFAULT=YES,URI="split-audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x90,AUDIO="a"',
    'split-video.m3u8',
  ].join('\n'));

  await writeFile(path.join(media, 'live.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nreplay0.ts\n');
  await cp(new URL('../dist', import.meta.url), dist, { recursive: true });
  let delaySegments = false;
  let failNextReplaySegment = false;
  let breakNextReplayBody = false;
  let replayFailures = 0;
  let replayBodyFailures = 0;
  let replayManifestRequests = 0;
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/replay.m3u8') replayManifestRequests++;
    if (url.pathname === '/fixture/status/111') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<title>X 测试</title><article><div data-testid="tweetText">' + longXTitle + '</div>' +
        '<a href="/fixture/status/111">帖子</a>' +
        '<video poster="https://pbs.twimg.com/ext_tw_video_thumb/111/pu/img/a.jpg"></video></article>');
      return;
    }
    if (url.pathname === '/page') {
      const mode = url.searchParams.get('mode');
      const element = mode === 'direct' ? '<video controls title="选中视频标题" src="/direct.mp4"></video><script>fetch("/direct.mp4", {headers:{Range:"bytes=0-1023"}}).then(r=>r.arrayBuffer())</script>'
        : ['missing', 'opaque'].includes(mode) ? '' : '<script>fetch("/' + mode + '").then(r=>r.text())</script>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<title>Fixture ' + mode + '</title>' + element);
      return;
    }
    const name = url.pathname === '/opaque-stream' ? 'live.m3u8' : path.basename(url.pathname);
    if (failNextReplaySegment && name === 'replay0.ts') {
      failNextReplaySegment = false;
      replayFailures++;
      res.writeHead(503).end();
      return;
    }
    if (['replay-video.mp4', 'replay-audio.mp4'].includes(name)
        && req.headers.referer !== 'https://www.bilibili.com/') {
      res.writeHead(403).end();
      return;
    }
    const filename = path.join(media, name);
    const info = await stat(filename).catch(() => null);
    if (!info || !/^[a-z0-9_.-]+$/i.test(name)) { res.writeHead(403).end(); return; }
    if (delaySegments && name.endsWith('.ts')) await new Promise(resolve => setTimeout(resolve, 120));
    const mime = { '.mp4': 'video/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml',
      '.ts': 'video/mp2t', '.m4s': 'video/iso.segment' }[path.extname(name)] ?? 'application/octet-stream';
    if (name === 'replay-video.mp4') biliVideoRequests.add(req.headers.range ? 'range' : 'full');
    const match = name === 'replay-video.mp4' ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + info.size }).end(); return; }
    res.writeHead(match ? 206 : 200, {
      'Accept-Ranges': 'bytes', 'Content-Type': mime, 'Content-Length': end - start + 1,
      'Access-Control-Allow-Origin': '*',
      ...(match ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + info.size } : {}),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    if (breakNextReplayBody && name === 'replay1.ts' && end - start > 1024) {
      breakNextReplayBody = false;
      replayBodyFailures++;
      const bytes = await readFile(filename);
      res.write(bytes.subarray(start, start + 1024));
      setTimeout(() => res.destroy(), 40);
      return;
    }
    const file = createReadStream(filename, { start, end });
    reads.add(file);
    file.on('close', () => reads.delete(file));
    res.on('close', () => file.destroy());
    file.pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const profile = path.join(scratch, 'profile');
  const browserOutput = path.join(media, 'browser-downloads');
  await mkdir(browserOutput);
  await mkdir(path.join(profile, 'Default'), { recursive: true });
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: browserOutput, directory_upgrade: true, prompt_for_download: false },
  }));
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: process.env.WEB_VIDEO_CHROME || undefined,
    headless: true, acceptDownloads: true, downloadsPath: media,
    args: ['--disable-extensions-except=' + dist, '--load-extension=' + dist, '--no-proxy-server',
      '--host-resolver-rules=MAP x.com 127.0.0.1, MAP video.twimg.com 127.0.0.1'],
  });
  browser = await launch();
  let worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 10000 });
  const extension = new URL(worker.url()).origin;
  const prefix = worker.url().replace(/background\.js$/, '');
  assert.ok(prefix.startsWith('chrome-extension://'), extension);
  assert.equal(await worker.evaluate(() => chrome.permissions.contains({
    origins: ['http://*/*', 'https://*/*'],
  })), true);
  let videoPage = browser.pages()[0];
  const session = await browser.newCDPSession(videoPage);
  await session.send('Browser.setDownloadBehavior', { behavior: 'default' });
  async function popupFor(mode) {
    await videoPage.bringToFront();
    const url = origin + '/page?mode=' + mode;
    if (videoPage.url() !== url) await videoPage.goto(url);
    if (!['opaque', 'missing'].includes(mode)) {
      await videoPage.waitForFunction(value => performance.getEntriesByType('resource')
        .some(entry => new URL(entry.name).pathname.endsWith('/' + value)), mode === 'direct' ? 'direct.mp4' : mode);
    }
    const popup = await browser.newPage();
    await videoPage.bringToFront();
    await popup.goto(prefix + 'popup.html');
    return popup;
  }

  async function status(page, selector, expression, timeout = 45000) {
    try {
      const outcome = await page.waitForFunction(({ selector, expression }) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const messages = [element.textContent, element.title];
        if (messages.some(text => new RegExp(expression).test(text))) return { matches: true };
        if (expression.startsWith('已保存') && element.textContent === '下载失败') return { messages };
        return false;
      }, { selector, expression }, { timeout });
      const { matches, messages } = await outcome.jsonValue();
      assert.ok(matches, JSON.stringify(messages));
    } catch (error) {
      throw new Error('Expected ' + expression + '; got ' + JSON.stringify(await page.locator(selector).allTextContents()), { cause: error });
    }
  }

  const initial = await popupFor('direct');
  assert.equal(await initial.locator('#media .media-title').first().innerText(), '选中视频标题');
  assert.deepEqual(await worker.evaluate(() => chrome.storage.session.get('download-jobs')), {});
  let options = await browser.newPage();
  await options.goto(prefix + 'options.html');
  assert.equal(await options.locator('#choose-directory').count(), 0);
  assert.equal(await options.locator('#browser-download-settings').isVisible(), true);
  const [proxySettings] = await Promise.all([
    browser.waitForEvent('page'),
    options.getByRole('button', { name: '打开浏览器代理设置' }).click(),
  ]);
  await proxySettings.waitForURL('chrome://settings/system');
  await proxySettings.close();

  await initial.close();

  async function maxSize(mib) {
    await options.locator('#max-mib').fill(String(mib));
    await options.locator('#save-settings').click();
    await status(options, '#settings-status', '已保存');
  }

  async function files() {
    return worker.evaluate(() => chrome.downloads.search({ state: 'complete' }));
  }

  async function jobState(selector) {
    const id = selector.split('"')[1];
    return worker.evaluate(async id => {
      const jobs = (await chrome.storage.session.get('download-jobs'))['download-jobs'];
      return jobs?.find(job => job.id === id)?.state;
    }, id);
  }

  async function saveToNas(name, seconds, hasAudio = true) {
    const complete = await files();
    const saved = complete.find(item => path.basename(item.filename) === path.basename(name));
    assert.ok(saved, 'missing native download record for ' + name + ': ' + JSON.stringify(complete.map(item => [item.id,item.filename,item.state])) + ', files: ' + JSON.stringify(await readdir(browserOutput)));
    assert.equal(path.dirname(saved.filename), browserOutput);
    verify(saved.filename, seconds, hasAudio);
  }

  async function start(popup, label) {
    const tabsBefore = browser.pages().length;
    const previous = await popup.locator('.job').evaluateAll(rows => rows.map(row => row.dataset.jobId));
    await popup.getByRole('button', { name: label }).click();
    const next = await popup.waitForFunction(ids => Array.from(document.querySelectorAll('.job'))
      .find(row => !ids.includes(row.dataset.jobId))?.dataset.jobId, previous);
    assert.equal(browser.pages().length, tabsBefore, 'download opened a visible tab');
    return '.job[data-job-id="' + await next.jsonValue() + '"]';
  }

  await videoPage.goto(origin + '/page?mode=opaque');
  await videoPage.evaluate(() => fetch('/opaque-stream').then(response => response.text()));
  const opaque = await browser.newPage();
  await videoPage.bringToFront();
  await opaque.goto(prefix + 'popup.html');
  await opaque.getByRole('button', { name: /HLS 清单/ }).waitFor({ timeout: 10000 });
  await opaque.close();
  console.log('打开扩展前，后台已识别无扩展名的 HLS 地址。');

  const leftovers = ['browser-download-22222222-2222-4222-8222-222222222222', 'media-11111111-1111-4111-8111-111111111111'];
  await worker.evaluate(async names => {
    const root = await navigator.storage.getDirectory();
    for (const name of names) {
      const dir = await root.getDirectoryHandle(name, { create: true });
      await dir.getFileHandle('leftover.bin', { create: true });
    }
  }, [...leftovers, 'media-other']);
  const direct = await popupFor('direct');
  await start(direct, /选中视频标题.*完整文件/);
  await direct.close();
  const reopened = await popupFor('direct');
  await status(reopened, '.job:first-child .job-message', '已保存');
  await reopened.close();
  await saveToNas('选中视频标题.mp4', 6);
  assert.deepEqual(await worker.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) names.push(name);
    return names;
  }), ['media-other']);
  const repeated = await popupFor('direct');
  await start(repeated, /选中视频标题.*完整文件/);
  await status(repeated, '.job:first-child .job-message', '已保存.*\\(1\\)');
  assert.equal((await files()).length, 2);
  await repeated.close();

  await maxSize(1);
  const limited = await popupFor('replay.m3u8');
  await start(limited, /HLS 清单/);
  await status(limited, '.job:first-child .job-message', '超出设置的 1 MiB 上限');
  assert.equal(await limited.locator('.job:first-child .job-message').innerText(), '下载失败');
  assert.equal((await files()).length, 2);
  await limited.close();
  await maxSize(0);

  for (const [mode, label, duration] of [
    ['replay.m3u8', /HLS 清单/, 720], ['split.m3u8', /HLS 清单/, 6], ['separated.mpd', /DASH 清单/, 6],
  ]) {
    failNextReplaySegment = mode === 'replay.m3u8';
    breakNextReplayBody = mode === 'replay.m3u8';
    const popup = await popupFor(mode);
    const beforeDownload = replayManifestRequests;
    await start(popup, label);
    await status(popup, '.job:first-child .job-message', '已保存', 120000);
    const job = await worker.evaluate(async () => (await chrome.storage.session.get('download-jobs'))['download-jobs'][0]);
    await saveToNas(job.filename, duration);
    if (mode === 'replay.m3u8') {
      assert.ok(replayManifestRequests - beforeDownload <= 2, 'direct HLS repeated its preflight request');
    }
    await popup.close();
  }
  assert.equal(replayFailures, 1, 'HLS regression did not exercise a transient segment failure');
  assert.equal(replayBodyFailures, 1, 'HLS regression did not exercise an interrupted response body');

  async function openBili(page) {
    const bili = 'https://www.bilibili.com/video/BV1Example';
    await page.route(bili, route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<title>B 站分离轨测试</title><script>' +
        'window.__INITIAL_STATE__={videoData:{bvid:"BV1Example",cid:42,title:"B 站分离轨测试"}};' +
        'window.__playinfo__={data:' + JSON.stringify({
          dash: {
            video: [{ baseUrl: origin + '/replay-video.mp4', width: 160, height: 90 }],
            audio: [{ baseUrl: origin + '/replay-audio.mp4' }],
          },
        }) + '};</script>',
    }));
    await page.route('https://api.bilibili.com/x/player/playurl?*', route => route.abort());
    await page.goto(bili);
  }
  await openBili(videoPage);
  const paired = await browser.newPage();
  await videoPage.bringToFront();
  await paired.goto(prefix + 'popup.html');
  await start(paired, /分离音视频/);
  await status(paired, '.job:first-child .job-message', '已保存');
  await saveToNas('B 站分离轨测试.mp4', 6);
  assert.deepEqual([...biliVideoRequests], ['range', 'full']);
  await paired.close();

  const live = await popupFor('live.m3u8');
  await start(live, /HLS 清单/);
  await status(live, '.job:first-child .job-message', '正在播的 HLS 直播');
  await live.close();

  const cancel = await popupFor('replay.m3u8');
  delaySegments = true;
  await cancel.locator('.job').first().waitFor();
  assert.deepEqual((await cancel.locator('.job-message').allTextContents()).sort(), ['下载失败', '已保存']);
  const running = await start(cancel, /HLS 清单/);
  await videoPage.reload();
  await cancel.waitForFunction(selector => {
    const rows = document.querySelectorAll('.job');
    return rows.length === 1 && rows[0].matches(selector) && rows[0].querySelector('.job-message').textContent === '下载中';
  }, running);
  const closeButton = cancel.getByRole('button', { name: /取消下载/ });
  assert.equal(await closeButton.innerText(), '×');
  await closeButton.click();
  await status(cancel, running + ' .job-message', '已取消');
  await videoPage.reload();
  await cancel.getByRole('button', { name: /HLS 清单/ }).waitFor();
  await cancel.locator('.job').waitFor({ state: 'detached' });
  assert.equal((await files()).length, 6);
  await cancel.close();
  delaySegments = false;

  const stale = await popupFor('direct');
  await stale.locator('.media').first().waitFor();
  await videoPage.evaluate(() => history.pushState(null, '', '?mode=missing'));
  await status(stale, '#state', '暂未发现');
  assert.equal(await stale.locator('.media').count(), 0);
  await videoPage.evaluate(() => fetch('/opaque-stream').then(response => response.text()));
  await stale.getByRole('button', { name: /HLS 清单/ }).waitFor({ timeout: 10000 });
  const otherTab = await browser.newPage();
  await otherTab.goto(origin + '/page?mode=direct');
  await stale.getByRole('button', { name: /选中视频标题.*完整文件/ }).waitFor({ timeout: 10000 });
  assert.equal(await stale.getByRole('button', { name: /HLS 清单/ }).count(), 0);
  await otherTab.close();
  await stale.close();

  const changedDirectory = path.join(media, 'changed-browser-downloads');
  await mkdir(changedDirectory);
  await browser.close();
  const preferences = path.join(profile, 'Default', 'Preferences');
  const prefs = JSON.parse(await readFile(preferences, 'utf8'));
  prefs.download.default_directory = changedDirectory;
  await writeFile(preferences, JSON.stringify(prefs));
  browser = await launch();
  worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker', { timeout: 10000 });
  videoPage = browser.pages()[0];
  await (await browser.newCDPSession(videoPage)).send('Browser.setDownloadBehavior', { behavior: 'default' });
  options = await browser.newPage();
  await options.goto(prefix + 'options.html');
  assert.equal((await files()).length, 6, 'native download records did not survive restart');
  const changed = await popupFor('direct');
  await start(changed, /完整文件/);
  await status(changed, '.job:first-child .job-message', '已保存');
  await status(options, '#last-download-path', 'changed-browser-downloads$');
  const relocated = (await files()).find(item => path.dirname(item.filename) === changedDirectory);
  assert.ok(relocated, 'browser did not use its changed default download directory');
  verify(relocated.filename, 6);
  await changed.close();

  const silent = await popupFor('silent.mp4');
  await start(silent, /完整文件/);
  await status(silent, '.job:first-child .job-message', '已保存');
  const silentFile = (await files()).find(item => item.filename.endsWith('Fixture silent.mp4'));
  assert.ok(silentFile, 'video without an audio track did not reach the native downloads manager');
  verify(silentFile.filename, 6, false);
  await silent.close();

  await maxSize(1);
  const capped = await popupFor('direct');
  await start(capped, /完整文件/);
  await status(capped, '.job:first-child .job-message', '已保存');
  await capped.close();
  await maxSize(0);

  const expired = await popupFor('direct');
  await expired.locator('.media').first().waitFor();
  await rm(path.join(media, 'direct.mp4'));
  await start(expired, /完整文件/);
  await status(expired, '.job:first-child .job-message', '已过期');
  await expired.close();
  console.log('一键后台保存、关弹窗继续、大小上限、同名保护、取消与切页均通过。');

  // X uses different HLS masters for two posts on the same tab. Route the page
  // locally and serve both real media playlists through the fixture CDN host.
  const port = server.address().port;
  const xPost = 'http://x.com:' + port + '/fixture/status/';
  const cdn = 'http://video.twimg.com:' + port;
  await videoPage.route('https://pbs.twimg.com/**', route => route.abort());
  await videoPage.goto(xPost + '111');
  const xPopup = await browser.newPage();
  await videoPage.bringToFront();
  await xPopup.goto(prefix + 'popup.html');
  const getPlaylist = url => videoPage.evaluate(address => fetch(address).then(response => response.text()), url);
  delaySegments = true;
  await getPlaylist(cdn + '/ext_tw_video/111/pl/replay.m3u8');
  const firstX = await start(xPopup, /X 第一条.*HLS 清单/);
  await status(xPopup, firstX + ' .job-message', '合并音视频');
  for (const title of ['#media .media-title', firstX + ' .media-title']) {
    const visible = await xPopup.locator(title).first().innerText();
    assert.equal([...new Intl.Segmenter().segment(visible)].length, 30);
    assert.ok(visible.endsWith('…'));
    assert.equal(await xPopup.locator(title).first().getAttribute('title'), longXTitle);
  }
  const titleBox = await xPopup.locator(firstX + ' .media-title').boundingBox();
  const statusBox = await xPopup.locator(firstX + ' .job-message').boundingBox();
  assert.ok(statusBox.x >= titleBox.x + titleBox.width);
  await videoPage.evaluate(() => {
    history.pushState(null, '', '/fixture/status/222');
    document.querySelector('article').innerHTML =
      '<div data-testid="tweetText">X 第二条</div><a href="/fixture/status/222">帖子</a>' +
      '<video poster="https://pbs.twimg.com/ext_tw_video_thumb/222/pu/img/b.jpg"></video>';
  });
  await getPlaylist(cdn + '/ext_tw_video/222/pl/x-silent-master.m3u8');
  const secondX = await start(xPopup, /X 第二条.*HLS 清单/);
  await status(xPopup, secondX + ' .job-message', '已保存');
  assert.equal(await xPopup.locator(firstX).count(), 0, 'previous page job leaked into current page');
  assert.equal(await jobState(firstX), 'running', 'first X job ended before the second saved');

  const biliPage = await browser.newPage();
  await openBili(biliPage);
  const biliJob = await start(xPopup, /B 站分离轨测试.*分离音视频/);

  const note = 'https://www.xiaohongshu.com/explore/abc123';
  await videoPage.route(note, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<title>小红书测试</title><script>window.__INITIAL_STATE__=' + JSON.stringify({
      note: { noteDetailMap: { abc123: { note: { title: '小红书视频', video: { media: {
        stream: { h264: [{ masterUrl: origin + '/silent.mp4' }] },
      } } } } } },
    }) + '</script>',
  }));
  await videoPage.goto(note);
  await videoPage.bringToFront();
  const noteJob = await start(xPopup, /小红书视频.*完整文件/);
  await status(xPopup, noteJob + ' .job-message', '已保存');
  assert.equal(await xPopup.locator(biliJob).count(), 0, 'another tab job leaked into current page');
  await biliPage.close();

  await videoPage.goto(origin + '/page?mode=replay.m3u8');
  const discard = await start(xPopup, /Fixture replay.m3u8.*HLS 清单/);
  await status(xPopup, discard + ' .job-message', '合并音视频');
  await xPopup.locator(discard + ' button').click();
  await status(xPopup, discard + ' .job-message', '已取消');
  assert.equal(await jobState(firstX), 'running', 'cancel also stopped the first X job');
  await xPopup.close();
  const reopenedJobs = await browser.newPage();
  await videoPage.goto(xPost + '111');
  await videoPage.bringToFront();
  await reopenedJobs.goto(prefix + 'popup.html');
  await status(reopenedJobs, firstX + ' .job-message', '已保存', 120000);
  const completed = await files();
  for (const [name, seconds, audio] of [
    [longXTitle.replaceAll('\u200d', '') + '.mp4', 720, true], ['X 第二条.mp4', 6, false],
    ['B 站分离轨测试.mp4', 6, true], ['小红书视频.mp4', 6, false],
  ]) {
    const saved = completed.find(item => item.filename === path.join(changedDirectory, name));
    assert.ok(saved, name);
    verify(saved.filename, seconds, audio);
  }
  console.log('X 同页切帖并行、B 站和小红书跨页并行、单独取消及重开弹窗通过。');

} finally {
  await browser?.close();
  if (server) {
    const closed = Array.from(reads, file => new Promise(resolve => {
      file.once('close', resolve);
      file.destroy();
    }));
    server.closeAllConnections();
    await Promise.all(closed);
    await new Promise(resolve => server.close(resolve));
  }
  await rm(scratch, { recursive: true, force: true });
  await rm(media, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(error => {
    console.error('Fixture cleanup:', error.message);
  });
}
