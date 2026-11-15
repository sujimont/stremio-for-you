// Poster image compositing and caching with IMDb rating badges
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'poster_cache');
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

// Ensure cache directory exists on startup
await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});

// In-memory rating cache to avoid duplicate Cinemeta lookups
const ratingMemoryCache = new Map();

// High-speed in-memory poster buffer cache (avoids disk read and re-compositing under load)
const posterMemoryCache = new Map();
const MAX_MEMORY_POSTERS = 300;

function storeInMemory(key, buffer) {
  if (posterMemoryCache.size >= MAX_MEMORY_POSTERS) {
    const oldest = posterMemoryCache.keys().next().value;
    posterMemoryCache.delete(oldest);
  }
  posterMemoryCache.set(key, buffer);
}

/**
 * Resolves the IMDb rating for a given media title.
 * Queries Cinemeta first, falling back to TMDB vote_average.
 */
export async function getImdbRating(imdbId, type = 'movie', fallbackScore = null) {
  if (!imdbId) return fallbackScore ? Number(fallbackScore).toFixed(1) : null;
  if (ratingMemoryCache.has(imdbId)) {
    return ratingMemoryCache.get(imdbId);
  }

  try {
    const res = await fetch(`${CINEMETA_URL}/${type}/${imdbId}.json`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'stremio-for-you' },
    });
    if (res.ok) {
      const data = await res.json();
      const score = data?.meta?.imdbRating;
      if (score && score !== '0' && score !== '0.0') {
        const formatted = String(score).trim();
        ratingMemoryCache.set(imdbId, formatted);
        return formatted;
      }
    }
  } catch {
    // Network/timeout error: proceed to fallback
  }

  if (fallbackScore && Number(fallbackScore) > 0) {
    const formatted = Number(fallbackScore).toFixed(1);
    ratingMemoryCache.set(imdbId, formatted);
    return formatted;
  }

  return null;
}

/**
 * Creates or retrieves a poster with an IMDb rating badge composited at the bottom.
 * Returns { buffer, contentType: 'image/jpeg' } or null if unavailable.
 */
export async function getBadgedPoster({ imdbId, type = 'movie', tmdbPath, fallbackScore, tmdbClient }) {
  if (!imdbId && !tmdbPath) return null;

  const memKey = `${imdbId || tmdbPath}:${fallbackScore || ''}`;

  // 1. Instant return from RAM cache (0.1ms)
  if (posterMemoryCache.has(memKey)) {
    return { buffer: posterMemoryCache.get(memKey), contentType: 'image/jpeg' };
  }

  const cacheFile = imdbId ? path.join(CACHE_DIR, `${imdbId}.jpg`) : null;

  // 2. Return from disk cache if already generated
  if (cacheFile) {
    try {
      const cached = await fs.readFile(cacheFile);
      if (cached && cached.length > 0) {
        storeInMemory(memKey, cached);
        return { buffer: cached, contentType: 'image/jpeg' };
      }
    } catch {
      // Not cached on disk yet
    }
  }

  // If tmdbPath was not passed, try resolving it via TMDB client if provided
  let resolvedPath = tmdbPath;
  if (!resolvedPath && tmdbClient && imdbId) {
    try {
      const hit = await tmdbClient.findByImdb(imdbId, type);
      if (hit?.tmdbId) {
        const details = await tmdbClient.details(type, hit.tmdbId);
        resolvedPath = details?.poster_path;
        if (!fallbackScore && details?.vote_average) {
          fallbackScore = details.vote_average;
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Fetch base poster image from TMDB
  const posterUrl = resolvedPath
    ? (resolvedPath.startsWith('http') ? resolvedPath : `${TMDB_IMG}${resolvedPath}`)
    : null;

  if (!posterUrl) return null;

  let baseImageBuffer;
  try {
    const imgRes = await fetch(posterUrl, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'stremio-for-you' },
    });
    if (!imgRes.ok) return null;
    baseImageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } catch (err) {
    console.error(`Poster download failed for ${imdbId || resolvedPath}:`, err.message);
    return null;
  }

  // 4. Resolve rating
  const rating = await getImdbRating(imdbId, type, fallbackScore);

  // If no rating is found or score is 0, return base image directly
  if (!rating) {
    if (cacheFile) await fs.writeFile(cacheFile, baseImageBuffer).catch(() => {});
    storeInMemory(memKey, baseImageBuffer);
    return { buffer: baseImageBuffer, contentType: 'image/jpeg' };
  }

  // 5. Composite IMDb badge banner at the bottom
  try {
    const metadata = await sharp(baseImageBuffer).metadata();
    const width = metadata.width || 342;
    const height = metadata.height || 513;

    // Bar height is ~8% of the poster height (e.g. 41px on a 513px tall poster)
    const barHeight = Math.round(height * 0.08);
    const ratingText = `${rating}/10`;

    // Exact styling matching user's screenshot:
    // - Dark semi-transparent horizontal bar across the bottom (#141416 @ 88% opacity)
    // - Yellow rounded rectangle IMDb logo badge (#f5c518)
    // - Clean bold white rating text
    const svgBanner = `
    <svg width="${width}" height="${barHeight}" viewBox="0 0 ${width} ${barHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${barHeight}" fill="#141416" fill-opacity="0.88"/>
      <g transform="translate(${Math.round(width / 2)}, ${Math.round(barHeight / 2)})">
        <g transform="translate(-48, -10)">
          <rect x="0" y="2" width="34" height="17" rx="3" fill="#f5c518"/>
          <text x="17" y="14.5" font-family="Arial, Helvetica, sans-serif" font-weight="900" font-size="10" fill="#000000" text-anchor="middle">IMDb</text>
          <text x="42" y="15.5" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="14" fill="#ffffff" text-anchor="start">${ratingText}</text>
        </g>
      </g>
    </svg>`;

    const badgedBuffer = await sharp(baseImageBuffer)
      .composite([
        {
          input: Buffer.from(svgBanner),
          top: height - barHeight,
          left: 0,
        },
      ])
      .jpeg({ quality: 86 })
      .toBuffer();

    if (cacheFile) {
      await fs.writeFile(cacheFile, badgedBuffer).catch(() => {});
    }

    storeInMemory(memKey, badgedBuffer);
    return { buffer: badgedBuffer, contentType: 'image/jpeg' };
  } catch (err) {
    console.error(`Poster compositing failed for ${imdbId}:`, err.message);
    return { buffer: baseImageBuffer, contentType: 'image/jpeg' };
  }
}

/**
 * Asynchronously pre-renders and caches posters in memory before the Stremio UI requests them.
 */
export function prewarmPosters(metas, tmdbClient) {
  if (!Array.isArray(metas) || metas.length === 0) return;
  setTimeout(async () => {
    for (const m of metas) {
      if (!m || !m.poster || !m.poster.includes('/poster/')) continue;
      try {
        const url = new URL(m.poster, 'http://localhost');
        const rest = url.pathname.replace(/^\/poster\//, '');
        if (rest.includes('/')) {
          const parts = rest.split('/');
          const imdbId = parts[0];
          const fallbackScore = parts[1] !== '0' ? parts[1] : null;
          const tmdbPath = '/' + parts.slice(2).join('/');
          await getBadgedPoster({ imdbId, type: m.type || 'movie', tmdbPath, fallbackScore, tmdbClient });
        }
      } catch {}
    }
  }, 10).unref?.();
}
