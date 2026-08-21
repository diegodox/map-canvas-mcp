import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// zod/v4 barrel-exports translated error messages for ~50 locales
// (`export * as locales from "../locales/index.js"`) purely as an opt-in
// convenience for callers that want `z.config(locales.fr())`. Nothing here
// (or in @modelcontextprotocol/ext-apps, which only calls `z.config({jitless})`)
// reads it, but esbuild can't prove that on its own and bundles all ~200KB of
// translations anyway. Stub the module out so only the English messages baked
// into zod's core (used regardless of this export) ship.
const stripZodLocales = {
  name: "strip-zod-locales",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /[/\\]zod[/\\]v4[/\\]locales[/\\]index\.js$/ }, () => ({
      contents: "export {};",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [path.join(root, "widget/src.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  loader: { ".png": "dataurl" },
  minify: true,
  write: false,
  outdir: "out",
  plugins: [stripZodLocales],
});

const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
if (!js || !css) throw new Error("Expected esbuild to emit JavaScript and CSS");

const template = await readFile(path.join(root, "widget/index.html"), "utf8");
const scriptTag = '<script type="module" src="./src.ts"></script>';
const headStart = template.indexOf("<head>");
const bodyStart = template.indexOf("<body>");
const scriptStart = template.indexOf(scriptTag);
if (headStart < 0 || bodyStart < 0 || scriptStart < 0 || scriptStart <= bodyStart) {
  throw new Error("Widget template does not contain the expected head, body, and module script");
}

const headMarkup = template.slice(headStart + "<head>".length, bodyStart).trim();
const bodyMarkup = template.slice(bodyStart + "<body>".length, scriptStart).trim();

// Escape stray `</script>`/`</style>` sequences so bundled text can't prematurely
// close the tag it is embedded in.
const inlineCss = css.text.replace(/<\/style/gi, "<\\/style");
const inlineJs = js.text.replace(/<\/script/gi, "<\\/script");

const widgetHtml = [
  "<!doctype html>",
  '<html lang="ja">',
  "<head>",
  headMarkup,
  `<style>${inlineCss}</style>`,
  "</head>",
  "<body>",
  bodyMarkup,
  `<script type="module">${inlineJs}</script>`,
  "</body>",
  "</html>",
  "",
].join("\n");

const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await writeFile(path.join(dist, "map-widget.html"), widgetHtml, "utf8");
