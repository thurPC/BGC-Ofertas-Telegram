import { escapeHtml } from './validation-service.js';

export function defaultScheduleSettings() {
  return {
    mode: 'always',
    startHour: 0,
    endHour: 23
  };
}

export function hoursFromRange(startHour, endHour) {
  const start = Number.parseInt(startHour, 10);
  const end = Number.parseInt(endHour, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) {
    return [];
  }
  const hours = [];
  if (start <= end) {
    for (let hour = start; hour <= end; hour += 1) hours.push(hour);
  } else {
    for (let hour = start; hour <= 23; hour += 1) hours.push(hour);
    for (let hour = 0; hour <= end; hour += 1) hours.push(hour);
  }
  return hours;
}

export function hoursFromSchedule(settings) {
  const resolved = mergeScheduleSettings(settings);
  if (resolved.mode === 'always') return [];
  return hoursFromRange(resolved.startHour, resolved.endHour);
}

export function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}h`;
}

export function formatScheduleRange(settings) {
  const resolved = mergeScheduleSettings(settings);
  if (resolved.mode === 'always') return '24h';
  return `${formatHour(resolved.startHour)}-${formatHour(resolved.endHour)}`;
}

export function parseScheduleInput(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return { ok: false, error: 'Informe o horario no formato 08-22, 8 22 ou 24h.' };
  if (['24h', '24', 'sempre', 'all', 'todo', 'todos', '0-23', '00-23'].includes(raw)) {
    return { ok: true, settings: defaultScheduleSettings() };
  }
  const match = raw.match(/^(\d{1,2})(?:h|:00)?\s*(?:-|ate|até|a|às|as)\s*(\d{1,2})(?:h|:00)?$/i)
    || raw.match(/^(\d{1,2})(?:h|:00)?\s+(\d{1,2})(?:h|:00)?$/);
  if (!match) {
    return { ok: false, error: 'Use horas cheias no formato 24h, sem minutos. Ex.: 08-22 ou 24h.' };
  }
  const startHour = Number.parseInt(match[1], 10);
  const endHour = Number.parseInt(match[2], 10);
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    return { ok: false, error: 'Horas validas vao de 00 a 23.' };
  }
  if (startHour === 0 && endHour === 23) {
    return { ok: true, settings: defaultScheduleSettings() };
  }
  return {
    ok: true,
    settings: {
      mode: 'range',
      startHour,
      endHour
    }
  };
}

export function scheduleFromHours(hours) {
  const unique = [...new Set((hours || []).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 23))].sort((a, b) => a - b);
  if (!unique.length || unique.length === 24) return defaultScheduleSettings();
  let gapAt = -1;
  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index] !== unique[index - 1] + 1) {
      gapAt = index;
      break;
    }
  }
  if (gapAt === -1) {
    return { mode: 'range', startHour: unique[0], endHour: unique[unique.length - 1] };
  }
  if (unique[0] === 0 && unique[unique.length - 1] === 23) {
    return { mode: 'range', startHour: unique[gapAt], endHour: unique[gapAt - 1] };
  }
  return { mode: 'range', startHour: unique[0], endHour: unique[unique.length - 1] };
}

export function mergeScheduleSettings(input = {}, fallback = defaultScheduleSettings()) {
  const source = input && typeof input === 'object' ? input : {};
  if (Array.isArray(source.hours) && source.hours.length) {
    return scheduleFromHours(source.hours);
  }
  const mode = source.mode === 'range' ? 'range' : source.mode === 'always' ? 'always' : fallback.mode;
  const startHour = Number.isInteger(Number(source.startHour)) ? Number(source.startHour) : fallback.startHour;
  const endHour = Number.isInteger(Number(source.endHour)) ? Number(source.endHour) : fallback.endHour;
  if (mode !== 'range') return defaultScheduleSettings();
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) return fallback;
  if (startHour === 0 && endHour === 23) return defaultScheduleSettings();
  return { mode: 'range', startHour, endHour };
}

export function describeSchedule(settings) {
  const resolved = mergeScheduleSettings(settings);
  const lines = ['<b>Horario de operacao</b>', ''];
  if (resolved.mode === 'always') {
    lines.push('O bot opera <b>24h</b>.');
  } else {
    lines.push(`Janela ativa: <b>${escapeHtml(formatScheduleRange(resolved))}</b>`);
    lines.push('Formato 24 horas, sem minutos.');
  }
  lines.push('');
  lines.push('Exemplos: <code>08-22</code>, <code>9 18</code>, <code>24h</code>.');
  return lines.join('\n');
}

export class ScheduleService {
  constructor(storage, env = {}) {
    this.storage = storage;
    this.envHours = Array.isArray(env.allowedHours) ? env.allowedHours : [];
  }

  defaults() {
    return this.envHours.length ? scheduleFromHours(this.envHours) : defaultScheduleSettings();
  }

  async get() {
    if (!this.storage) return this.defaults();
    const db = await this.storage.read();
    return mergeScheduleSettings(db.settings?.schedule, this.defaults());
  }

  async save(next, { actorId, action = 'schedule-update' } = {}) {
    const resolved = mergeScheduleSettings(next, this.defaults());
    if (!this.storage) return resolved;
    await this.storage.update((db) => {
      db.settings = { ...db.settings, schedule: resolved };
      db.history.push({
        at: new Date().toISOString(),
        action,
        actorId: actorId ?? null
      });
      return db;
    });
    return resolved;
  }

  async setFromInput(value, { actorId } = {}) {
    const parsed = parseScheduleInput(value);
    if (!parsed.ok) return parsed;
    const settings = await this.save(parsed.settings, { actorId, action: 'schedule-set' });
    return { ok: true, settings };
  }

  async reset({ actorId } = {}) {
    return this.save(this.defaults(), { actorId, action: 'schedule-reset' });
  }
}
