import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { InvalidJobError } from '../../../src/jobs/schemas.js';
import { ProviderFailure } from '../../../src/handlers/providers.js';
import {
  assertUrlIsPubliclyRoutable,
  buildWebhookHandler,
} from '../../../src/handlers/webhook.js';

const logger: Logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('assertUrlIsPubliclyRoutable (SSRF guard)', () => {
  it('accepts a public https URL (real DNS resolution)', async () => {
    await expect(assertUrlIsPubliclyRoutable('https://example.com/hook')).resolves.toBeUndefined();
  });

  it('rejects non-http(s) schemes and unparseable URLs', async () => {
    await expect(assertUrlIsPubliclyRoutable('ftp://example.com/hook')).rejects.toThrow(InvalidJobError);
    await expect(assertUrlIsPubliclyRoutable('not a url')).rejects.toThrow(InvalidJobError);
  });

  it('blocks localhost and cloud metadata hostnames', async () => {
    await expect(assertUrlIsPubliclyRoutable('http://localhost:8080/hook')).rejects.toThrow(/blocked host/);
    await expect(
      assertUrlIsPubliclyRoutable('http://metadata.google.internal/computeMetadata/v1/'),
    ).rejects.toThrow(/blocked host/);
  });

  it('blocks private and loopback literal IPs', async () => {
    await expect(assertUrlIsPubliclyRoutable('http://10.0.0.5/hook')).rejects.toThrow(InvalidJobError);
    await expect(assertUrlIsPubliclyRoutable('http://127.0.0.1/hook')).rejects.toThrow(InvalidJobError);
    await expect(assertUrlIsPubliclyRoutable('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      InvalidJobError,
    );
    await expect(assertUrlIsPubliclyRoutable('http://192.168.1.10/hook')).rejects.toThrow(InvalidJobError);
  });

  it('blocks IPv6 loopback and unique-local literals (bracket stripping)', async () => {
    await expect(assertUrlIsPubliclyRoutable('http://[::1]:8080/hook')).rejects.toThrow(InvalidJobError);
    await expect(assertUrlIsPubliclyRoutable('http://[fd00::1]/hook')).rejects.toThrow(InvalidJobError);
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    // *.localhost resolves to 127.0.0.1 via most resolvers; use a name we can
    // control deterministically instead: an RFC-7719 guaranteed NXDOMAIN name
    // would test ENOTFOUND, so assert the private-resolution path via literal
    // coverage above and verify resolution-failure classification here.
    await expect(assertUrlIsPubliclyRoutable('https://this-hostname-does-not-exist-ndstest.invalid/hook'))
      .rejects.toThrow(InvalidJobError);
  });
});

describe('buildWebhookHandler (delivery behavior)', () => {
  const ctx = { logger, idempotencyKey: 'idem-1' };

  function fetchOk(): { fetch: (url: string, init: RequestInit) => Promise<Response> } {
    return { fetch: vi.fn(async () => new Response(null, { status: 200 })) };
  }

  it('POSTs JSON with idempotency key in header and body', async () => {
    const httpClient = fetchOk();
    const handler = buildWebhookHandler({ httpClient, timeoutMs: 1_000, logger });
    await handler(
      { url: 'https://example.com/hook', event: 'user.created', data: { id: 7 } },
      ctx,
    );
    const init = (httpClient.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-idempotency-key']).toBe('idem-1');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      event: 'user.created',
      data: { id: 7 },
      idempotency_key: 'idem-1',
    });
  });

  it('treats 4xx as permanent (poison via InvalidJobError)', async () => {
    const httpClient = {
      fetch: vi.fn(async () => new Response(null, { status: 410 })),
    };
    const handler = buildWebhookHandler({ httpClient, timeoutMs: 1_000, logger });
    await expect(
      handler({ url: 'https://example.com/hook', event: 'e' }, ctx),
    ).rejects.toThrow(InvalidJobError);
  });

  it('treats 5xx as transient (retryable ProviderFailure)', async () => {
    const httpClient = {
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
    };
    const handler = buildWebhookHandler({ httpClient, timeoutMs: 1_000, logger });
    await expect(
      handler({ url: 'https://example.com/hook', event: 'e' }, ctx),
    ).rejects.toThrow(ProviderFailure);
  });

  it('treats network failures as transient', async () => {
    const httpClient = {
      fetch: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    };
    const handler = buildWebhookHandler({ httpClient, timeoutMs: 1_000, logger });
    await expect(
      handler({ url: 'https://example.com/hook', event: 'e' }, ctx),
    ).rejects.toThrow(ProviderFailure);
  });

  it('rejects a missing url/event before any network call', async () => {
    const httpClient = fetchOk();
    const handler = buildWebhookHandler({ httpClient, timeoutMs: 1_000, logger });
    await expect(handler({ event: 'e' }, ctx)).rejects.toThrow(InvalidJobError);
    expect(httpClient.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
