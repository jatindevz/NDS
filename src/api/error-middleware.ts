import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { InvalidJobError } from '../jobs/schemas.js';
import { HttpError } from './errors.js';

/**
 * Translates thrown errors into HTTP responses (TDR §7). Routes never touch
 * res.status() for failures; they throw and this middleware decides.
 */
export const errorHandler =
  (logger: Logger): ErrorRequestHandler =>
  (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.body);
      return;
    }
    if (err instanceof InvalidJobError) {
      res.status(400).json({ error: 'validation_failed', message: err.message });
      return;
    }
    // Malformed JSON bodies arrive as SyntaxError from express.json.
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'validation_failed', message: 'request body is not valid JSON' });
      return;
    }
    logger.error({ err }, 'unhandled API error');
    res.status(500).json({ error: 'internal_error', message: 'unexpected server error' });
  };

/** JSON 404 for unknown routes instead of the Express HTML default. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'unknown route' });
};
