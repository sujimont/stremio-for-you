// Stremio addon server: config page, manifest and catalog endpoints.
// No dependencies: Node's built-in http + fetch.
//
// The server never sees a password: the config page signs in to Stremio
// straight from the browser and puts the resulting auth key (plus settings)
// in the install URL. Nothing about users is stored on disk.
//
// Used by server.js (npm start / Docker) and desktop/main.js (ForYou.exe).
import http from 'node:http';
import { createTmdb } from './tmdb.js';
import { moveAddonToTop, clearLibraryCache } from './stremio.js';
import { analyzeLibrary, recentSeeds, catalogPage } from './recommend.js';
import { getBadgedPoster, prewarmPosters } from './poster.js';

const BECAUSE_ROWS_PER_TYPE = 2;
const ADDON_ID = 'community.personal.foryou';
export const VERSION = '1.3.0';

// --- config <-> URL segment -------------------------------------------------
// Base64url JSON: { authKey, top?, off?: [row keys] }
// `top` defaults to on for installs made before it was a setting.

function decodeConfig(segment) {
  try {
    const config = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof config?.authKey !== 'string' || !config.authKey) return null;
    config.off = Array.isArray(config.off) ? config.off : [];
    if (!Array.isArray(config.indianLangs) || config.indianLangs.length === 0) {
      config.indianLangs = ['ml', 'ta', 'hi'];
    }
    config.ratingBadges = config.ratingBadges !== false;
    return config;
  } catch {
    return null;
  }
}

const rowOn = (config, row) => !config?.off.includes(row);

// --- helpers -----------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('Body too large');
  }
  return JSON.parse(raw || '{}');
}

/**
 * Starts the addon server and resolves once it is listening.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.host
 * @param {string} [options.publicUrl]     Public base URL when behind a proxy.
 * @param {string} options.configureHtml   The setup page.
 * @param {() => string|undefined} options.getTmdbKey
 * @param {object} [options.desktop]       Only for ForYou.exe: { saveTmdbKey(key), shortcuts(mode) }.
 *                                         Enables the local /api endpoints.
 * @param {() => void} [options.onRequest] Called on every request.
 */
export function startServer({ port, host, publicUrl = '', configureHtml, getTmdbKey, desktop, onRequest = () => {} }) {
  // The TMDB key can change at runtime (set on the desktop setup page).
  let tmdb = null;
  let tmdbKeyInUse;
  function currentTmdb() {
    const key = getTmdbKey();
    if (!key) return null;
    if (key !== tmdbKeyInUse) {
      tmdb = createTmdb(key);
      tmdbKeyInUse = key;
    }
    return tmdb;
  }

  function baseUrl(req) {
    if (publicUrl) return publicUrl;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  }

  // --- manifest --------------------------------------------------------------

  async function genreOptions(kind) {
    const genres = await currentTmdb()?.genres(kind).catch(() => null);
    return [...(genres || new Map()).values()].sort();
  }

  // Rows in the order they appear on the Board.
  async function buildManifest(config) {
    const includeMovie = rowOn(config, 'movie');
    const includeSeries = rowOn(config, 'series');

    const [movieGenres, tvGenres] = await Promise.all([
      includeMovie ? genreOptions('movie') : Promise.resolve([]),
      includeSeries ? genreOptions('tv') : Promise.resolve([]),
    ]);
    const skip = [{ name: 'skip' }];

    const catalogs = [];
    if (includeMovie) {
      catalogs.push({ type: 'movie', id: 'foryou', name: 'Recommended for You', extra: [{ name: 'genre', options: movieGenres }, ...skip] });
    }
    if (includeSeries) {
      catalogs.push({ type: 'series', id: 'foryou', name: 'Recommended for You', extra: [{ name: 'genre', options: tvGenres }, ...skip] });
    }
    if (rowOn(config, 'next')) {
      if (includeMovie) catalogs.push({ type: 'movie', id: 'next', name: 'Finish the Story', extra: skip });
      if (includeSeries) catalogs.push({ type: 'series', id: 'next', name: 'New Seasons', extra: skip });
    }
    if (includeMovie && rowOn(config, 'short')) catalogs.push({ type: 'movie', id: 'short', name: 'Under 100 Minutes', extra: skip });
    if (includeSeries && rowOn(config, 'weekend')) catalogs.push({ type: 'series', id: 'weekend', name: 'Finish in a Weekend', extra: skip });

    // AI Storyline Matches for recently watched movies (default 4 rows, configurable)
    if (config && rowOn(config, 'ai') && includeMovie) {
      try {
        const analysis = await analyzeLibrary(config.authKey);
        const aiCount = Math.min(6, Math.max(1, Number(config.aiCount) || 4));
        const recent = recentSeeds(analysis, 'movie', aiCount);

        for (const seed of recent) {
          catalogs.push({
            type: 'movie',
            id: `ai-${seed.id || seed.imdbId}`,
            name: `Storyline Match: ${seed.name}`,
          });
        }
      } catch (err) {
        console.error('Could not build AI rows for manifest:', err.message);
      }
    }

    // "Because you watched X" rows. Their ids carry the seed, so a row's
    // contents always match its title. They rotate when the addon is reinstalled.
    if (config && rowOn(config, 'byw')) {
      try {
        const analysis = await analyzeLibrary(config.authKey);
        const types = [];
        if (includeMovie) types.push('movie');
        if (includeSeries) types.push('series');
        for (const type of types) {
          for (const seed of recentSeeds(analysis, type, BECAUSE_ROWS_PER_TYPE)) {
            catalogs.push({ type, id: `byw-${seed.imdbId}`, name: `Because you watched ${seed.name}` });
          }
        }
      } catch (err) {
        console.error('Could not read library for manifest:', err.message);
      }
    }

    const types = [];
    if (includeMovie) types.push('movie');
    if (includeSeries) types.push('series');

    return {
      id: ADDON_ID,
      version: VERSION,
      name: 'For You',
      description:
        'Personal movie and series recommendations based on your Stremio library and watch history. '
        + 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
      resources: ['catalog'],
      types: types.length ? types : ['movie'],
      catalogs,
      behaviorHints: { configurable: true, configurationRequired: !config },
    };
  }

  // --- catalogs --------------------------------------------------------------

  // Keep For You first in the account's addon list so its rows sit right under
  // Continue Watching, and sync the installed manifest with latest watched titles.
  const ORDER_CHECK_EVERY_MS = 30_000;
  const lastOrderCheck = new Map();
  function keepOnTop(config) {
    const authKey = config?.authKey;
    if (!authKey) return;
    const now = Date.now();
    if (now - (lastOrderCheck.get(authKey) || 0) < ORDER_CHECK_EVERY_MS) return;
    lastOrderCheck.set(authKey, now);
    buildManifest(config)
      .then((manifest) => moveAddonToTop(authKey, ADDON_ID, manifest, config.top !== false))
      .then(({ found, moved, changed, before }) => {
        if (!found) lastOrderCheck.delete(authKey); // Not installed yet: check again next time.
        const position = found ? `#${before.indexOf(ADDON_ID) + 1} of ${before.length}` : 'not installed';
        console.log(`Addon order: For You is ${position}${moved ? ', moved it to #1' : ''}${changed ? ', manifest updated' : ''}. First: ${before.slice(0, 3).join(', ')}`);
      })
      .catch((err) => {
        lastOrderCheck.delete(authKey);
        console.error('Could not check addon order / sync manifest:', err.message);
      });
  }

  async function catalog(req, res, config, manifestUrl, type, id, extraSegment) {
    keepOnTop(config);
    if (!['movie', 'series'].includes(type) || !rowOn(config, type)) return send(res, 404, { metas: [] });
    const tmdbClient = currentTmdb();
    if (!tmdbClient) return send(res, 503, { metas: [], error: 'No TMDB key set up yet' });
    const extra = new URLSearchParams(extraSegment || '');
    const row = id.startsWith('byw-') ? 'byw' : id.startsWith('ai-') ? 'ai' : id;
    const options = {
      row,
      type,
      genre: extra.get('genre') || undefined,
      skip: Math.max(0, Number(extra.get('skip')) || 0),
      manifestUrl,
      indianLangs: config.indianLangs,
      ratingBadges: config.ratingBadges !== false,
    };
    const known = ['foryou', 'byw', 'ai', 'next', 'short', 'weekend'];
    if (!known.includes(row) || !rowOn(config, row)) return send(res, 404, { metas: [] });
    if ((row === 'short' && type !== 'movie') || (row === 'weekend' && type !== 'series') || (row === 'ai' && type !== 'movie')) return send(res, 404, { metas: [] });
    if (row === 'byw') {
      options.seedImdbId = id.slice(4);
      options.pageSize = 30;
    } else if (row === 'ai') {
      options.seedImdbId = id.slice(3);
      options.pageSize = 20;
    }

    const metas = await catalogPage(tmdbClient, config.authKey, options);
    prewarmPosters(metas, tmdbClient);

    const maxAge = metas.length ? 1800 : 60;
    const bodyObj = {
      metas,
      cacheMaxAge: maxAge,
      staleRevalidate: maxAge * 2,
    };
    const bodyStr = JSON.stringify(bodyObj);
    const clientEtag = (req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/^"|"$/g, '');
    const cleanEtag = `${Buffer.byteLength(bodyStr)}-${metas.length}`;
    const etag = `"${cleanEtag}"`;

    if (clientEtag && clientEtag === cleanEtag) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end();
    }

    send(res, 200, bodyObj, {
      'Cache-Control': `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
      'ETag': etag,
    });
  }

  // --- desktop-only local API --------------------------------------------------
  // Only ForYou.exe enables these. POSTs must come from this server's own setup
  // page, so another website can't change settings through the user's browser.

  const ownOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function localApi(req, res, pathname) {
    if (pathname === '/api/status') {
      return send(res, 200, { desktop: Boolean(desktop), hasTmdbKey: Boolean(getTmdbKey()), version: VERSION });
    }
    if (!desktop) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (!ownOrigins.has(req.headers.origin)) return send(res, 403, { error: 'Forbidden' });
    const body = await readJson(req);

    if (pathname === '/api/tmdb-key') {
      const key = String(body.key || '').trim();
      const genres = key && (await createTmdb(key).genres('movie').catch(() => null));
      if (!genres?.size) return send(res, 400, { error: "TMDB didn't accept that key. Check you copied all of it." });
      await desktop.saveTmdbKey(key);
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/shortcuts') {
      const mode = body.enable ? 'enable' : body.enable === false ? 'disable' : 'status';
      try {
        return send(res, 200, { shortcuts: await desktop.shortcuts(mode) });
      } catch (err) {
        console.error('Shortcut update failed:', err.message);
        return send(res, 500, { error: err.message });
      }
    }
    send(res, 404, { error: 'Not found' });
  }

  // --- router ----------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    onRequest();
    const started = Date.now();
    const { pathname } = new URL(req.url, 'http://localhost');
    const parts = pathname.split('/').filter(Boolean);

    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (pathname.startsWith('/api/')) return await localApi(req, res, pathname);
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

      if (parts.length === 0) return send(res, 302, '', { Location: '/configure' });
      if (pathname === '/configure') return send(res, 200, configureHtml);
      if (pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
        return res.end('pong');
      }
      if (pathname === '/manifest.json') {
        const manifestObj = await buildManifest(null);
        return send(res, 200, manifestObj, {
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=86400',
        });
      }

      if (pathname.startsWith('/poster/')) {
        let imdbId, fallbackScore, tmdbPath;
        const rest = pathname.slice(8); // after "/poster/"
        if (rest.includes('/')) {
          // Format: /poster/:imdbId/:score/:tmdbPath...
          const parts = rest.split('/');
          imdbId = parts[0];
          fallbackScore = parts[1] !== '0' ? parts[1] : null;
          tmdbPath = '/' + parts.slice(2).join('/');
        } else {
          // Legacy format: /poster/:imdbId.jpg?tmdb=...&score=...
          imdbId = rest.replace(/\.jpg$/, '');
          const urlObj = new URL(req.url, 'http://localhost');
          tmdbPath = urlObj.searchParams.get('tmdb');
          fallbackScore = urlObj.searchParams.get('score');
        }

        const clientEtag = (req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/^"|"$/g, '');
        const cleanEtag = `${imdbId}-${fallbackScore || '0'}`;
        const etag = `"${cleanEtag}"`;
        if (clientEtag && clientEtag === cleanEtag) {
          res.writeHead(304, {
            'ETag': etag,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          });
          return res.end();
        }

        const result = await getBadgedPoster({
          imdbId,
          type: 'movie',
          tmdbPath,
          fallbackScore,
          tmdbClient: currentTmdb(),
        });
        if (!result) return send(res, 404, 'Poster not found');

        res.writeHead(200, {
          'Content-Type': result.contentType || 'image/jpeg',
          'Content-Length': result.buffer.length,
          'ETag': etag,
          'Last-Modified': 'Sat, 01 Jan 2024 00:00:00 GMT',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(result.buffer);
      }

      // Everything else lives under /<config>/...
      const config = decodeConfig(parts[0]);
      if (!config) return send(res, 404, { error: 'Not found' });
      const rest = parts.slice(1);

      if (rest[0] === 'configure') return send(res, 200, configureHtml);
      if (rest[0] === 'manifest.json') {
        clearLibraryCache(config.authKey);
        const manifestObj = await buildManifest(config);
        return send(res, 200, manifestObj, {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
      }
      if (rest[0] === 'catalog' && rest.length >= 3) {
        const [, type, idOrFile, extraFile] = rest;
        const id = extraFile ? idOrFile : idOrFile.replace(/\.json$/, '');
        // Left percent-encoded on purpose: URLSearchParams decodes it, and
        // decoding first would split genres like "Action & Adventure".
        const extra = extraFile ? extraFile.replace(/\.json$/, '') : '';
        return await catalog(req, res, config, `${baseUrl(req)}/${parts[0]}/manifest.json`, type, id, extra);
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(`${req.method} ${pathname.replace(/^\/[^/]{20,}/, '/<config>')}:`, err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error', metas: [] });
    } finally {
      // Never log the config segment: it contains the auth key.
      const safePath = pathname.replace(/^\/[^/]{20,}/, '/<config>');
      console.log(`${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
