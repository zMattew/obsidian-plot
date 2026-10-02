import { MathExpressionCompiler } from "./math-expression";

export interface SystemSolution {
  x: number;
  y: number;
  z: number;
}

const compiler = new MathExpressionCompiler();

function compileCurve(equation: string, variables: Record<string, number>): ((x: number) => number | null) | null {
  const expression = equation.trim().replace(/^y\s*=\s*/i, "");
  const compiled = compiler.compile(expression, variables, ["x"]);
  if (!compiled) return null;
  return x => {
    try {
      const value = compiled({ ...variables, x });
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
}

export function findCurveIntersections(
  equations: string[],
  variables: Record<string, number>,
  bounds: [number, number],
  samples = 256
): SystemSolution[] {
  const curves = equations.map(equation => compileCurve(equation, variables));
  if (curves.length < 2 || curves.some(curve => curve === null)) return [];
  const solutions: SystemSolution[] = [];
  const [xMin, xMax] = bounds;
  const step = (xMax - xMin) / Math.max(16, samples);

  for (let first = 0; first < curves.length; first++) {
    for (let second = first + 1; second < curves.length; second++) {
      const curveA = curves[first];
      const curveB = curves[second];
      let previous: { x: number; difference: number } | null = null;
      for (let index = 0; index <= samples; index++) {
        const x = xMin + index * step;
        const yA = curveA(x);
        const yB = curveB(x);
        if (yA === null || yB === null) {
          previous = null;
          continue;
        }
        const difference = yA - yB;
        if (previous && ((previous.difference <= 0 && difference >= 0) || (previous.difference >= 0 && difference <= 0))) {
          const fraction = Math.abs(previous.difference - difference) < 1e-12
            ? 0
            : previous.difference / (previous.difference - difference);
          const solutionX = previous.x + (x - previous.x) * fraction;
          const valueA = curveA(solutionX);
          const valueB = curveB(solutionX);
          if (valueA !== null && valueB !== null) {
            const candidate = { x: solutionX, y: (valueA + valueB) / 2, z: 0 };
            if (!solutions.some(solution => Math.abs(solution.x - candidate.x) < step && Math.abs(solution.y - candidate.y) < step)) {
              solutions.push(candidate);
            }
          }
        }
        previous = { x, difference };
      }
    }
  }

  return solutions;
}

export function findCurveSystemSolutions(
  equations: string[],
  variables: Record<string, number>,
  bounds: [number, number],
  samples = 256
): SystemSolution[] {
  const curves = equations.map(equation => compileCurve(equation, variables));
  if (curves.length < 2 || curves.some(curve => curve === null)) return [];
  const tolerance = Math.max(1e-4, (bounds[1] - bounds[0]) / Math.max(16, samples) * 2);
  return findCurveIntersections(equations, variables, bounds, samples).filter(solution =>
    curves.every(curve => Math.abs((curve(solution.x) ?? Number.POSITIVE_INFINITY) - solution.y) <= tolerance)
  );
}

function compileResidual(equation: string, variables: Record<string, number>): ((x: number, y: number, z: number) => number | null) | null {
  const source = equation.trim();
  const explicit = source.match(/^z\s*=\s*([\s\S]+)$/i);
  if (explicit) {
    const compiled = compiler.compile(explicit[1], variables, ["x", "y"]);
    if (!compiled) return null;
    return (x, y, z) => {
      try {
        const value = compiled({ ...variables, x, y });
        return typeof value === "number" && Number.isFinite(value) ? z - value : null;
      } catch {
        return null;
      }
    };
  }

  const equalsIndex = source.indexOf("=");
  if (equalsIndex < 1 || equalsIndex !== source.lastIndexOf("=")) return null;
  const compiled = compiler.compile(`(${source.slice(0, equalsIndex)}) - (${source.slice(equalsIndex + 1)})`, variables, ["x", "y", "z"]);
  if (!compiled) return null;
  return (x, y, z) => {
    try {
      const value = compiled({ ...variables, x, y, z });
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-10) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const scale = rows[column][column];
    for (let entry = column; entry < 4; entry++) rows[column][entry] /= scale;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let entry = column; entry < 4; entry++) rows[row][entry] -= factor * rows[column][entry];
    }
  }
  return rows.map(row => row[3]);
}

export function findSpatialSolutions(
  equations: string[],
  variables: Record<string, number>,
  bounds: [number, number, number, number, number, number]
): SystemSolution[] {
  if (equations.length < 3) return [];
  const allFields = equations.map(equation => compileResidual(equation, variables));
  if (allFields.some(field => field === null)) return [];
  const fields = allFields.slice(0, 3);
  const [xMin, xMax, yMin, yMax, zMin, zMax] = bounds;
  const seedFractions = [0.2, 0.5, 0.8];
  const solutions: SystemSolution[] = [];

  for (const xFraction of seedFractions) {
    for (const yFraction of seedFractions) {
      for (const zFraction of seedFractions) {
        const point = [
          xMin + (xMax - xMin) * xFraction,
          yMin + (yMax - yMin) * yFraction,
          zMin + (zMax - zMin) * zFraction
        ];
        for (let iteration = 0; iteration < 24; iteration++) {
          const values = fields.map(field => field(point[0], point[1], point[2]));
          if (values.some(value => value === null)) break;
          const residuals = values;
          const norm = Math.hypot(...residuals);
          if (norm < 1e-5) {
            const [x, y, z] = point;
            const candidate = { x, y, z };
            if (!solutions.some(solution => Math.hypot(solution.x - x, solution.y - y, solution.z - z) < 0.02)) {
              solutions.push(candidate);
            }
            break;
          }

          const epsilon = 1e-5;
          const jacobian = fields.map((field, row) => point.map((coordinate, column) => {
            const shifted = [...point];
            shifted[column] = coordinate + epsilon;
            const shiftedValue = field(shifted[0], shifted[1], shifted[2]);
            return shiftedValue === null ? 0 : (shiftedValue - residuals[row]) / epsilon;
          }));
          const delta = solveLinearSystem(jacobian, residuals);
          if (!delta || delta.some(value => !Number.isFinite(value))) break;
          point[0] -= delta[0];
          point[1] -= delta[1];
          point[2] -= delta[2];
          if (point[0] < xMin - 0.5 || point[0] > xMax + 0.5 || point[1] < yMin - 0.5 || point[1] > yMax + 0.5 || point[2] < zMin - 0.5 || point[2] > zMax + 0.5) break;
        }
      }
    }
  }

  return solutions.filter(solution => allFields.every(field => Math.abs(field(solution.x, solution.y, solution.z) ?? Number.POSITIVE_INFINITY) < 1e-4));
}