// Turns a Stremio library into ranked recommendation rows.
//
// Main ranking ("Recommended for You"):
// 1. Every library/history item gets an "interest" weight from how much of it
//    you watched, whether you saved it, and how recently you touched it.
// 2. The strongest items become seeds. For each seed we pull TMDB's
//    recommendations (and, at lower weight, "similar" titles).
// 3. Candidates are scored by summing seed weight x list position, so titles
//    suggested by several things you liked rise to the top. A Bayesian rating
//    nudge keeps obscure or badly rated titles down.
// 4. Anything already in your library or history is filtered out.
//
// Other rows reuse that ranking (Under 100 Minutes, Finish in a Weekend) or
// follow what you've finished (Finish the Story: next film in a series, new
// season of a show).
import { TTLCache, mapLimit } from './cache.js';
import { getLibrary } from './stremio.js';
import { poster, backdrop } from './tmdb.js';
import { getAiStorylineRecommendations, getAiProfileRecommendations } from './ai.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_SEEDS = 30;
const MIN_VOTES = 15;
const RECENCY_HALF_LIFE_DAYS = 120;
const SHORT_MOVIE_MINUTES = 100;
const WEEKEND_MAX_EPISODES = 12;

const poolCache = new TTLCache(30 * 60 * 1000, 1000);

const tmdbKind = (type) => (type === 'movie' ? 'movie' : 'tv');
const today = () => new Date().toISOString().slice(0, 10);

function interest(item, now) {
  const s = item.state || {};
  const inLibrary = !item.removed && !item.temp;
  const watchedMs = Math.max(s.overallTimeWatched || 0, s.timeOffset || 0);
  const finished = s.timesWatched > 0 || s.flaggedWatched > 0;

  let engagement = 0;
  if (item.type === 'movie') {
    if (finished) engagement = 1;
    else if (s.duration > 0) engagement = Math.min(1, watchedMs / s.duration);
    else if (watchedMs >= 60 * 60 * 1000) engagement = 0.7;
  } else {
    // Series: hours watched across all episodes, saturating at ~10h.
    engagement = Math.min(1, watchedMs / (10 * 3600 * 1000));
    if (finished) engagement = Math.max(engagement, 0.5);
  }

  const lastWatched = Date.parse(s.lastWatched) || Date.parse(item._mtime) || 0;
  const touched = Math.max(lastWatched, Date.parse(item._mtime) || 0, Date.parse(item._ctime) || 0);
  const ageDays = touched ? (now - touched) / DAY : 365;

  let weight;
  if (engagement > 0) {
    // Started but dropped early and not touched for a week: probably didn't like it.
    const abandoned = engagement < 0.35 && !finished && ageDays > 7;
    weight = abandoned ? 0.05 : 0.4 + 0.6 * engagement;
    if (inLibrary) weight += 0.2;
  } else if (inLibrary) {
    weight = 0.35; // Saved but not watched yet: interested.
  } else {
    weight = 0; // Removed without watching.
  }

  const recency = 0.3 + 0.7 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return { weight: weight * recency, lastWatched, engagement, watchedMs };
}

// Library items Stremio can play from IMDb or TMDB ids, grouped and scored.
export async function analyzeLibrary(authKey) {
  const items = await getLibrary(authKey);
  const now = Date.now();
  const seen = new Set();
  const byType = { movie: [], series: [] };

  for (const item of items) {
    if (!item?._id) continue;
    const rawId = item._id.split(':')[0];
    const fullId = item._id.startsWith('tmdb:') ? item._id : rawId;
    seen.add(fullId);
    if (fullId.startsWith('tt')) seen.add(fullId);
    const isImdb = fullId.startsWith('tt');
    const isTmdb = fullId.startsWith('tmdb:');
    if ((!isImdb && !isTmdb) || !(item.type in byType)) continue;
    byType[item.type].push({
      id: fullId,
      imdbId: isImdb ? fullId : null,
      name: item.name,
      type: item.type,
      videoId: item.state?.video_id, // Last watched episode, e.g. "tt0903747:2:13".
      ...interest(item, now),
    });
  }

  for (const list of Object.values(byType)) list.sort((a, b) => b.weight - a.weight);
  return { seen, byType };
}

// Most recently watched titles with real engagement, for "Because you watched" and "Storyline Match" rows.
export function recentSeeds(analysis, type, count) {
  const minEngagement = type === 'movie' ? 0.7 : 0.25;
  return (analysis.byType[type] || [])
    .filter((s) => s.lastWatched && (s.engagement >= minEngagement || (type === 'movie' && (s.watchedMs || 0) >= 60 * 60 * 1000)))
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .slice(0, count);
}

const ALL_INDIAN_LANGS = new Set(['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'pa', 'gu', 'ur', 'or', 'as']);
const DEFAULT_INDIAN_LANGS = ['ml', 'ta', 'hi'];

function bayesianRating(c, allowedIndian) {
  const v = c.vote_count || 0;
  const isIndian = allowedIndian.has(c.original_language);
  // Hollywood titles on TMDB have thousands of votes, whereas acclaimed Indian
  // films typically have 30-300 votes. An m of 30 prevents crushing Indian titles.
  const m = isIndian ? 30 : 200;
  const C = 6.5;
  return (v * (c.vote_average || 0) + m * C) / (v + m);
}

function isUsable(c, date, allowedIndian) {
  if (c.adult) return false;
  // If this title is an Indian film, strictly check if it's in the user's allowed Indian languages:
  if (ALL_INDIAN_LANGS.has(c.original_language)) {
    if (!allowedIndian.has(c.original_language)) return false;
    if ((c.vote_count || 0) < 8) return false;
  } else if ((c.vote_count || 0) < MIN_VOTES) {
    return false;
  }
  const released = c.release_date || c.first_air_date;
  return Boolean(released) && released <= date; // Skip unreleased titles: no streams yet.
}

async function scoreCandidates(tmdb, seeds, type, indianLangs = DEFAULT_INDIAN_LANGS) {
  const allowedIndian = new Set(indianLangs);
  const kind = tmdbKind(type);
  const date = today();
  const candidates = new Map();
  const seedTmdbIds = new Set();

  const resolved = await mapLimit(seeds, 6, async (seed) => {
    const idToFind = seed.id || seed.imdbId;
    const found = tmdb.findItem
      ? await tmdb.findItem(idToFind, type).catch(() => null)
      : await tmdb.findByImdb(idToFind, type).catch(() => null);
    return found && {
      ...seed,
      tmdbId: found.tmdbId,
      original_language: found.original_language,
      genre_ids: found.genre_ids || [],
    };
  });
  const usableSeeds = resolved.filter(Boolean);
  for (const seed of usableSeeds) seedTmdbIds.add(seed.tmdbId);

  await mapLimit(usableSeeds, 6, async (seed) => {
    const { recommendations, similar } = await tmdb.related(kind, seed.tmdbId).catch(() => ({ recommendations: [], similar: [] }));
    const lists = [
      [recommendations, 1.0],
      [similar, 0.4],
    ];

    const isIndianSeed = ALL_INDIAN_LANGS.has(seed.original_language);
    // Only discover if seed is one of the user's allowed Indian languages:
    if (isIndianSeed && allowedIndian.has(seed.original_language) && tmdb.discoverByLanguage) {
      const discovered = await tmdb.discoverByLanguage(kind, seed.original_language, seed.genre_ids).catch(() => []);
      if (discovered?.length) {
        lists.push([discovered, 1.3]);
      }
    }

    for (const [list, listWeight] of lists) {
      list.forEach((c, rank) => {
        if (!isUsable(c, date, allowedIndian)) return;

        let langFactor = 1.0;
        const isCandidateIndian = allowedIndian.has(c.original_language);
        if (isIndianSeed && allowedIndian.has(seed.original_language)) {
          if (c.original_language === seed.original_language) {
            langFactor = 2.2; // Same Indian language (e.g. Malayalam -> Malayalam)
          } else if (isCandidateIndian) {
            langFactor = 1.3; // Across user's allowed Indian cinema (e.g. Tamil, Hindi, Malayalam)
          } else {
            langFactor = 0.2; // Suppress unrelated Western titles TMDB misattributed
          }
        } else if (seed.original_language && c.original_language === seed.original_language) {
          langFactor = 1.2;
        }

        const contribution = seed.weight * listWeight * langFactor * Math.max(0.2, 1 - rank / 25);
        let entry = candidates.get(c.id);
        if (!entry) {
          entry = { tmdb: c, score: 0, because: new Map() };
          candidates.set(c.id, entry);
        }
        entry.score += contribution;
        const prev = entry.because.get(seed.imdbId);
        entry.because.set(seed.imdbId, { seed, weight: (prev?.weight || 0) + contribution });
      });
    }
  });

  return [...candidates.values()]
    .filter((e) => !seedTmdbIds.has(e.tmdb.id))
    .map((e) => ({
      ...e,
      score: e.score * (0.5 + 0.5 * (bayesianRating(e.tmdb, allowedIndian) / 10)),
      because: [...e.because.values()].sort((a, b) => b.weight - a.weight).map(({ seed }) => seed),
    }))
    .sort((a, b) => b.score - a.score);
}

// --- pools: ranked candidate lists, one per row --------------------------------
// Each returns { ranked: [entry], seen: Set<imdbId> }. An entry has the TMDB
// list item (`tmdb`), and optionally `imdbId`, `reasons`, `releaseInfo` and
// `allowSeen` (show it even though it's in your library).

// Main ranking. `seedImdbId` narrows it to one title ("Because you watched X").
function rankedPool(tmdb, authKey, type, seedImdbId, indianLangs = DEFAULT_INDIAN_LANGS) {
  return poolCache.wrap(`${authKey}|${type}|${seedImdbId || '*'}|${indianLangs.join()}`, async () => {
    const analysis = await analyzeLibrary(authKey).catch(() => ({ seen: new Set(), byType: { movie: [], series: [] } }));
    const all = analysis.byType[type] || [];
    let seeds;
    if (seedImdbId) {
      seeds = all.filter((s) => s.imdbId === seedImdbId || s.id === seedImdbId).map((s) => ({ ...s, weight: 1 }));
      if (seeds.length === 0) {
        seeds = [{ id: seedImdbId, imdbId: seedImdbId.startsWith('tt') ? seedImdbId : null, weight: 1 }];
      }
    } else {
      seeds = all.filter((s) => s.weight > 0.1).slice(0, MAX_SEEDS);
    }
    return { ranked: await scoreCandidates(tmdb, seeds, type, indianLangs), seen: analysis.seen };
  });
}

const byReleaseDate = (a, b) => (a.release_date || '').localeCompare(b.release_date || '');

// The earliest part you haven't seen of each film series you've finished a
// movie from, most recently watched first.
async function nextMovies(tmdb, finished, seen, indianLangs = DEFAULT_INDIAN_LANGS) {
  const allowedIndian = new Set(indianLangs);
  const date = today();
  const resolved = await mapLimit(finished, 6, async (seed) => {
    const found = await tmdb.findByImdb(seed.imdbId, 'movie').catch(() => null);
    const details = found && (await tmdb.details('movie', found.tmdbId).catch(() => null));
    return details && { seed, tmdbId: found.tmdbId, collectionId: details.belongs_to_collection?.id };
  });
  const finishedTmdbIds = new Set(resolved.filter(Boolean).map((r) => r.tmdbId));
  const collections = new Map();
  for (const r of resolved) if (r?.collectionId && !collections.has(r.collectionId)) collections.set(r.collectionId, r.seed);

  const entries = await mapLimit([...collections], 6, async ([collectionId, seed]) => {
    const collection = await tmdb.collection(collectionId).catch(() => null);
    const parts = (collection?.parts || []).filter((p) => p.release_date && p.release_date <= date).sort(byReleaseDate);
    for (const part of parts) {
      if (finishedTmdbIds.has(part.id)) continue;
      if (ALL_INDIAN_LANGS.has(part.original_language) && !allowedIndian.has(part.original_language)) continue;
      const details = await tmdb.details('movie', part.id).catch(() => null);
      if (!details?.imdbId || seen.has(details.imdbId)) continue;
      return {
        tmdb: part,
        imdbId: details.imdbId,
        reasons: [{ category: 'Next after', name: seed.name, url: detailLink('movie', seed.imdbId) }],
      };
    }
    return null;
  });
  return entries.filter(Boolean);
}

function parseVideoId(videoId) {
  const m = /^tt\d+:(\d+):(\d+)$/.exec(videoId || '');
  return m && { season: Number(m[1]), episode: Number(m[2]) };
}

// Shows where you watched a season to the end and the next season is out,
// newest season first.
async function newSeasons(tmdb, watched) {
  const date = today();
  const entries = await mapLimit(watched, 6, async (seed) => {
    const progress = parseVideoId(seed.videoId);
    if (!progress) return null;
    const found = await tmdb.findByImdb(seed.imdbId, 'series').catch(() => null);
    const show = found && (await tmdb.details('tv', found.tmdbId).catch(() => null));
    const seasons = (show?.seasons || []).filter((s) => s.season_number > 0);
    const current = seasons.find((s) => s.season_number === progress.season);
    const next = seasons.find((s) => s.season_number === progress.season + 1);
    if (!current || progress.episode < current.episode_count) return null; // Season not finished.
    if (!next?.air_date || next.air_date > date) return null; // No new season out yet.
    return {
      tmdb: { ...show, genre_ids: (show.genres || []).map((g) => g.id) },
      imdbId: seed.imdbId,
      allowSeen: true,
      releaseInfo: `Season ${next.season_number}`,
      airDate: next.air_date,
      reasons: [{ category: 'You finished', name: `Season ${progress.season}`, url: detailLink('series', seed.imdbId) }],
    };
  });
  return entries.filter(Boolean).sort((a, b) => b.airDate.localeCompare(a.airDate));
}

function finishStoryPool(tmdb, authKey, type, indianLangs = DEFAULT_INDIAN_LANGS) {
  return poolCache.wrap(`${authKey}|${type}|next|${indianLangs.join()}`, async () => {
    const analysis = await analyzeLibrary(authKey);
    const recent = analysis.byType[type]
      .filter((s) => s.lastWatched)
      .sort((a, b) => b.lastWatched - a.lastWatched);
    const ranked = type === 'movie'
      ? await nextMovies(tmdb, recent.filter((s) => s.engagement >= 0.9).slice(0, 60), analysis.seen, indianLangs)
      : await newSeasons(tmdb, recent.slice(0, 40));
    return { ranked, seen: analysis.seen };
  });
}

// --- metas -----------------------------------------------------------------------

// Stremio deep links (formats from stremio-core's deep_links module).
const detailLink = (type, id) => `stremio:///detail/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
const discoverLink = (manifestUrl, type, catalogId, genre) =>
  `stremio:///discover/${encodeURIComponent(manifestUrl)}/${type}/${catalogId}?genre=${encodeURIComponent(genre)}`;

const becauseReasons = (entry) =>
  (entry.because || []).slice(0, 2).map((seed) => ({
    category: 'Because you watched',
    name: seed.name,
    url: detailLink(seed.type, seed.imdbId),
  }));

export function resolvePoster(posterPath, imdbId, manifestUrl, fallbackScore, ratingBadges = true) {
  if (!posterPath) return undefined;
  if (!ratingBadges || !imdbId || !String(imdbId).startsWith('tt')) {
    return poster(posterPath);
  }
  try {
    const origin = new URL(manifestUrl).origin;
    const cleanScore = fallbackScore ? Number(fallbackScore).toFixed(1) : '0';
    const cleanPath = posterPath.startsWith('/') ? posterPath : `/${posterPath}`;
    return `${origin}/poster/${imdbId}/${cleanScore}${cleanPath}`;
  } catch {
    return poster(posterPath);
  }
}

function toMeta(entry, type, imdbId, genreNames, manifestUrl, reasons, ratingBadges = true) {
  const c = entry.tmdb;
  const date = c.release_date || c.first_air_date || '';
  const genres = (c.genre_ids || []).map((id) => genreNames.get(id)).filter(Boolean);

  // Reasons and genres show as chip groups under the description. Once an item
  // has `links`, Stremio ignores `genres`, so genres are sent as links too:
  // they open "Recommended for You" filtered to that genre.
  const links = [
    ...reasons,
    ...genres.map((genre) => ({ name: genre, category: 'Genres', url: discoverLink(manifestUrl, type, 'foryou', genre) })),
  ];

  return {
    id: imdbId,
    type,
    name: c.title || c.name,
    poster: resolvePoster(c.poster_path, imdbId, manifestUrl, c.vote_average, ratingBadges),
    background: backdrop(c.backdrop_path),
    description: c.overview || '',
    releaseInfo: entry.releaseInfo || date.slice(0, 4),
    imdbRating: c.vote_average ? Number(c.vote_average).toFixed(1) : undefined,
    genres,
    links,
  };
}

const keepers = {
  short: (d) => d?.runtime > 0 && d.runtime <= SHORT_MOVIE_MINUTES,
  weekend: (d) => d?.number_of_seasons === 1
    && d.number_of_episodes > 0 && d.number_of_episodes <= WEEKEND_MAX_EPISODES
    && ['Ended', 'Canceled'].includes(d.status),
};

const LANG_NAME_TO_CODE = {
  malayalam: 'ml',
  tamil: 'ta',
  hindi: 'hi',
  telugu: 'te',
  kannada: 'kn',
  marathi: 'mr',
  bengali: 'bn',
};

const sessionServedTitles = new TTLCache(10 * 60 * 1000, 500);

export async function aiStorylineMetas(tmdb, authKey, seedId, indianLangs = DEFAULT_INDIAN_LANGS, manifestUrl, ratingBadges = true) {
  const seed = tmdb.findItem
    ? await tmdb.findItem(seedId, 'movie').catch(() => null)
    : await tmdb.findByImdb(seedId, 'movie').catch(() => null);
  if (!seed) return [];

  const allowedIndian = new Set(indianLangs);
  const isIndianSeed = ALL_INDIAN_LANGS.has(seed.original_language);
  const genreNames = await tmdb.genres('movie').catch(() => new Map());
  const seedGenreNames = (seed.genre_ids || []).map((gid) => genreNames.get(gid)).filter(Boolean);

  const aiRecs = await getAiStorylineRecommendations({
    title: seed.title || seed.name,
    overview: seed.overview,
    releaseDate: seed.release_date,
    originalLanguage: seed.original_language,
    genres: seedGenreNames.join(', '),
    allowedIndianLangs: indianLangs,
  }).catch(() => []);

  const analysis = await analyzeLibrary(authKey).catch(() => ({ seen: new Set(), byType: { movie: [], series: [] } }));
  const metas = [];

  const seedGenreSet = new Set(seed.genre_ids || []);
  const isHorror = seedGenreSet.has(27);
  const isComedy = seedGenreSet.has(35) && !seedGenreSet.has(27) && !seedGenreSet.has(53) && !seedGenreSet.has(80);

  if (aiRecs && aiRecs.length > 0) {
    for (const rec of aiRecs) {
      try {
        const langCode = LANG_NAME_TO_CODE[rec.language?.toLowerCase()] || (isIndianSeed ? seed.original_language : undefined);
        const hit = await tmdb.searchMovie(rec.title, rec.year, langCode).catch(() => null);
        if (!hit) continue;

        // If seed is an Indian movie, strictly reject candidates not in allowed Indian cinema:
        if (isIndianSeed && (!allowedIndian.has(hit.original_language) || !ALL_INDIAN_LANGS.has(hit.original_language))) continue;

        const details = await tmdb.details('movie', hit.id).catch(() => null);
        const hitGenreSet = new Set(hit.genre_ids || (details?.genres || []).map((g) => g.id));

        // Strict Genre Guardrail:
        // Horror movies MUST only recommend Horror (27), Mystery (9648), Thriller (53), or Fantasy (14).
        // Blocks absurd cross-genre hallucinations (e.g. Kadaisi Vivasayi into Horror rows).
        if (isHorror && !hitGenreSet.has(27) && !hitGenreSet.has(9648) && !hitGenreSet.has(53) && !hitGenreSet.has(14)) {
          continue;
        }
        if (isComedy && !hitGenreSet.has(35) && !hitGenreSet.has(18) && !hitGenreSet.has(10749)) {
          continue;
        }

        const imdbId = details?.imdbId;
        const id = imdbId || `tmdb:${hit.id}`;
        if (analysis.seen.has(id) || (imdbId && analysis.seen.has(imdbId))) continue;

        const date = hit.release_date || '';
        const genres = (hit.genre_ids || []).map((gid) => genreNames.get(gid)).filter(Boolean);
        const links = [
          { category: 'Storyline Match', name: rec.reason, url: detailLink('movie', seedId) },
          ...genres.map((g) => ({ name: g, category: 'Genres', url: discoverLink(manifestUrl, 'movie', 'foryou', g) })),
        ];

        metas.push({
          id,
          type: 'movie',
          name: hit.title,
          poster: resolvePoster(hit.poster_path, imdbId, manifestUrl, hit.vote_average || details?.vote_average, ratingBadges),
          background: backdrop(hit.backdrop_path),
          description: hit.overview || rec.reason || '',
          releaseInfo: date.slice(0, 4),
          imdbRating: (hit.vote_average || details?.vote_average) ? Number(hit.vote_average || details?.vote_average).toFixed(1) : undefined,
          genres,
          links,
        });
      } catch (e) {
        // skip on error
      }
    }
  }

  // Guaranteed fallback: If AI didn't yield enough metas, discover movies matching seed's language and genres
  if (metas.length < 5 && tmdb.discoverByLanguage && seed.original_language) {
    const discovered = await tmdb.discoverByLanguage('movie', seed.original_language, seed.genre_ids).catch(() => []);
    for (const hit of discovered) {
      if (hit.id === seed.tmdbId) continue;
      const id = `tmdb:${hit.id}`;
      if (analysis.seen.has(id)) continue;
      if (metas.some((m) => m.name === hit.title)) continue;
      const details = await tmdb.details('movie', hit.id).catch(() => null);
      const imdbId = details?.imdbId;
      const finalId = imdbId || id;
      if (imdbId && analysis.seen.has(imdbId)) continue;

      const date = hit.release_date || '';
      const genres = (hit.genre_ids || []).map((gid) => genreNames.get(gid)).filter(Boolean);
      const links = [
        { category: 'Because you watched', name: seed.title || seed.name, url: detailLink('movie', seedId) },
        ...genres.map((g) => ({ name: g, category: 'Genres', url: discoverLink(manifestUrl, 'movie', 'foryou', g) })),
      ];

      metas.push({
        id: finalId,
        type: 'movie',
        name: hit.title,
        poster: resolvePoster(hit.poster_path, imdbId, manifestUrl, hit.vote_average || details?.vote_average, ratingBadges),
        background: backdrop(hit.backdrop_path),
        description: hit.overview || '',
        releaseInfo: date.slice(0, 4),
        imdbRating: (hit.vote_average || details?.vote_average) ? Number(hit.vote_average || details?.vote_average).toFixed(1) : undefined,
        genres,
        links,
      });
      if (metas.length >= 15) break;
    }
  }

  // Cross-row diversity: prioritize fresh titles that haven't been shown in other rows during this session
  const servedSet = sessionServedTitles.get(authKey) || new Set();
  const fresh = [];
  const repeated = [];
  for (const m of metas) {
    if (servedSet.has(m.id) || servedSet.has(m.name)) repeated.push(m);
    else fresh.push(m);
  }
  const ordered = [...fresh, ...repeated];
  const newServed = new Set(servedSet);
  for (const m of ordered.slice(0, 8)) {
    newServed.add(m.id);
    newServed.add(m.name);
  }
  sessionServedTitles.set(authKey, newServed);
  return ordered;
}

export async function aiProfileMetas(tmdb, authKey, indianLangs = DEFAULT_INDIAN_LANGS, manifestUrl, ratingBadges = true) {
  const analysis = await analyzeLibrary(authKey).catch(() => ({ seen: new Set(), byType: { movie: [], series: [] } }));
  const topMovies = recentSeeds(analysis, 'movie', 8);

  if (topMovies.length === 0) return [];

  const resolved = await mapLimit(topMovies, 6, async (m) => {
    const idToFind = m.id || m.imdbId;
    const found = tmdb.findItem
      ? await tmdb.findItem(idToFind, 'movie').catch(() => null)
      : await tmdb.findByImdb(idToFind, 'movie').catch(() => null);
    return found ? {
      title: found.title || m.name,
      releaseDate: found.release_date,
      originalLanguage: found.original_language,
      overview: found.overview,
    } : null;
  });

  const watchedMovies = resolved.filter(Boolean);
  if (watchedMovies.length === 0) return [];

  const aiRecs = await getAiProfileRecommendations({
    watchedMovies,
    allowedIndianLangs: indianLangs,
  }).catch(() => []);

  if (!aiRecs || aiRecs.length === 0) return [];

  const allowedIndian = new Set(indianLangs);
  const genreNames = await tmdb.genres('movie').catch(() => new Map());
  const metas = [];

  for (const rec of aiRecs) {
    try {
      const langCode = LANG_NAME_TO_CODE[rec.language?.toLowerCase()];
      const hit = await tmdb.searchMovie(rec.title, rec.year, langCode).catch(() => null);
      if (!hit) continue;

      if (ALL_INDIAN_LANGS.has(hit.original_language) && !allowedIndian.has(hit.original_language)) continue;

      const details = await tmdb.details('movie', hit.id).catch(() => null);
      const imdbId = details?.imdbId;
      const id = imdbId || `tmdb:${hit.id}`;
      if (analysis.seen.has(id) || (imdbId && analysis.seen.has(imdbId))) continue;

      const date = hit.release_date || '';
      const genres = (hit.genre_ids || []).map((gid) => genreNames.get(gid)).filter(Boolean);
      const links = [
        { category: 'AI Taste Match', name: rec.reason, url: manifestUrl },
        ...genres.map((g) => ({ name: g, category: 'Genres', url: discoverLink(manifestUrl, 'movie', 'foryou', g) })),
      ];

      metas.push({
        id,
        type: 'movie',
        name: hit.title,
        poster: resolvePoster(hit.poster_path, imdbId, manifestUrl, hit.vote_average || details?.vote_average, ratingBadges),
        background: backdrop(hit.backdrop_path),
        description: hit.overview || rec.reason || '',
        releaseInfo: date.slice(0, 4),
        imdbRating: (hit.vote_average || details?.vote_average) ? Number(hit.vote_average || details?.vote_average).toFixed(1) : undefined,
        genres,
        links,
      });
    } catch (e) {
      // skip on error
    }
  }

  // Cross-row diversity: prioritize fresh titles
  const servedSet = sessionServedTitles.get(authKey) || new Set();
  const fresh = [];
  const repeated = [];
  for (const m of metas) {
    if (servedSet.has(m.id) || servedSet.has(m.name)) repeated.push(m);
    else fresh.push(m);
  }
  const ordered = [...fresh, ...repeated];
  const newServed = new Set(servedSet);
  for (const m of ordered.slice(0, 8)) {
    newServed.add(m.id);
    newServed.add(m.name);
  }
  sessionServedTitles.set(authKey, newServed);
  return ordered;
}

// One page of a row as Stremio metas.
//   row: 'foryou' | 'byw' | 'ai' | 'next' | 'short' | 'weekend'
export async function catalogPage(tmdb, authKey, {
  row, type, seedImdbId, genre, skip = 0, pageSize = 40, manifestUrl, indianLangs = DEFAULT_INDIAN_LANGS, ratingBadges = true,
}) {
  const kind = tmdbKind(type);

  if (row === 'foryou' && type === 'movie') {
    const aiMetas = await aiProfileMetas(tmdb, authKey, indianLangs, manifestUrl, ratingBadges);
    if (aiMetas.length > 0) {
      const pool = genre
        ? aiMetas.filter((m) => (m.genres || []).includes(genre))
        : aiMetas;
      return pool.slice(skip, skip + pageSize);
    }
  }

  if (row === 'ai') {
    const aiMetas = await aiStorylineMetas(tmdb, authKey, seedImdbId, indianLangs, manifestUrl, ratingBadges);
    if (aiMetas.length > 0) return aiMetas.slice(skip, skip + pageSize);
    // If AI is offline/empty, fallback gracefully to seed-based rankedPool
    const { ranked, seen } = await rankedPool(tmdb, authKey, 'movie', seedImdbId, indianLangs);
    const genreNames = await tmdb.genres(kind).catch(() => new Map());
    const metas = [];
    const wanted = skip + pageSize;
    let produced = 0;
    for (let i = 0; i < ranked.length && produced < wanted; i += 10) {
      const batch = ranked.slice(i, i + 10);
      const details = await mapLimit(batch, 10, (e) => tmdb.details(kind, e.tmdb.id).catch(() => null));
      batch.forEach((entry, j) => {
        const imdbId = entry.imdbId || details[j]?.imdbId;
        if (!imdbId || produced >= wanted) return;
        if (!entry.allowSeen && seen.has(imdbId)) return;
        if (produced++ >= skip) metas.push(toMeta(entry, type, imdbId, genreNames, manifestUrl, entry.reasons || becauseReasons(entry), ratingBadges));
      });
    }
    return metas;
  }

  const { ranked, seen } = row === 'next'
    ? await finishStoryPool(tmdb, authKey, type, indianLangs)
    : await rankedPool(tmdb, authKey, type, row === 'byw' ? seedImdbId : undefined, indianLangs);
  const genreNames = await tmdb.genres(kind).catch(() => new Map());
  const keep = keepers[row];
  const reasonsFor = (entry) => (row === 'byw' ? [] : entry.reasons || becauseReasons(entry));

  const pool = genre
    ? ranked.filter((e) => (e.tmdb.genre_ids || []).some((id) => genreNames.get(id) === genre))
    : ranked;

  // Look up details (IMDb id, runtime, seasons) lazily, only as far as this page needs.
  const metas = [];
  const wanted = skip + pageSize;
  let produced = 0;
  for (let i = 0; i < pool.length && produced < wanted; i += 10) {
    const batch = pool.slice(i, i + 10);
    const details = await mapLimit(batch, 10, (e) =>
      (e.imdbId && !keep ? null : tmdb.details(kind, e.tmdb.id).catch(() => null)));
    batch.forEach((entry, j) => {
      const imdbId = entry.imdbId || details[j]?.imdbId;
      if (!imdbId || produced >= wanted) return;
      if (!entry.allowSeen && seen.has(imdbId)) return;
      if (keep && !keep(details[j])) return;
      if (produced++ >= skip) metas.push(toMeta(entry, type, imdbId, genreNames, manifestUrl, reasonsFor(entry), ratingBadges));
    });
  }
  return metas;
}
