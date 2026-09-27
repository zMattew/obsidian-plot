/**
 * Core primitive types and string format aliases.
 */

/** Mathematical expression (Standard JS arithmetic or LaTeX syntax: e.g., "x^2", "\\sqrt{x}", "\\sin(x)"). */
export type MathExpr = string;

/** Comma-separated coordinate tuple supporting numbers and defined variable names: "x, y" (2D) or "x, y, z" (3D). */
export type CoordTuple = string;

/** Hexadecimal color string (e.g., "#4caf50", "#e91e63"). */
export type HexColor = string;

// ============================================================================
// ITEM DEFINITIONS
// ============================================================================

/**
 * Interactive variable controlled via an in-UI slider.
 */
export interface PlotVariable {
  type: "var";
  /** Variable identifier (single letter: a-w, excluding reserved axis variables x, y, z). */
  name: string;
  /** Initial numeric value. */
  value: number;
  /** Minimum slider boundary. */
  min?: number;
  /** Maximum slider boundary. */
  max?: number;
  /** Step increment value. */
  step?: number;
}

/**
 * Continuous scalar function (2D: y = f(x), 3D: z = f(x, y)).
 */
export interface PlotFunction {
  type: "fn";
  /** Explicit expression to evaluate (e.g., "4 - 0.25*x^2 - 0.2*y^2"). */
  fn: MathExpr;
  /** Hex color code for the surface mesh or 2D curve. */
  color?: HexColor;
  /** Opacity factor ranging from 0.0 (transparent) to 1.0 (opaque). */
  opacity?: number;
  /** Optional floating label rendered next to the curve/surface in the viewport. */
  label?: string;
  /** Visibility toggle state. Defaults to true. */
  visible?: boolean;
}

/**
 * Point marker plotted in 2D or 3D space with an automatic dashed reference drop-line to the z=0 plane.
 */
export interface PlotPoint {
  type: "point";
  /** Coordinates expression: "x, y" (2D) or "x, y, z" (3D). Variables are dynamically evaluated. */
  coords: CoordTuple;
  /** Spherical marker color. */
  color?: HexColor;
  /** Pinned text label displayed next to the point. */
  label?: string;
  /** Visibility toggle state. Defaults to true. */
  visible?: boolean;
}

/**
 * Directed vector or tangent line segment rendered with a directional arrowhead.
 */
export interface PlotVector {
  type: "vector";
  /** Vector origin coordinates: "x, y, z". Supports variable expressions. */
  origin: CoordTuple;
  /** Directional delta vector components: "dx, dy, dz". */
  dir: CoordTuple;
  /** Color of the vector shaft and arrowhead. */
  color?: HexColor;
  /** Floating text label anchored at the tip of the arrowhead. */
  label?: string;
  /** Visibility toggle state. Defaults to true. */
  visible?: boolean;
}

/** Union of all entity items supported in a plot block. */
export type PlotItem = PlotVariable | PlotFunction | PlotPoint | PlotVector;

// ============================================================================
// CAMERA & AXES CONFIGURATION
// ============================================================================

/**
 * Viewport camera positioning, perspective angles, and pan translation.
 */
export interface PlotCamera {
  /** Polar inclination angle in radians (Standard isometric default: 1.05). */
  rotX?: number;
  /** Azimuthal rotation angle in radians (Standard isometric default: -1.95). */
  rotZ?: number;
  /** Viewport zoom scale factor (Default: 38). */
  scale?: number;
  /** Horizontal pan displacement in pixels (Default: -40). */
  panX?: number;
  /** Vertical pan displacement in pixels (Default: 20). */
  panY?: number;
}

/**
 * Selective axis visibility toggles.
 */
export interface AxesVisibility {
  x?: boolean;
  y?: boolean;
  /** Applicable only in 3D mode. */
  z?: boolean;
}

// ============================================================================
// ROOT CONFIGURATION
// ============================================================================

/**
 * Root schema for the ```math-plot code block.
 */
export interface MathPlotConfig {
  /** Dimension mode of the plot canvas. */
  type: "2d" | "3d";
  /** Surface render style (Applicable in 3D mode). */
  renderStyle?: "wireframe" | "solid" | "points";
  /** Grid sampling density steps (Recommended range: 40 - 70. Default: 50). */
  resolution?: number;
  /** Automatically highlight curve intersections between distinct 3D surfaces in yellow. */
  showIntersections?: boolean;
  /** Axis ornamentation: "ticks" (graduated relief marks), "grid" (full mesh planes), or "none". */
  axisMode?: "ticks" | "grid" | "none";
  /** Displays numeric graduation numbers along the axes. */
  showAxisNumbers?: boolean;
  /** Selective axes visibility flags. */
  axesEnabled?: AxesVisibility;
  /** When enabled, collapses all controls and equation inputs to show only the interactive canvas. */
  viewOnly?: boolean;
  /**
   * Spatial domain boundaries:
   * - 2D mode: [xMin, xMax] (e.g., [-8, 8])
   * - 3D mode: [xMin, xMax, yMin, yMax] (e.g., [-4, 4, -4, 4])
   */
  bounds?: [number, number] | [number, number, number, number];
  /** Initial camera pose and translation parameters. */
  camera?: PlotCamera;
  /** Ordered list of mathematical elements, variables, points, and vectors. */
  items: PlotItem[];
}