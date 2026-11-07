import { escapeHtml } from '../services/validation-service.js';
import { QUEUE_STATUS } from './defaults.js';

export function emptyCycleMetrics() {
  return {
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    discovered: 0,
    identified: 0,
    classified: 0,
    ranked: 0,
    queued: 0,
    published: 0,
    expired: 0,
    rejected: 0,
    quarantined: 0,
    sourceFailures: 0,
    rejectionReasons: {},
    modules: {}
  };
}

export function createCycleTracker() {
  const metrics = emptyCycleMetrics();
  const marks = new Map();
  metrics.startedAt = new Date().toISOString();
  const started = Date.now();

  return {
    metrics,
    markStart(name) {
      marks.set(name, Date.now());
    },
    markEnd(name) {
      const from = marks.get(name);
      if (from == null) return;
      metrics.modules[name] = (metrics.modules[name] || 0) + (Date.now() - from);
    },
    count(field, amount = 1) {
      metrics[field] = (metrics[field] || 0) + amount;
    },
    reject(reason) {
      metrics.rejected += 1;
      const key = String(reason || 'unknown');
      metrics.rejectionReasons[key] = (metrics.rejectionReasons[key] || 0) + 1;
    },
    finish() {
      metrics.finishedAt = new Date().toISOString();
      metrics.durationMs = Date.now() - started;
      return { ...metrics, rejectionReasons: { ...metrics.rejectionReasons }, modules: { ...metrics.modules } };
    }
  };
}

export function summarizeCycle(metrics = emptyCycleMetrics()) {
  const reasons = Object.entries(metrics.rejectionReasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([code, count]) => `${code}: ${count}`);
  return {
    discovered: metrics.discovered || 0,
    identified: metrics.identified || 0,
    classified: metrics.classified || 0,
    rejected: metrics.rejected || 0,
    ranked: metrics.ranked || 0,
    queued: metrics.queued || 0,
    published: metrics.published || 0,
    expired: metrics.expired || 0,
    quarantined: metrics.quarantined || 0,
    sourceFailures: metrics.sourceFailures || 0,
    durationMs: metrics.durationMs || 0,
    topRejections: reasons
  };
}

export function formatDiagnosticsReport(metrics, extras = {}) {
  const summary = summarizeCycle(metrics);
  const lines = [
    '<b>BGC Deal Engine — diagnóstico</b>',
    '',
    `Descobertos: ${summary.discovered}`,
    `Identificados: ${summary.identified}`,
    `Classificados: ${summary.classified}`,
    `Rejeitados: ${summary.rejected}`,
    `Ranking: ${summary.ranked}`,
    `Fila: ${summary.queued}`,
    `Publicados: ${summary.published}`,
    `Expirados: ${summary.expired}`,
    `Quarentena: ${summary.quarantined}`,
    `Falhas de fonte: ${summary.sourceFailures}`,
    `Tempo do ciclo: ${summary.durationMs} ms`
  ];
  if (summary.topRejections.length) {
    lines.push('', '<b>Principais rejeições</b>');
    for (const item of summary.topRejections) lines.push(`• ${escapeHtml(item)}`);
  }
  if (extras.note) {
    lines.push('', escapeHtml(extras.note));
  }
  lines.push('', 'Credenciais de autenticação nunca entram neste relatório.');
  return lines.join('\n');
}

export function statusFromGate(gate, identity) {
  if (identity?.uncertain) return QUEUE_STATUS.QUARANTINE;
  if (!gate?.ok) return QUEUE_STATUS.REJECTED;
  return QUEUE_STATUS.QUEUED;
}
