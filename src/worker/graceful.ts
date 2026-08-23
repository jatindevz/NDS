import type { Logger } from 'pino';

export type ShutdownComponent = {
  /** Human-readable name for logs. */
  name: string;
  /** Graceful close; should release resources and drain in-flight work. */
  close: () => Promise<void>;
  /** Last-resort synchronous teardown when close() exceeds the timeout. */
  forceKill?: () => void;
};

export type ShutdownResult = { clean: boolean };

/**
 * Orchestrates shutdown: components are closed in the order given (worker
 * first so active jobs drain before their redis connection disappears).
 * Each close gets its own timeout; on expiry we fall back to forceKill so
 * one hung component cannot keep the process alive indefinitely.
 */
export function registerGracefulShutdown(deps: {
  components: ShutdownComponent[];
  signals: NodeJS.Signals[];
  timeoutMs: number;
  logger: Logger;
}): { shutdown: () => Promise<ShutdownResult>; unregister: () => void } {
  let shuttingDown = false;

  async function shutdown(): Promise<ShutdownResult> {
    if (shuttingDown) {
      return { clean: false };
    }
    shuttingDown = true;
    deps.logger.info({ components: deps.components.map((c) => c.name) }, 'graceful shutdown started');
    let clean = true;
    for (const component of deps.components) {
      const ok = await closeWithTimeout(component, deps.timeoutMs, deps.logger);
      clean = clean && ok;
    }
    deps.logger.info({ clean }, 'graceful shutdown finished');
    return { clean };
  }

  const handler = () => {
    void shutdown();
  };
  for (const signal of deps.signals) {
    process.on(signal, handler);
  }

  return {
    shutdown,
    unregister: () => {
      for (const signal of deps.signals) {
        process.removeListener(signal, handler);
      }
    },
  };
}

async function closeWithTimeout(
  component: ShutdownComponent,
  timeoutMs: number,
  logger: Logger,
): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const attempt = component.close().then(
    () => true,
    (err) => {
      logger.error({ err, component: component.name }, 'component close failed');
      return false;
    },
  );
  const ok = await Promise.race([attempt, timeout]);
  if (!ok) {
    logger.warn({ component: component.name, timeoutMs }, 'component close timed out, forcing');
    try {
      component.forceKill?.();
    } catch (err) {
      logger.error({ err, component: component.name }, 'forceKill threw');
    }
  }
  return ok;
}
