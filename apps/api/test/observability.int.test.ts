import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  integrityDifferences,
  integrityLastRun,
  jobsCompleted,
  jobsFailed,
  jobsStuck,
} from '../src/observability/telemetry.js';
import { startTelemetry, type Telemetry } from '../src/observability/setup.js';
import { Browser, call, newTenant, startApp, stubHeaders } from './support.js';

let telemetry: Telemetry;
let app: INestApplication;
let base: string;
let admin: { tenantId: string; adminId: string; adminEmail: string };

async function scrape(): Promise<string> {
  const { resourceMetrics } = await telemetry.prometheus.collect();
  return new PrometheusSerializer().serialize(resourceMetrics);
}

beforeAll(async () => {
  telemetry = startTelemetry({}, { serve: false });
  ({ app, base } = await startApp());
  admin = await newTenant('Observability');
});
afterAll(async () => {
  await app?.close();
  await telemetry?.shutdown();
});

describe('http telemetry', () => {
  it('echoes a request id, and measures every response by route template, guard rejections included', async () => {
    const ok = await call(base, 'GET', '/health', {});
    expect(ok.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const mine = await fetch(`${base}/health`, { headers: { 'x-request-id': 'trace-me-12345' } });
    expect(mine.headers.get('x-request-id')).toBe('trace-me-12345');
    const bad = await fetch(`${base}/health`, {
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(bad.headers.get('x-request-id')).not.toBe('bad id with spaces');

    await call(base, 'GET', '/parties', {}); // 401 from the guard
    await call(
      base,
      'GET',
      `/documents/service_order/${'0'.repeat(8)}-0000-4000-8000-000000000000`,
      stubHeaders(admin.tenantId, admin.adminId),
    ); // 403
    await call(base, 'GET', '/no/such/route', {}); // 404
    const text = await scrape();
    expect(text).toMatch(
      /http_server_request_duration_count\{[^}]*http_route="\/health"[^}]*http_response_status_class="2xx"/,
    );
    expect(text).toMatch(/http_route="\/parties"[^}]*http_response_status_class="4xx"/);
    expect(text).toMatch(/http_route="\/documents\/:docType\/:id"/); // a template, never an id
    expect(text).toContain('http_route="unmatched"');
    expect(text).not.toMatch(/http_route="[^"]*[0-9a-f]{8}-[0-9a-f]{4}/); // no ids in labels
    expect(text).toContain('http_server_request_duration_bucket');
  });

  it('writes one structured line per request with the ids that find a problem, and no secrets', async () => {
    const lines: string[] = [];
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    try {
      const b = new Browser(base);
      await b.signIn(admin.tenantId, admin.adminEmail, 'definitely-the-wrong-password');
      await call(base, 'GET', '/parties', stubHeaders(admin.tenantId, admin.adminId));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
    const logged = lines
      .flatMap((l) => l.split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const req = logged.filter((l) => l.msg === 'request');
    expect(req).toHaveLength(2);
    expect(req[0]).toMatchObject({
      level: 'info',
      method: 'POST',
      route: '/auth/sign-in',
      status: 401,
    });
    expect(req[1]).toMatchObject({
      level: 'info',
      method: 'GET',
      route: '/parties',
      status: 200,
      tenantId: admin.tenantId,
      userId: admin.adminId,
    });
    for (const l of req) {
      expect(l.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof l.ms).toBe('number');
      expect(l.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(lines.join('')).not.toMatch(/definitely-the-wrong-password|cookie|erp_session|argon2/i);
  });

  it('counts sign-ins by outcome', async () => {
    await new Browser(base).signIn(admin.tenantId, 'nobody@example.test');
    expect(await scrape()).toMatch(/erp_auth_sign_in_total\{[^}]*outcome="failure"/);
  });
});

describe('the alert rules name metrics that exist', () => {
  it('every metric in ops/alerts.yml is exported by the service', async () => {
    jobsCompleted.add(1, { queue: 'q' });
    jobsFailed.add(1, { queue: 'q' });
    jobsStuck.record(0);
    integrityDifferences.record(0);
    integrityLastRun.record(1);
    const exported = new Set(
      [...(await scrape()).matchAll(/^([a-z_:][a-z0-9_:]*)[ {]/gim)].map((m) => m[1]!),
    );
    const rules = readFileSync(join(import.meta.dirname, '../../../ops/alerts.yml'), 'utf8');
    const used = new Set(
      [...rules.matchAll(/\b((?:http_server|erp)_[a-z0-9_]+)/g)].map((m) => m[1]!),
    );
    expect(used.size).toBeGreaterThanOrEqual(7);
    for (const name of used)
      expect(exported, `ops/alerts.yml uses ${name}, which the service does not export`).toContain(
        name,
      );
  });
});
