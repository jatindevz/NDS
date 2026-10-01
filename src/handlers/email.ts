import type { EmailProvider } from './providers.js';
import { ProviderFailure, classifyHttpStatus } from './providers.js';

/**
 * Email delivery via Resend's REST API (TDR §2). Uses fetch directly — one
 * endpoint, no SDK. Network-level failures (DNS, timeout, abort) are always
 * transient; HTTP-level failures are classified by status code.
 */
export function buildResendEmailProvider(deps: {
  apiKey: string | undefined;
  from: string | undefined;
  httpClient?: { fetch(url: string, init: RequestInit): Promise<Response> };
}): EmailProvider {
  if (!deps.apiKey || !deps.from) {
    // Fail loud and unrecoverable: a worker started without credentials must
    // not "succeed" by silently doing nothing (worker/index.ts precedent).
    throw new Error(
      'email handler requires RESEND_API_KEY and EMAIL_FROM to be configured',
    );
  }
  const http = deps.httpClient ?? { fetch: (url, init) => fetch(url, init) };

  return {
    async send(input) {
      let response: Response;
      try {
        response = await http.fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: input.from,
            to: [input.to],
            subject: input.subject,
            text: input.body,
          }),
        });
      } catch (err) {
        throw new ProviderFailure('transient', `resend request failed: ${String(err)}`, { cause: err });
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ProviderFailure(
          classifyHttpStatus(response.status),
          `resend returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        );
      }
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { id: body.id ?? '' };
    },
  };
}
