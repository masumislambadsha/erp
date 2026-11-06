import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { RequestWithContext } from '../context/request-context.js';
import { log } from './logger.js';
import { httpDuration, statusClass } from './telemetry.js';

const tracer = trace.getTracer('erp-api');

/**
 * Express middleware: a request id (echoed in x-request-id), a span, the duration histogram and
 * one structured access line per response. It sees guard rejections too, which an interceptor would not.
 * The route is the template (`/documents/:docType/:id`), so metrics and logs carry no ids or tokens.
 */
export function httpTelemetry(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const requestId =
    typeof req.headers['x-request-id'] === 'string' &&
    /^[\w-]{8,64}$/.test(req.headers['x-request-id'])
      ? req.headers['x-request-id']
      : randomUUID();
  res.setHeader('x-request-id', requestId);
  const span = tracer.startSpan(`${req.method} request`, {
    attributes: { 'http.request.method': req.method },
  });
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const route = (req.route?.path as string | undefined)
      ? `${req.baseUrl}${req.route.path}`
      : 'unmatched';
    const status = res.statusCode;
    const auth = (req as RequestWithContext).erpAuth;
    span.updateName(`${req.method} ${route}`);
    span.setAttributes({
      'http.route': route,
      'http.response.status_code': status,
      ...(auth ? { 'erp.tenant_id': auth.tenantId } : {}),
    });
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    httpDuration.record(seconds, {
      'http.request.method': req.method,
      'http.route': route,
      'http.response.status_class': statusClass(status),
    });
    log[status >= 500 ? 'error' : 'info']('request', {
      method: req.method,
      route,
      status,
      ms: Math.round(seconds * 1000),
      requestId,
      ...(auth ? { tenantId: auth.tenantId, userId: auth.userId } : {}),
    });
  });
  next();
}
