import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

export type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * One JSON object per line on stdout: timestamp, level, message, the fields, and the trace and
 * span ids of whatever is running, so a log line leads to its trace. Never pass a password,
 * cookie, token, request body or TOTP secret in `fields`.
 */
const ORDER: Record<Level | 'silent', number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
function threshold(): number {
  const set = process.env.LOG_LEVEL as Level | 'silent' | undefined;
  if (set && set in ORDER) return ORDER[set];
  return process.env.NODE_ENV === 'test' ? ORDER.silent : ORDER.info; // tests are quiet unless asked
}

export function logLine(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const ctx = trace.getActiveSpan()?.spanContext();
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
    ...(ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => logLine('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => logLine('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => logLine('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => logLine('error', msg, f),
};

/** Nest's own logging (startup, unhandled exceptions) in the same shape. */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    logLine('info', String(message), { context });
  }
  warn(message: unknown, context?: string) {
    logLine('warn', String(message), { context });
  }
  error(message: unknown, stackOrContext?: string, context?: string) {
    logLine('error', String(message), { stack: stackOrContext, context });
  }
  debug(message: unknown, context?: string) {
    logLine('debug', String(message), { context });
  }
}
