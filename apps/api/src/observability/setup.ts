import { metrics, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface Telemetry {
  /** The Prometheus exporter, for tests to read the metrics without a network. */
  prometheus: PrometheusExporter;
  shutdown(): Promise<void>;
}

/**
 * Registers the OpenTelemetry providers. Metrics are exposed in Prometheus format on
 * METRICS_HOST:METRICS_PORT (loopback by default, so a scraper next to the service reads them and
 * the internet does not). Traces go over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Vendor-neutral: any OTLP backend or Prometheus-compatible store works.
 */
export function startTelemetry(
  env: Record<string, string | undefined> = process.env,
  opts: { serve?: boolean } = {},
): Telemetry {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? 'erp-api',
  });
  const prometheus = new PrometheusExporter({
    host: env.METRICS_HOST ?? '127.0.0.1',
    port: Number(env.METRICS_PORT ?? 9464),
    preventServerStart: opts.serve === false,
  });
  const meterProvider = new MeterProvider({ resource, readers: [prometheus] });
  metrics.setGlobalMeterProvider(meterProvider);

  const spanProcessors = env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
          }),
        ),
      ]
    : [];
  const tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  tracerProvider.register();
  trace.setGlobalTracerProvider(tracerProvider);

  return {
    prometheus,
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}
