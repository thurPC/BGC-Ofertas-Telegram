import fs from 'node:fs/promises';
import path from 'node:path';
import { puxadorProductKey } from './shopee-post-parser.js';

const EMPTY = { version: 1, items: [] };

export class PuxadorInboxStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.serial = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await this.#write(EMPTY);
    }
  }

  async #exclusive(task) {
    const run = this.serial.then(task, task);
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(EMPTY);
      throw new Error(`Não foi possível ler a caixa de entrada do Puxador: ${error?.message || 'erro desconhecido'}`);
    }
  }

  async #write(data) {
    await fs.writeFile(this.tmpPath, `${JSON.stringify(data, null, 2)}\\n`, 'utf8');
    await fs.rename(this.tmpPath, this.filePath);
  }

  async enqueue(capture) {
    if (!capture?.sourceChatId || !capture?.sourceMessageId || !capture?.productUrl) {
      return { ok: false, reason: 'invalid-capture' };
    }
    return this.#exclusive(async () => {
      const db = await this.#read();
      const productKey = puxadorProductKey(capture);
      const duplicate = productKey && db.items.find((item) =>
        item.productKey === productKey &&
        !['rejected', 'expired'].includes(item.status)
      );
      if (duplicate) {
        const sourceKey = `${capture.sourceChatId}:${capture.sourceMessageId}`;
        const exists = duplicate.sources?.some((source) => `${source.chatId}:${source.messageId}` === sourceKey);
        if (!exists) {
          duplicate.sources = [...(duplicate.sources || []), {
            chatId: capture.sourceChatId,
            messageId: capture.sourceMessageId
          }];
          duplicate.updatedAt = new Date().toISOString();
          await this.#write(db);
        }
        return { ok: true, duplicate: true, item: duplicate };
      }
      const item = {
        ...capture,
        sources: Array.isArray(capture.sources) && capture.sources.length
          ? capture.sources
          : [{ chatId: capture.sourceChatId, messageId: capture.sourceMessageId }],
        id: `${capture.sourceChatId}:${capture.sourceMessageId}`,
        productKey,
        status: 'discovered',
        createdAt: new Date().toISOString()
      };
      db.items.push(item);
      db.items = db.items.slice(-1000);
      await this.#write(db);
      return { ok: true, duplicate: false, item };
    });
  }

  async list({ status, limit = 100 } = {}) {
    const db = await this.#read();
    const filtered = status ? db.items.filter((item) => item.status === status) : db.items;
    return filtered.slice(-Math.max(1, Math.min(500, Number(limit) || 100))).reverse();
  }

  async updateStatus(id, status, extra = {}) {
    const allowed = new Set(['discovered', 'needs_review', 'approved', 'rejected', 'expired', 'published']);
    if (!allowed.has(status)) return { ok: false, reason: 'invalid-status' };
    return this.#exclusive(async () => {
      const db = await this.#read();
      const item = db.items.find((entry) => entry.id === id);
      if (!item) return { ok: false, reason: 'not-found' };
      Object.assign(item, extra, { status, updatedAt: new Date().toISOString() });
      await this.#write(db);
      return { ok: true, item };
    });
  }
}
