import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { mkdirSync, copyFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const root = dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

/**
 * Point OBSIDIAN_VAULT at a vault to build straight into it:
 *   OBSIDIAN_VAULT=~/Notes npm run dev
 * Without it the build lands in ./dist.
 */
const vault = process.env.OBSIDIAN_VAULT;
const outDir = vault
  ? join(resolve(vault), ".obsidian", "plugins", "task-timer")
  : join(root, "dist");

mkdirSync(outDir, { recursive: true });

const context = await esbuild.context({
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: join(outDir, "main.js"),
  minify: prod,
});

const copyStatics = () => {
  copyFileSync(join(root, "manifest.json"), join(outDir, "manifest.json"));
  copyFileSync(join(root, "styles.css"), join(outDir, "styles.css"));
};

copyStatics();
console.log(`task-timer -> ${outDir}`);

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
