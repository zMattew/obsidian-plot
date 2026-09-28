import { surfaceNets } from "isosurface";
import { expandImplicitBounds } from "./implicit-bounds";
import { MathExpressionCompiler } from "./math-expression";
import type { MeshRequest, MeshResponse, PlotBounds3D, RenderedMeshData } from "./plot-protocol";

const compiler = new MathExpressionCompiler();

function finiteValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function triangulate(cells: number[][]): Uint32Array {
  const indices: number[] = [];
  cells.forEach(cell => {
    for (let index = 1; index < cell.length - 1; index++) {
      indices.push(cell[0], cell[index], cell[index + 1]);
    }
  });
  return new Uint32Array(indices);
}

function createImplicitMesh(
  equation: string,
  variables: Record<string, number>,
  bounds: PlotBounds3D,
  resolution: number
): { positions: Float32Array; indices: Uint32Array; bounds: PlotBounds3D } | null {
  const equalsIndex = equation.indexOf("=");
  if (equalsIndex <= 0 || equalsIndex !== equation.lastIndexOf("=")) return null;
  const left = equation.slice(0, equalsIndex).trim();
  const right = equation.slice(equalsIndex + 1).trim();
  if (!left || !right) return null;

  const compiled = compiler.compile(`(${left}) - (${right})`, variables, ["x", "y", "z"]);
  if (!compiled) return null;
  const scope = { ...variables, x: 0, y: 0, z: 0 };
  const field = (x: number, y: number, z: number): number | null => {
    scope.x = x;
    scope.y = y;
    scope.z = z;
    try {
      return finiteValue(compiled(scope));
    } catch {
      return null;
    }
  };

  const expandedBounds = expandImplicitBounds(field, bounds);
  const spans = [
    expandedBounds[1] - expandedBounds[0],
    expandedBounds[3] - expandedBounds[2],
    expandedBounds[5] - expandedBounds[4]
  ];
  const longestSpan = Math.max(...spans);
  const dimensions = spans.map(span => Math.max(12, Math.ceil(resolution * span / longestSpan))) as [number, number, number];
  const mesh = surfaceNets(
    dimensions,
    (x, y, z) => field(x, y, z) ?? 1e6,
    [
      [expandedBounds[0], expandedBounds[2], expandedBounds[4]],
      [expandedBounds[1], expandedBounds[3], expandedBounds[5]]
    ]
  );

  return {
    positions: new Float32Array(mesh.positions.flat()),
    indices: triangulate(mesh.cells),
    bounds: expandedBounds
  };
}

function createExplicitEvaluator(
  expression: string,
  variables: Record<string, number>
): ((x: number, y: number) => number | null) | null {
  const source = expression.trim().replace(/^(z|f\([xXyY,\s]+\))\s*=\s*/i, "");
  const compiled = compiler.compile(source, variables, ["x", "y"]);
  if (!compiled) return null;

  const scope = { ...variables, x: 0, y: 0 };
  return (x: number, y: number) => {
    scope.x = x;
    scope.y = y;
    try {
      return finiteValue(compiled(scope));
    } catch {
      return null;
    }
  };
}

function createExplicitMesh(
  field: (x: number, y: number) => number | null,
  bounds: PlotBounds3D,
  resolution: number
): { positions: Float32Array; indices: Uint32Array } {
  const divisions = Math.max(12, Math.min(100, Math.round(resolution)));
  const [xMin, xMax, yMin, yMax] = bounds;
  const positions = new Float32Array((divisions + 1) * (divisions + 1) * 3);
  const valid = new Uint8Array((divisions + 1) * (divisions + 1));

  for (let row = 0; row <= divisions; row++) {
    const y = yMin + (yMax - yMin) * row / divisions;
    for (let column = 0; column <= divisions; column++) {
      const x = xMin + (xMax - xMin) * column / divisions;
      const z = field(x, y);

      const vertexIndex = row * (divisions + 1) + column;
      if (z === null) continue;
      valid[vertexIndex] = 1;
      const offset = vertexIndex * 3;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
    }
  }

  const vertexMap = new Int32Array(valid.length);
  vertexMap.fill(-1);
  const compactPositions: number[] = [];
  for (let vertexIndex = 0; vertexIndex < valid.length; vertexIndex++) {
    if (!valid[vertexIndex]) continue;
    vertexMap[vertexIndex] = compactPositions.length / 3;
    const offset = vertexIndex * 3;
    compactPositions.push(positions[offset], positions[offset + 1], positions[offset + 2]);
  }

  const indices: number[] = [];
  for (let row = 0; row < divisions; row++) {
    for (let column = 0; column < divisions; column++) {
      const lowerLeft = row * (divisions + 1) + column;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + divisions + 1;
      const upperRight = upperLeft + 1;
      if (!valid[lowerLeft] || !valid[lowerRight] || !valid[upperLeft] || !valid[upperRight]) continue;
      indices.push(vertexMap[lowerLeft], vertexMap[lowerRight], vertexMap[upperRight], vertexMap[lowerLeft], vertexMap[upperRight], vertexMap[upperLeft]);
    }
  }

  return { positions: new Float32Array(compactPositions), indices: new Uint32Array(indices) };
}

function findIntersections(
  fields: Array<(x: number, y: number) => number | null>,
  bounds: PlotBounds3D,
  resolution: number
): Float32Array {
  const divisions = Math.max(12, Math.min(64, Math.round(resolution)));
  const [xMin, xMax, yMin, yMax] = bounds;
  const stepX = (xMax - xMin) / divisions;
  const stepY = (yMax - yMin) / divisions;
  const segments: number[] = [];

  for (let first = 0; first < fields.length; first++) {
    for (let second = first + 1; second < fields.length; second++) {
      const gridA: Array<number | null> = [];
      const gridB: Array<number | null> = [];
      for (let row = 0; row <= divisions; row++) {
        const y = yMin + row * stepY;
        for (let column = 0; column <= divisions; column++) {
          const x = xMin + column * stepX;
          gridA.push(fields[first](x, y));
          gridB.push(fields[second](x, y));
        }
      }

      for (let row = 0; row < divisions; row++) {
        const y0 = yMin + row * stepY;
        const y1 = yMin + (row + 1) * stepY;
        for (let column = 0; column < divisions; column++) {
          const x0 = xMin + column * stepX;
          const x1 = xMin + (column + 1) * stepX;
          const lowerLeft = row * (divisions + 1) + column;
          const lowerRight = lowerLeft + 1;
          const upperLeft = lowerLeft + divisions + 1;
          const upperRight = upperLeft + 1;
          const differences = [
            gridA[lowerLeft] !== null && gridB[lowerLeft] !== null ? gridA[lowerLeft]! - gridB[lowerLeft]! : null,
            gridA[lowerRight] !== null && gridB[lowerRight] !== null ? gridA[lowerRight]! - gridB[lowerRight]! : null,
            gridA[upperRight] !== null && gridB[upperRight] !== null ? gridA[upperRight]! - gridB[upperRight]! : null,
            gridA[upperLeft] !== null && gridB[upperLeft] !== null ? gridA[upperLeft]! - gridB[upperLeft]! : null
          ];
          if (differences.some(value => value === null)) continue;
          const [d00, d10, d11, d01] = differences as [number, number, number, number];
          const crossings: Array<[number, number]> = [];
          const cross = (d0: number, d1: number, ax: number, ay: number, bx: number, by: number): void => {
            if ((d0 >= 0 && d1 < 0) || (d0 < 0 && d1 >= 0)) {
              const t = d0 / (d0 - d1);
              crossings.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
            }
          };
          cross(d00, d10, x0, y0, x1, y0);
          cross(d10, d11, x1, y0, x1, y1);
          cross(d01, d11, x0, y1, x1, y1);
          cross(d00, d01, x0, y0, x0, y1);

          if (crossings.length < 2) continue;
          const firstPoint = crossings[0];
          const secondPoint = crossings[1];
          const firstZ = fields[first](firstPoint[0], firstPoint[1]);
          const secondZ = fields[first](secondPoint[0], secondPoint[1]);
          if (firstZ === null || secondZ === null) continue;
          segments.push(firstPoint[0], firstPoint[1], firstZ, secondPoint[0], secondPoint[1], secondZ);
        }
      }
    }
  }

  return new Float32Array(segments);
}

function buildResponse(request: MeshRequest): MeshResponse {
  let bounds = request.bounds;
  const meshes: RenderedMeshData[] = [];
  const explicitFields: Array<(x: number, y: number) => number | null> = [];

  request.items.forEach(item => {
    let mesh: { positions: Float32Array; indices: Uint32Array; bounds?: PlotBounds3D } | null;
    if (item.kind === "implicit") {
      mesh = createImplicitMesh(item.expression, request.variables, bounds, request.resolution);
    } else {
      const field = createExplicitEvaluator(item.expression, request.variables);
      if (!field) return;
      explicitFields.push(field);
      mesh = createExplicitMesh(field, bounds, request.resolution);
    }
    if (!mesh) return;

    if (item.kind === "implicit") {
      const implicitBounds = mesh.bounds;
      if (implicitBounds) {
        bounds = [
          Math.min(bounds[0], implicitBounds[0]), Math.max(bounds[1], implicitBounds[1]),
          Math.min(bounds[2], implicitBounds[2]), Math.max(bounds[3], implicitBounds[3]),
          Math.min(bounds[4], implicitBounds[4]), Math.max(bounds[5], implicitBounds[5])
        ];
      }
    }

    meshes.push({
      id: item.id,
      kind: item.kind,
      positions: mesh.positions.buffer as ArrayBuffer,
      indices: mesh.indices.buffer as ArrayBuffer,
      color: item.color,
      opacity: item.opacity,
      label: item.label
    });
  });

  const intersections = request.showIntersections
    ? findIntersections(explicitFields, bounds, request.resolution)
    : new Float32Array(0);
  return { requestId: request.requestId, bounds, meshes, intersections: intersections.buffer as ArrayBuffer };
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MeshRequest>) => void) | null;
  postMessage(message: MeshResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = event => {
  try {
    const response = buildResponse(event.data);
    const transfer = response.meshes.flatMap(mesh => [mesh.positions, mesh.indices]);
    if (response.intersections.byteLength > 0) transfer.push(response.intersections);
    workerScope.postMessage(response, transfer);
  } catch (error) {
    workerScope.postMessage({
      requestId: event.data.requestId,
      bounds: event.data.bounds,
      meshes: [],
      intersections: new ArrayBuffer(0),
      error: error instanceof Error ? error.message : String(error)
    });
  }
};