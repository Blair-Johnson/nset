import { test } from "node:test";
import assert from "node:assert/strict";
import katex, { type KatexOptions } from "katex";
import { renderChartMarkdown as render } from "./chart-markdown";
import type { ChartMeasurement } from "./workspace-types";

const measurements: Record<string, ChartMeasurement> = {
  "final-depth": { axis: "x", a: 2000, b: null },
  Window_2: { axis: "y", a: 1, b: 2 },
};

function noActiveResource(html: string): void {
  assert.doesNotMatch(
    html,
    /<(?:a|button|img|script|iframe|object|embed|video|audio|link|style)\b/i,
  );
  assert.doesNotMatch(
    html,
    /<[^>]*\s(?:href|src|srcset|onerror|onclick|data-measurement|data-payload|id)\s*=/i,
  );
  assert.doesNotMatch(html, /style="[^"]*url\(/i);
}

test("headings, emphasis, tables, lists, quotes, code and rules remain supported", () => {
  const html = render(
    `# Heading\n\n## Section\n\n**Strong** and *emphasis*.\n\n| A | B |\n| --- | ---: |\n| one | two |\n\n- item\n\n1. first\n\n> quote\n\n---\n\n\`inline <script>\`\n\n\`\`\`js\n<script>alert(1)</script>\n\`\`\``,
  );
  for (const tag of [
    "h1",
    "h2",
    "strong",
    "em",
    "table",
    "ul",
    "ol",
    "blockquote",
    "hr",
    "code",
    "pre",
  ]) {
    assert.match(html, new RegExp(`<${tag}\\b`), tag);
  }
  assert.match(html, /class="language-js"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script\b/);
  assert.equal(render(""), "");
});

test("only declared own measurement keys become buttons; labels keep inline formatting", () => {
  const html = render(
    '[**Exact** `label`](measurement:final-depth "discarded title") and [range](measurement:Window_2)',
    measurements,
  );
  assert.match(
    html,
    /<button type="button" class="chart-measurement-link" data-measurement="final-depth"><strong>Exact<\/strong> <code>label<\/code><\/button>/,
  );
  assert.match(html, /data-measurement="Window_2">range<\/button>/);
  assert.doesNotMatch(html, /href=|title=/);
  assert.deepEqual(measurements["final-depth"], {
    axis: "x",
    a: 2000,
    b: null,
  });
  noActiveResource(render("[old](measurement:final-depth)"));
  const inherited = Object.create(measurements) as Record<
    string,
    ChartMeasurement
  >;
  noActiveResource(render("[inherited](measurement:final-depth)", inherited));
  const ownNullPrototype = Object.assign(Object.create(null), measurements);
  assert.match(
    render("[own](measurement:final-depth)", ownNullPrototype),
    /<button\b/,
  );
});

test("invalid names, missing declarations and malformed measurement data remain inert", () => {
  const forged = JSON.parse(
    '{"constructor":{"axis":"x","a":1},"prototype":{"axis":"x","a":1},"__proto__":{"axis":"x","a":1}}',
  );
  for (const name of [
    "missing",
    "constructor",
    "prototype",
    "__proto__",
    "-bad",
    "a/b",
    "a%22onclick%3Dx",
    "a.b",
    "a:b",
  ]) {
    noActiveResource(render(`[blocked](measurement:${name})`, forged));
  }
  for (const value of [
    null,
    {},
    { axis: "z", a: 1 },
    { axis: "x", a: "1" },
    { axis: "x", a: Infinity },
    { axis: "x", a: NaN },
    { axis: "x", a: 1, b: "2" },
  ]) {
    noActiveResource(
      render("[blocked](measurement:bad)", { bad: value } as unknown as Record<
        string,
        ChartMeasurement
      >),
    );
  }
});

test("HTTP(S) links have fixed attributes; reference links use the same policy", () => {
  const html = render(
    '[Docs](https://example.com/?x=1&y=2 "ignored") [HTTP](http://example.com)\n\n[measure][m]\n\n[m]: measurement:final-depth',
    measurements,
  );
  assert.match(
    html,
    /href="https:\/\/example.com\/\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"/,
  );
  assert.match(
    html,
    /href="http:\/\/example.com" target="_blank" rel="noopener noreferrer"/,
  );
  assert.match(html, /data-measurement="final-depth">measure<\/button>/);
  assert.doesNotMatch(html, /title=/);
  assert.doesNotMatch(render("https://example.com"), /<a\b/);
  assert.match(render("<https://example.com>"), /<a\b/);
});

test("unsafe schemes, relative URLs and malformed destinations never become actions", () => {
  for (const href of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "jav&#x61;script:alert(1)",
    "data:text/html,test",
    "data:image/svg+xml,test",
    "vbscript:msgbox(1)",
    "file:///tmp/x",
    "mailto:a@example.com",
    "/relative",
    "//example.com",
    "#fragment",
    "https://",
    "https:example.com",
    "blob:https://example.com/id",
    "measurement:missing",
  ]) {
    noActiveResource(render(`[blocked](${href})`, measurements));
    noActiveResource(render(`[blocked][ref]\n\n[ref]: ${href}`, measurements));
  }
  noActiveResource(render("[unresolved][missing]"));
});

test("raw HTML, embeds, image URLs and image alt markup never execute or fetch", () => {
  const html = render(
    '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://example.com"></iframe>\n\n<!-- comment -->\n\n<svg onload=alert(1)>',
  );
  noActiveResource(html);
  assert.match(html, /&lt;script&gt;/);
  for (const src of [
    "https://example.com/image.png",
    "data:image/png;base64,AAAA",
    "data:image/svg+xml,test",
    "file:///tmp/image",
    "javascript:alert(1)",
  ]) {
    const image = render(`![alt <img src=x onerror=alert(1)>](${src})`);
    noActiveResource(image);
    assert.match(image, /alt/);
  }
  noActiveResource(
    render(
      "![[action](measurement:final-depth)](https://example.com/image.png)",
      measurements,
    ),
  );
  noActiveResource(
    render("![reference][image]\n\n[image]: data:image/png;base64,AAAA"),
  );
});

test("inline/display math works and code does not become math", () => {
  assert.match(render("Inline $x^2$ math."), /class="katex"/);
  assert.match(render("$$\nx^2\n$$"), /class="katex-display"/);
  assert.doesNotMatch(render("`$x$`\n\n```text\n$x$\n```"), /class="katex"/);
  noActiveResource(render("$$x$$ (<img/src=x/onerror=alert>)"));
});

test("untrusted math cannot create links, resources, injected HTML or CSS", () => {
  for (const tex of [
    String.raw`\href{javascript:alert(1)}{bad}`,
    String.raw`\href{https://example.com}{bad}`,
    String.raw`\url{https://example.com}`,
    String.raw`\includegraphics{https://example.com/a.png}`,
    String.raw`\includegraphics{data:image/svg+xml,bad}`,
    String.raw`\htmlClass{injected}{x}`,
    String.raw`\htmlId{injected}{x}`,
    String.raw`\htmlData{payload=injected}{x}`,
    String.raw`\htmlStyle{background-image:url(https://example.com/a)}{x}`,
    String.raw`\unknown{<img src=x onerror=alert(1)>}`,
    "<script>alert(1)</script>",
  ]) {
    for (const delimiters of ["$", "$$"]) {
      const html = render(`${delimiters}${tex}${delimiters}`);
      noActiveResource(html);
      assert.doesNotMatch(html, /class="injected"/);
    }
  }
});

test("invalid and oversized math stays visible without losing the rest of the report", () => {
  const html = render("Before $\\frac{1}{$ after.\n\n# Still rendered");
  assert.match(html, /katex-error|chart-math-error/);
  assert.match(html, /<h1>Still rendered<\/h1>/);
  assert.match(
    render("$" + String.raw`\def\loop{\loop}\loop` + "$"),
    /katex-error/,
  );
  assert.match(
    render("$" + "x".repeat(4097) + "$"),
    /chart-math-error.*too long/,
  );
});

test("macro definitions cannot leak across expressions or reports", () => {
  const definition = String.raw`\gdef\localonly{123}`;
  const use = String.raw`\localonly`;
  const before = render(`$${use}$`);
  render(`$${definition}$`);
  assert.equal(render(`$${use}$`), before);
  const sameReport = render(`$${definition}$ then $${use}$`);
  assert.match(sameReport, /<mtext>\\localonly<\/mtext>|katex-error/);
});

test("every math call enforces bounds, strictness and fresh macros; engine failure is contained", () => {
  const original = katex.renderToString;
  const calls: KatexOptions[] = [];
  try {
    katex.renderToString = (tex, options) => {
      calls.push(options!);
      return original(tex, options);
    };
    render("$x$ and $y$\n\n$$z$$");
    assert.equal(calls.length, 3);
    for (const options of calls) {
      assert.equal(options.trust, false);
      assert.equal(options.strict, "error");
      assert.equal(options.maxExpand, 200);
      assert.equal(options.maxSize, 20);
      assert.equal(options.globalGroup, false);
      assert.equal(options.throwOnError, false);
    }
    assert.equal(
      new Set(calls.map((options) => options.macros)).size,
      calls.length,
    );
    katex.renderToString = () => {
      throw new Error("<img src=x>");
    };
    const html = render("$<script>$\n\n# Survives");
    assert.match(html, /chart-math-error/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<h1>Survives<\/h1>/);
    noActiveResource(html);
  } finally {
    katex.renderToString = original;
  }
});
