/**
 * Provider ports: the handlers depend on these narrow interfaces, never on
 * concrete HTTP clients, so tests inject fakes instead of stubbing global
 * fetch or hitting real APIs.
 */

export type ResendSendInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type ProviderErrorKind = 'transient' | 'permanent';

/** Errors that tell the worker whether to retry (transient) or poison (permanent). */
export class ProviderFailure extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ProviderFailure';
    this.kind = kind;
    this.cause = options?.cause;
  }
}

export interface EmailProvider {
  send(input: ResendSendInput): Promise<{ id: string }>;
}

export interface HttpClient {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export class FetchHttpClient implements HttpClient {
  async fetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Classifies an HTTP status against the transient/permanent boundary. */
export function classifyHttpStatus(status: number): ProviderErrorKind {
  return TRANSIENT_HTTP_STATUSES.has(status) ? 'transient' : 'permanent';
}
