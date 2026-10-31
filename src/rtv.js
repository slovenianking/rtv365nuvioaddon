// Odjemalec za RTV 365 (365.rtvslo.si): javni MMC API (api.rtvslo.si/ava) + razčlenjevanje HTML strani.

export const DEFAULT_CLIENT_ID = '82013fb3a531d5414f478747c1aca622'; // javni client_id, ki ga uporablja spletna stran
export const DEFAULT_API_URL = 'https://api.rtvslo.si/ava';
export const DEFAULT_SITE_URL = 'https://365.rtvslo.si';

// RTV veže žetone (keylockhash) na User-Agent: ISTI UA mora biti pri API klicih in pri pretakanju.
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- pomožne funkcije ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

export function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const DURATION_ONLY = /^\s*(\d+:)?\d{1,2}:\d{2}\s*$|^\s*\d+\s*min\s*$/i;

function absolute(url, base) {
  if (!url) return undefined;
  try {
    return new URL(url, base).toString();
  } catch (_) {
    return undefined;
  }
}

function findImage(value, depth = 0) {
  if (!value || depth > 3) return undefined;
  if (typeof value === 'string') {
    return /\.(jpe?g|png|webp)(\?|$)/i.test(value) ? absolute(value, 'https://img.rtvcdn.si') : undefined;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = findImage(v, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const key of ['wide', 'wide1', 'big', 'thumb', 'thumbnail', 'poster', 'image', 'medium', 'small']) {
      if (value[key]) {
        const r = findImage(value[key], depth + 1);
        if (r) return r;
      }
    }
    for (const v of Object.values(value)) {
      const r = findImage(v, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

function parseTime(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  return isNaN(t) ? null : t;
}

function toMinutes(d) {
  const n = parseFloat(d);
  if (!n || isNaN(n)) return undefined;
  return n > 400 ? Math.round(n / 60) : Math.round(n); // >400 -> sekunde
}

export function showLogo(showId) {
  return `https://img.rtvcdn.si/_up/ava/ava_misc/show_logos/${showId}/logo_2_wide1.jpg`;
}

/** Enoten opis posnetka iz API odgovora (getSearch2 / getRecording). */
export function normalizeRecording(r) {
  if (!r || (r.id === undefined && r.recordingId === undefined)) return null;
  const date = r.date || r.broadcastDate || r.published || r.dateOfBroadcast || r.created;
  const ts = parseTime(date);
  return {
    id: String(r.id !== undefined ? r.id : r.recordingId),
    title: r.title || r.name || 'Brez naslova',
    description: r.description || r.summary || r.text || '',
    timestamp: ts,
    year: ts ? String(new Date(ts).getUTCFullYear()) : (String(date || '').match(/\b(19|20)\d\d\b/) || [])[0],
    minutes: toMinutes(r.duration || r.length || r.durationSec),
    poster: findImage(r.images) || findImage(r.image) || findImage(r.thumbnail) || findImage(r.thumb),
    showId: r.showId !== undefined ? String(r.showId) : undefined,
    showName: r.showName || r.show || undefined
  };
}

/** "Smrdljivc, 6/6" -> 6 ; "3. del" -> 3 */
export function parseEpisodeNumber(title) {
  const t = String(title || '');
  let m = t.match(/(\d+)\s*\/\s*\d+\s*$/);
  if (m) return parseInt(m[1], 10);
  m = t.match(/(\d+)\.\s*del\b/i) || t.match(/\bepizoda\s*(\d+)/i) || t.match(/\bdel\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Epizode v kronološkem vrstnem redu -> season/episode (nov sezona, ko številka epizode "skoči nazaj"). */
export function assignSeasons(episodes) {
  let season = 1;
  let prevParsed = 0;
  let counter = 0;
  return episodes.map((ep) => {
    const parsed = parseEpisodeNumber(ep.title);
    if (parsed !== null && prevParsed && parsed <= prevParsed) season += 1;
    counter = parsed !== null ? parsed : counter + 1;
    if (parsed !== null) prevParsed = parsed;
    return { ...ep, season, episode: counter };
  });
}

// ---------- razčlenjevanje HTML ----------
export function parseShowList(html, siteUrl = DEFAULT_SITE_URL) {
  const re = /<a\b[^>]*href=["'](?:https?:\/\/365\.rtvslo\.si)?\/oddaja\/([^\/"'?#]+)\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const shows = new Map();
  let m;
  while ((m = re.exec(html))) {
    const [, slug, id, inner] = m;
    const title = stripTags(inner);
    const existing = shows.get(id);
    if (!existing) shows.set(id, { id, slug, title: title && !DURATION_ONLY.test(title) ? title : '' });
    else if (!existing.title && title && !DURATION_ONLY.test(title)) existing.title = title;
  }
  return [...shows.values()].filter((s) => s.title).map((s) => ({ ...s, poster: showLogo(s.id), url: `${siteUrl}/oddaja/${s.slug}/${s.id}` }));
}

export function parseRecordingList(html, { slug } = {}) {
  const re = /<a\b[^>]*href=["'](?:https?:\/\/365\.rtvslo\.si)?\/arhiv\/([^\/"'?#]+)\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const items = new Map();
  let m;
  while ((m = re.exec(html))) {
    const [, s, id, inner] = m;
    if (slug && s !== slug) continue;
    const title = stripTags(inner);
    const usable = title && !DURATION_ONLY.test(title) && !/^shrani$/i.test(title);
    const existing = items.get(id);
    if (!existing) items.set(id, { id, slug: s, title: usable ? title : '' });
    else if (!existing.title && usable) existing.title = title;
  }
  return [...items.values()].filter((i) => i.title);
}

export function parseMetaTags(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/(?:property|name)=["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content=["']([^"']*)["']/i) || [])[1];
    if (key && content !== undefined && out[key] === undefined) out[key] = decodeEntities(content);
  }
  return out;
}

// ---------- API odjemalec ----------
export class RtvClient {
  constructor({ clientId = DEFAULT_CLIENT_ID, apiUrl = DEFAULT_API_URL, siteUrl = DEFAULT_SITE_URL } = {}) {
    this.clientId = clientId;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.siteUrl = siteUrl.replace(/\/+$/, '');
  }

  headers(extra = {}) {
    return {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'sl-SI,sl;q=0.9,en;q=0.8',
      Referer: `${this.siteUrl}/`,
      Origin: this.siteUrl,
      ...extra
    };
  }

  async api(path, params = {}) {
    const qs = new URLSearchParams({ client_id: this.clientId, ...params });
    const res = await fetch(`${this.apiUrl}/${path}?${qs}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`RTV API ${res.status} @ ${path}`);
    const data = await res.json();
    return data && data.response !== undefined ? data.response : data;
  }

  async page(url) {
    const res = await fetch(url, { headers: this.headers({ Accept: 'text/html,application/xhtml+xml' }) });
    if (!res.ok) throw new Error(`RTV stran ${res.status} @ ${url}`);
    return res.text();
  }

  async searchRecordings(params) {
    const response = await this.api('getSearch2', { clip: 'show', sort: 'date', order: 'desc', pageSize: '500', ...params });
    const list = (response && (response.recordings || response.shows || response.items)) || [];
    return list.map(normalizeRecording).filter(Boolean);
  }

  async getRecording(id) {
    return normalizeRecording({ id, ...(await this.api(`getRecording/${id}`)) });
  }

  /**
   * Poišče predvajalne povezave. Najprej "DRM" pot (getRecordingDrm -> jwt -> getMedia), nato klasični getRecording.
   * Vrne seznam kandidatov: { kind: 'mp4'|'hls', url, height, bitrate, label }, najboljši prvi.
   */
  async resolveMedia(id) {
    let responses = [];

    try {
      const drm = await this.api(`getRecordingDrm/${id}`);
      const jwt = drm && drm.jwt;
      if (jwt) responses.push(await this.api(`getMedia/${id}`, { jwt }));
    } catch (_) {
      // nadaljuj s klasično potjo
    }
    if (!responses.some((r) => r && r.mediaFiles && r.mediaFiles.length)) {
      try {
        responses.push(await this.api(`getRecording/${id}`));
      } catch (_) {}
    }

    const candidates = [];
    const seen = new Set();
    const add = (c) => {
      if (!c.url) return;
      const url = c.url.replace(/^http:\/\/([^/]*\.rtvslo\.si)/i, 'https://$1');
      if (seen.has(url)) return;
      seen.add(url);
      candidates.push({ ...c, url });
    };

    for (const resp of responses) {
      for (const f of (resp && resp.mediaFiles) || []) {
        const type = String(f.mediaType || '').toUpperCase();
        if (['MP3', 'AAC', 'M4A', 'OGG'].includes(type)) continue;
        const height = parseInt(f.height, 10) || 0;
        const bitrate = parseInt(f.bitrate, 10) || 0;
        const streams = f.streams || {};
        const streamers = f.streamers || {};

        const progressive =
          streams.http || (streamers.http && f.filename ? `${streamers.http.replace(/\/+$/, '')}/${f.filename}` : null);
        if (progressive && !/\.mp3(\?|$)/i.test(progressive)) add({ kind: 'mp4', url: progressive, height, bitrate });

        const hls =
          streams.hls_sec ||
          streams.hls ||
          (streamers.hls_sec && f.filename ? `${streamers.hls_sec.replace(/\/+$/, '')}/${f.filename}/playlist.m3u8` : null);
        if (hls) add({ kind: 'hls', url: hls, height, bitrate });
      }

      // (RTV v API-ju črkuje "addaptiveMedia") - adaptivni HLS z več kakovostmi
      const adaptive = resp && (resp.addaptiveMedia || resp.adaptiveMedia);
      if (adaptive) {
        const url = adaptive.hls_sec || adaptive.hls || (adaptive.streams && (adaptive.streams.hls_sec || adaptive.streams.hls));
        if (url) add({ kind: 'hls', url, height: 0, bitrate: 0, adaptive: true });
      }
    }

    // mp4 najprej (najboljša kakovost prva), HLS za njimi
    const rank = (c) => (c.kind === 'mp4' ? 0 : 1);
    candidates.sort((a, b) => rank(a) - rank(b) || b.height - a.height || b.bitrate - a.bitrate);
    candidates.forEach((c) => {
      c.label = c.height ? `${c.height}p` : c.bitrate ? `${Math.round(c.bitrate / 1000)} kbps` : c.adaptive ? 'HLS' : '';
    });

    if (candidates.length === 0) throw new Error(`Za posnetek ${id} ni mogoče najti predvajalne povezave (vsebina je morda geo-omejena ali plačljiva).`);
    return candidates;
  }
}
