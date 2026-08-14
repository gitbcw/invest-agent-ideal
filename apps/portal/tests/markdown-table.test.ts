import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import { MarkdownLite } from "../src/components/chat/MarkdownLite";

test("Markdown tables use the portal desktop table layout", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownLite, {
    text: "| 名称 | 备注 |\n| --- | --- |\n| 浦发银行 | 需要复核 |",
  }));
  assert.match(html, /responsive-data-table/);
  assert.match(html, /break-words/);
  assert.doesNotMatch(html, /data-label=/);
});
