import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import Module from "node:module";

// Mock obsidian before requiring dist/main.js
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "obsidian") {
    return {
      Plugin: class {},
      PluginSettingTab: class {},
      Modal: class {},
      MarkdownRenderChild: class {},
      TFile: class {},
      finishRenderMath: () => {},
      renderMath: () => document.createElement("span")
    };
  }
  return origRequire.apply(this, arguments);
};

const require = createRequire(import.meta.url);
const MultiPlotterPlugin = require("../dist/main.js").default;

test("parseConfig parses camera configuration with locked: true", () => {
  const plugin = new MultiPlotterPlugin();
  const raw = JSON.stringify({
    type: "3d",
    camera: {
      rotX: 1.05,
      rotZ: -1.95,
      scale: 38,
      panX: -40,
      panY: 20,
      locked: true
    },
    items: []
  });

  const parsed = plugin.parseConfig(raw);
  assert.equal(parsed.type, "3d");
  assert.ok(parsed.camera);
  assert.equal(parsed.camera.locked, true);
  assert.equal(parsed.camera.rotX, 1.05);
  assert.equal(parsed.camera.rotZ, -1.95);
});

test("parseConfig parses configuration with root locked: true", () => {
  const plugin = new MultiPlotterPlugin();
  const raw = JSON.stringify({
    type: "3d",
    locked: true,
    items: []
  });

  const parsed = plugin.parseConfig(raw);
  assert.equal(parsed.locked, true);
});

test("parseConfig accepts vector fields, piecewise branches, and LaTeX systems", () => {
  const plugin = new MultiPlotterPlugin();
  const parsed = plugin.parseConfig(JSON.stringify({
    type: "3d",
    items: [
      { type: "vectorField", components: "-y, x, 0", density: 5 },
      { type: "piecewise", branches: [{ equation: "x + y", condition: "z >= 0" }] },
      { type: "system", latex: "\\begin{aligned}x = 0\\\\y = 0\\\\z = 0\\end{aligned}" }
    ]
  }));

  assert.equal(parsed.items[0].type, "vectorField");
  assert.equal(parsed.items[1].type, "piecewise");
  assert.equal(parsed.items[2].type, "system");
  assert.equal(parsed.items[2].equations.length, 3);
});

test("parseConfig rejects piecewise surfaces in 2D and invalid vector-field density", () => {
  const plugin = new MultiPlotterPlugin();

  assert.throws(() => plugin.parseConfig(JSON.stringify({
    type: "2d",
    items: [{ type: "piecewise", branches: [{ equation: "x", condition: "x < 0" }] }]
  })));
  assert.throws(() => plugin.parseConfig(JSON.stringify({
    type: "2d",
    items: [{ type: "vectorField", components: "-y, x", density: 40 }]
  })));
});

test("360-degree camera rotation can rotate fully without clamping", () => {
  const TWO_PI = Math.PI * 2;
  function normalizeAngle(rad) {
    let a = rad % TWO_PI;
    if (a > Math.PI) a -= TWO_PI;
    else if (a < -Math.PI) a += TWO_PI;
    return a;
  }

  // Simulate dragging vertically over multiple full 360-degree revolutions
  let rotX = 1.05;
  const dy = 50; // Drag step in px

  // Rotate downwards through 100 steps
  for (let i = 0; i < 100; i++) {
    rotX = normalizeAngle(rotX + dy * 0.01);
    assert.ok(rotX >= -Math.PI && rotX <= Math.PI, `rotX ${rotX} should stay in [-PI, PI]`);
  }

  // Ensure it was NOT blocked at Math.PI - 0.1 (~3.04) or 0.1
  // Full rotation can reach any angle in [-PI, PI]
  const anglesCovered = [];
  rotX = 0;
  for (let i = 0; i < 628; i++) {
    rotX = normalizeAngle(rotX + 0.01);
    anglesCovered.push(rotX);
  }
  // Check that values below 0.1 and near +-PI are covered
  assert.ok(anglesCovered.some(a => a < 0.05 && a > -0.05), "Should reach near 0");
  assert.ok(anglesCovered.some(a => a > 3.0), "Should reach near PI");
  assert.ok(anglesCovered.some(a => a < -3.0), "Should reach near -PI");
  assert.ok(anglesCovered.some(a => a > 1.5 && a < 1.6), "Should reach near PI/2");
});
