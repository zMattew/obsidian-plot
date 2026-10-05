import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { build, context } from "esbuild";

const outputDirectory = "dist";
const watch = process.argv.includes("--watch");
const vaultPluginDir = "C:\\Users\\matma\\Documents\\uni\\Obsidian\\uni\\.obsidian\\plugins\\plot";

async function copyAssets() {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    copyFile("manifest.json", `${outputDirectory}/manifest.json`),
    copyFile("prompt.md", `${outputDirectory}/prompt.md`),
    copyFile("styles.css", `${outputDirectory}/styles.css`)
  ]);

  if (existsSync(vaultPluginDir)) {
    await Promise.all([
      copyFile("manifest.json", `${vaultPluginDir}/manifest.json`),
      copyFile("prompt.md", `${vaultPluginDir}/prompt.md`),
      copyFile("styles.css", `${vaultPluginDir}/styles.css`)
    ]);
  }
}

async function syncOutputs() {
  if (existsSync(vaultPluginDir)) {
    await Promise.all([
      copyFile(`${outputDirectory}/main.js`, `${vaultPluginDir}/main.js`),
      copyFile(`${outputDirectory}/plot-worker.js`, `${vaultPluginDir}/plot-worker.js`)
    ]);
  }
}

await copyAssets();

const postBuildPlugin = {
  name: "post-build-sync",
  setup(buildInstance) {
    buildInstance.onEnd(async () => {
      await copyAssets();
      await syncOutputs();
    });
  }
};

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  platform: "browser",
  target: "es2020",
  format: "cjs",
  minify: !watch,
  outfile: `${outputDirectory}/main.js`,
  plugins: [postBuildPlugin]
};

const workerBuildOptions = {
  entryPoints: ["src/plot-worker.ts"],
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
  await copyAssets();
  await syncOutputs();
}