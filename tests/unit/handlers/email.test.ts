import { describe, expect, it, vi } from 'vitest';
import { buildResendEmailProvider } from '../../../src/handlers/email.js';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('buildResendEmailProvider', () => {
  it('throws loudly when credentials are missing (no silent no-op)', () => {
    expect(() =>
      buildResendEmailProvider({ apiKey: undefined, from: undefined }),
    ).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
  });

  it('sends a properly structured request and parses the provider id', async () => {
    const httpClient = { fetch: vi.fn(async () => okResponse({ id: 're_123' })) };
    const provider = buildResendEmailProvider({
      apiKey: 're_test',
      from: 'nds@example.com',
      httpClient,
    });
    const result = await provider.send({
      from: 'nds@example.com',
      to: 'user@example.com',
      subject: 'Hi',
      body: 'Hello',
    });
    expect(result).toEqual({ id: 're_123' });
    const [url, init] = (httpClient.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ from: 'nds@example.com', to: ['user@example.com'], subject: 'Hi', text: 'Hello' });
  });

  it.each([500, 502, 503, 504, 429, 408])('classifies HTTP %i as transient', async (status) => {
    const httpClient = { fetch: vi.fn(async () => new Response(null, { status })) };
    const provider = buildResendEmailProvider({ apiKey: 're_test', from: 'a@b.co', httpClient });
    await expect(provider.send({ from: 'a@b.co', to: 'x@y.co', subject: 's', body: 'b' })).rejects.toMatchObject({
      kind: 'transient',
    });
  });

  it.each([400, 401, 403, 404, 422])('classifies HTTP %i as permanent', async (status) => {
    const httpClient = { fetch: vi.fn(async () => new Response(null, { status })) };
    const provider = buildResendEmailProvider({ apiKey: 're_test', from: 'a@b.co', httpClient });
    await expect(provider.send({ from: 'a@b.co', to: 'x@y.co', subject: 's', body: 'b' })).rejects.toMatchObject({
      kind: 'permanent',
    });
  });

  it('classifies network-level failures as transient', async () => {
    const httpClient = {
      fetch: vi.fn(async () => {
        throw new Error('EAI_AGAIN');
      }),
    };
    const provider = buildResendEmailProvider({ apiKey: 're_test', from: 'a@b.co', httpClient });
    await expect(provider.send({ from: 'a@b.co', to: 'x@y.co', subject: 's', body: 'b' })).rejects.toMatchObject({
      kind: 'transient',
    });
  });
});
