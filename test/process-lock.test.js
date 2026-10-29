import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  InstanceLock,
  looksLikeThisApp,
  parseLockPayload,
  parseStatStarttime
} from '../src/process-lock.js';

function tempLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-lock-'));
  return path.join(dir, 'bot.pid');
}

function memoryFs(files = {}) {
  const store = { ...files };
  return {
    store,
    mkdirSync() {},
    existsSync(file) {
      return Object.prototype.hasOwnProperty.call(store, file);
    },
    readFileSync(file) {
      if (!Object.prototype.hasOwnProperty.call(store, file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return store[file];
    },
    writeFileSync(fdOrFile, content) {
      if (typeof fdOrFile === 'number') {
        store.__fd = String(content);
        return;
      }
      store[fdOrFile] = String(content);
    },
    openSync(file, flags) {
      if (flags === 'wx' && Object.prototype.hasOwnProperty.call(store, file)) {
        const error = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      }
      store[file] = store[file] ?? '';
      store.__opened = file;
      return 1;
    },
    closeSync() {
      if (store.__opened && store.__fd != null) {
        store[store.__opened] = store.__fd;
      }
    },
    unlinkSync(file) {
      delete store[file];
    },
    readlinkSync(file) {
      if (!Object.prototype.hasOwnProperty.call(store, file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return store[file];
    }
  };
}

test('parseia lock antigo só com PID e lock JSON', () => {
  assert.deepEqual(parseLockPayload('78\n'), { pid: 78, starttime: null, cwd: null });
  assert.equal(parseLockPayload('abc'), null);
  assert.equal(parseLockPayload(''), null);
  assert.equal(parseLockPayload('{"pid":"x"}'), null);
  const json = parseLockPayload('{"pid":78,"starttime":"123","cwd":"/app"}');
  assert.equal(json.pid, 78);
  assert.equal(json.starttime, '123');
});

test('parseia starttime do /proc/pid/stat mesmo com nome entre parênteses', () => {
  const stat = '78 (node index.js) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 98765 21';
  assert.equal(parseStatStarttime(stat), '98765');
});

test('reconhece a linha de comando desta aplicação', () => {
  assert.equal(looksLikeThisApp('node index.js', '/app', '/app'), true);
  assert.equal(looksLikeThisApp('/usr/bin/node /workspace/index.js', '', ''), true);
  assert.equal(looksLikeThisApp('', '/app', '/app'), true);
  assert.equal(looksLikeThisApp('nginx: master', '/app', '/app'), false);
  assert.equal(looksLikeThisApp('nginx: master', '/other', '/app'), false);
});

test('adquire lock quando não há arquivo', () => {
  const lockFile = tempLock();
  const lock = new InstanceLock({ lockFile, pid: 100, projectRoot: '/app' });
  const result = lock.acquire();
  assert.equal(result.ok, true);
  const stored = parseLockPayload(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(stored.pid, 100);
  assert.equal(lock.release(), true);
  assert.equal(fs.existsSync(lockFile), false);
});

test('lock válido de outra instância viva desta aplicação é recusado', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 78, starttime: '10', cwd: '/app' }));
  const lock = new InstanceLock({
    lockFile,
    pid: 200,
    projectRoot: '/app',
    inspect: () => ({
      exists: true,
      starttime: '10',
      cmdline: 'node index.js',
      cwd: '/app',
      zombie: false
    }),
    kill: () => true
  });
  assert.throws(() => lock.acquire(), /pid 78/);
  assert.equal(lock.owned, false);
  assert.equal(fs.existsSync(lockFile), true);
});

test('lock obsoleto de PID morto é substituído', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, '78');
  const lock = new InstanceLock({
    lockFile,
    pid: 200,
    projectRoot: '/app',
    inspect: () => ({ exists: false }),
    kill: () => {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
  });
  assert.equal(lock.acquire().ok, true);
  const stored = parseLockPayload(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(stored.pid, 200);
});

test('PID inválido no lock não impede a inicialização', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, 'não-é-pid');
  const lock = new InstanceLock({ lockFile, pid: 200, projectRoot: '/app' });
  assert.equal(lock.acquire().ok, true);
});

test('PID do próprio processo no lock é tratado como obsoleto', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, '78');
  const lock = new InstanceLock({
    lockFile,
    pid: 78,
    projectRoot: '/app',
    inspect: () => ({
      exists: true,
      starttime: '99',
      cmdline: 'node index.js',
      cwd: '/app'
    })
  });
  assert.equal(lock.acquire().ok, true);
  const stored = parseLockPayload(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(stored.pid, 78);
});

test('lock antigo só com PID de processo alheio é substituído', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, '78');
  const lock = new InstanceLock({
    lockFile,
    pid: 200,
    projectRoot: '/app',
    inspect: () => ({
      exists: true,
      starttime: '50',
      cmdline: 'sshd',
      cwd: '/',
      zombie: false
    }),
    kill: () => true
  });
  assert.equal(lock.acquire().ok, true);
  const stored = parseLockPayload(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(stored.pid, 200);
});

test('PID reutilizado por outro processo libera o lock', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 78, starttime: '10', cwd: '/app' }));
  const lock = new InstanceLock({
    lockFile,
    pid: 200,
    projectRoot: '/app',
    inspect: () => ({
      exists: true,
      starttime: '999',
      cmdline: 'sshd',
      cwd: '/',
      zombie: false
    }),
    kill: () => true
  });
  assert.equal(lock.acquire().ok, true);
});

test('PID vivo sem evidência suficiente não é removido', () => {
  const lockFile = tempLock();
  fs.writeFileSync(lockFile, '78');
  const lock = new InstanceLock({
    lockFile,
    pid: 200,
    projectRoot: '/app',
    inspect: () => ({ exists: null }),
    kill: () => true
  });
  assert.throws(() => lock.acquire(), /pid 78/);
  assert.equal(fs.existsSync(lockFile), true);
});

test('encerramento só remove o lock se esta instância for a dona', () => {
  const io = memoryFs();
  const lockFile = '/tmp/bot.pid';
  const owner = new InstanceLock({
    lockFile,
    pid: 200,
    projectRoot: '/app',
    fs: io,
    inspect: () => ({ exists: false }),
    kill: () => {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    },
    readStarttime: () => '1'
  });
  owner.acquire();
  const other = new InstanceLock({ lockFile, pid: 201, projectRoot: '/app', fs: io });
  assert.equal(other.release(), false);
  assert.equal(io.existsSync(lockFile), true);
  assert.equal(owner.release(), true);
  assert.equal(io.existsSync(lockFile), false);
});
