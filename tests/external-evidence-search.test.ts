import assert from "node:assert/strict";
import test from "node:test";
import { readPublicWebPage, resetDoubaoQpsWindowForTests, searchPublicFinanceNews, searchPublicWeb } from "../src/services/external-evidence-search.js";

// Doubao tests inject DOUBAO_SEARCH_API_KEY per-process. Tests reset the QPS
// window before each case so the process-local limiter does not cross-contaminate.
function doubaoEnabledEnv(value = "test-doubao-key"): NodeJS.ProcessEnv {
  return { ...process.env, DOUBAO_SEARCH_API_KEY: value, DOUBAO_SEARCH_ENABLED: "true" };
}

test("public finance-news search returns normalized, dated and linked evidence", async () => {
  const payload = {
    result: {
      cmsArticleWebOld: [
        {
          date: "2026-07-24 09:30:00",
          title: "<em>贵州茅台</em>发布经营信息",
          content: "公司披露&nbsp;相关经营信息。",
          mediaName: "测试财经媒体",
          url: "https://finance.example.test/article/1",
        },
        {
          date: "2026-06-01 09:30:00",
          title: "过期新闻",
          content: "old",
          mediaName: "测试媒体",
          url: "https://finance.example.test/article/old",
        },
        {
          date: "2026-07-23 09:30:00",
          title: "危险链接",
          content: "ignored",
          mediaName: "测试媒体",
          url: "javascript:alert(1)",
        },
      ],
    },
  };
  const fetchImpl = async () => new Response(`cb(${JSON.stringify(payload)})`, { status: 200 });

  const result = await searchPublicFinanceNews(
    { query: " 贵州茅台\n经营信息 ", days: 14, limit: 5, userId: "evidence-search-test" },
    { fetchImpl, now: new Date("2026-07-26T00:00:00.000Z") },
  );

  assert.equal(result.query, "贵州茅台 经营信息");
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    title: "贵州茅台 发布经营信息",
    snippet: "公司披露 相关经营信息。",
    publishedAt: "2026-07-24 09:30:00",
    publisher: "测试财经媒体",
    url: "https://finance.example.test/article/1",
  });
  assert.equal(result.source.evidenceLevel, "secondary_evidence");
  assert.deepEqual(result.source.warnings, []);
});

test("public finance-news search preserves provider failure as a warning", async () => {
  const result = await searchPublicFinanceNews(
    { query: "测试主题", userId: "evidence-search-test" },
    { fetchImpl: async () => new Response("unavailable", { status: 503 }) },
  );

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.source.warnings, ["provider_failed:eastmoney_finance_search:http_503"]);
});

test("public web search returns normalized Sogou results for source discovery", async () => {
  const html = `<!doctype html><html><body>
    <div class="vrwrap"><h3 class="vr-title"><a href="/link?url=result-a"><em>申万一级行业</em>资金流</a></h3><p class="space-txt">证券时报数据表与行业排名</p><div data-url="https://finance.example.test/article/1"></div></div>
    <div class="vrwrap"><h3 class="vr-title"><a href="https://example.org/report">官方行业指数</a></h3><p>申万宏源研究发布</p></div>
  </body></html>`;
  const result = await searchPublicWeb(
    { query: " 申万一级行业\n资金流 ", limit: 2, userId: "web-search-test" },
    { fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }), now: new Date("2026-07-26T00:00:00.000Z") },
  );

  assert.equal(result.query, "申万一级行业 资金流");
  assert.equal(result.source.provider, "sogou_web_search");
  assert.deepEqual(result.items.map((item) => ({ title: item.title, rank: item.rank })), [
    { title: "申万一级行业资金流", rank: 1 },
    { title: "官方行业指数", rank: 2 },
  ]);
  assert.equal(result.items[0]?.url, "https://finance.example.test/article/1");
  assert.match(result.items[0]?.snippet || "", /证券时报数据表/);
});

test("public web search uses a configured SearXNG JSON endpoint", async () => {
  let requestedUrl = "";
  const result = await searchPublicWeb(
    { query: "申万一级行业 资金流", limit: 2, userId: "searxng-search-test" },
    {
      searxngUrl: "http://127.0.0.1:8888/search",
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          results: [
            {
              title: "<b>行业资金流向</b>",
              content: "申万一级行业主力资金数据",
              url: "https://finance.example.test/article/1",
            },
            {
              title: "无效链接",
              content: "ignored",
              url: "javascript:alert(1)",
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      now: new Date("2026-07-26T00:00:00.000Z"),
    },
  );

  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "http://127.0.0.1:8888/search");
  assert.equal(url.searchParams.get("q"), "申万一级行业 资金流");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("categories"), "general");
  assert.equal(url.searchParams.get("language"), "zh-CN");
  assert.equal(url.searchParams.has("time_range"), false);
  assert.equal(result.source.provider, "searxng_web_search");
  assert.deepEqual(result.items, [
    {
      title: "行业资金流向",
      snippet: "申万一级行业主力资金数据",
      url: "https://finance.example.test/article/1",
      rank: 1,
    },
  ]);
});

test("public web reader validates redirects and returns sanitized page text", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://search.example.test/link") {
      return new Response(null, { status: 302, headers: { location: "https://redirect.example.test/result" } });
    }
    if (url === "https://redirect.example.test/result") {
      return new Response(`<script>window.location.replace("https://finance.example.test/article/1")</script>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(`<!doctype html><html><head><title>行业数据</title><script>secret()</script></head><body><nav>菜单</nav><article><h1>行业数据</h1><p>银行主力资金净流出17.58亿元。</p></article></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  const result = await readPublicWebPage(
    { url: "https://search.example.test/link", maxCharacters: 5000, userId: "web-read-test" },
    {
      fetchImpl,
      resolveHost: async () => [{ address: "93.184.216.34" }],
      now: new Date("2026-07-26T00:00:00.000Z"),
    },
  );

  assert.deepEqual(calls, [
    "https://search.example.test/link",
    "https://redirect.example.test/result",
    "https://finance.example.test/article/1",
  ]);
  assert.equal(result.page?.url, "https://finance.example.test/article/1");
  assert.equal(result.page?.title, "行业数据");
  assert.match(result.page?.text || "", /银行主力资金净流出17.58亿元/);
  assert.doesNotMatch(result.page?.text || "", /secret|菜单/);
});

test("public web reader identifies client-rendered pages with no readable text", async () => {
  const result = await readPublicWebPage(
    { url: "https://spa.example.test/source", userId: "web-read-spa-test" },
    {
      fetchImpl: async () => new Response("<!doctype html><html><body><div id='root'></div><script src='/app.js'></script></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      resolveHost: async () => [{ address: "93.184.216.34" }],
    },
  );

  assert.equal(result.page?.text, "");
  assert.ok(result.source.warnings.includes("page_text_unavailable"));
});

test("public web reader reports nested TLS trust failures explicitly", async () => {
  const tlsError = new Error("fetch failed", { cause: new Error("unable to verify the first certificate") });
  const result = await readPublicWebPage(
    { url: "https://tls.example.test/source", userId: "web-read-tls-test" },
    {
      fetchImpl: async () => { throw tlsError; },
      resolveHost: async () => [{ address: "93.184.216.34" }],
    },
  );

  assert.equal(result.page, null);
  assert.deepEqual(result.source.warnings, ["page_fetch_failed:tls_certificate_untrusted"]);
});

test("public web reader rejects private and local destinations before fetch", async () => {
  let fetchCalled = false;
  await assert.rejects(
    readPublicWebPage(
      { url: "http://127.0.0.1:22655/api/platform", userId: "web-read-test" },
      { fetchImpl: async () => { fetchCalled = true; return new Response("unexpected"); } },
    ),
    /UNSAFE_URL/,
  );
  assert.equal(fetchCalled, false);
});

test("Doubao primary search constructs the request and normalizes results", async () => {
  resetDoubaoQpsWindowForTests();
  let captured: { url: string; method: string; auth?: string; ctype?: string; body?: string } | null = null;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers;
    const headerGet = (key: string): string | undefined => {
      if (headers instanceof Headers) return headers.get(key) ?? undefined;
      if (headers && typeof headers === "object") {
        const record = headers as Record<string, string>;
        return record[key] ?? undefined;
      }
      return undefined;
    };
    captured = {
      url: String(input),
      method: String(init?.method ?? "GET"),
      auth: headerGet("Authorization"),
      ctype: headerGet("Content-Type"),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    return new Response(JSON.stringify({
      ResponseMetadata: { RequestId: "req-1" },
      Result: {
        WebResults: [
          { Title: "<em>贵州茅台</em>经营数据", Url: "https://finance.example.test/article/1", Summary: "公司披露季度经营信息", Snippet: "fallback snippet", SortId: 2 },
          { Title: "无效链接", Url: "javascript:alert(1)", Summary: "ignored", SortId: 3 },
          { Title: "缺少Summary时回退Snippet", Url: "https://finance.example.test/article/2", Snippet: "snippet content", SortId: 5 },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await searchPublicWeb(
    { query: "贵州茅台 经营数据", limit: 5, userId: "doubao-search-test" },
    {
      fetchImpl,
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key", DOUBAO_SEARCH_ENABLED: "true" } as NodeJS.ProcessEnv,
      now: new Date("2026-07-26T00:00:00.000Z"),
    },
  );

  assert.ok(captured);
  assert.equal(captured!.url, "https://open.feedcoopapi.com/search_api/web_search");
  assert.equal(captured!.method, "POST");
  assert.equal(captured!.auth, "Bearer test-doubao-key");
  assert.equal(captured!.ctype, "application/json");
  const parsedBody = JSON.parse(captured!.body ?? "{}");
  assert.equal(parsedBody.SearchType, "web");
  assert.equal(parsedBody.Count, 5);
  assert.deepEqual(parsedBody.Filter, { NeedUrl: true, NeedContent: false });
  assert.equal(parsedBody.Query, "贵州茅台 经营数据");

  assert.equal(result.source.provider, "doubao_web_search");
  assert.equal(result.source.evidenceLevel, "secondary_evidence");
  assert.deepEqual(result.source.warnings, []);
  assert.deepEqual(result.items, [
    { title: "贵州茅台 经营数据", snippet: "公司披露季度经营信息", url: "https://finance.example.test/article/1", rank: 2 },
    { title: "缺少Summary时回退Snippet", snippet: "snippet content", url: "https://finance.example.test/article/2", rank: 5 },
  ]);
});

test("Doubao truncates the query to the provider 100-character maximum", async () => {
  resetDoubaoQpsWindowForTests();
  let capturedBody: string | undefined;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = typeof init?.body === "string" ? init.body : undefined;
    return new Response(JSON.stringify({
      ResponseMetadata: { RequestId: "req-1" },
      Result: { WebResults: [{ Title: "ok", Url: "https://example.test/a", Summary: "s", SortId: 1 }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const longQuery = "A".repeat(150);
  await searchPublicWeb(
    { query: longQuery, limit: 1, userId: "doubao-truncate-test" },
    {
      fetchImpl,
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key" } as NodeJS.ProcessEnv,
    },
  );
  const parsedBody = JSON.parse(capturedBody ?? "{}");
  assert.equal(parsedBody.Query.length, 100);
});

test("Doubao falls back to SearXNG on a provider business error inside an HTTP 200 response", async () => {
  resetDoubaoQpsWindowForTests();
  let doubaoCalled = false;
  let searxngCalled = false;
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("feedcoopapi.com")) {
      doubaoCalled = true;
      return new Response(JSON.stringify({
        ResponseMetadata: { Error: { Code: "10403", Message: "no permission" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    searxngCalled = true;
    return new Response(JSON.stringify({
      results: [{ title: "SearXNG result", content: "fallback snippet", url: "https://finance.example.test/article/9" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await searchPublicWeb(
    { query: "测试主题", limit: 3, userId: "doubao-fallback-test" },
    {
      fetchImpl,
      searxngUrl: "http://127.0.0.1:8888/search",
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key" } as NodeJS.ProcessEnv,
    },
  );

  assert.equal(doubaoCalled, true);
  assert.equal(searxngCalled, true);
  assert.equal(result.source.provider, "searxng_web_search");
  assert.ok(result.source.warnings.some((w) => w.startsWith("provider_failed:doubao_web_search:")));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.title, "SearXNG result");
});

test("Doubao falls back to SearXNG on timeout/429/5xx with a preserved primary-failure warning", async () => {
  resetDoubaoQpsWindowForTests();
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("feedcoopapi.com")) {
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    }
    return new Response(JSON.stringify({
      results: [{ title: "SearXNG result", content: "fallback", url: "https://finance.example.test/article/9" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await searchPublicWeb(
    { query: "测试主题", limit: 3, userId: "doubao-429-test" },
    {
      fetchImpl,
      searxngUrl: "http://127.0.0.1:8888/search",
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key" } as NodeJS.ProcessEnv,
    },
  );

  assert.equal(result.source.provider, "searxng_web_search");
  assert.ok(result.source.warnings.includes("provider_failed:doubao_web_search:http_429"));
  assert.equal(result.items.length, 1);
});

test("Doubao falls back to SearXNG when it returns zero results or only invalid URLs", async () => {
  resetDoubaoQpsWindowForTests();
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("feedcoopapi.com")) {
      return new Response(JSON.stringify({
        ResponseMetadata: { RequestId: "req-1" },
        Result: { WebResults: [{ Title: "only bad url", Url: "javascript:alert(1)", Summary: "s", SortId: 1 }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      results: [{ title: "SearXNG result", content: "fallback", url: "https://finance.example.test/article/9" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await searchPublicWeb(
    { query: "测试主题", limit: 3, userId: "doubao-no-usable-test" },
    {
      fetchImpl,
      searxngUrl: "http://127.0.0.1:8888/search",
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key" } as NodeJS.ProcessEnv,
    },
  );

  assert.equal(result.source.provider, "searxng_web_search");
  assert.ok(result.source.warnings.includes("primary_provider_no_usable_results:doubao_web_search"));
  assert.equal(result.items.length, 1);
});

test("Doubao is skipped when disabled or unconfigured, falling back directly to SearXNG", async () => {
  resetDoubaoQpsWindowForTests();
  let doubaoCalled = false;
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("feedcoopapi.com")) {
      doubaoCalled = true;
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({
      results: [{ title: "SearXNG result", content: "fallback", url: "https://finance.example.test/article/9" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await searchPublicWeb(
    { query: "测试主题", limit: 3, userId: "doubao-disabled-test" },
    {
      fetchImpl,
      searxngUrl: "http://127.0.0.1:8888/search",
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key", DOUBAO_SEARCH_ENABLED: "false" } as NodeJS.ProcessEnv,
    },
  );

  assert.equal(doubaoCalled, false);
  assert.equal(result.source.provider, "searxng_web_search");
  assert.deepEqual(result.source.warnings, []);
  assert.equal(result.items.length, 1);
});

test("both providers unavailable returns no items and stable, non-secret warnings", async () => {
  resetDoubaoQpsWindowForTests();
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("feedcoopapi.com")) {
      return new Response(JSON.stringify({
        ResponseMetadata: { Error: { Code: "10500", Message: "internal" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unavailable", { status: 503 });
  };
  const result = await searchPublicWeb(
    { query: "测试主题", limit: 3, userId: "doubao-both-fail-test" },
    {
      fetchImpl,
      searxngUrl: "http://127.0.0.1:8888/search",
      env: { ...process.env, DOUBAO_SEARCH_API_KEY: "test-doubao-key" } as NodeJS.ProcessEnv,
    },
  );

  assert.deepEqual(result.items, []);
  assert.ok(result.source.warnings.some((w) => w.startsWith("provider_failed:doubao_web_search:")));
  assert.ok(result.source.warnings.some((w) => w.startsWith("provider_failed:searxng_web_search:")));
  // Warnings must not leak the API key.
  assert.ok(result.source.warnings.every((w) => !w.includes("test-doubao-key")));
});

test("provider registry accepts and emits doubao_web_search metadata", async () => {
  const { getProvider } = await import("../src/services/market-data-providers.js");
  const meta = getProvider("doubao_web_search");
  assert.equal(meta.runtimeProvider, "web");
  assert.equal(meta.confidence, "medium");
  assert.equal(meta.evidenceLevel, "secondary_evidence");
  assert.equal(meta.category, "web_search");
  assert.match(meta.usageBoundary, /来源发现/);
});
