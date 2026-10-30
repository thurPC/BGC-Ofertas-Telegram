import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';

const DEFAULT_DB = {
  version: 1,
  offers: [],
  history: [],
  settings: {
    autoPublishEnabled: false,
    template: null
  }
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JsonStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.bakPath = `${filePath}.bak`;
    this.lockPath = `${filePath}.lock`;
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.#atomicWrite(structuredClone(DEFAULT_DB));
    }
  }

  async read() {
    return this.#enqueue(async () => this.#readUnlocked());
  }

  async write(data) {
    return this.#enqueue(async () => {
      await this.#atomicWrite(data);
      return data;
    });
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      const current = await this.#readUnlocked();
      const next = await mutator(current);
      const payload = next ?? current;
      await this.#atomicWrite(payload);
      return payload;
    });
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
      const parsed = JSON.parse(raw);
      return this.#normalize(parsed);
    } catch (error) {
      logger.warn('Falha ao ler o banco JSON. Tentando backup.', error.message);
      try {
        const raw = await fs.readFile(this.bakPath, 'utf8');
        const parsed = JSON.parse(raw);
        const data = this.#normalize(parsed);
        await this.#atomicWrite(data);
        return data;
      } catch {
        const fresh = structuredClone(DEFAULT_DB);
        await this.#atomicWrite(fresh);
        return fresh;
      }
    }
  }

  #normalize(data) {
    const base = structuredClone(DEFAULT_DB);
    if (!data || typeof data !== 'object') return base;
    return {
      version: Number.isInteger(data.version) ? data.version : 1,
      offers: Array.isArray(data.offers) ? data.offers : [],
      history: Array.isArray(data.history) ? data.history : [],
      settings: {
        autoPublishEnabled: Boolean(data.settings?.autoPublishEnabled),
        template: data.settings?.template ?? null
      }
    };
  }

  async #atomicWrite(data) {
    const json = `${JSON.stringify(data, null, 2)}\n`;
    await this.#withLock(async () => {
      await fs.writeFile(this.tmpPath, json, 'utf8');
      try {
        await fs.copyFile(this.filePath, this.bakPath);
      } catch {
        // arquivo ainda não existia
      }
      await fs.rename(this.tmpPath, this.filePath);
    });
  }

  async #withLock(task) {
    const started = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        try {
          await handle.writeFile(String(process.pid), 'utf8');
        } finally {
          await handle.close();
        }
        try {
          return await task();
        } finally {
          await fs.unlink(this.lockPath).catch(() => undefined);
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (Date.now() - started > 8000) {
          await fs.unlink(this.lockPath).catch(() => undefined);
          throw new Error('Tempo esgotado ao obter bloqueio do armazenamento JSON.');
        }
        await wait(40);
      }
    }
  }
}

export function createDefaultDb() {
  return structuredClone(DEFAULT_DB);
}
