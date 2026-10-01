import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../errors.js';

/**
 * Static bearer-token auth (TDR §11). Deliberately fail-closed: an unset
 * API_KEY disables the API entirely rather than leaving it open — a missing
 * secret must never silently become "allow all".
 */
export function requireBearerToken(apiKey: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next(new UnauthorizedError());
      return;
    }
    const header = req.headers.authorization;
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
    const token = match?.[1]?.trim();
    if (!token || token.length !== apiKey.length || !timingSafeEqual(token, apiKey)) {
      next(new UnauthorizedError());
      return;
    }
    next();
  };
}

/** Length-matched comparison; short-circuits on length to stay constant-time. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
