import fs from 'node:fs';
import path from 'node:path';

const APP_MARKERS = ['index.js', 'bgc-ofertas'];

export function parseLockPayload(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const pid = Number.parseInt(data.pid, 10);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        starttime: data.starttime == null ? null : String(data.starttime),
        cwd: data.cwd ? String(data.cwd) : null
      };
    } catch {
      return null;
    }
  }
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, starttime: null, cwd: null };
}

export function parseStatStarttime(statContent) {
  const close = String(statContent ?? '').lastIndexOf(')');
  if (close === -1) return null;
  const rest = String(statContent).slice(close + 1).trim().split(/\s+/);
  return rest[19] || null;
}

export function looksLikeThisApp(cmdline = '', cwd = '', projectRoot = '') {
  const line = String(cmdline).toLowerCase();
  const hasNode = /(^|[\\/\s])node(\s|$)/.test(line);
  const hasMarker = APP_MARKERS.some((marker) => line.includes(marker));
  if (hasNode && hasMarker) return true;
  if (!String(cmdline).trim() && projectRoot && cwd) {
    try {
      return path.resolve(cwd) === path.resolve(projectRoot);
    } catch {
      return false;
    }
  }
  return false;
}

export function inspectProcess(pid, { readFileSync, readlinkSync } = fs) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    let cmdline = '';
    let cwd = null;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      cmdline = '';
    }
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
    const stateMatch = /\((.*)\)\s+(\S)/s.exec(stat);
    const state = stateMatch ? stateMatch[2] : null;
    return {
      exists: true,
      starttime: parseStatStarttime(stat),
      cmdline,
      cwd,
      zombie: state === 'Z'
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return { exists: false };
    }
    return { exists: null, error };
  }
}

function processExists(pid, killFn) {
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export class InstanceLock {
  constructor(options = {}) {
    this.lockFile = options.lockFile;
    this.pid = options.pid ?? process.pid;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.fs = options.fs ?? fs;
    this.kill = options.kill ?? process.kill.bind(process);
    this.inspect = options.inspect ?? ((pid) => inspectProcess(pid, this.fs));
    this.readStarttime = options.readStarttime ?? (() => {
      try {
        return parseStatStarttime(this.fs.readFileSync('/proc/self/stat', 'utf8'));
      } catch {
        return null;
      }
    });
    this.owned = false;
  }

  classifyExisting(payload) {
    if (!payload?.pid) return 'invalid';
    if (payload.pid === this.pid) return 'self';

    const snapshot = this.inspect(payload.pid);
    if (snapshot?.exists === false || snapshot?.zombie) return 'dead';

    if (snapshot?.exists === true) {
      if (payload.starttime && snapshot.starttime && payload.starttime !== snapshot.starttime) {
        return 'stale-reuse';
      }
      if (looksLikeThisApp(snapshot.cmdline, snapshot.cwd, this.projectRoot)) {
        return 'live-ours';
      }
      if (snapshot.cmdline) return 'other-process';
      return 'live-unknown';
    }

    if (!processExists(payload.pid, this.kill)) return 'dead';
    return 'live-unknown';
  }

  acquire() {
    this.fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.#writeExclusive();
        this.owned = true;
        return { ok: true, path: this.lockFile, pid: this.pid };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const decision = this.#inspectLockFile();
        if (decision === 'live-ours' || decision === 'live-unknown') {
          const stored = this.#readPayload();
          throw new Error(
            `Outra instância do BGC Ofertas já está em execução (pid ${stored?.pid ?? 'desconhecido'}). Encerrando para evitar polling duplicado.`
          );
        }
        try {
          this.fs.unlinkSync(this.lockFile);
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
    throw new Error('Não foi possível obter o bloqueio de instância.');
  }

  release() {
    if (!this.owned) return false;
    try {
      if (!this.fs.existsSync(this.lockFile)) {
        this.owned = false;
        return false;
      }
      const stored = this.#readPayload();
      if (!stored || stored.pid === this.pid) {
        this.fs.unlinkSync(this.lockFile);
        this.owned = false;
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  #readPayload() {
    try {
      return parseLockPayload(this.fs.readFileSync(this.lockFile, 'utf8'));
    } catch {
      return null;
    }
  }

  #inspectLockFile() {
    const payload = this.#readPayload();
    if (!payload) return 'invalid';
    return this.classifyExisting(payload);
  }

  #writeExclusive() {
    const payload = `${JSON.stringify({
      pid: this.pid,
      starttime: this.readStarttime(),
      cwd: this.projectRoot,
      createdAt: new Date().toISOString()
    })}\n`;
    const fd = this.fs.openSync(this.lockFile, 'wx');
    try {
      this.fs.writeFileSync(fd, payload, 'utf8');
    } finally {
      this.fs.closeSync(fd);
    }
  }
}
