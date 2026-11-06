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
  /** Development only: take tenant and user from request headers. See context/resolve-context.ts. */
  DEV_AUTH_STUB: z.enum(['true', 'false']).default('false'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  devAuthStub: boolean;
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
  };
  if (config.nodeEnv === 'production' && config.devAuthStub) {
    // The tenant must never come from request input (PLAN.md, Security: "Injection").
    throw new ConfigError('DEV_AUTH_STUB=true is not allowed when NODE_ENV=production');
  }
  return config;
}
