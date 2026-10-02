import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../system-solver.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false
});
const solverModule = { exports: {} };
runInNewContext(outputFiles[0].text, {
  exports: solverModule.exports,
  module: solverModule,
  require: createRequire(import.meta.url)
});

const { findCurveIntersections, findCurveSystemSolutions, findSpatialSolutions } = solverModule.exports;

test("2D system solver finds intersections of explicit curves", () => {
  const intersections = findCurveIntersections(["y = x", "y = 2 - x"], {}, [-3, 3]);

  assert.equal(intersections.length, 1);
  assert.ok(Math.abs(intersections[0].x - 1) < 0.01);
  assert.ok(Math.abs(intersections[0].y - 1) < 0.01);
});

test("3D system solver finds isolated intersections of three surfaces", () => {
  const solutions = findSpatialSolutions(["x = 0", "y = 0", "z = x + y"], {}, [-2, 2, -2, 2, -2, 2]);

  assert.ok(solutions.length >= 1);
  assert.ok(solutions.some(solution => Math.hypot(solution.x, solution.y, solution.z) < 0.001));
});

test("3D system solver does not report isolated solutions for fewer than three equations", () => {
  assert.equal(findSpatialSolutions(["x = 0", "y = 0"], {}, [-2, 2, -2, 2, -2, 2]).length, 0);
});

test("2D system solver filters pairwise intersections that do not satisfy every curve", () => {
  const solutions = findCurveSystemSolutions(["y = x", "y = 2 - x", "y = 2"], {}, [-3, 3]);

  assert.equal(solutions.length, 0);
});

test("3D system solver validates candidates against additional equations", () => {
  const solutions = findSpatialSolutions(["x = 0", "y = 0", "z = 0", "x = 1"], {}, [-2, 2, -2, 2, -2, 2]);

  assert.equal(solutions.length, 0);
});