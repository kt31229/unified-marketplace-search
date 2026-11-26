import type {
  BrowserContextHandle,
  BrowserCookie,
  BrowserPageHandle,
  BrowserResponseHandle,
  BrowserTransport,
} from '../../../src/server/browser-session-manager.ts';

export function wrapRelayHtml(relayPayload: unknown): string {
  const json = JSON.stringify(relayPayload);
  return `<!doctype html><html><head><title>Facebook Marketplace</title></head><body><script type="application/json" data-sjs>${json}</script></body></html>`;
}

export interface FacebookMockStep {
  finalUrl?: string;
  status?: number;
  title?: string;
  html: string;
}

export interface ScriptedFacebookOptions {
  cookies?: BrowserCookie[];
  stepsByUrl?: (url: string, callIndex: number) => FacebookMockStep | Promise<FacebookMockStep>;
  onScrollLoadMore?: (
    callIndex: number,
    currentUrl: string,
  ) => Promise<{
    url?: string;
    status?: number;
    postData?: string;
    body: unknown;
  }>;
}

export function createScriptedFacebookTransport(options: ScriptedFacebookOptions) {
  const gotoUrls: string[] = [];
  const evaluateCalls: number[] = [];
  const pages: BrowserPageHandle[] = [];
  let launchCount = 0;
  let scrollCallIndex = 0;

  const transport: BrowserTransport = {
    async launchPersistentContext(): Promise<BrowserContextHandle> {
      launchCount += 1;
      const makePage = (): BrowserPageHandle => {
        let currentUrl = 'about:blank';
        let currentStep: FacebookMockStep = { html: '<html></html>' };
        let closed = false;
        let pendingWaiter: ((res: BrowserResponseHandle) => void) | null = null;

        const page: BrowserPageHandle = {
          async goto(url: string) {
            const idx = gotoUrls.length;
            gotoUrls.push(url);
            if (options.stepsByUrl) {
              currentStep = await options.stepsByUrl(url, idx);
            }
            currentUrl = currentStep.finalUrl ?? url;
            return {
              url: () => currentUrl,
              status: () => currentStep.status ?? 200,
              json: async () => ({}),
            };
          },
          url: () => currentUrl,
          title: async () => currentStep.title ?? 'Marketplace Search',
          content: async () => currentStep.html,
          async evaluate<R>(): Promise<R> {
            evaluateCalls.push(scrollCallIndex);
            if (options.onScrollLoadMore) {
              const payload = await options.onScrollLoadMore(scrollCallIndex, currentUrl);
              scrollCallIndex += 1;
              const resHandle: BrowserResponseHandle = {
                url: () => payload.url ?? 'https://www.facebook.com/api/graphql/',
                status: () => payload.status ?? 200,
                json: async () => payload.body,
                request: () => ({
                  method: () => 'POST',
                  postData: () =>
                    payload.postData ??
                    'fb_api_req_friendly_name=CometMarketplaceSearchContentPaginationQuery&variables=%7B%7D',
                }),
              };
              pendingWaiter?.(resHandle);
              pendingWaiter = null;
            }
            return undefined as R;
          },
          waitForResponse: async (predicate) => {
            return new Promise<BrowserResponseHandle>((resolve) => {
              pendingWaiter = async (res) => {
                const matched =
                  typeof predicate === 'string'
                    ? res.url().includes(predicate)
                    : await predicate(res);
                if (matched) {
                  resolve(res);
                }
              };
            });
          },
          close: async () => {
            closed = true;
          },
          isClosed: () => closed,
        };
        pages.push(page);
        return page;
      };

      makePage();

      return {
        pages: () => pages.filter((p) => !p.isClosed?.()),
        newPage: async () => makePage(),
        cookies: async () =>
          options.cookies ?? [{ name: 'c_user', value: '10000123456', domain: '.facebook.com' }],
        close: async () => undefined,
        on: () => undefined,
      };
    },
  };

  return {
    transport,
    gotoUrls,
    evaluateCalls,
    getLaunchCount: () => launchCount,
    getPageCount: () => pages.length,
  };
}
