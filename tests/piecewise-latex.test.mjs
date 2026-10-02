import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { transform } from "esbuild";

const source = readFileSync(new URL("../piecewise-latex.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "cjs" });
const piecewiseModule = { exports: {} };
runInNewContext(code, { exports: piecewiseModule.exports, module: piecewiseModule });

const { parsePiecewiseLatex, serializePiecewiseLatex, parseSystemLatex, serializeSystemLatex } = piecewiseModule.exports;

test("piecewise LaTeX round-trips equation-condition branches", () => {
  const sourceLatex = String.raw`\begin{cases}
x + y & \text{z >= 0} \\
x - y & \text{z < 0}
\end{cases}`;
  const branches = parsePiecewiseLatex(sourceLatex);

  assert.deepEqual(JSON.parse(JSON.stringify(branches)), [
    { equation: "x + y", condition: "z >= 0" },
    { equation: "x - y", condition: "z < 0" }
  ]);
  assert.equal(
    JSON.stringify(parsePiecewiseLatex(serializePiecewiseLatex(branches))),
    JSON.stringify(branches)
  );
});

test("piecewise LaTeX parser rejects rows without an equation-condition separator", () => {
  assert.equal(parsePiecewiseLatex(String.raw`\begin{cases}x+y\end{cases}`), null);
});

test("system LaTeX round-trips aligned equations", () => {
  const equations = ["x + y = 1", "x - y = 3"];

  assert.deepEqual(JSON.parse(JSON.stringify(parseSystemLatex(serializeSystemLatex(equations)))), equations);
});