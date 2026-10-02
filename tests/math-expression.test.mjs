import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";

const source = readFileSync(new URL("../math-expression.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "cjs" });
const expressionModule = { exports: {} };
runInNewContext(code, {
  exports: expressionModule.exports,
  module: expressionModule,
  require: createRequire(import.meta.url)
});

const { MathExpressionCompiler } = expressionModule.exports;

test("condition compiler evaluates comparisons and logical expressions", () => {
  const compiler = new MathExpressionCompiler();
  const condition = compiler.compileCondition("x >= 0 and y < 2", {}, ["x", "y", "z"]);

  assert.ok(condition);
  assert.equal(condition({ x: 1, y: 1, z: 0 }), true);
  assert.equal(condition({ x: -1, y: 1, z: 0 }), false);
  assert.equal(condition({ x: 1, y: 2, z: 0 }), false);
});

test("condition compiler accepts common LaTeX comparison and logic commands", () => {
  const compiler = new MathExpressionCompiler();
  const condition = compiler.compileCondition("x \\geq 1 \\land y \\le 3", {}, ["x", "y"]);

  assert.ok(condition);
  assert.equal(condition({ x: 2, y: 3 }), true);
  assert.equal(condition({ x: 0, y: 3 }), false);
});

test("condition compiler interprets a single equals sign as equality", () => {
  const compiler = new MathExpressionCompiler();
  const condition = compiler.compileCondition("x = 2", {}, ["x"]);

  assert.ok(condition);
  assert.equal(condition({ x: 2 }), true);
  assert.equal(condition({ x: 1 }), false);
});

test("condition compiler rejects unknown symbols and unsupported AST nodes", () => {
  const compiler = new MathExpressionCompiler();

  assert.equal(compiler.compileCondition("x > secret", {}, ["x"]), null);
  assert.equal(compiler.compileCondition("x!", {}, ["x"]), null);
  assert.equal(compiler.compileCondition("x > 0", {}, ["x"] )?.({ x: 1 }), true);
});