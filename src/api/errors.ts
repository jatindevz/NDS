/**
 * Error taxonomy mapped to HTTP responses (TDR §7). Routes throw these;
 * errorMiddleware translates them — handlers never touch res.status().
 */

export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = { error, message, ...extra };
  }
}

export class UnauthorizedError extends HttpError {
  constructor() {
    super(401, 'unauthorized', 'missing or invalid bearer token');
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string) {
    super(404, 'not_found', `${resource} not found`);
  }
}

export class ValidationError extends HttpError {
  constructor(details: string) {
    super(400, 'validation_failed', details);
  }
}

export class ConflictError extends HttpError {
  constructor(error: string, message: string) {
    super(409, error, message);
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(component: string) {
    super(503, 'dependency_unavailable', `${component} is unavailable`);
  }
}
