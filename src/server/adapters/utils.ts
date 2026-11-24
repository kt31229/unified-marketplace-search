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

const MAX_UPSTREAM_ERROR_LEN = 160;

function pickNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function pickScalarCode(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return pickNonEmptyString(value);
}

function truncateSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_UPSTREAM_ERROR_LEN) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_UPSTREAM_ERROR_LEN - 3)}...`;
}

/**
 * Extracts a compact, single-line summary from common upstream Marketplace error payloads
 * (Poshmark `error`, eBay/Mercari/Facebook `errors[]`, or top-level `message`).
 */
export function summarizeUpstreamError(rawBody: unknown): string | null {
  if (!rawBody || typeof rawBody !== 'object') {
    return null;
  }
  const record = rawBody as Record<string, unknown>;

  if (typeof record.error === 'string') {
    const msg = pickNonEmptyString(record.error);
    return msg ? truncateSummary(msg) : null;
  }

  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const errObj = record.error as Record<string, unknown>;
    const type = pickNonEmptyString(errObj.errorType) ?? pickNonEmptyString(errObj.type);
    const code = pickScalarCode(errObj.pmErrorCode) ?? pickScalarCode(errObj.code);
    const status = pickScalarCode(errObj.statusCode) ?? pickScalarCode(errObj.status);
    const msg =
      pickNonEmptyString(errObj.errorMessage) ??
      pickNonEmptyString(errObj.userMessage) ??
      pickNonEmptyString(errObj.message);

    const head = [type, code ? `code ${code}` : null, status ? `status ${status}` : null]
      .filter(Boolean)
      .join(', ');
    const combined = [head, msg].filter(Boolean).join(': ');
    if (combined) {
      return truncateSummary(combined);
    }
  }

  if (Array.isArray(record.errors)) {
    for (const entry of record.errors) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const errObj = entry as Record<string, unknown>;
      const extensions =
        errObj.extensions && typeof errObj.extensions === 'object'
          ? (errObj.extensions as Record<string, unknown>)
          : null;
      const code =
        pickScalarCode(errObj.errorId) ??
        pickScalarCode(errObj.code) ??
        (extensions ? pickScalarCode(extensions.code) : null);
      const msg =
        pickNonEmptyString(errObj.summary) ??
        pickNonEmptyString(errObj.message) ??
        pickNonEmptyString(errObj.longMessage) ??
        pickNonEmptyString(errObj.description);

      const combined = [code ? `code ${code}` : null, msg].filter(Boolean).join(': ');
      if (combined) {
        return truncateSummary(combined);
      }
    }
  }

  const topMsg =
    pickNonEmptyString(record.message) ?? pickNonEmptyString(record.error_description);
  return topMsg ? truncateSummary(topMsg) : null;
}

export function formatErrorWithUpstreamDetail(baseMessage: string, rawBody: unknown): string {
  const detail = summarizeUpstreamError(rawBody);
  if (!detail) {
    return baseMessage;
  }
  if (baseMessage.endsWith('.')) {
    return `${baseMessage.slice(0, -1)} (${detail}).`;
  }
  return `${baseMessage} (${detail})`;
}
