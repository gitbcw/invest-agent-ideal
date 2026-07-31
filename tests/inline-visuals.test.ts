import assert from "node:assert/strict";
import test from "node:test";

import { extractInlineSvgVisuals } from "../src/services/inline-visuals.js";

const SAFE_SVG = `<svg viewBox="0 0 680 320" xmlns="http://www.w3.org/2000/svg">
  <title>三种价格情景</title>
  <rect x="0" y="0" width="680" height="320" fill="#ffffff"/>
  <rect x="20" y="64" width="180" height="120" fill="#e2e8f0"/>
  <text x="32" y="92" fill="#172033">观察</text>
</svg>`;

test("extractInlineSvgVisuals separates a safe visual from customer text", () => {
  const result = extractInlineSvgVisuals(`结论先行：等待确认。\n\n\`\`\`invest-svg\n${SAFE_SVG}\n\`\`\`\n\n后续验证：放量突破。`);
  assert.equal(result.text, "结论先行：等待确认。\n\n后续验证：放量突破。");
  assert.equal(result.visuals.length, 1);
  assert.equal(result.visuals[0]?.title, "三种价格情景");
  assert.match(result.visuals[0]?.svg || "", /^<svg/);
});

test("extractInlineSvgVisuals rejects unsafe or malformed visuals but retains text", () => {
  const unsafe = `<svg viewBox="0 0 680 320"><script>alert(1)</script></svg>`;
  const result = extractInlineSvgVisuals(`保留这段文字。\n\n\`\`\`invest-svg\n${unsafe}\n\`\`\``);
  assert.equal(result.text, "保留这段文字。");
  assert.equal(result.visuals.length, 0);
});

test("extractInlineSvgVisuals requires a bounded zero-origin viewBox", () => {
  const result = extractInlineSvgVisuals(`\`\`\`invest-svg\n<svg viewBox="10 10 680 320"><title>x</title></svg>\n\`\`\``);
  assert.equal(result.visuals.length, 0);
  assert.equal(result.text, "");
});

test("extractInlineSvgVisuals rejects XML processing features", () => {
  const result = extractInlineSvgVisuals(`\`\`\`invest-svg\n<!DOCTYPE svg><svg viewBox="0 0 680 320"><title>x</title></svg>\n\`\`\``);
  assert.equal(result.visuals.length, 0);
});

test("extractInlineSvgVisuals caps Portal replies at two visuals", () => {
  const second = SAFE_SVG.replace("三种价格情景", "第二张图");
  const third = SAFE_SVG.replace("三种价格情景", "第三张图");
  const result = extractInlineSvgVisuals([
    "```invest-svg", SAFE_SVG, "```",
    "```invest-svg", second, "```",
    "```invest-svg", third, "```",
  ].join("\n"));

  assert.equal(result.visuals.length, 2);
  assert.deepEqual(result.visuals.map((visual) => visual.title), ["三种价格情景", "第二张图"]);
  assert.equal(result.text, "图示如下。");
});
