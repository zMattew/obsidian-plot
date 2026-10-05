import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/navigation-settings.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false
});
const settingsModule = { exports: {} };
runInNewContext(outputFiles[0].text, {
  exports: settingsModule.exports,
  module: settingsModule,
  require: createRequire(import.meta.url)
});

const { DEFAULT_NAVIGATION_SETTINGS, normalizeKeybinding, resolveNavigationAction } = settingsModule.exports;

test("navigation shortcuts resolve case-insensitively with modifiers", () => {
  const settings = {
    ...DEFAULT_NAVIGATION_SETTINGS,
    keys: { ...DEFAULT_NAVIGATION_SETTINGS.keys, zoomIn: "Ctrl+Shift+=" }
  };

  assert.equal(normalizeKeybinding("Shift+Ctrl+= "), "ctrl+shift+=");
  assert.equal(resolveNavigationAction({ key: "=", ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }, settings), "zoomIn");
});

test("unmapped navigation keys do not produce an action", () => {
  assert.equal(resolveNavigationAction({ key: "x", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, DEFAULT_NAVIGATION_SETTINGS), null);
});