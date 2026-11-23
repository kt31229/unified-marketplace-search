/**
 * Shared timeout and abortable sleep utilities used across Marketplace adapters
 * and the search orchestrator.
 */

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createTimeoutRace<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  label = 'Marketplace',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`${label} request timed out after ${timeoutMs}ms`), {
          isTimeout: true,
        }),
      );
    }, timeoutMs);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (val) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  if ('isTimeout' in err && (err as { isTimeout?: boolean }).isTimeout) {
    return true;
  }
  if (err instanceof Error) {
    return (
      err.name === 'TimeoutError' ||
      /timeout/i.test(err.message) ||
      /timed out/i.test(err.message)
    );
  }
  return false;
}
