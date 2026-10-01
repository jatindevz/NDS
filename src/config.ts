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
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(5),
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  REDIS_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  RESEND_API_KEY: z.string().optional(),
  /** Static bearer token guarding the API (TDR §11). Unset => API rejects all requests (fail-closed). */
  API_KEY: z.string().min(16).optional(),
  /** From-address for outbound email; required for the email handler to deliver. */
  EMAIL_FROM: z.string().min(3).optional(),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  workerConcurrency: number;
  gracefulShutdownTimeoutMs: number;
  redisUrl: string;
  databaseUrl: string;
  resendApiKey: string | undefined;
  apiKey: string | undefined;
  emailFrom: string | undefined;
  webhookTimeoutMs: number;
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
    workerConcurrency: e.WORKER_CONCURRENCY,
    gracefulShutdownTimeoutMs: e.GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    redisUrl: e.REDIS_URL,
    databaseUrl: e.DATABASE_URL,
    resendApiKey: e.RESEND_API_KEY,
    apiKey: e.API_KEY,
    emailFrom: e.EMAIL_FROM,
    webhookTimeoutMs: e.WEBHOOK_TIMEOUT_MS,
  };
}
