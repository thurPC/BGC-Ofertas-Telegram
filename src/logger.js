const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, raw) ? raw : 'info';
}

function shouldLog(level) {
  return LEVELS[level] <= LEVELS[currentLevel()];
}

function stamp() {
  return new Date().toISOString();
}

function write(stream, level, args) {
  if (!shouldLog(level)) return;
  const prefix = `[${stamp()}] [${level.toUpperCase()}]`;
  stream.write(`${prefix} ${args.map(formatArg).join(' ')}\n`);
}

function formatArg(value) {
  if (value instanceof Error) {
    return process.env.NODE_ENV === 'production'
      ? value.message
      : `${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export const logger = {
  error(...args) {
    write(process.stderr, 'error', args);
  },
  warn(...args) {
    write(process.stderr, 'warn', args);
  },
  info(...args) {
    write(process.stdout, 'info', args);
  },
  debug(...args) {
    write(process.stdout, 'debug', args);
  }
};
