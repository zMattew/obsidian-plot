export type PlotBounds3D = [number, number, number, number, number, number];

export interface MeshRequestItem {
  id: number;
  kind: "explicit" | "implicit";
  expression: string;
  condition?: string;
  intersectionGroup?: number;
  showIntersections?: boolean;
  color: string;
  opacity: number;
  label: string;
}

export interface MeshRequest {
  requestId: number;
  resolution: number;
  bounds: PlotBounds3D;
  variables: Record<string, number>;
  showIntersections: boolean;
  items: MeshRequestItem[];
}

export interface RenderedMeshData {
  id: number;
  kind: MeshRequestItem["kind"];
  positions: ArrayBuffer;
  indices: ArrayBuffer;
  color: string;
  opacity: number;
  label: string;
}

export interface MeshResponse {
  requestId: number;
  bounds: PlotBounds3D;
  meshes: RenderedMeshData[];
  intersections: ArrayBuffer;
  error?: string;
}