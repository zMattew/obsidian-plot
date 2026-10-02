import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const workerSource = readFileSync(new URL("../dist/plot-worker.js", import.meta.url), "utf8");

function runWorker(data) {
  let response;
  let transferredBuffers = [];
  const workerScope = {
    postMessage(message, transfer = []) {
      response = message;
      transferredBuffers = transfer;
    }
  };
  runInNewContext(workerSource, { self: workerScope, console });
  workerScope.onmessage({ data });
  return { response, transferredBuffers };
}

test("implicit sphere mesh preserves its equation and transfers geometry", () => {
  const { response, transferredBuffers } = runWorker({
    requestId: 17,
    resolution: 24,
    bounds: [-2, 2, -2, 2, -2, 2],
    variables: {},
    items: [{
      id: 3,
      kind: "implicit",
      expression: "x^2 + y^2 + z^2 + x + y + z + 0 = 0",
      color: "#f59e0b",
      opacity: 0.8,
      label: "Sphere"
    }]
  });

  assert.equal(response.requestId, 17);
  assert.equal(response.meshes.length, 1);
  assert.equal(transferredBuffers.length, 2);

  const positions = new Float32Array(response.meshes[0].positions);
  const indices = new Uint32Array(response.meshes[0].indices);
  assert.equal(positions.length % 3, 0);
  assert.equal(indices.length % 3, 0);
  for (let index = 0; index < positions.length; index += 3) {
    const [x, y, z] = positions.slice(index, index + 3);
    assert.ok(Math.abs(x * x + y * y + z * z + x + y + z) < 0.08);
  }
});

test("implicit bounds expand when a surface crosses the initial volume", () => {
  const { response } = runWorker({
    requestId: 1,
    resolution: 24,
    bounds: [-2, 2, -2, 2, -2, 2],
    variables: {},
    items: [{
      id: 0,
      kind: "implicit",
      expression: "x^2 + y^2 + (z - 3)^2 = 1",
      color: "#e91e63",
      opacity: 1,
      label: ""
    }]
  });

  assert.ok(response.bounds[5] > 4);
  const positions = new Float32Array(response.meshes[0].positions);
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 2; index < positions.length; index += 3) maxZ = Math.max(maxZ, positions[index]);
  assert.ok(maxZ < response.bounds[5]);
});

test("explicit surface mesh contains only valid vertices and triangles", () => {
  const { response } = runWorker({
    requestId: 2,
    resolution: 16,
    bounds: [-2, 2, -2, 2, -4, 4],
    variables: {},
    items: [{
      id: 4,
      kind: "explicit",
      expression: "4 - 0.25 * x^2 - 0.25 * y^2",
      color: "#4caf50",
      opacity: 1,
      label: "Paraboloid"
    }]
  });

  const positions = new Float32Array(response.meshes[0].positions);
  const indices = new Uint32Array(response.meshes[0].indices);
  assert.equal(positions.length, 17 * 17 * 3);
  assert.equal(indices.length, 16 * 16 * 6);
  for (let index = 0; index < positions.length; index += 3) {
    const [x, y, z] = positions.slice(index, index + 3);
    assert.ok(Math.abs(z - (4 - 0.25 * x * x - 0.25 * y * y)) < 0.0001);
  }
});

test("explicit piecewise surface is clipped by its branch condition", () => {
  const { response } = runWorker({
    requestId: 3,
    resolution: 16,
    bounds: [-2, 2, -2, 2, -2, 2],
    variables: {},
    items: [{
      id: 5,
      kind: "explicit",
      expression: "x",
      condition: "z >= 0",
      color: "#4caf50",
      opacity: 1,
      label: ""
    }]
  });

  assert.equal(response.meshes.length, 1);
  const positions = new Float32Array(response.meshes[0].positions);
  assert.ok(positions.length > 0);
  for (let index = 2; index < positions.length; index += 3) {
    assert.ok(positions[index] >= 0);
  }
});

test("intersection toggle returns line segments for crossing explicit surfaces", () => {
  const { response, transferredBuffers } = runWorker({
    requestId: 9,
    resolution: 16,
    bounds: [-2, 2, -2, 2, -2, 2],
    variables: {},
    showIntersections: true,
    items: [
      { id: 0, kind: "explicit", expression: "x", color: "#f59e0b", opacity: 1, label: "" },
      { id: 1, kind: "explicit", expression: "-x", color: "#2196f3", opacity: 1, label: "" }
    ]
  });

  const intersections = new Float32Array(response.intersections);
  assert.ok(intersections.length >= 6);
  assert.equal(intersections.length % 6, 0);
  assert.equal(transferredBuffers.length, 5);
  for (let index = 0; index < intersections.length; index += 3) {
    assert.ok(Math.abs(intersections[index]) < 0.0001);
    assert.ok(Math.abs(intersections[index + 2]) < 0.0001);
  }
});

test("system intersection toggle only highlights equations in its own group", () => {
  const { response } = runWorker({
    requestId: 11,
    resolution: 16,
    bounds: [-2, 2, -2, 2, -2, 2],
    variables: {},
    showIntersections: false,
    items: [
      { id: 0, kind: "explicit", expression: "x", intersectionGroup: 4, showIntersections: true, color: "#e91e63", opacity: 1, label: "" },
      { id: 1, kind: "explicit", expression: "-x", intersectionGroup: 4, showIntersections: true, color: "#4caf50", opacity: 1, label: "" },
      { id: 2, kind: "explicit", expression: "y", color: "#2196f3", opacity: 1, label: "" },
      { id: 3, kind: "explicit", expression: "-y", color: "#ff9800", opacity: 1, label: "" }
    ]
  });

  const intersections = new Float32Array(response.intersections);
  assert.ok(intersections.length > 0);
  for (let index = 0; index < intersections.length; index += 3) {
    assert.ok(Math.abs(intersections[index]) < 0.0001);
  }
});