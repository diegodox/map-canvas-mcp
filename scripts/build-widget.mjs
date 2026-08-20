import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
});

const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
if (!js || !css) throw new Error("Expected esbuild to emit JavaScript and CSS");

const template = await readFile(path.join(root, "widget/index.html"), "utf8");
const html = template
  .replace('<script type="module" src="./src.ts"></script>', `<script type="module">${js.text}</script>`)
  .replace("</head>", `<style>${css.text}</style></head>`);

await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist/map-widget.html"), html, "utf8");
