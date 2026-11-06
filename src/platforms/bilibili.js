export async function scanBilibili({ url, resources, resourceSince, result, clip }) {
  const bvid = url.pathname.match(/^\/video\/(BV[\w]+)/i)?.[1];
  const state = window.__INITIAL_STATE__?.videoData;
  const part = Number(url.searchParams.get('p') || 1);
  const cid = state?.bvid === bvid ? (state.pages?.[part - 1]?.cid ?? (part === 1 ? state.cid : null)) : null;
  const playRequest = [...resources].reverse().map(item => new URL(item.url, url))
    .find(item => item.hostname === 'api.bilibili.com' && item.searchParams.get('cid') === String(cid)
      && /^\/x\/player\/(?:wbi\/)?playurl$/.test(item.pathname));

  // A fresh API response is tied to the current part, including SPA transitions.
  let data;
  if (bvid && cid) {
    const api = playRequest ?? new URL('https://api.bilibili.com/x/player/playurl');
    if (!playRequest) {
      for (const [name, value] of Object.entries({ bvid, cid, qn: 80, fnval: 4048, fourk: 1 })) {
        api.searchParams.set(name, value);
      }
    }
    try {
      data = (await (await fetch(api, { credentials: 'include', signal: AbortSignal.timeout(3000) })).json()).data;
    } catch {}
  }
  if (!data && bvid && cid && !resourceSince && part === 1) data = window.__playinfo__?.data;
  if (data) {
    result.title = state.pages?.length > 1
      ? state.title + ' P' + part + ' ' + (state.pages[part - 1]?.part ?? '') : state.title || result.title;
    result.variants = (data.dash?.video ?? []).map(clip);
    result.audio = (data.dash?.audio ?? []).map(clip);
    result.files = data.durl?.length === 1 ? [clip(data.durl[0])] : [];
    result.site = 'bilibili';
  }
}

export const bilibiliDownload = { referer: "https://www.bilibili.com/", stageWithoutRanges: true };
