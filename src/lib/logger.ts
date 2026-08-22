import pino from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type Logger = pino.Logger;

/**
 * JSON logs in production (machine-parseable, greppable by jobId),
 * pretty logs in development. Never log raw payloads — log IDs and
 * counts so credentials or user content never reach the log stream.
 */
export function buildLogger(opts: { level: LogLevel; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    base: undefined, // drop pid/hostname noise; add context via child loggers
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(opts.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}
