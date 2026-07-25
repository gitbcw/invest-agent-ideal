import assert from "node:assert/strict";
import test from "node:test";
import { getStockAnnouncements } from "../src/services/stock-news.js";

test("公告清洗会转义带 *ST 前缀的旧公司名", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("cninfo.com.cn")) {
      return new Response(JSON.stringify({
        announcements: [{ announcementTitle: "*ST萃华:关于公司重大事项的公告", announcementTime: Date.now(), secName: "*ST萃华" }],
      }), { status: 200 });
    }
    assert.match(url, /np-anotice-stock\.eastmoney\.com/);
    assert.match(url, /stock_list=002460/);
    return new Response(JSON.stringify({ data: { list: [
      { title: "其他公司公告", notice_date: "2026-07-23", codes: [{ stock_code: "300054", short_name: "鼎龙股份" }] },
      { title: "赣锋锂业:目标公司公告", notice_date: "2026-07-23", codes: [{ stock_code: "002460", short_name: "赣锋锂业" }] },
    ] } }), { status: 200 });
  }) as typeof fetch;

  try {
    const result = await getStockAnnouncements("002460", 7, "赣锋锂业");
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((item) => item.title).sort(), ["关于公司重大事项的公告", "目标公司公告"]);
    assert.ok(result.every((item) => item.secName === "赣锋锂业"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
