// Talks to the Stremio account API (the same API the official apps use).
import { TTLCache } from './cache.js';

const API = 'https://api.strem.io/api';
const libraryCache = new TTLCache(2 * 60 * 1000, 200);

export function clearLibraryCache(authKey) {
  if (authKey) libraryCache.delete(authKey);
  else libraryCache.clear();
}

async function call(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Stremio API ${method} failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Stremio API ${method}: ${data.error.message || JSON.stringify(data.error)}`);
  return data.result;
}

// Moves an installed addon to the front of the account's addon list and syncs
// its manifest so newly watched movies reflect on the Home screen.
export async function moveAddonToTop(authKey, addonId, newManifest = null, moveToTop = true) {
  const { addons } = await call('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
  const before = addons.map((a) => a.manifest?.id);
  const index = before.indexOf(addonId);
  if (index === -1) return { found: false, moved: false, before };

  let changed = false;
  if (moveToTop && index > 0) {
    addons.unshift(...addons.splice(index, 1));
    changed = true;
  }

  // Auto-sync manifest if catalogs have changed (newly watched movies)
  const currentAddon = addons[moveToTop && index > 0 ? 0 : index];
  if (newManifest && currentAddon) {
    const oldCatalogs = JSON.stringify(currentAddon.manifest?.catalogs || []);
    const nextCatalogs = JSON.stringify(newManifest.catalogs || []);
    if (oldCatalogs !== nextCatalogs) {
      currentAddon.manifest = newManifest;
      changed = true;
    }
  }

  if (changed) {
    await call('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons });
  }
  return { found: true, moved: moveToTop && index > 0, changed, before };
}

// Returns every library item, including watch-history-only items
// (Stremio keeps those as `temp: true`) and removed ones.
export function getLibrary(authKey) {
  return libraryCache.wrap(authKey, () =>
    call('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true }),
  );
}
