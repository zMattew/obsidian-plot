declare module "isosurface" {
  export interface SurfaceNetsMesh {
    positions: number[][];
    cells: number[][];
  }

  export function surfaceNets(
    dimensions: [number, number, number],
    potential: (x: number, y: number, z: number) => number,
    bounds?: [[number, number, number], [number, number, number]]
  ): SurfaceNetsMesh;
}