import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AppSettingsSchema,
  createDefaultAppSettings,
  type AppSettings,
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
];

export interface AppSettingsRow {
  browser_channel: string;
  home_postal_code: string | null;
  default_local_pickup_radius_miles: number;
  home_facebook_city_slug: string | null;
  facebook_radius_miles: number;
  facebook_city_hubs_json: string;
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
          facebook_city_hubs_json
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
      updatedAt: new Date().toISOString(),
    });

    return merged;
  }
}

export interface AppDatabase {
  db: DatabaseSync;
  settings: SettingsRepository;
  savedSearches: SavedSearchesRepository;
  getUserVersion: () => number;
  close: () => void;
}

function runMigrations(db: DatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
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
