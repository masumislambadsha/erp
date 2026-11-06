import {
  type Attributes,
  type Histogram,
  type Counter,
  type Gauge,
  metrics,
} from '@opentelemetry/api';

/**
 * The metrics this service emits. Names here are OpenTelemetry names; the Prometheus exporter
 * writes them with dots as underscores, `_total` on counters and the unit on histograms. The alert
 * rules in ops/alerts.yml use the exported names, and a test checks each one exists.
 *
 * The metrics API has no late binding: an instrument made before the meter provider is registered
 * stays a no-op. So each one is created on first use, which is after startTelemetry() in main.
 */
const meter = () => metrics.getMeter('erp-api');

const lazyHistogram = (
  name: string,
  options: Parameters<ReturnType<typeof meter>['createHistogram']>[1],
) => {
  let h: Histogram | undefined;
  return {
    record: (v: number, a?: Attributes) =>
      (h ??= meter().createHistogram(name, options)).record(v, a),
  };
};
const lazyCounter = (name: string, options: { description: string }) => {
  let c: Counter | undefined;
  return {
    add: (v: number, a?: Attributes) => (c ??= meter().createCounter(name, options)).add(v, a),
  };
};
const lazyGauge = (name: string, options: { description: string; unit?: string }) => {
  let g: Gauge | undefined;
  return {
    record: (v: number, a?: Attributes) => (g ??= meter().createGauge(name, options)).record(v, a),
  };
};

/** Every HTTP response: duration in seconds, by method, route template and status class. */
export const httpDuration = lazyHistogram('http.server.request.duration', {
  description: 'HTTP server request duration',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
});
export const jobsCompleted = lazyCounter('erp.jobs.completed', {
  description: 'Jobs that finished',
});
export const jobsFailed = lazyCounter('erp.jobs.failed', {
  description: 'Jobs that threw (a retry may follow)',
});
export const jobsStuck = lazyGauge('erp.jobs.stuck', {
  description: 'Active jobs past their expiry: a worker died',
});
export const integrityDifferences = lazyGauge('erp.integrity.differences', {
  description: 'Differences found by the last ledger-integrity check, summed over tenants',
});
export const integrityLastRun = lazyGauge('erp.integrity.last_run_timestamp', {
  description: 'Unix time the nightly integrity check last finished',
  unit: 's',
});
export const partitionsMissing = lazyGauge('erp.ledger.partitions.missing', {
  description:
    'Ledger partitions for this year or next that do not exist: posting into that year fails',
});
export const signIns = lazyCounter('erp.auth.sign_in', {
  description: 'Sign-in attempts, by outcome',
});

export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;
