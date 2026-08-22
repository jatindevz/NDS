import { z } from 'zod';

/**
 * All configuration comes from validated environment variables.
 * The process must fail fast at startup if anything is missing or
 * malformed — never limp along with an undefined connection string.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  RESEND_API_KEY: z.string().optional(),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  redisUrl: string;
  databaseUrl: string;
  resendApiKey: string | undefined;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration -> ${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
    databaseUrl: e.DATABASE_URL,
    resendApiKey: e.RESEND_API_KEY,
  };
}
