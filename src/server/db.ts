import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AppSettingsSchema,
  WatchlistEntrySchema,
  createDefaultAppSettings,
  createDefaultMarketplaceRetrySettings,
  sortWatchlistEntries,
  type AppSettings,
  type MarketplaceId,
  type WatchlistEntry,
  type WatchlistSnapshotInput,
  type WatchlistSortOrder,
} from '../shared/index.ts';
import { SavedSearchesRepository } from './saved-searches-repo.ts';

interface Migration {
  version: number;
  apply: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          browser_channel TEXT NOT NULL,
          home_postal_code TEXT,
          default_local_pickup_radius_miles INTEGER NOT NULL,
          home_facebook_city_slug TEXT,
          facebook_radius_miles INTEGER NOT NULL,
          facebook_city_hubs_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      const defaults = createDefaultAppSettings();
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO app_settings (
          id,
          browser_channel,
          home_postal_code,
          default_local_pickup_radius_miles,
          home_facebook_city_slug,
          facebook_radius_miles,
          facebook_city_hubs_json,
          updated_at
        ) VALUES (
          1,
          :browserChannel,
          :homePostalCode,
          :defaultLocalPickupRadiusMiles,
          :homeFacebookCitySlug,
          :facebookRadiusMiles,
          :facebookCityHubsJson,
          :updatedAt
        )
      `);
      stmt.setAllowBareNamedParameters(true);
      stmt.run({
        browserChannel: defaults.browserChannel,
        homePostalCode: defaults.homePostalCode,
        defaultLocalPickupRadiusMiles: defaults.defaultLocalPickupRadiusMiles,
        homeFacebookCitySlug: defaults.homeFacebookCitySlug,
        facebookRadiusMiles: defaults.facebookRadiusMiles,
        facebookCityHubsJson: JSON.stringify(defaults.facebookCityHubs),
        updatedAt: new Date().toISOString(),
      });
    },
  },
  {
    version: 2,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          keywords TEXT NOT NULL,
          unified_filters_json TEXT NOT NULL,
          marketplaces_json TEXT NOT NULL,
          sort_order TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_run_at TEXT,
          display_order INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS watchlist_entries (
          id TEXT PRIMARY KEY,
          marketplace TEXT NOT NULL,
          marketplace_listing_id TEXT NOT NULL,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          price REAL,
          shipping_price REAL,
          thumbnail_url TEXT,
          cached_thumbnail_path TEXT,
          saved_at TEXT NOT NULL,
          UNIQUE(marketplace, marketplace_listing_id)
        );
      `);
    },
  },
  {
    version: 4,
    apply: (db) => {
      db.exec(`ALTER TABLE app_settings ADD COLUMN retry_settings_json TEXT;`);
      const defaults = JSON.stringify(createDefaultMarketplaceRetrySettings());
      const stmt = db.prepare(`
        UPDATE app_settings
        SET retry_settings_json = :retrySettingsJson
        WHERE retry_settings_json IS NULL
      `);
      stmt.setAllowBareNamedParameters(true);
      stmt.run({ retrySettingsJson: defaults });
    },
  },
  {
    version: 5,
    apply: (db) => {
      db.exec(`ALTER TABLE app_settings ADD COLUMN facebook_cooldown_profile TEXT;`);
      db.exec(
        `UPDATE app_settings SET facebook_cooldown_profile = 'conservative' WHERE facebook_cooldown_profile IS NULL;`,
      );
    },
  },
];

export interface AppSettingsRow {
  browser_channel: string;
  home_postal_code: string | null;
  default_local_pickup_radius_miles: number;
  home_facebook_city_slug: string | null;
  facebook_radius_miles: number;
  facebook_city_hubs_json: string;
  facebook_cooldown_profile: string | null;
  retry_settings_json: string | null;
}

export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getSettings(): AppSettings {
    const row = this.db
      .prepare(
        `SELECT
          browser_channel,
          home_postal_code,
          default_local_pickup_radius_miles,
          home_facebook_city_slug,
          facebook_radius_miles,
          facebook_city_hubs_json,
          facebook_cooldown_profile,
          retry_settings_json
        FROM app_settings
        WHERE id = 1`,
      )
      .get() as AppSettingsRow | undefined;

    if (!row) {
      return createDefaultAppSettings();
    }

    return AppSettingsSchema.parse({
      browserChannel: row.browser_channel,
      homePostalCode: row.home_postal_code,
      defaultLocalPickupRadiusMiles: row.default_local_pickup_radius_miles,
      homeFacebookCitySlug: row.home_facebook_city_slug,
      facebookRadiusMiles: row.facebook_radius_miles,
      facebookCityHubs: JSON.parse(row.facebook_city_hubs_json),
      facebookCooldownProfile: row.facebook_cooldown_profile ?? 'conservative',
      retrySettings: row.retry_settings_json
        ? JSON.parse(row.retry_settings_json)
        : createDefaultMarketplaceRetrySettings(),
    });
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const merged = AppSettingsSchema.parse({
      ...current,
      ...partial,
      homePostalCode:
        partial.homePostalCode === '' ? null : (partial.homePostalCode ?? current.homePostalCode),
      homeFacebookCitySlug:
        partial.homeFacebookCitySlug === ''
          ? null
          : (partial.homeFacebookCitySlug ?? current.homeFacebookCitySlug),
      retrySettings: partial.retrySettings
        ? { ...current.retrySettings, ...partial.retrySettings }
        : current.retrySettings,
    });

    const stmt = this.db.prepare(`
      UPDATE app_settings
      SET
        browser_channel = :browserChannel,
        home_postal_code = :homePostalCode,
        default_local_pickup_radius_miles = :defaultLocalPickupRadiusMiles,
        home_facebook_city_slug = :homeFacebookCitySlug,
        facebook_radius_miles = :facebookRadiusMiles,
        facebook_city_hubs_json = :facebookCityHubsJson,
        facebook_cooldown_profile = :facebookCooldownProfile,
        retry_settings_json = :retrySettingsJson,
        updated_at = :updatedAt
      WHERE id = 1
    `);
    stmt.setAllowBareNamedParameters(true);
    stmt.run({
      browserChannel: merged.browserChannel,
      homePostalCode: merged.homePostalCode,
      defaultLocalPickupRadiusMiles: merged.defaultLocalPickupRadiusMiles,
      homeFacebookCitySlug: merged.homeFacebookCitySlug,
      facebookRadiusMiles: merged.facebookRadiusMiles,
      facebookCityHubsJson: JSON.stringify(merged.facebookCityHubs),
      facebookCooldownProfile: merged.facebookCooldownProfile,
      retrySettingsJson: JSON.stringify(merged.retrySettings),
      updatedAt: new Date().toISOString(),
    });

    return merged;
  }
}

export interface WatchlistEntryRow {
  id: string;
  marketplace: string;
  marketplace_listing_id: string;
  url: string;
  title: string;
  price: number | null;
  shipping_price: number | null;
  thumbnail_url: string | null;
  cached_thumbnail_path: string | null;
  saved_at: string;
}

function mapWatchlistRow(row: WatchlistEntryRow): WatchlistEntry {
  return WatchlistEntrySchema.parse({
    marketplace: row.marketplace,
    marketplaceListingId: row.marketplace_listing_id,
    url: row.url,
    title: row.title,
    price: row.price,
    shippingPrice: row.shipping_price,
    thumbnailUrl: row.thumbnail_url,
    cachedThumbnailPath: row.cached_thumbnail_path,
    savedAt: row.saved_at,
  });
}

export class WatchlistRepository {
  constructor(private readonly db: DatabaseSync) {}

  listEntries(
    options: { marketplace?: MarketplaceId; sort?: WatchlistSortOrder } = {},
  ): WatchlistEntry[] {
    let rows: WatchlistEntryRow[];
    if (options.marketplace) {
      const stmt = this.db.prepare(`
        SELECT
          id,
          marketplace,
          marketplace_listing_id,
          url,
          title,
          price,
          shipping_price,
          thumbnail_url,
          cached_thumbnail_path,
          saved_at
        FROM watchlist_entries
        WHERE marketplace = :marketplace
        ORDER BY saved_at DESC
      `);
      stmt.setAllowBareNamedParameters(true);
      rows = stmt.all({ marketplace: options.marketplace }) as unknown as WatchlistEntryRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT
            id,
            marketplace,
            marketplace_listing_id,
            url,
            title,
            price,
            shipping_price,
            thumbnail_url,
            cached_thumbnail_path,
            saved_at
          FROM watchlist_entries
          ORDER BY saved_at DESC`,
        )
        .all() as unknown as WatchlistEntryRow[];
    }

    const entries = rows.map(mapWatchlistRow);
    return sortWatchlistEntries(entries, options.sort ?? 'saved_desc');
  }

  getEntry(marketplace: MarketplaceId, marketplaceListingId: string): WatchlistEntry | null {
    const stmt = this.db.prepare(`
      SELECT
        id,
        marketplace,
        marketplace_listing_id,
        url,
        title,
        price,
        shipping_price,
        thumbnail_url,
        cached_thumbnail_path,
        saved_at
      FROM watchlist_entries
      WHERE marketplace = :marketplace
        AND marketplace_listing_id = :marketplaceListingId
    `);
    stmt.setAllowBareNamedParameters(true);
    const row = stmt.get({
      marketplace,
      marketplaceListingId,
    }) as WatchlistEntryRow | undefined;

    return row ? mapWatchlistRow(row) : null;
  }

  upsertEntry(
    input: WatchlistSnapshotInput,
    savedAt: string,
  ): { entry: WatchlistEntry; previousCachedThumbnailPath: string | null } {
    const existing = this.getEntry(input.marketplace, input.marketplaceListingId);
    const previousCachedThumbnailPath = existing?.cachedThumbnailPath ?? null;

    const stmt = this.db.prepare(`
      INSERT INTO watchlist_entries (
        id,
        marketplace,
        marketplace_listing_id,
        url,
        title,
        price,
        shipping_price,
        thumbnail_url,
        cached_thumbnail_path,
        saved_at
      ) VALUES (
        :id,
        :marketplace,
        :marketplaceListingId,
        :url,
        :title,
        :price,
        :shippingPrice,
        :thumbnailUrl,
        NULL,
        :savedAt
      )
      ON CONFLICT(marketplace, marketplace_listing_id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        price = excluded.price,
        shipping_price = excluded.shipping_price,
        thumbnail_url = excluded.thumbnail_url,
        cached_thumbnail_path = NULL,
        saved_at = excluded.saved_at
    `);
    stmt.setAllowBareNamedParameters(true);
    stmt.run({
      id: crypto.randomUUID(),
      marketplace: input.marketplace,
      marketplaceListingId: input.marketplaceListingId,
      url: input.url,
      title: input.title,
      price: input.price ?? null,
      shippingPrice: input.shippingPrice ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      savedAt,
    });

    const entry = this.getEntry(input.marketplace, input.marketplaceListingId);
    if (!entry) {
      throw new Error('Failed to persist Watchlist Entry');
    }

    return { entry, previousCachedThumbnailPath };
  }

  updateCachedThumbnailPath(
    marketplace: MarketplaceId,
    marketplaceListingId: string,
    cachedThumbnailPath: string | null,
    expectedSavedAt?: string,
  ): boolean {
    if (expectedSavedAt !== undefined) {
      const stmt = this.db.prepare(`
        UPDATE watchlist_entries
        SET cached_thumbnail_path = :cachedThumbnailPath
        WHERE marketplace = :marketplace
          AND marketplace_listing_id = :marketplaceListingId
          AND saved_at = :expectedSavedAt
      `);
      stmt.setAllowBareNamedParameters(true);
      const res = stmt.run({
        cachedThumbnailPath,
        marketplace,
        marketplaceListingId,
        expectedSavedAt,
      });
      return Number(res.changes) > 0;
    }

    const stmt = this.db.prepare(`
      UPDATE watchlist_entries
      SET cached_thumbnail_path = :cachedThumbnailPath
      WHERE marketplace = :marketplace
        AND marketplace_listing_id = :marketplaceListingId
    `);
    stmt.setAllowBareNamedParameters(true);
    const res = stmt.run({
      cachedThumbnailPath,
      marketplace,
      marketplaceListingId,
    });
    return Number(res.changes) > 0;
  }

  deleteEntry(marketplace: MarketplaceId, marketplaceListingId: string): WatchlistEntry | null {
    const existing = this.getEntry(marketplace, marketplaceListingId);
    if (!existing) {
      return null;
    }

    const stmt = this.db.prepare(`
      DELETE FROM watchlist_entries
      WHERE marketplace = :marketplace
        AND marketplace_listing_id = :marketplaceListingId
    `);
    stmt.setAllowBareNamedParameters(true);
    stmt.run({ marketplace, marketplaceListingId });
    return existing;
  }

  deleteEntryById(id: string): WatchlistEntry | null {
    const selectStmt = this.db.prepare(`
      SELECT
        id,
        marketplace,
        marketplace_listing_id,
        url,
        title,
        price,
        shipping_price,
        thumbnail_url,
        cached_thumbnail_path,
        saved_at
      FROM watchlist_entries
      WHERE id = :id
    `);
    selectStmt.setAllowBareNamedParameters(true);
    const row = selectStmt.get({ id }) as WatchlistEntryRow | undefined;
    if (!row) {
      return null;
    }

    const delStmt = this.db.prepare('DELETE FROM watchlist_entries WHERE id = :id');
    delStmt.setAllowBareNamedParameters(true);
    delStmt.run({ id });
    return mapWatchlistRow(row);
  }
}

export interface AppDatabase {
  db: DatabaseSync;
  settings: SettingsRepository;
  savedSearches: SavedSearchesRepository;
  watchlist: WatchlistRepository;
  getUserVersion: () => number;
  close: () => void;
}

function runMigrations(db: DatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  let currentVersion = versionRow?.user_version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec('BEGIN');
      try {
        migration.apply(db);
        db.exec(`PRAGMA user_version = ${migration.version};`);
        db.exec('COMMIT');
        currentVersion = migration.version;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }
}

/**
 * Opens data.sqlite in WAL mode, runs PRAGMA user_version migrations, and exposes typed repositories.
 */
export function openDatabase(dataDir: string): AppDatabase {
  const dbPath = path.join(dataDir, 'data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  runMigrations(db);

  let closed = false;

  return {
    db,
    settings: new SettingsRepository(db),
    savedSearches: new SavedSearchesRepository(db),
    watchlist: new WatchlistRepository(db),
    getUserVersion: () => {
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
      return row?.user_version ?? 0;
    },
    close: () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
