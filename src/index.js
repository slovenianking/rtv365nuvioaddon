import { TTLCache } from './cache.js';
import {
  RtvClient,
  UA,
  assignSeasons,
  parseMetaTags,
  parseRecordingList,
  parseShowList,
  showLogo
} from './rtv.js';

// ==========================================
// Nastavitve
// ==========================================
const DEFAULTS = {
  // Katalog "Slovenski filmi": https://365.rtvslo.si/raziskuj?&WPId=335&c=show  (oddaja "Slovenski filmi" ima id 236)
  MOVIES_URL: 'https://365.rtvslo.si/raziskuj?&WPId=335&c=show',
  MOVIES_SHOW_ID: '236',
  // Katalog "Slovenske serije"
  SERIES_URL: 'https://365.rtvslo.si/oddaje/seznam/339?group=show_covers&imageType=thumbnail&clip=show&page=serije'
};

const CATALOG_TTL_MS = 30 * 60 * 1000;
const MEDIA_TTL_MS = 5 * 60 * 1000;
const META_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15 * 1000;
const PAGE_SIZE = 100;

const catalogCache = new TTLCache(CATALOG_TTL_MS);
const mediaCache = new TTLCache(MEDIA_TTL_MS);
const metaCache = new TTLCache(META_TTL_MS);

const MANIFEST = {
  id: 'si.rtvslo.365.stremio',
  version: '1.0.0',
  name: 'RTV 365',
  description: 'Slovenski filmi in Slovenske serije z RTV 365 (365.rtvslo.si), neposredno v Nuvio ali Stremio. Neuradni dodatek.',
  logo: '/icon.png',
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['rtv365:'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['rtv365:'] }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['rtv365:'],
  catalogs: [
    {
      type: 'movie',
      id: 'rtv365-slovenski-filmi',
      name: 'RTV 365 Slovenski filmi',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    },
    {
      type: 'series',
      id: 'rtv365-slovenske-serije',
      name: 'RTV 365 Slovenske serije',
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

// ==========================================
// Pomožne funkcije
// ==========================================
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...extra } });

function cfg(env, key) {
  return (env && env[key]) || DEFAULTS[key];
}

function makeClient(env) {
  return new RtvClient({
    clientId: env && env.RTV_CLIENT_ID ? env.RTV_CLIENT_ID : undefined,
    apiUrl: env && env.RTV_API_URL ? env.RTV_API_URL : undefined,
    siteUrl: env && env.RTV_SITE_URL ? env.RTV_SITE_URL : undefined
  });
}

function publicUrl(ctx) {
  return ctx.env && ctx.env.PUBLIC_URL ? String(ctx.env.PUBLIC_URL).replace(/\/+$/, '') : ctx.baseUrl;
}

const ids = {
  movie: (id) => `rtv365:m:${id}`,
  episode: (id) => `rtv365:e:${id}`,
  show: (id, slug) => `rtv365:s:${id}:${slug || 'oddaja'}`
};

function parseId(id) {
  const [prefix, kind, a, b] = String(id).split(':');
  if (prefix !== 'rtv365') return null;
  return { kind, id: a, slug: b };
}

function toPreview(item, type) {
  return {
    id: item.metaId,
    type,
    name: item.title,
    poster: item.poster,
    posterShape: 'landscape',
    background: item.poster,
    description: item.description || undefined,
    releaseInfo: item.year || undefined
  };
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Proxy sme nagovarjati samo RTV-jeve gostitelje (da ne postane odprt proxy).
function isAllowedHost(url, env) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const extra = String((env && env.EXTRA_ALLOWED_HOSTS) || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    return h === 'rtvslo.si' || h.endsWith('.rtvslo.si') || h.endsWith('.rtvcdn.si') || extra.includes(h);
  } catch (_) {
    return false;
  }
}

// ==========================================
// Katalogi
// ==========================================
async function loadMovies(ctx) {
  const client = makeClient(ctx.env);
  let items = [];
  try {
    const recs = await client.searchRecordings({ showId: cfg(ctx.env, 'MOVIES_SHOW_ID') });
    items = recs.map((r) => ({ ...r, slug: 'slovenski-filmi', metaId: ids.movie(r.id) }));
  } catch (_) {
    // API ni uspel - poskusi še s HTML stranjo iz seznama
  }
  if (items.length === 0) {
    const html = await client.page(cfg(ctx.env, 'MOVIES_URL'));
    items = parseRecordingList(html).map((r) => ({ ...r, metaId: ids.movie(r.id) }));
  }
  return items;
}

async function loadSeries(ctx) {
  const client = makeClient(ctx.env);
  const html = await client.page(cfg(ctx.env, 'SERIES_URL'));
  return parseShowList(html, client.siteUrl).map((s) => ({ ...s, metaId: ids.show(s.id, s.slug) }));
}

async function handleCatalog(ctx, type, id, extra) {
  let items;
  if (type === 'movie' && id === 'rtv365-slovenski-filmi') {
    items = await catalogCache.getOrLoad('movies', () => loadMovies(ctx));
  } else if (type === 'series' && id === 'rtv365-slovenske-serije') {
    items = await catalogCache.getOrLoad('series', () => loadSeries(ctx));
  } else {
    return { metas: [] };
  }

  const search = extra && extra.search ? extra.search.toLowerCase().trim() : '';
  if (search) items = items.filter((i) => i.title.toLowerCase().includes(search));
  const skip = (extra && parseInt(extra.skip, 10)) || 0;
  if (!search) items = items.slice(skip, skip + PAGE_SIZE);

  return { metas: items.map((i) => toPreview(i, type)) };
}

// ==========================================
// Meta
// ==========================================
async function loadMovieMeta(ctx, recId) {
  const client = makeClient(ctx.env);
  let rec = null;
  try {
    rec = await client.getRecording(recId);
  } catch (_) {}

  if (!rec || !rec.title || rec.title === 'Brez naslova') {
    // rezerva: og: oznake na strani posnetka
    const html = await client.page(`${client.siteUrl}/arhiv/slovenski-filmi/${recId}`);
    const tags = parseMetaTags(html);
    rec = {
      id: recId,
      title: tags['og:title'] || tags.title || 'RTV 365',
      description: tags['og:description'] || tags.description || '',
      poster: tags['og:image'] || undefined,
      ...(rec || {})
    };
    if (!rec.title || rec.title === 'RTV 365') throw new Error('Posnetek ni najden.');
  }

  const meta = {
    id: ids.movie(recId),
    type: 'movie',
    name: rec.title,
    poster: rec.poster,
    posterShape: 'landscape',
    background: rec.poster,
    description: rec.description || undefined,
    releaseInfo: rec.year || undefined
  };
  if (rec.minutes) meta.runtime = `${rec.minutes} min`;
  return { meta };
}

async function loadSeriesMeta(ctx, showId, slug) {
  const client = makeClient(ctx.env);
  const showUrl = `${client.siteUrl}/oddaja/${slug}/${showId}`;

  const [html, apiEpisodes] = await Promise.all([
    client.page(showUrl).catch(() => ''),
    client.searchRecordings({ showId, order: 'asc' }).catch(() => [])
  ]);

  const tags = parseMetaTags(html);
  let episodes = apiEpisodes.filter((e) => !e.showId || e.showId === String(showId));

  if (episodes.length === 0 && html) {
    // rezerva: epizode s strani oddaje (na strani so najnovejše prve -> obrnemo v kronološki vrstni red)
    episodes = parseRecordingList(html, { slug })
      .reverse()
      .map((e) => ({ ...e, description: '', timestamp: null }));
  }

  // kronološko (po datumu, sicer ohrani vrstni red)
  if (episodes.every((e) => e.timestamp)) episodes = [...episodes].sort((a, b) => a.timestamp - b.timestamp);

  const withNumbers = assignSeasons(episodes);
  const base = Date.UTC(2000, 0, 1);
  const videos = withNumbers.map((e, idx) => ({
    id: ids.episode(e.id),
    title: e.title,
    season: e.season,
    episode: e.episode,
    released: new Date(e.timestamp || base + idx * 86400000).toISOString(),
    thumbnail: e.poster,
    overview: e.description || undefined
  }));

  const title = tags['og:title'] || tags.title || (slug || '').replace(/-/g, ' ');
  const poster = tags['og:image'] || showLogo(showId);
  const meta = {
    id: ids.show(showId, slug),
    type: 'series',
    name: title,
    poster,
    posterShape: 'landscape',
    background: poster,
    description: tags['og:description'] || tags.description || undefined,
    videos
  };
  if (videos.length === 0) throw new Error('Za to oddajo ni najdenih epizod.');
  return { meta };
}

async function handleMeta(ctx, type, id) {
  const p = parseId(id);
  if (!p) return { meta: null };
  if (p.kind === 'm') return metaCache.getOrLoad(id, () => loadMovieMeta(ctx, p.id));
  if (p.kind === 's') return metaCache.getOrLoad(id, () => loadSeriesMeta(ctx, p.id, p.slug));
  return { meta: null };
}

// ==========================================
// Stream
// ==========================================
async function getCandidates(ctx, recId) {
  return mediaCache.getOrLoad(recId, () => makeClient(ctx.env).resolveMedia(recId));
}

async function handleStream(ctx, type, id) {
  const p = parseId(id);
  if (!p || (p.kind !== 'm' && p.kind !== 'e')) return { streams: [] };
  const base = publicUrl(ctx);

  try {
    const candidates = await getCandidates(ctx, p.id);
    // Max. 3 možnosti (mp4 kakovosti, nato HLS)
    return {
      streams: candidates.slice(0, 3).map((c, idx) => ({
        url: `${base}/play/${p.id}/${idx}`,
        title: `RTV 365${c.label ? ' - ' + c.label : ''}${c.kind === 'hls' ? ' (HLS)' : ''}`,
        behaviorHints: { notWebReady: false, bingeGroup: `rtv365-${p.kind === 'e' ? 'series' : 'movie'}` }
      }))
    };
  } catch (err) {
    // Razreševanje ni uspelo (npr. začasna napaka) - ponudi leno razrešeno povezavo; /play/ vrne jasno napako.
    return { streams: [{ url: `${base}/play/${p.id}/0`, title: 'RTV 365', behaviorHints: { notWebReady: false } }] };
  }
}

// ==========================================
// Proxy (video / HLS)
// ==========================================
async function fetchUpstream(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function upstreamHeaders(env, request) {
  const siteUrl = ((env && env.RTV_SITE_URL) || 'https://365.rtvslo.si').replace(/\/+$/, '');
  const headers = { 'User-Agent': UA, Referer: `${siteUrl}/`, Origin: siteUrl, 'Accept-Encoding': 'identity' };
  const range = request.headers.get('range');
  if (range) headers.Range = range;
  return headers;
}

function passThrough(upstream) {
  const out = new Headers(CORS);
  out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  ['content-type', 'content-range', 'accept-ranges', 'cache-control'].forEach((h) => {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  });
  if (!upstream.headers.get('content-encoding')) {
    const len = upstream.headers.get('content-length');
    if (len) out.set('content-length', len);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function proxyBytes(ctx, request, url) {
  if (!isAllowedHost(url, ctx.env)) return text('Nedovoljen naslov vira.', 403);
  try {
    const upstream = await fetchUpstream(url, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders(ctx.env, request)
    });
    return passThrough(upstream);
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return text(timedOut ? `Vir se ni odzval znotraj ${UPSTREAM_TIMEOUT_MS / 1000}s` : 'Napaka vira: ' + err.message, timedOut ? 504 : 502);
  }
}

function hlsLink(base, target, kindHint) {
  const path = new URL(target).pathname;
  const ext = kindHint === 'key' ? '.key' : /\.m3u8/i.test(path) ? '.m3u8' : /\.mpd/i.test(path) ? '.mpd' : '.ts';
  return `${base}/hls/${b64urlEncode(target)}${ext}`;
}

function rewritePlaylist(body, upstreamUrl, base) {
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => {
          const abs = new URL(u, upstreamUrl).toString();
          return `URI="${hlsLink(base, abs, /#EXT-X-KEY/.test(line) ? 'key' : undefined)}"`;
        });
      }
      return hlsLink(base, new URL(line.trim(), upstreamUrl).toString());
    })
    .join('\n');
}

async function proxyHls(ctx, request, url) {
  if (!isAllowedHost(url, ctx.env)) return text('Nedovoljen naslov vira.', 403);
  try {
    const upstream = await fetchUpstream(url, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders(ctx.env, request)
    });
    const type = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(url);
    if (!isPlaylist || !upstream.ok) return passThrough(upstream);

    const body = await upstream.text();
    return new Response(rewritePlaylist(body, upstream.url || url, publicUrl(ctx)), {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', ...CORS }
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return text(timedOut ? 'HLS vir se ni odzval' : 'HLS napaka: ' + err.message, timedOut ? 504 : 502);
  }
}

async function handlePlay(ctx, request, recId, idxRaw) {
  const candidates = await getCandidates(ctx, recId);
  const idx = parseInt(idxRaw, 10);
  const pick = (!isNaN(idx) && candidates[idx]) || candidates[0];
  return pick.kind === 'hls' ? proxyHls(ctx, request, pick.url) : proxyBytes(ctx, request, pick.url);
}

// ==========================================
// Domača stran in usmerjevalnik
// ==========================================
function landingPage(baseUrl) {
  const host = new URL(baseUrl).host;
  const manifestUrl = `${baseUrl}/manifest.json`;
  return `<!DOCTYPE html>
<html lang="sl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RTV 365 - Stremio / Nuvio addon</title>
<style>
body{margin:0;font-family:system-ui,Arial,sans-serif;background:#111;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:420px;padding:24px;text-align:center}
img{width:96px;height:96px;border-radius:20px}
h1{margin:12px 0 4px}p{opacity:.8;line-height:1.5}
a.btn,button{display:block;width:100%;box-sizing:border-box;margin:12px 0;padding:14px;border:0;border-radius:8px;background:#8A5AAB;color:#fff;font-size:16px;font-weight:600;text-decoration:none;cursor:pointer}
button.secondary{background:#333}
code{display:block;word-break:break-all;background:#222;padding:8px;border-radius:6px;font-size:13px}
</style></head><body><main>
<img src="/icon.png" alt="RTV 365">
<h1>RTV 365</h1>
<p>Slovenski filmi in Slovenske serije z RTV 365 neposredno v Nuvio ali Stremio. Prijava ni potrebna.</p>
<a class="btn" href="stremio://${host}/manifest.json">NAMESTI</a>
<button class="secondary" id="copy">Kopiraj povezavo addona (Nuvio)</button>
<code id="url">${manifestUrl}</code>
<p style="font-size:13px">Neuradni dodatek. Vsa vsebina pripada RTV Slovenija.</p>
</main>
<script>document.getElementById('copy').onclick=function(){var u=document.getElementById('url').textContent;(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){document.getElementById('copy').textContent='Kopirano!'}).catch(function(){window.prompt('Kopirajte povezavo:',u)})}</script>
</body></html>`;
}

function parseExtra(raw) {
  const extra = {};
  if (!raw) return extra;
  for (const pair of raw.replace(/\.json$/i, '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const dec = (s) => {
      try {
        return decodeURIComponent(s);
      } catch (_) {
        return s;
      }
    };
    extra[dec(i === -1 ? pair : pair.slice(0, i))] = i === -1 ? '' : dec(pair.slice(i + 1));
  }
  return extra;
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
};
const stripJson = (s) => (s || '').replace(/\.json$/i, '');

async function route(request, env) {
  const url = new URL(request.url);
  const ctx = { env, baseUrl: url.origin };
  const raw = url.pathname.split('/').filter(Boolean);
  const segs = raw.map(safeDecode);
  const resource = segs[0];

  if (!resource || resource === 'configure') {
    return new Response(landingPage(url.origin), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (resource === 'manifest.json') {
    const m = JSON.parse(JSON.stringify(MANIFEST));
    m.logo = `${url.origin}/icon.png`;
    return json(m);
  }

  try {
    switch (resource) {
      case 'catalog':
        return json(await handleCatalog(ctx, segs[1], stripJson(segs[2]), parseExtra(raw[3])));
      case 'meta':
        return json(await handleMeta(ctx, segs[1], stripJson(segs[2])));
      case 'stream':
        return json(await handleStream(ctx, segs[1], stripJson(segs[2])));
      case 'play':
        return await handlePlay(ctx, request, segs[1], segs[2]);
      case 'hls': {
        const encoded = (segs[1] || '').replace(/\.(m3u8|mpd|ts|key)$/i, '');
        return await proxyHls(ctx, request, b64urlDecode(encoded));
      }
      default:
        return text('Not found', 404);
    }
  } catch (err) {
    if (resource === 'play' || resource === 'hls') return text('RTV 365 proxy napaka: ' + err.message, 502);
    return json({ err: err.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);
    return route(request, env);
  }
};
