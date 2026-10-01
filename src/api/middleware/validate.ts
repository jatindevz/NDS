import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { ValidationError } from '../errors.js';

/**
 * Validates a portion of the request against a zod schema and replaces it
 * with the parsed (coerced, defaulted) value. Oversized bodies are rejected
 * by express.json's limit before this runs; this covers structural checks.
 */
export function validate<T extends z.ZodType>(
  source: 'body' | 'params' | 'query',
  schema: T,
): (req: Request, _res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || source}: ${issue.message}`)
        .join('; ');
      next(new ValidationError(details));
      return;
    }
    Object.defineProperty(req, source, { value: parsed.data, writable: true, configurable: true });
    next();
  };
}
