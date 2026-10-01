import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { Logger } from 'pino';
import { InvalidJobError } from '../jobs/schemas.js';
import { ProviderFailure, classifyHttpStatus } from './providers.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * SSRF guard (TDR §11): a webhook targets a customer-chosen URL, so the
 * worker — which holds cloud credentials and sits inside the VPC — must not
 * become a proxy into the internal network.
 *
 * Defense-in-depth:
 *  1. hostname blocklist (localhost, cloud metadata endpoints)
 *  2. resolve DNS and validate every returned address against private,
 *    loopback, and link-local ranges — defeats hostname-spoof bypasses
 *  3. fail-closed on unparseable/unresolvable/unknown addresses.
 *
 * Scope note: this is a solid baseline, not a hard security boundary. The
 * TOCTOU window between this check and the actual connection (DNS rebinding)
 * remains; closing it requires connect-by-IP with SNI pinning or an egress
 * proxy — documented as a deliberate non-goal for this scope.
 */
export async function assertUrlIsPubliclyRoutable(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InvalidJobError('webhook url is not parseable');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new InvalidJobError('webhook url must use http or https');
  }
  // WHATWG URL keeps brackets in hostname for IPv6 literals ([::1]);
  // strip them so isIP() can classify the address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new InvalidJobError(`webhook url points at blocked host '${hostname}'`);
  }
  if (isIP(hostname) !== 0) {
    // Literal IPs skip DNS; validate the literal directly.
    assertPublicIp(hostname, 'literal ip');
    return;
  }

  let resolved: LookupAddress[];
  try {
    resolved = await lookup(hostname, { all: true });
  } catch (err) {
    // NXDOMAIN is a typo'd/dead domain (permanent); SERVFAIL/timeout can
    // clear on retry, so only ENOTFOUND poisons the job.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOTFOUND') {
      throw new InvalidJobError(`webhook url host '${hostname}' does not exist`);
    }
    throw new ProviderFailure('transient', `webhook url could not be resolved: ${String(err)}`);
  }
  if (resolved.length === 0) {
    throw new InvalidJobError('webhook url resolved to no addresses');
  }
  for (const addr of resolved) {
    assertPublicIp(addr.address, `resolved '${hostname}'`);
  }
}

export class PrivateAddressError extends InvalidJobError {
  constructor(ip: string, context: string) {
    super(`${context} address ${ip} is private or reserved — blocked by SSRF guard`);
  }
}

function assertPublicIp(ip: string, context: string): void {
  if (isIpv6MappedIpv4(ip)) {
    throw new PrivateAddressError(ip, context);
  }
  if (isIP(ip) === 0) {
    throw new InvalidJobError(`${context} address ${ip} is not a valid IP`);
  }
  if (isPrivateIp(ip)) {
    throw new PrivateAddressError(ip, context);
  }
}

function isIpv6MappedIpv4(ip: string): boolean {
  return ip.toLowerCase().startsWith('::ffff:');
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // unknown => block (fail-closed)
}

function isPrivateIpv4(ip: string): boolean {
  return RESERVED_IPV4_RANGES.some(([range, bits]) => ipInCidr(ip, range, bits));
}

const RESERVED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipInCidr(ip: string, range: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function isPrivateIpv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  if (/^fe[89ab]/.test(norm)) return true; // link-local
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // unique-local
  if (norm.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Delivers a webhook: POSTs the payload JSON with the idempotency key both
 * in a header and in the body, so receivers can dedupe end-to-end (TDR §8)
 * even if they never read our queue semantics.
 */
export function buildWebhookHandler(deps: {
  httpClient: { fetch: (url: string, init: RequestInit) => Promise<Response> };
  timeoutMs: number;
  logger: Logger;
}) {
  return async function handleWebhook(
    payload: unknown,
    ctx: { logger: Logger; idempotencyKey: string },
  ): Promise<void> {
    const { url, event, data } = payload as { url?: string; event?: string; data?: unknown };
    if (!url || !event) {
      throw new InvalidJobError('webhook payload missing url or event');
    }

    await assertUrlIsPubliclyRoutable(url);

    const response = await deps.httpClient
      .fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': ctx.idempotencyKey,
          'user-agent': 'nds-notification-service/0.1',
        },
        body: JSON.stringify({ event, data, idempotency_key: ctx.idempotencyKey }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      })
      .catch((err: unknown) => {
        throw new ProviderFailure('transient', `webhook request failed: ${String(err)}`);
      });

    if (!response.ok) {
      const message = `webhook ${url} returned ${response.status}`;
      if (classifyHttpStatus(response.status) === 'permanent') {
        // 4xx (bad URL, gone, rejected): retrying can never succeed — poison.
        throw new InvalidJobError(message);
      }
      throw new ProviderFailure('transient', message);
    }
    ctx.logger.debug({ url, event }, 'webhook delivered');
  };
}
