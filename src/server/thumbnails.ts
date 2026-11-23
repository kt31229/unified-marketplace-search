import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MarketplaceId, WatchlistEntry } from '../shared/index.ts';
import type { FetchLike } from './adapters/types.ts';
import type { WatchlistRepository } from './db.ts';
import { getThumbnailsDir } from './paths.ts';

const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/;

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const ALLOWED_EXTS = new Set(Object.keys(EXT_TO_CONTENT_TYPE));

export function isSafeThumbnailFilename(filename: string): boolean {
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return false;
  }
  return SAFE_FILENAME_PATTERN.test(filename) && path.basename(filename) === filename;
}

export function getThumbnailContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TO_CONTENT_TYPE[ext] ?? 'application/octet-stream';
}

function resolveExtension(contentTypeHeader: string | null, thumbnailUrl: string): string {
  if (contentTypeHeader) {
    const mime = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';
    const mapped = CONTENT_TYPE_TO_EXT[mime];
    if (mapped) {
      return mapped;
    }
  }

  try {
    const urlExt = path.extname(new URL(thumbnailUrl).pathname).toLowerCase();
    if (ALLOWED_EXTS.has(urlExt)) {
      return urlExt === '.jpeg' ? '.jpg' : urlExt;
    }
  } catch {
    // Ignore invalid URL pathname
  }

  return '.jpg';
}

function makeKey(marketplace: MarketplaceId, listingId: string): string {
  return `${marketplace}:${listingId}`;
}

function makeHashPrefix(marketplace: MarketplaceId, listingId: string): string {
  return crypto.createHash('sha256').update(makeKey(marketplace, listingId)).digest('hex').slice(0, 24);
}

export interface ThumbnailCacheDeps {
  dataDir: string;
  watchlist: WatchlistRepository;
  fetchImpl?: FetchLike;
}

/**
 * Manages non-blocking background thumbnail downloads, safe local serving,
 * and immediate file cleanup when Watchlist Entries are deleted.
 */
export class ThumbnailCache {
  private readonly thumbnailsDir: string;
  private readonly fetchImpl: FetchLike;
  private readonly inFlight = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private disposed = false;

  constructor(private readonly deps: ThumbnailCacheDeps) {
    this.thumbnailsDir = path.resolve(getThumbnailsDir(deps.dataDir));
    this.fetchImpl = deps.fetchImpl ?? fetch;
    fs.mkdirSync(this.thumbnailsDir, { recursive: true });
  }

  resolveSafePath(filename: string): string | null {
    if (!isSafeThumbnailFilename(filename)) {
      return null;
    }
    const candidate = path.resolve(this.thumbnailsDir, filename);
    if (!candidate.startsWith(this.thumbnailsDir + path.sep)) {
      return null;
    }
    return candidate;
  }

  readCachedFile(filename: string): { bytes: Buffer; contentType: string } | null {
    const safePath = this.resolveSafePath(filename);
    if (!safePath || !fs.existsSync(safePath)) {
      return null;
    }
    const stat = fs.statSync(safePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      bytes: fs.readFileSync(safePath),
      contentType: getThumbnailContentType(filename),
    };
  }

  deleteFile(filename: string | null | undefined): void {
    if (!filename) {
      return;
    }
    const safePath = this.resolveSafePath(filename);
    if (!safePath) {
      return;
    }
    try {
      if (fs.existsSync(safePath)) {
        fs.unlinkSync(safePath);
      }
    } catch {
      // Ignore file unlink errors during cleanup
    }
  }

  cancel(marketplace: MarketplaceId, marketplaceListingId: string): void {
    const key = makeKey(marketplace, marketplaceListingId);
    const active = this.inFlight.get(key);
    if (active) {
      active.controller.abort();
      this.inFlight.delete(key);
    }
  }

  scheduleDownload(entry: WatchlistEntry): void {
    if (this.disposed || !entry.thumbnailUrl) {
      return;
    }

    const key = makeKey(entry.marketplace, entry.marketplaceListingId);
    this.cancel(entry.marketplace, entry.marketplaceListingId);

    const controller = new AbortController();
    const promise = this.downloadAndPersist(entry, controller.signal).finally(() => {
      const current = this.inFlight.get(key);
      if (current?.controller === controller) {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, { controller, promise });
  }

  private async downloadAndPersist(entry: WatchlistEntry, signal: AbortSignal): Promise<void> {
    if (!entry.thumbnailUrl || signal.aborted || this.disposed) {
      return;
    }

    try {
      const response = await this.fetchImpl(entry.thumbnailUrl, { signal });
      if (!response.ok || signal.aborted || this.disposed) {
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength === 0 || signal.aborted || this.disposed) {
        return;
      }

      const ext = resolveExtension(response.headers.get('content-type'), entry.thumbnailUrl);
      const filename = `${makeHashPrefix(entry.marketplace, entry.marketplaceListingId)}${ext}`;
      const safePath = this.resolveSafePath(filename);
      if (!safePath) {
        return;
      }

      fs.mkdirSync(this.thumbnailsDir, { recursive: true });
      fs.writeFileSync(safePath, Buffer.from(arrayBuffer));

      if (signal.aborted || this.disposed) {
        this.deleteFile(filename);
        return;
      }

      const updated = this.deps.watchlist.updateCachedThumbnailPath(
        entry.marketplace,
        entry.marketplaceListingId,
        filename,
        entry.savedAt,
      );
      if (!updated) {
        this.deleteFile(filename);
      }
    } catch {
      // Swallow download/write failures so the Watchlist Entry stays saved with remote URL fallback
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = Array.from(this.inFlight.values());
    for (const item of pending) {
      item.controller.abort();
    }
    this.inFlight.clear();
    await Promise.allSettled(pending.map((item) => item.promise));
  }
}
