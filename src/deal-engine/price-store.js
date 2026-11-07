import fs from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, summarizeHistory } from './price-intelligence.js';

const EMPTY = {
  version: 1,
  snapshots: {},
  publications: [],
  cycleReports: []
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PriceHistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.bakPath = `${filePath}.bak`;
    this.lockPath = `${filePath}.lock`;
    this.queue = Promise.resolve();
  }

  static fromConfig(config) {
    const dir = config?.dataDir || path.resolve('data');
    return new PriceHistoryStore(path.join(dir, 'price-history.json'));
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.#writeUnlocked(structuredClone(EMPTY));
    }
  }

  async read() {
    return this.#enqueue(async () => this.#readUnlocked());
  }

  async #enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #readUnlocked() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return this.#normalize(JSON.parse(raw));
    } catch {
      try {
        const raw = await fs.readFile(this.bakPath, 'utf8');
        const data = this.#normalize(JSON.parse(raw));
        await this.#writeUnlocked(data);
        return data;
      } catch {
        const fresh = structuredClone(EMPTY);
        await this.#writeUnlocked(fresh);
        return fresh;
      }
    }
  }

  #normalize(data) {
    if (!data || typeof data !== 'object') return structuredClone(EMPTY);
    return {
      version: 1,
      snapshots: data.snapshots && typeof data.snapshots === 'object' ? data.snapshots : {},
      publications: Array.isArray(data.publications) ? data.publications : [],
      cycleReports: Array.isArray(data.cycleReports) ? data.cycleReports : []
    };
  }

  async #writeUnlocked(data) {
    const json = `${JSON.stringify(data)}\n`;
    const started = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        try {
          await fs.writeFile(this.tmpPath, json, 'utf8');
          try {
            await fs.copyFile(this.filePath, this.bakPath);
          } catch {
            // first write
          }
          await fs.rename(this.tmpPath, this.filePath);
        } finally {
          await handle.close();
          await fs.unlink(this.lockPath).catch(() => undefined);
        }
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (Date.now() - started > 8000) {
          await fs.unlink(this.lockPath).catch(() => undefined);
          throw new Error('Tempo esgotado ao gravar o histórico de preços.');
        }
        await wait(40);
      }
    }
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      const current = await this.#readUnlocked();
      const next = await mutator(current);
      const payload = next ?? current;
      await this.#writeUnlocked(payload);
      return payload;
    });
  }

  async record(offer, identity, extras = {}) {
    const key = identity?.key;
    if (!key) return null;
    const snapshot = createSnapshot(offer, identity, extras);
    await this.update((db) => {
      const list = Array.isArray(db.snapshots[key]) ? db.snapshots[key] : [];
      list.push(snapshot);
      db.snapshots[key] = list.slice(-(extras.snapshotLimit || 400));
      return db;
    });
    return snapshot;
  }

  async history(identityKey) {
    if (!identityKey) return [];
    const db = await this.read();
    return Array.isArray(db.snapshots[identityKey]) ? db.snapshots[identityKey] : [];
  }

  async stats(identityKey, now = new Date()) {
    return summarizeHistory(await this.history(identityKey), now);
  }

  async prune(retentionDays = 365, now = new Date()) {
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    await this.update((db) => {
      for (const [key, list] of Object.entries(db.snapshots)) {
        const kept = (list || []).filter((item) => {
          const at = new Date(item.at).getTime();
          return Number.isFinite(at) && at >= cutoff;
        });
        if (kept.length) db.snapshots[key] = kept;
        else delete db.snapshots[key];
      }
      db.cycleReports = (db.cycleReports || []).slice(-200);
      db.publications = (db.publications || []).slice(-2000);
      return db;
    });
  }

  async recordPublication(entry) {
    await this.update((db) => {
      db.publications.push({
        at: entry.at || new Date().toISOString(),
        identityKey: entry.identityKey,
        variantKey: entry.variantKey || null,
        taxonomyId: entry.taxonomyId || null,
        family: entry.family || null,
        brand: entry.brand || null,
        dealScore: entry.dealScore ?? null,
        price: entry.price ?? null
      });
      db.publications = db.publications.slice(-2000);
      return db;
    });
  }

  async publications() {
    const db = await this.read();
    return db.publications || [];
  }

  async saveCycleReport(report) {
    await this.update((db) => {
      db.cycleReports.push(report);
      db.cycleReports = db.cycleReports.slice(-200);
      return db;
    });
  }

  async latestCycleReport() {
    const db = await this.read();
    return db.cycleReports?.at(-1) || null;
  }
}
