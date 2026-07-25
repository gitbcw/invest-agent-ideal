import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeSvgForInline, scanForUnsafeContent } from "../src/services/svg-sanitizer.js";

test("accepts static SVG styles and local fragment URLs", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">
    <style type="text/css">
      .node { fill: #fff; stroke: #222; font-family: sans-serif; }
      .edge { marker-end: url('#arrow'); }
    </style>
    <defs><marker id="arrow"><path d="M0 0L4 2L0 4z"/></marker></defs>
    <rect class="node" width="20" height="10"/>
  </svg>`;

  assert.deepEqual(scanForUnsafeContent(svg), { safe: true });
  assert.match(sanitizeSvgForInline(svg), /<style type="text\/css">/);
});

test("rejects external and executable CSS in SVG styles", () => {
  const unsafeCss = [
    `@import "https://example.com/style.css";`,
    `.node { fill: url(https://example.com/pixel); }`,
    `.node { fill: url(data:image/svg+xml;base64,AAAA); }`,
    `.node { width: expression(alert(1)); }`,
    `.node { behavior: url(#default#VML); }`,
    `.node { fill: u/**/rl(https://example.com/pixel); }`,
    String.raw`.node { fill: u\72l(https://example.com/pixel); }`,
    `.node { fill: &#x75;rl(https://example.com/pixel); }`,
  ];

  for (const css of unsafeCss) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style></svg>`;
    assert.equal(scanForUnsafeContent(svg).safe, false, css);
    assert.doesNotMatch(sanitizeSvgForInline(svg), /<style/i, css);
  }
});

test("rejects malformed style blocks and style attributes", () => {
  assert.equal(scanForUnsafeContent(`<svg><style>.node { fill: red; }</svg>`).safe, false);
  assert.equal(scanForUnsafeContent(`<svg><style media="all">.node { fill: red; }</style></svg>`).safe, false);
  assert.equal(scanForUnsafeContent(`<svg><rect style="fill:red"/></svg>`).safe, false);
});
