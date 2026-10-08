import type { Lifecycle } from "./lifecycle.ts";
import type { Logger } from "./logging.ts";

/** Graceful shutdown on OS signals. Owner: FOUNDATION. A second signal forces exit(1). */
export interface SignalSource {
  on(signal: string, fn: () => void): unknown;
  off(signal: string, fn: () => void): unknown;
}
export interface SignalOptions {
  readonly logger: Logger;
  readonly source: SignalSource;
  readonly exit: (code: number) => void;
  readonly signals?: readonly string[];
}
export function installSignalHandlers(lifecycle: Lifecycle, opts: SignalOptions): () => void {
  const signals = opts.signals ?? ["SIGINT", "SIGTERM"];
  let shuttingDown = false;
  const handlers = signals.map((signal) => {
    const fn = () => {
      if (shuttingDown) { opts.logger.warn("second shutdown signal; forcing exit", { signal }); opts.exit(1); return; }
      shuttingDown = true;
      opts.logger.info("shutdown signal received", { signal });
      lifecycle.stop().then(
        (r) => opts.exit(r.clean ? 0 : 1),
        (e) => { opts.logger.error("shutdown failed", { error: e }); opts.exit(1); },
      );
    };
    opts.source.on(signal, fn);
    return [signal, fn] as const;
  });
  return () => { for (const [s, fn] of handlers) opts.source.off(s, fn); };
}
