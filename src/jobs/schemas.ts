import { z } from 'zod';

export const NOTIFICATION_TYPES = ['email', 'webhook'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const emailPayloadSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().max(100_000),
});
export type EmailPayload = z.infer<typeof emailPayloadSchema>;

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'url must use http or https' },
  );

export const webhookPayloadSchema = z.object({
  url: httpUrlSchema,
  event: z.string().min(1).max(255),
  data: z.unknown().optional(),
});
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export class InvalidJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobError';
  }
}

/**
 * The wire format (API boundary) uses snake_case per the PDR; internally we
 * normalize to camelCase so the rest of the codebase is idiomatic.
 */
const requestSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(255),
});

export type ParsedJobRequest = {
  type: NotificationType;
  payload: EmailPayload | WebhookPayload;
  idempotencyKey: string;
};

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
    .join('; ');
}

export function parseJobRequest(input: unknown): ParsedJobRequest {
  const envelope = requestSchema.safeParse(input);
  if (!envelope.success) {
    throw new InvalidJobError(`invalid job request -> ${formatIssues(envelope.error.issues)}`);
  }
  const { type, payload, idempotency_key } = envelope.data;
  const payloadSchema = type === 'email' ? emailPayloadSchema : webhookPayloadSchema;
  const parsedPayload = payloadSchema.safeParse(payload);
  if (!parsedPayload.success) {
    throw new InvalidJobError(
      `invalid ${type} payload -> ${formatIssues(parsedPayload.error.issues)}`,
    );
  }
  return { type, payload: parsedPayload.data as ParsedJobRequest['payload'], idempotencyKey: idempotency_key };
}

/**
 * Envelope stored inside the queue job's data field. Payload stays `unknown`
 * here on purpose: the worker re-validates at processing time — data that
 * crossed a process boundary is never trusted blindly.
 */
export const jobEnvelopeSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  payload: z.unknown(),
  idempotencyKey: z.string().min(1).max(255),
});
export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
