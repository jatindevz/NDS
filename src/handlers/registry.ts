import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { buildResendEmailProvider } from './email.js';
import { buildWebhookHandler } from './webhook.js';
import { runDelivery } from './delivery.js';
import type { EmailProvider } from './providers.js';
import type { HandlerContext, HandlerRegistry, NotificationHandler } from '../worker/handlers.js';

/**
 * Provider-agnostic handler contract, restated for implementers: a handler
 * either succeeds, throws InvalidJobError (permanent — poisoned on the first
 * attempt, never retried), or throws any other error (transient — BullMQ
 * retries with capped exponential backoff). runDelivery enforces the
 * ProviderFailure half of this automatically.
 */
export type RegistryBuildResult = {
  registry: HandlerRegistry;
  /** Non-fatal config gaps surfaced at startup (e.g. email disabled). */
  warnings: string[];
};

export function buildHandlerRegistry(deps: { config: AppConfig; logger: Logger }): RegistryBuildResult {
  const registry: HandlerRegistry = {};
  const warnings: string[] = [];

  if (deps.config.resendApiKey && deps.config.emailFrom) {
    const emailProvider: EmailProvider = buildResendEmailProvider({
      apiKey: deps.config.resendApiKey,
      from: deps.config.emailFrom,
    });
    const emailHandler: NotificationHandler = async (payload, ctx: HandlerContext) => {
      const p = payload as { to: string; subject: string; body: string };
      await runDelivery(() => emailProvider.send({ from: deps.config.emailFrom as string, ...p }));
      ctx.logger.info({ to: p.to }, 'email dispatched to provider');
    };
    registry.email = emailHandler;
  } else {
    // Deliberately no silent no-op email handler: unregistered types are
    // poisoned visibly by the processor, so a misconfigured deployment
    // fails loudly instead of pretending to deliver.
    warnings.push('email handler disabled: RESEND_API_KEY and EMAIL_FROM must both be set');
  }

  registry.webhook = buildWebhookHandler({
    httpClient: { fetch: (url, init) => fetch(url, init) },
    timeoutMs: deps.config.webhookTimeoutMs,
    logger: deps.logger,
  });

  return { registry, warnings };
}
