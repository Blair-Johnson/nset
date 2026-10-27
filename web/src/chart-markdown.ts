import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import katex, { type KatexOptions } from "katex";
import texmath from "markdown-it-texmath";
import type { ChartMeasurement } from "./workspace-types";

// No CSS or DOM dependency: the panel imports katex/dist/katex.min.css so Vite
// bundles its fonts locally. Never add a raw-HTML or syntax-highlighting plugin.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

const safeMathEngine = {
  renderToString(tex: string, options: KatexOptions): string {
    if (tex.length > 4096) {
      return '<span class="chart-math-error">Math expression is too long.</span>';
    }
    try {
      return katex.renderToString(tex, {
        displayMode: options.displayMode === true,
        trust: false,
        strict: "error",
        throwOnError: false,
        maxExpand: 200,
        maxSize: 20,
        globalGroup: false,
        // KaTeX mutates this object for global definitions. Never share it.
        macros: {},
        output: "htmlAndMathml",
      });
    } catch {
      // Also contain non-ParseError failures to this expression, not the report.
      return `<span class="chart-math-error">Invalid math: ${md.utils.escapeHtml(tex)}</span>`;
    }
  },
};
md.use(texmath, { engine: safeMathEngine, delimiters: "dollars" });

function safeHttp(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function allowedMeasurement(
  measurements: Record<string, ChartMeasurement>,
  name: string,
): boolean {
  if (
    name === "constructor" ||
    name === "prototype" ||
    name === "__proto__" ||
    !measurements ||
    !Object.hasOwn(measurements, name)
  )
    return false;
  const value = measurements[name];
  return (
    !!value &&
    (value.axis === "x" || value.axis === "y") &&
    Number.isFinite(value.a) &&
    (value.b == null || Number.isFinite(value.b))
  );
}

// Rewrite parsed tokens, not Markdown source or rendered HTML: Markdown-it owns
// label nesting and attribute escaping. No authored attributes survive rewriting.
md.core.ruler.after("inline", "chart_measurement_links", (state) => {
  const measurements: Record<string, ChartMeasurement> = state.env.measurements;
  function rewrite(tokens: Token[]): void {
    const tags: string[] = [];
    for (const token of tokens) {
      if (token.type === "link_open") {
        const href = token.attrGet("href") || "";
        const match = /^measurement:([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(href);
        token.tag = "span";
        token.attrs = null;
        if (match && allowedMeasurement(measurements, match[1])) {
          token.tag = "button";
          token.attrs = [
            ["type", "button"],
            ["class", "chart-measurement-link"],
            ["data-measurement", match[1]],
          ];
        } else if (safeHttp(href)) {
          token.tag = "a";
          token.attrs = [
            ["href", href],
            ["target", "_blank"],
            ["rel", "noopener noreferrer"],
          ];
        }
        tags.push(token.tag);
      } else if (token.type === "link_close") {
        token.tag = tags.pop() || "span";
      }
      if (token.children) rewrite(token.children);
    }
  }
  rewrite(state.tokens);
});

// Images never fetch, including data: URLs accepted by Markdown-it. Keep only
// escaped, plain alt text; links or formatting inside alt text are not actions.
md.renderer.rules.image = (tokens, index, options, env, renderer) =>
  md.utils.escapeHtml(
    renderer.renderInlineAsText(tokens[index].children || [], options, env),
  );

/** Render authored chart details as inert Markdown/math plus allowlisted actions. */
export function renderChartMarkdown(
  markdown: string,
  measurements: Record<string, ChartMeasurement> = {},
): string {
  return md.render(markdown, { measurements });
}
