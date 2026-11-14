// AI-powered Storyline & Narrative Analysis using Google Gemini Flash
import { persistentAiCache } from './persistent_cache.js';

const aiCache = persistentAiCache;

// Throttled semaphore to prevent burst rate-limits from parallel Stremio requests
const MAX_CONCURRENT = 1;
let inFlight = 0;
const queue = [];

async function throttled(fn) {
  if (inFlight >= MAX_CONCURRENT) {
    await new Promise((resolve) => queue.push(resolve));
  } else {
    inFlight++;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else inFlight--;
  }
}

const INDIAN_LANG_MAP = {
  ml: 'Malayalam',
  ta: 'Tamil',
  hi: 'Hindi',
  te: 'Telugu',
  kn: 'Kannada',
  mr: 'Marathi',
  bn: 'Bengali',
  pa: 'Punjabi',
};

export async function getAiStorylineRecommendations({
  title,
  overview,
  releaseDate,
  originalLanguage,
  allowedIndianLangs = ['ml', 'ta', 'hi'],
  apiKey = process.env.GEMINI_API_KEY,
}) {
  if (!apiKey) return [];

  const cacheKey = `${title}|${releaseDate || ''}|${originalLanguage}|${allowedIndianLangs.sort().join()}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  return throttled(async () => {
    // Re-check cache after queue wait
    const hit = aiCache.get(cacheKey);
    if (hit && Array.isArray(hit) && hit.length > 0) return hit;

    const isIndian = ['hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'pa', 'gu', 'ur'].includes(originalLanguage);
    const allowedNames = allowedIndianLangs.map((c) => INDIAN_LANG_MAP[c] || c).join(', ');

    let prompt;
    if (isIndian) {
      prompt = `The user recently watched the Indian movie "${title}" (${releaseDate?.slice(0, 4) || ''}).
Synopsis: ${overview || 'A prominent Indian film.'}

As a cinema expert, analyze what makes "${title}" unique in its specific plot premise, subgenre, conflicts, and storytelling tone.
Recommend 12-15 distinct, high-quality movies in ${allowedNames} that share this specific narrative formula and storyline vibe.

Strict guidelines:
1. ONLY recommend movies in ${allowedNames}.
2. CRITICAL - DIVERSITY & FRESHNESS: Avoid repeatedly suggesting the same generic all-time blockbusters (such as Drishyam, Ratsasan, Talvar) unless their core premise is an undeniable 1-to-1 match. Actively delve into acclaimed gems, cult classics, and memorable films from 2010 to 2025 across Malayalam, Tamil, and Hindi cinema.
3. SPECIFIC SUBGENRE ALIGNMENT:
   - If "${title}" is a family drama/emotional story, recommend heartfelt family/relationship dramas (NOT murder thrillers).
   - If "${title}" is a crime/investigation, recommend distinct investigative films matching that specific angle (e.g. courtroom, police procedural, or gangster noir).
   - If "${title}" is a comedy or satire, recommend smart comedies or satires.
   - If "${title}" is an action or revenge thriller, recommend gritty action or revenge thrillers.
4. Exclude "${title}" itself.

Respond ONLY with a valid JSON array matching this exact schema:
[
  {
    "title": "Movie Title",
    "year": 2023,
    "language": "Language",
    "reason": "1 short sentence explaining why the storyline and narrative style matches."
  }
]`;
    } else {
      prompt = `The user recently watched the film "${title}" (${releaseDate?.slice(0, 4) || ''}).
Synopsis: ${overview || 'A prominent film.'}

As a cinema expert, recommend 12-15 distinct, high-quality movies (in English or acclaimed international cinema) that share the exact narrative DNA, screenplay complexity, or storytelling tone as "${title}".
Strict constraints:
1. Focus on the actual storyline mechanics, character arcs, and screenplay mood.
2. Ensure diverse and fresh recommendations rather than generic mainstream titles.
3. Exclude "${title}" itself.

Respond ONLY with a valid JSON array matching this exact schema:
[
  {
    "title": "Movie Title",
    "year": 2023,
    "language": "Language",
    "reason": "1 short sentence explaining why the storyline and narrative style matches."
  }
]`;
    }

    const models = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'];
    for (const model of models) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.7,
            },
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          console.error(`Gemini model ${model} HTTP ${res.status}:`, errText);
          continue;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) continue;
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          aiCache.set(cacheKey, parsed);
          return parsed;
        }
      } catch (err) {
        console.error(`Gemini model ${model} error:`, err.message);
      }
    }
    return [];
  });
}

export async function getAiProfileRecommendations({
  watchedMovies,
  allowedIndianLangs = ['ml', 'ta', 'hi'],
  apiKey = process.env.GEMINI_API_KEY,
}) {
  if (!apiKey || !watchedMovies?.length) return [];

  const moviesSummary = watchedMovies
    .map((m, i) => `${i + 1}. "${m.title}" (${m.releaseDate?.slice(0, 4) || ''}, ${INDIAN_LANG_MAP[m.originalLanguage] || m.originalLanguage || 'Film'}): ${m.overview || ''}`)
    .join('\n');

  const cacheKey = `profile|${watchedMovies.map((m) => m.title).sort().join('|')}|${allowedIndianLangs.sort().join()}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  return throttled(async () => {
    // Re-check cache after queue wait
    const hit = aiCache.get(cacheKey);
    if (hit && Array.isArray(hit) && hit.length > 0) return hit;

    const allowedNames = allowedIndianLangs.map((c) => INDIAN_LANG_MAP[c] || c).join(', ');

    const prompt = `The user has watched and enjoyed the following movies in their library:
${moviesSummary}

As a cinema expert, analyze this user's overarching cinematic taste, preferred narrative depth, pacing, and storytelling atmosphere.
Recommend 25-30 outstanding movies that perfectly match this taste profile.

Strict constraints:
1. For Indian cinema, ONLY recommend movies in ${allowedNames}. Do not recommend movies in any other Indian language.
2. If the user's history includes English or international movies, you may also include acclaimed English or international thrillers/dramas matching this exact storytelling depth.
3. Do not recommend any of the movies listed in their watched list above.
4. Ensure variety across the recommended titles while keeping the storytelling quality and narrative intrigue extremely high.

Respond ONLY with a valid JSON array matching this exact schema:
[
  {
    "title": "Movie Title",
    "year": 2023,
    "language": "Language",
    "reason": "1 short sentence explaining why this matches their taste profile."
  }
]`;

    const models = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'];
    for (const model of models) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(25000),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.7,
            },
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          console.error(`Gemini profile model ${model} HTTP ${res.status}:`, errText);
          continue;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) continue;
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          aiCache.set(cacheKey, parsed);
          return parsed;
        }
      } catch (err) {
        console.error(`Gemini profile model ${model} error:`, err.message);
      }
    }
    return [];
  });
}
