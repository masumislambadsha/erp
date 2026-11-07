import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  /** The erp_app role only: never a superuser, erp_owner or a BYPASSRLS role (CLAUDE.md rule 2). */
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => decodeURIComponent(new URL(u).username) === 'erp_app', {
      message: 'must connect as the erp_app role',
    }),
  /** 32 random bytes, base64: encrypts TOTP secrets at rest (AES-256-GCM). */
  TOTP_ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, {
    message: 'must be 32 bytes, base64-encoded',
  }),
  /** Run the job workers and the scheduler, and enqueue jobs. Switch off only for tools and tests. */
  JOBS_ENABLED: z.enum(['true', 'false']).default('true'),
  /**
   * The job supervisor's role, erp_scheduler (owner-approved exception to "one role"): pg-boss supervision and cron
   * take advisory locks, which erp_app must not have. Without it jobs still run, but stuck ones do not recover and
   * the nightly check is never scheduled.
   */
  DATABASE_SCHEDULER_URL: z
    .string()
    .url()
    .refine((u) => decodeURIComponent(new URL(u).username) === 'erp_scheduler', {
      message: 'must connect as the erp_scheduler role',
    })
    .optional(),
  /** Requests per minute: per signed-in user, and per client IP on sign-in. */
  RATE_LIMIT_USER_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_SIGNIN_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  /** Reverse proxies in front of the API (0 when exposed directly): needed to see the client's real IP. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Development only: take tenant and user from request headers. See context/resolve-context.ts. */
  DEV_AUTH_STUB: z.enum(['true', 'false']).default('false'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  devAuthStub: boolean;
  totpKey: Buffer;
  cookieSecure: boolean;
  jobsEnabled: boolean;
  schedulerUrl: string | undefined;
  rateLimit: { userPerMinute: number; signInPerMinute: number };
  trustProxy: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  const config: Config = {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    devAuthStub: e.DEV_AUTH_STUB === 'true',
    totpKey: Buffer.from(e.TOTP_ENCRYPTION_KEY, 'base64'),
    cookieSecure: e.NODE_ENV === 'production',
    jobsEnabled: e.JOBS_ENABLED === 'true',
    schedulerUrl: e.DATABASE_SCHEDULER_URL,
    rateLimit: {
      userPerMinute: e.RATE_LIMIT_USER_PER_MINUTE,
      signInPerMinute: e.RATE_LIMIT_SIGNIN_PER_MINUTE,
    },
    trustProxy: e.TRUST_PROXY,
  };
  if (config.nodeEnv === 'production' && config.devAuthStub) {
    // The tenant must never come from request input (PLAN.md, Security: "Injection").
    throw new ConfigError('DEV_AUTH_STUB=true is not allowed when NODE_ENV=production');
  }
  return config;
}
