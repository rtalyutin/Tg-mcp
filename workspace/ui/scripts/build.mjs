import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const js = await build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
});
const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
let css = await readFile("src/style.css", "utf8");
for (const subset of ["cyrillic", "latin"]) {
  const font = await readFile(
    `../../dashboard/web/assets/roboto-${subset}.woff2`,
  );
  css = css.replace(
    `FONT_${subset.toUpperCase()}`,
    `data:font/woff2;base64,${font.toString("base64")}`,
  );
}
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Совместная работа · Проекты</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
const sha = (s) => createHash("sha256").update(s).digest("base64");
const csp = `default-src 'none'; script-src 'sha256-${sha(script)}'; style-src 'sha256-${sha(css)}'; font-src data:; img-src data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'`;
await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", html);
await writeFile("dist/csp.txt", csp);
console.log(`WORKSPACE_UI ${Buffer.byteLength(html)} bytes`);
