export function scanYouTube({ url, players, result, clip }) {
  const isShort = url.pathname.startsWith('/shorts/');
  const player = (isShort && (document.querySelector('#shorts-player')
    || document.querySelector('ytd-reel-video-renderer[is-active] #movie_player')))
    || document.querySelector('#movie_player');
  const id = (url.pathname === '/watch' ? url.searchParams.get('v') : null)
    ?? url.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
  if (!id) return result;
  result.site = 'youtube';
  if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) {
    result.hint = 'YouTube 正在播放广告，正片开始后会重新识别。';
    return result;
  }
  const liveResponse = player?.getPlayerResponse?.();
  const response = liveResponse?.videoDetails?.videoId === id ? liveResponse : window.ytInitialPlayerResponse;
  if (response?.videoDetails?.videoId === id) {
    const data = response.streamingData;
    result.files = (data?.formats ?? []).filter(entry => entry.url).map(clip);
    result.variants = (data?.adaptiveFormats ?? []).filter(entry => entry.url && entry.height).map(clip);
    result.audio = (data?.adaptiveFormats ?? []).filter(entry => entry.url && /^audio\//.test(entry.mimeType)).map(clip);
    result.title = response.videoDetails.title || result.title;
    result.youtubeManifests = [
      { kind: 'hls', url: data?.hlsManifestUrl }, { kind: 'dash', url: data?.dashManifestUrl },
    ].filter(item => item.url);
    const config = response.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
    const duration = Number(response.videoDetails.lengthSeconds);
    if (response.playabilityStatus?.status === 'OK' && data?.serverAbrStreamingUrl && config && duration > 0
        && !response.videoDetails.isLive && !response.videoDetails.isLiveContent && !response.videoDetails.isPostLiveDvr) {
      // Shorts can render the playing video outside the legacy #movie_player.
      if (isShort && !players.some(video => {
        if (video.readyState < 2) return false;
        const { top, bottom, left, right } = video.getBoundingClientRect();
        return bottom > 0 && top < window.innerHeight && right > 0 && left < window.innerWidth;
      })) {
        result.hint = '请先在网页播放当前 Shorts，开始播放后会重新识别。';
        return;
      }
      const formats = (data.adaptiveFormats ?? []).filter(item =>
        !item.drmFamilies?.length && !item.licenseInfos?.length && item.itag && /^(?:video|audio)\/(?:mp4|webm)\b/.test(item.mimeType ?? ''))
        .map(({ itag, width, height, mimeType, lastModified, xtags, bitrate, contentLength,
          approxDurationMs, qualityLabel, audioQuality, audioTrack, audioChannels, fps }) => ({
          itag, width, height, mimeType, lastModified, xtags, bitrate, contentLength,
          approxDurationMs, qualityLabel, audioQuality, audioTrack: audioTrack && { id: audioTrack.id }, audioChannels, fps,
        }));
      const video = formats.filter(format => format.qualityLabel && /^video\//.test(format.mimeType));
      const audio = formats.filter(format => format.audioQuality && /^audio\//.test(format.mimeType));
      if (video.length && audio.length) {
        result.youtubeSabr = { url: data.serverAbrStreamingUrl, config, videoId: id, duration, video, audio };
      }
    }
  }
  result.hint = response?.playabilityStatus?.status === 'LOGIN_REQUIRED'
    ? 'YouTube 要求登录。请先在当前浏览器确认能播放，再重新扫描。'
    : '尚未取得与这条 YouTube 正片匹配的完整下载地址。';
}
