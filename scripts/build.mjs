import { copyFile, mkdir } from "node:fs/promises";
import { build, context } from "esbuild";

const outputDirectory = "dist";
const watch = process.argv.includes("--watch");

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  copyFile("manifest.json", `${outputDirectory}/manifest.json`),
  copyFile("prompt.md", `${outputDirectory}/prompt.md`),
  copyFile("styles.css", `${outputDirectory}/styles.css`)
]);

const buildOptions = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  platform: "browser",
  target: "es2020",
  format: "cjs",
  minify: !watch,
  outfile: `${outputDirectory}/main.js`
};

const workerBuildOptions = {
  entryPoints: ["plot-worker.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  minify: !watch,
  outfile: `${outputDirectory}/plot-worker.js`
};

if (watch) {
  const buildContexts = await Promise.all([context(buildOptions), context(workerBuildOptions)]);
  await Promise.all(buildContexts.map(buildContext => buildContext.watch()));
} else {
  await Promise.all([build(buildOptions), build(workerBuildOptions)]);
}