import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CreateSavedSearchInputSchema,
  SavedSearchSchema,
  UpdateSavedSearchInputSchema,
  type CreateSavedSearchInput,
  type SavedSearch,
  type UpdateSavedSearchInput,
} from '../shared/index.ts';

interface SavedSearchRow {
  id: string;
  name: string;
  keywords: string;
  unified_filters_json: string;
  marketplaces_json: string;
  sort_order: string;
  created_at: string;
  last_run_at: string | null;
  display_order: number;
}

function mapRowToSavedSearch(row: SavedSearchRow): SavedSearch {
  return SavedSearchSchema.parse({
    id: row.id,
    name: row.name,
    keywords: row.keywords,
    unifiedFilters: JSON.parse(row.unified_filters_json),
    marketplaces: JSON.parse(row.marketplaces_json),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at,
  });
}

/**
 * SQLite-backed repository for Saved Searches preserving stable sidebar display_order.
 */
export class SavedSearchesRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): SavedSearch[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          name,
          keywords,
          unified_filters_json,
          marketplaces_json,
          sort_order,
          created_at,
          last_run_at,
          display_order
        FROM saved_searches
        ORDER BY display_order ASC, created_at DESC`,
      )
      .all() as unknown as SavedSearchRow[];

    return rows.map(mapRowToSavedSearch);
  }

  getById(id: string): SavedSearch | null {
    const stmt = this.db.prepare(
      `SELECT
        id,
        name,
        keywords,
        unified_filters_json,
        marketplaces_json,
        sort_order,
        created_at,
        last_run_at,
        display_order
      FROM saved_searches
      WHERE id = :id`,
    );
    stmt.setAllowBareNamedParameters(true);
    const row = stmt.get({ id }) as SavedSearchRow | undefined;
    return row ? mapRowToSavedSearch(row) : null;
  }

  create(input: CreateSavedSearchInput, nowIso = new Date().toISOString()): SavedSearch {
    const parsed = CreateSavedSearchInputSchema.parse(input);
    const id = randomUUID();
    const minRow = this.db
      .prepare('SELECT COALESCE(MIN(display_order), 1) - 1 AS next_order FROM saved_searches')
      .get() as { next_order: number } | undefined;
    const displayOrder = minRow?.next_order ?? 0;

    const stmt = this.db.prepare(`
      INSERT INTO saved_searches (
        id,
        name,
        keywords,
        unified_filters_json,
        marketplaces_json,
        sort_order,
        created_at,
        last_run_at,
        display_order
      ) VALUES (
        :id,
        :name,
        :keywords,
        :unifiedFiltersJson,
        :marketplacesJson,
        :sortOrder,
        :createdAt,
        NULL,
        :displayOrder
      )
    `);
    stmt.setAllowBareNamedParameters(true);
    stmt.run({
      id,
      name: parsed.name,
      keywords: parsed.keywords,
      unifiedFiltersJson: JSON.stringify(parsed.unifiedFilters),
      marketplacesJson: JSON.stringify(parsed.marketplaces),
      sortOrder: parsed.sortOrder,
      createdAt: nowIso,
      displayOrder,
    });

    return SavedSearchSchema.parse({
      id,
      name: parsed.name,
      keywords: parsed.keywords,
      unifiedFilters: parsed.unifiedFilters,
      marketplaces: parsed.marketplaces,
      sortOrder: parsed.sortOrder,
      createdAt: nowIso,
      lastRunAt: null,
    });
  }

  update(id: string, input: UpdateSavedSearchInput): SavedSearch | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const parsed = UpdateSavedSearchInputSchema.parse(input);
    const merged = SavedSearchSchema.parse({
      ...existing,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.keywords !== undefined ? { keywords: parsed.keywords } : {}),
      ...(parsed.unifiedFilters !== undefined ? { unifiedFilters: parsed.unifiedFilters } : {}),
      ...(parsed.marketplaces !== undefined ? { marketplaces: parsed.marketplaces } : {}),
      ...(parsed.sortOrder !== undefined ? { sortOrder: parsed.sortOrder } : {}),
    });

    const stmt = this.db.prepare(`
      UPDATE saved_searches
      SET
        name = :name,
        keywords = :keywords,
        unified_filters_json = :unifiedFiltersJson,
        marketplaces_json = :marketplacesJson,
        sort_order = :sortOrder
      WHERE id = :id
    `);
    stmt.setAllowBareNamedParameters(true);
    stmt.run({
      id,
      name: merged.name,
      keywords: merged.keywords,
      unifiedFiltersJson: JSON.stringify(merged.unifiedFilters),
      marketplacesJson: JSON.stringify(merged.marketplaces),
      sortOrder: merged.sortOrder,
    });

    return merged;
  }

  recordRun(id: string, nowIso = new Date().toISOString()): SavedSearch | null {
    const stmt = this.db.prepare(`
      UPDATE saved_searches
      SET last_run_at = :lastRunAt
      WHERE id = :id
    `);
    stmt.setAllowBareNamedParameters(true);
    const result = stmt.run({ id, lastRunAt: nowIso });
    if (result.changes === 0) {
      return null;
    }
    return this.getById(id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM saved_searches WHERE id = :id');
    stmt.setAllowBareNamedParameters(true);
    const result = stmt.run({ id });
    return Number(result.changes) > 0;
  }
}
