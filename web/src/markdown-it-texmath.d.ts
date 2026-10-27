declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  import type { KatexOptions } from "katex";

  interface TexmathOptions {
    engine: {
      renderToString(tex: string, options: KatexOptions): string;
    };
    delimiters: "dollars";
  }

  const texmath: MarkdownIt.PluginWithOptions<TexmathOptions>;
  export default texmath;
}
