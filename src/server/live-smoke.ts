import {
  ConditionTierSchema,
  DEFAULT_FACEBOOK_CITY_HUBS,
  MARKETPLACE_IDS,
  MarketplaceIdSchema,
  type AppSettings,
  type ConditionTier,
  type MarketplaceId,
  type MarketplaceRunStatus,
  type UnifiedFilter,
} from '../shared/index.ts';
import type {
  AdapterExecutionContext,
  ClockFn,
  MarketplaceAdapter,
  SleepFn,
} from './adapters/types.ts';
import type { RawEbayCredentials } from './secrets.ts';

export const DEFAULT_LIVE_SMOKE_QUERY = 'patagonia jacket';
export const DEFAULT_SMOKE_PACING_COOLDOWN_MS = 3_500;

export interface ParsedLiveSmokeArgs {
  help: boolean;
  optedIn: boolean;
  query: string;
  marketplaces: MarketplaceId[];
  priceMin: number | null;
  priceMax: number | null;
  conditions: ConditionTier[];
  isolated: boolean;
}

export type LiveSmokeOutcome = 'pass' | 'fail' | 'skipped';

export interface LiveSmokeResult {
  marketplace: MarketplaceId;
  outcome: LiveSmokeOutcome;
  runStatus: MarketplaceRunStatus;
  listingCount: number;
  droppedMalformedCount: number;
  durationMs: number;
  message: string;
  sampleListing: {
    title: string;
    price: number;
  } | null;
}

export interface LiveSmokeSummary {
  query: string;
  startedAt: string;
  totalDurationMs: number;
  results: LiveSmokeResult[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts known secret values, OAuth/Bearer/Basic credentials, and session cookies
 * from diagnostic messages before logging.
 */
export function redactSensitiveText(
  input: string,
  extraSecrets: readonly (string | null | undefined)[] = [],
): string {
  let output = input;

  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      output = output.replace(new RegExp(escapeRegExp(trimmed), 'g'), '[REDACTED]');
    }
  }

  output = output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
  output = output.replace(
    /("(?:client_secret|client_id|access_token|refresh_token|authorization|cookie|set-cookie|c_user|xs|datr|fr|sb)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"',
  );
  output = output.replace(
    /\b(client_secret|client_id|access_token|refresh_token|authorization|set-cookie|cookie|c_user|xs|datr|fr|sb)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s;,}]+)/gi,
    '$1$2[REDACTED]',
  );

  return output;
}

const OUTCOME_TAG: Record<LiveSmokeOutcome, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIP',
};

export function formatLiveSmokeReport(
  summary: LiveSmokeSummary,
  extraSecrets: readonly (string | null | undefined)[] = [],
): string {
  const lines: string[] = [
    `Live Smoke Report — query="${redactSensitiveText(summary.query, extraSecrets)}" (${summary.totalDurationMs}ms)`,
  ];

  for (const res of summary.results) {
    const tag = OUTCOME_TAG[res.outcome];
    const safeMessage = redactSensitiveText(res.message, extraSecrets);
    const sample = res.sampleListing
      ? ` | sample: ${res.sampleListing.title} ($${res.sampleListing.price.toFixed(2)})`
      : '';
    const dropped = res.droppedMalformedCount > 0 ? `, dropped=${res.droppedMalformedCount}` : '';
    lines.push(
      `[${tag}] ${res.marketplace} (${res.runStatus}) — ${res.listingCount} Listings (${res.durationMs}ms${dropped})${sample}${safeMessage ? ` — ${safeMessage}` : ''}`,
    );
  }

  return lines.join('\n');
}

function parseMarketplaceList(raw: string): MarketplaceId[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error('At least one Marketplace must be provided to --marketplaces.');
  }

  const deduped: MarketplaceId[] = [];
  const seen = new Set<MarketplaceId>();
  for (const part of parts) {
    const parsed = MarketplaceIdSchema.safeParse(part);
    if (!parsed.success) {
      throw new Error(
        `Invalid Marketplace "${part}". Expected one of: ${MARKETPLACE_IDS.join(', ')}.`,
      );
    }
    if (!seen.has(parsed.data)) {
      seen.add(parsed.data);
      deduped.push(parsed.data);
    }
  }
  return deduped;
}

function parsePriceArg(flag: string, raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${flag} must be a non-negative number.`);
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`Invalid ${flag} value "${raw}". Expected a non-negative number.`);
  }
  return num;
}

function parseConditionList(raw: string): ConditionTier[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error('At least one condition tier must be provided to --condition.');
  }

  const deduped: ConditionTier[] = [];
  const seen = new Set<ConditionTier>();
  for (const part of parts) {
    const parsed = ConditionTierSchema.safeParse(part);
    if (!parsed.success) {
      throw new Error(
        `Invalid condition "${part}". Expected one of: new, like_new, good, fair, poor.`,
      );
    }
    if (!seen.has(parsed.data)) {
      seen.add(parsed.data);
      deduped.push(parsed.data);
    }
  }
  return deduped;
}

export function parseLiveSmokeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedLiveSmokeArgs {
  let help = false;
  let yesFlag = false;
  let query = DEFAULT_LIVE_SMOKE_QUERY;
  let marketplaces: MarketplaceId[] = [...MARKETPLACE_IDS];
  let priceMin: number | null = null;
  let priceMax: number | null = null;
  let conditions: ConditionTier[] = [];
  let isolated = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--yes' || arg === '-y') {
      yesFlag = true;
    } else if (arg === '--isolated') {
      isolated = true;
    } else if (arg.startsWith('--query=')) {
      query = arg.slice('--query='.length).trim();
    } else if (arg === '--query') {
      query = (argv[++i] ?? '').trim();
    } else if (arg.startsWith('--marketplaces=')) {
      marketplaces = parseMarketplaceList(arg.slice('--marketplaces='.length));
    } else if (arg === '--marketplaces') {
      marketplaces = parseMarketplaceList(argv[++i] ?? '');
    } else if (arg.startsWith('--price-min=')) {
      priceMin = parsePriceArg('--price-min', arg.slice('--price-min='.length));
    } else if (arg === '--price-min') {
      priceMin = parsePriceArg('--price-min', argv[++i] ?? '');
    } else if (arg.startsWith('--price-max=')) {
      priceMax = parsePriceArg('--price-max', arg.slice('--price-max='.length));
    } else if (arg === '--price-max') {
      priceMax = parsePriceArg('--price-max', argv[++i] ?? '');
    } else if (arg.startsWith('--condition=')) {
      conditions = parseConditionList(arg.slice('--condition='.length));
    } else if (arg === '--condition') {
      conditions = parseConditionList(argv[++i] ?? '');
    } else {
      throw new Error(`Unknown live-smoke argument: ${arg}`);
    }
  }

  if (!query) {
    throw new Error('Live-smoke --query must be a non-empty string.');
  }

  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    throw new Error(
      `Invalid price range: --price-min (${priceMin}) cannot exceed --price-max (${priceMax}).`,
    );
  }

  const envOptIn =
    env.UMS_LIVE_SMOKE === '1' ||
    env.UMS_LIVE_SMOKE === 'true' ||
    env.npm_lifecycle_event === 'smoke:live';
  const optedIn = yesFlag || envOptIn;

  if (!help && !optedIn) {
    throw new Error(
      'Manual opt-in required for live Marketplace smoke checks. Run "npm run smoke:live" or pass "--yes" / set UMS_LIVE_SMOKE=1.',
    );
  }

  return {
    help,
    optedIn,
    query,
    marketplaces,
    priceMin,
    priceMax,
    conditions,
    isolated,
  };
}

export interface RunLiveSmokeOptions {
  query: string;
  marketplaces: MarketplaceId[];
  adapters: Record<MarketplaceId, MarketplaceAdapter>;
  settings: AppSettings;
  ebayCredentials: RawEbayCredentials;
  priceMin?: number | null;
  priceMax?: number | null;
  conditions?: ConditionTier[];
  pacingCooldownMs?: number;
  sleep?: SleepFn;
  clock?: ClockFn;
}

export interface RunLiveSmokeOutput {
  summary: LiveSmokeSummary;
  report: string;
  exitCode: 0 | 1;
}

function defaultSmokeSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSmokeFilters(
  settings: AppSettings,
  overrides: {
    priceMin?: number | null;
    priceMax?: number | null;
    conditions?: ConditionTier[];
  } = {},
): UnifiedFilter {
  const firstEnabledHub =
    settings.homeFacebookCitySlug?.trim() ||
    settings.facebookCityHubs.find((h) => h.enabled)?.slug ||
    DEFAULT_FACEBOOK_CITY_HUBS[0]!.slug;

  return {
    priceMin: overrides.priceMin ?? null,
    priceMax: overrides.priceMax ?? null,
    conditions: overrides.conditions ?? [],
    fulfillment: 'any',
    facebookLocationSlugs: [firstEnabledHub],
    facebookRadiusMiles: settings.facebookRadiusMiles ?? 500,
    localPickupPostalCode: settings.homePostalCode,
    localPickupRadiusMiles: settings.defaultLocalPickupRadiusMiles,
  };
}

function classifyRunStatus(runStatus: MarketplaceRunStatus): LiveSmokeOutcome {
  if (runStatus === 'success' || runStatus === 'empty') {
    return 'pass';
  }
  if (runStatus === 'unconfigured' || runStatus === 'skipped_unsupported') {
    return 'skipped';
  }
  return 'fail';
}

/**
 * Executes a single paced sequential diagnostic check across the requested Marketplaces
 * without automated login/2FA or secret/cookie logging.
 */
export async function runLiveSmoke(options: RunLiveSmokeOptions): Promise<RunLiveSmokeOutput> {
  const clock = options.clock ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSmokeSleep;
  const pacingCooldownMs = options.pacingCooldownMs ?? DEFAULT_SMOKE_PACING_COOLDOWN_MS;
  const extraSecrets = [options.ebayCredentials.clientSecret, options.ebayCredentials.clientId];
  const unifiedFilters = buildSmokeFilters(options.settings, {
    priceMin: options.priceMin,
    priceMax: options.priceMax,
    conditions: options.conditions,
  });

  const startedAtMs = clock();
  const startedAt = new Date(startedAtMs).toISOString();
  const results: LiveSmokeResult[] = [];
  let executedLiveCheckBefore = false;

  for (const marketplace of options.marketplaces) {
    if (marketplace === 'ebay' && !options.ebayCredentials.configured) {
      results.push({
        marketplace,
        outcome: 'skipped',
        runStatus: 'unconfigured',
        listingCount: 0,
        droppedMalformedCount: 0,
        durationMs: 0,
        message:
          'eBay credentials not configured (set EBAY_CLIENT_ID/EBAY_CLIENT_SECRET or save in Settings)',
        sampleListing: null,
      });
      continue;
    }

    if (executedLiveCheckBefore && pacingCooldownMs > 0) {
      await sleep(pacingCooldownMs);
    }

    const adapter = options.adapters[marketplace];
    const checkStartMs = clock();
    const context: AdapterExecutionContext = {
      settings: options.settings,
      ebayCredentials: options.ebayCredentials,
      clock,
      sleep,
    };

    try {
      const translation = adapter.translateFilters(
        options.query,
        unifiedFilters,
        'relevance',
        context,
      );

      if (translation.status === 'skipped_unsupported') {
        results.push({
          marketplace,
          outcome: 'skipped',
          runStatus: 'skipped_unsupported',
          listingCount: 0,
          droppedMalformedCount: 0,
          durationMs: Math.max(0, clock() - checkStartMs),
          message: translation.notices.join('; ') || 'Skipped unsupported filter combination',
          sampleListing: null,
        });
        continue;
      }

      executedLiveCheckBefore = true;
      const batch = await adapter.executeInitial({
        keywords: options.query,
        unifiedFilters,
        sortOrder: 'relevance',
        translation,
        context,
      });

      const outcome = classifyRunStatus(batch.runStatus);
      const first = batch.listings[0];
      const rawMessage =
        batch.errorMessage ??
        (batch.runStatus === 'success'
          ? 'OK'
          : batch.runStatus === 'empty'
            ? '0 Listings matched query'
            : batch.runStatus);

      results.push({
        marketplace,
        outcome,
        runStatus: batch.runStatus,
        listingCount: batch.listings.length,
        droppedMalformedCount: batch.droppedMalformedCount,
        durationMs: Math.max(0, clock() - checkStartMs),
        message: redactSensitiveText(rawMessage, extraSecrets),
        sampleListing: first ? { title: first.title, price: first.price } : null,
      });
    } catch (err) {
      executedLiveCheckBefore = true;
      const rawMessage = err instanceof Error ? err.message : String(err);
      results.push({
        marketplace,
        outcome: 'fail',
        runStatus: 'network_error',
        listingCount: 0,
        droppedMalformedCount: 0,
        durationMs: Math.max(0, clock() - checkStartMs),
        message: redactSensitiveText(rawMessage, extraSecrets),
        sampleListing: null,
      });
    }
  }

  const summary: LiveSmokeSummary = {
    query: options.query,
    startedAt,
    totalDurationMs: Math.max(0, clock() - startedAtMs),
    results,
  };

  const exitCode: 0 | 1 = results.some((r) => r.outcome === 'fail') ? 1 : 0;
  return {
    summary,
    report: formatLiveSmokeReport(summary, extraSecrets),
    exitCode,
  };
}
