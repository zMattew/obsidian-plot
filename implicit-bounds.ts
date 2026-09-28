import type { PlotBounds3D } from "./plot-protocol";

export function expandImplicitBounds(
  field: (x: number, y: number, z: number) => number | null,
  initialBounds: PlotBounds3D
): PlotBounds3D {
  const bounds = initialBounds.slice() as PlotBounds3D;
  const faceSamples = 12;

  for (let pass = 0; pass < 5; pass++) {
    const expandLow = [false, false, false];
    const expandHigh = [false, false, false];

    for (let axis = 0; axis < 3; axis++) {
      for (const highSide of [false, true]) {
        const faceCoordinate = bounds[axis * 2 + (highSide ? 1 : 0)];
        let minValue = Number.POSITIVE_INFINITY;
        let maxValue = Number.NEGATIVE_INFINITY;

        for (let u = 0; u <= faceSamples; u++) {
          for (let v = 0; v <= faceSamples; v++) {
            const coordinates = [0, 0, 0];
            coordinates[axis] = faceCoordinate;
            let otherAxis = 0;
            for (let coordinateAxis = 0; coordinateAxis < 3; coordinateAxis++) {
              if (coordinateAxis === axis) continue;
              const min = bounds[coordinateAxis * 2];
              const max = bounds[coordinateAxis * 2 + 1];
              coordinates[coordinateAxis] = otherAxis === 0
                ? min + (max - min) * u / faceSamples
                : min + (max - min) * v / faceSamples;
              otherAxis++;
            }

            const value = field(coordinates[0], coordinates[1], coordinates[2]);
            if (value === null) continue;
            minValue = Math.min(minValue, value);
            maxValue = Math.max(maxValue, value);
          }
        }

        if (minValue <= 0 && maxValue >= 0) {
          if (highSide) expandHigh[axis] = true;
          else expandLow[axis] = true;
        }
      }
    }

    if (![...expandLow, ...expandHigh].some(Boolean)) break;

    for (let axis = 0; axis < 3; axis++) {
      const span = bounds[axis * 2 + 1] - bounds[axis * 2];
      const margin = Math.max(span * 0.5, 1);
      if (expandLow[axis]) bounds[axis * 2] -= margin;
      if (expandHigh[axis]) bounds[axis * 2 + 1] += margin;
    }
  }

  return bounds;
}