import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function setValidEnv(): void {
  process.env.REDIS_URL = 'redis://:secret@localhost:6379';
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/nds';
  process.env.LOG_LEVEL = 'info';
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
}

describe('loadConfig', () => {
  it('parses a fully valid environment', () => {
    setValidEnv();
    const config = loadConfig();
    expect(config.redisUrl).toBe('redis://:secret@localhost:6379');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.isProduction).toBe(false);
  });

  it('applies defaults for optional variables', () => {
    setValidEnv();
    delete process.env.LOG_LEVEL;
    delete process.env.PORT;
    const config = loadConfig();
    expect(config.logLevel).toBe('info');
    expect(config.port).toBe(3000);
    expect(config.workerConcurrency).toBe(5);
    expect(config.gracefulShutdownTimeoutMs).toBe(10_000);
  });

  it('fails fast when REDIS_URL is missing', () => {
    setValidEnv();
    delete process.env.REDIS_URL;
    expect(() => loadConfig()).toThrow(/REDIS_URL/);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    setValidEnv();
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow(/DATABASE_URL/);
  });

  it('rejects an invalid log level', () => {
    setValidEnv();
    process.env.LOG_LEVEL = 'loud';
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });

  it('rejects a non-numeric PORT', () => {
    setValidEnv();
    process.env.PORT = 'http';
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  it('rejects an out-of-range PORT', () => {
    setValidEnv();
    process.env.PORT = '99999';
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  it('rejects a non-positive WORKER_CONCURRENCY', () => {
    setValidEnv();
    process.env.WORKER_CONCURRENCY = '0';
    expect(() => loadConfig()).toThrow(/WORKER_CONCURRENCY/);
  });

  it('flags production mode', () => {
    setValidEnv();
    process.env.NODE_ENV = 'production';
    expect(loadConfig().isProduction).toBe(true);
  });

  it('applies the webhook timeout default and accepts overrides', () => {
    setValidEnv();
    expect(loadConfig().webhookTimeoutMs).toBe(10_000);
    process.env.WEBHOOK_TIMEOUT_MS = '2500';
    expect(loadConfig().webhookTimeoutMs).toBe(2_500);
  });

  it('rejects an out-of-range WEBHOOK_TIMEOUT_MS', () => {
    setValidEnv();
    process.env.WEBHOOK_TIMEOUT_MS = '10';
    expect(() => loadConfig()).toThrow(/WEBHOOK_TIMEOUT_MS/);
  });

  it('keeps API_KEY and EMAIL_FROM optional but surfaced', () => {
    setValidEnv();
    const bare = loadConfig();
    expect(bare.apiKey).toBeUndefined();
    expect(bare.emailFrom).toBeUndefined();
    process.env.API_KEY = 'a-key-at-least-16ch';
    process.env.EMAIL_FROM = 'nds@example.com';
    const full = loadConfig();
    expect(full.apiKey).toBe('a-key-at-least-16ch');
    expect(full.emailFrom).toBe('nds@example.com');
  });

  it('rejects an API_KEY shorter than 16 characters', () => {
    setValidEnv();
    process.env.API_KEY = 'short';
    expect(() => loadConfig()).toThrow(/API_KEY/);
  });
});
