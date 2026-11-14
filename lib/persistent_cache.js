// Persistent JSON-backed disk cache for AI recommendations
// Keeps recommendations locked and consistent across Stremio restarts, server reboots, and updates.
import fs from 'node:fs';
import path from 'node:path';

export class PersistentCache {
  constructor(filePath = path.join(process.cwd(), 'data', 'ai_cache.json')) {
    this.filePath = filePath;
    this.memory = new Map();
    this.saveTimer = null;
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            if (Array.isArray(v) && v.length > 0) {
              this.memory.set(k, v);
            }
          }
        }
      }
    } catch (err) {
      console.error('Could not load persistent AI cache from disk:', err.message);
    }
  }

  get(key) {
    return this.memory.get(key);
  }

  set(key, value) {
    if (!Array.isArray(value) || value.length === 0) return;
    this.memory.set(key, value);
    this._scheduleSave();
  }

  has(key) {
    return this.memory.has(key);
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          await fs.promises.mkdir(dir, { recursive: true });
        }
        const obj = Object.fromEntries(this.memory);
        const tempPath = `${this.filePath}.tmp.${Date.now()}`;
        await fs.promises.writeFile(tempPath, JSON.stringify(obj, null, 2), 'utf8');
        await fs.promises.rename(tempPath, this.filePath);
      } catch (err) {
        console.error('Could not save persistent AI cache to disk:', err.message);
      }
    }, 200);
  }
}

export const persistentAiCache = new PersistentCache();
