import { describe, expect, it } from 'vitest';
import {
  InvalidJobError,
  emailPayloadSchema,
  parseJobRequest,
  webhookPayloadSchema,
} from '../../../src/jobs/schemas.js';

describe('emailPayloadSchema', () => {
  it('accepts a well-formed email payload', () => {
    const result = emailPayloadSchema.safeParse({
      to: 'user@example.com',
      subject: 'Welcome',
      body: 'Hello there',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed recipient', () => {
    const result = emailPayloadSchema.safeParse({
      to: 'not-an-email',
      subject: 'Welcome',
      body: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty subject', () => {
    const result = emailPayloadSchema.safeParse({
      to: 'user@example.com',
      subject: '',
      body: 'Hello',
    });
    expect(result.success).toBe(false);
  });
});

describe('webhookPayloadSchema', () => {
  it('accepts a well-formed webhook payload', () => {
    const result = webhookPayloadSchema.safeParse({
      url: 'https://example.com/hooks',
      event: 'order.shipped',
      data: { orderId: 42 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-http(s) url', () => {
    const result = webhookPayloadSchema.safeParse({
      url: 'ftp://example.com',
      event: 'order.shipped',
    });
    expect(result.success).toBe(false);
  });
});

describe('parseJobRequest', () => {
  const validRequest = {
    type: 'email',
    payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
    idempotency_key: 'welcome-user-42',
  };

  it('parses a valid request into a typed envelope', () => {
    const parsed = parseJobRequest(validRequest);
    expect(parsed).toEqual({
      type: 'email',
      payload: { to: 'user@example.com', subject: 'Hi', body: 'Hello' },
      idempotencyKey: 'welcome-user-42',
    });
  });

  it('rejects an unknown job type', () => {
    expect(() => parseJobRequest({ ...validRequest, type: 'sms' })).toThrow(InvalidJobError);
  });

  it('rejects a missing idempotency key', () => {
    const withoutKey = { ...validRequest } as Partial<typeof validRequest>;
    delete withoutKey.idempotency_key;
    expect(() => parseJobRequest(withoutKey)).toThrow(/idempotency_key/);
  });

  it('rejects a payload that does not match the declared type', () => {
    expect(() =>
      parseJobRequest({ ...validRequest, payload: { url: 'https://x.dev', event: 'e' } }),
    ).toThrow(InvalidJobError);
  });

  it('rejects null and non-object input', () => {
    expect(() => parseJobRequest(null)).toThrow(InvalidJobError);
    expect(() => parseJobRequest('job')).toThrow(InvalidJobError);
  });
});
