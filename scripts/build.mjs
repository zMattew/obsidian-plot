import { copyFile, mkdir } from "node:fs/promises";
import { build, context } from "esbuild";

const outputDirectory = "dist";
const watch = process.argv.includes("--watch");

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  copyFile("manifest.json", `${outputDirectory}/manifest.json`),
  copyFile("prompt.md", `${outputDirectory}/prompt.md`)
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

if (watch) {
  const buildContext = await context(buildOptions);
  await buildContext.watch();
} else {
  await build(buildOptions);
}