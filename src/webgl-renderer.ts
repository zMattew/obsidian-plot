import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { RenderedMeshData } from "./plot-protocol";
import { renderMathLabel } from "./math-label";

export interface WebGLViewState {
  width: number;
  height: number;
  rotX: number;
  rotZ: number;
  scale: number;
  panX: number;
  panY: number;
  bounds: [number, number, number, number, number, number];
  renderStyle: "wireframe" | "solid" | "points";
  axisMode: "ticks" | "grid" | "none";
  axesEnabled: { x: boolean; y: boolean; z: boolean };
  showAxisNumbers: boolean;
}

export type WebGLOverlayItem =
  | { type: "point"; origin: [number, number, number]; color: string; label: string }
  | { type: "vector"; origin: [number, number, number]; direction: [number, number, number]; color: string; label: string }
  | {
      type: "vectorField";
      origin: [number, number, number];
      vectors: Array<{ origin: [number, number, number]; direction: [number, number, number] }>;
      length: number;
      color: string;
      label: string;
    };

function disposeGroup(group: THREE.Group): void {
  group.traverse(object => {
    const renderable = object as THREE.Mesh | THREE.Line | THREE.Points;
    renderable.geometry?.dispose();
    const material = renderable.material;
    if (Array.isArray(material)) material.forEach(entry => entry.dispose());
    else material?.dispose();
  });
  group.clear();
}

export class WebGLPlotRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly labelsElement: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10000);
  private world = new THREE.Group();
  private meshes = new THREE.Group();
  private intersectionLines = new THREE.Group();
  private axes = new THREE.Group();
  private overlays = new THREE.Group();
  private meshLabels = new THREE.Group();
  private axisLabels = new THREE.Group();
  private vectorLabels: Array<{ label: CSS2DObject; origin: THREE.Vector3; direction: THREE.Vector3 }> = [];
  private lastDecorationKey = "";
  private disposed = false;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "math-webgl-canvas";
    container.appendChild(this.canvas);

    this.labelRenderer = new CSS2DRenderer();
    this.labelsElement = this.labelRenderer.domElement;
    this.labelsElement.className = "math-webgl-label-layer";
    container.appendChild(this.labelsElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(-5, -8, 10);
    this.scene.add(keyLight);
    this.scene.add(this.world);
    this.world.add(this.meshes, this.intersectionLines, this.axes, this.overlays, this.meshLabels, this.axisLabels);

    this.camera.position.set(0, -1000, 0);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);
  }

  setMeshes(meshes: RenderedMeshData[], renderStyle: WebGLViewState["renderStyle"], intersections: ArrayBuffer): void {
    disposeGroup(this.meshes);
    disposeGroup(this.intersectionLines);
    disposeGroup(this.meshLabels);

    meshes.forEach(meshData => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meshData.positions), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(meshData.indices), 1));
      geometry.computeVertexNormals();

      if (renderStyle === "points") {
        const points = new THREE.Points(geometry, new THREE.PointsMaterial({
          color: meshData.color,
          opacity: meshData.opacity,
          transparent: meshData.opacity < 1,
          size: 3,
          sizeAttenuation: false
        }));
        this.meshes.add(points);
      } else if (renderStyle === "wireframe") {
        const wireGeometry = new THREE.WireframeGeometry(geometry);
        geometry.dispose();
        this.meshes.add(new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({
          color: meshData.color,
          opacity: meshData.opacity,
          transparent: meshData.opacity < 1
        })));
      } else {
        this.meshes.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
          color: meshData.color,
          opacity: meshData.opacity,
          transparent: meshData.opacity < 1,
          depthWrite: true,
          side: THREE.DoubleSide,
          roughness: 0.72,
          metalness: 0
        })));
      }

      if (meshData.label) {
        const center = new THREE.Vector3();
        const position = geometry.getAttribute("position");
        if (position.count > 0) {
          for (let index = 0; index < position.count; index++) {
            center.x += position.getX(index);
            center.y += position.getY(index);
            center.z += position.getZ(index);
          }
          center.multiplyScalar(1 / position.count);
          this.addLabel(this.meshLabels, meshData.label, center, meshData.color);
        }
      }
    });

    if (intersections.byteLength > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(intersections), 3));
      this.intersectionLines.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: "#ffeb3b", linewidth: 3 })));
    }
  }

  render(view: WebGLViewState, items: WebGLOverlayItem[]): void {
    const width = Math.max(1, view.width);
    const height = Math.max(1, view.height);
    this.renderer.setSize(width, height, false);
    this.labelRenderer.setSize(width, height);

    const safeScale = Math.max(1, view.scale);
    this.camera.left = -width / (2 * safeScale);
    this.camera.right = width / (2 * safeScale);
    this.camera.top = height / (2 * safeScale);
    this.camera.bottom = -height / (2 * safeScale);
    this.camera.updateProjectionMatrix();

    const rotationZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), view.rotZ);
    const rotationX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), view.rotX);
    this.world.quaternion.copy(rotationX).multiply(rotationZ);
    this.world.position.set(view.panX / safeScale, 0, -view.panY / safeScale);

    const decorationKey = JSON.stringify([view.bounds, view.axisMode, view.axesEnabled, view.showAxisNumbers, items]);
    if (decorationKey !== this.lastDecorationKey) {
      this.lastDecorationKey = decorationKey;
      this.rebuildAxes(view);
      this.rebuildOverlays(items);
    }
    this.updateVectorLabelOffsets();

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposeGroup(this.meshes);
    disposeGroup(this.intersectionLines);
    disposeGroup(this.axes);
    disposeGroup(this.overlays);
    disposeGroup(this.meshLabels);
    disposeGroup(this.axisLabels);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.labelRenderer.domElement.remove();
    this.canvas.remove();
  }

  private rebuildAxes(view: WebGLViewState): void {
    disposeGroup(this.axes);
    disposeGroup(this.axisLabels);
    const [xMin, xMax, yMin, yMax, , zMax] = view.bounds;
    const linePoints: THREE.Vector3[] = [];
    const lineColors: THREE.Color[] = [];
    const addLine = (start: THREE.Vector3, end: THREE.Vector3, color: string): void => {
      linePoints.push(start, end);
      lineColors.push(new THREE.Color(color), new THREE.Color(color));
    };
    const gridColor = new THREE.Color("#8b8b8b");

    if (view.axisMode === "grid") {
      const step = Math.max(1, Math.round(Math.max(xMax - xMin, yMax - yMin) / 8));
      if (view.axesEnabled.x) {
        for (let x = Math.ceil(xMin / step) * step; x <= xMax; x += step) {
          addLine(new THREE.Vector3(x, yMin, 0), new THREE.Vector3(x, yMax, 0), gridColor.getStyle());
        }
      }
      if (view.axesEnabled.y) {
        for (let y = Math.ceil(yMin / step) * step; y <= yMax; y += step) {
          addLine(new THREE.Vector3(xMin, y, 0), new THREE.Vector3(xMax, y, 0), gridColor.getStyle());
        }
      }
    }

    const axisEnds: Array<[keyof WebGLViewState["axesEnabled"], THREE.Vector3, string, string]> = [
      ["x", new THREE.Vector3(xMax + 1, 0, 0), "#e91e63", "X"],
      ["y", new THREE.Vector3(0, yMax + 1, 0), "#4caf50", "Y"],
      ["z", new THREE.Vector3(0, 0, Math.max(4.5, zMax)), "#2196f3", "Z"]
    ];

    axisEnds.forEach(([axis, end, color, label]) => {
      if (!view.axesEnabled[axis]) return;
      addLine(new THREE.Vector3(), end, color);
      this.addLabel(this.axisLabels, label, end, color);

      const length = Math.max(Math.abs(end.x), Math.abs(end.y), Math.abs(end.z));
      const tickStep = Math.max(1, Math.round(length / 5));
      for (let value = tickStep; value < length; value += tickStep) {
        const position = axis === "x"
          ? new THREE.Vector3(value, 0, 0)
          : axis === "y" ? new THREE.Vector3(0, value, 0) : new THREE.Vector3(0, 0, value);
        const tickEnd = position.clone();
        if (axis === "x") tickEnd.y = 0.15;
        else if (axis === "y") tickEnd.x = 0.15;
        else tickEnd.x = 0.15;
        if (view.axisMode === "ticks") addLine(position, tickEnd, color);
        if (view.showAxisNumbers && view.axisMode === "ticks") {
          const numberPosition = position.clone();
          numberPosition.x += axis === "y" ? 0.2 : 0;
          numberPosition.y += axis === "x" ? 0.2 : 0;
          numberPosition.z += axis === "z" ? 0.2 : 0;
          this.addLabel(this.axisLabels, String(value), numberPosition, color);
        }
      }
    });

    if (linePoints.length > 0) {
      const geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(lineColors.flatMap(color => color.toArray()), 3));
      this.axes.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 })));
    }
  }

  private rebuildOverlays(items: WebGLOverlayItem[]): void {
    disposeGroup(this.overlays);
    this.vectorLabels = [];
    items.forEach(item => {
      const origin = new THREE.Vector3(...item.origin);
      let labelPosition = origin;
      let vectorLabelDirection: THREE.Vector3 | null = null;
      if (item.type === "point") {
        this.overlays.add(new THREE.Mesh(
          new THREE.SphereGeometry(0.1, 12, 8),
          new THREE.MeshBasicMaterial({ color: item.color })
        ).translateX(origin.x).translateY(origin.y).translateZ(origin.z));
      } else if (item.type === "vector") {
        const direction = new THREE.Vector3(...item.direction);
        const length = direction.length();
        if (length === 0) return;
        this.overlays.add(new THREE.ArrowHelper(direction.clone().normalize(), origin, length, item.color, Math.min(0.25, length * 0.25), Math.min(0.15, length * 0.15)));
        vectorLabelDirection = direction;
        labelPosition = origin.clone().add(direction);
      } else {
        const segments: THREE.Vector3[] = [];
        const addSegment = (start: THREE.Vector3, end: THREE.Vector3): void => {
          segments.push(start, end);
        };
        item.vectors.forEach(vector => {
          const start = new THREE.Vector3(...vector.origin);
          const direction = new THREE.Vector3(...vector.direction).normalize();
          if (direction.lengthSq() === 0) return;
          const end = start.clone().addScaledVector(direction, item.length);
          const referenceAxis = Math.abs(direction.z) < 0.9
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);
          const side = new THREE.Vector3().crossVectors(direction, referenceAxis).normalize();
          const headBase = end.clone().addScaledVector(direction, -item.length * 0.24);
          const halfWidth = item.length * 0.09;
          addSegment(start, end);
          addSegment(end, headBase.clone().addScaledVector(side, halfWidth));
          addSegment(end, headBase.clone().addScaledVector(side, -halfWidth));
        });
        if (segments.length > 0) {
          const geometry = new THREE.BufferGeometry().setFromPoints(segments);
          this.overlays.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: item.color })));
        }
      }
      if (item.label) {
        const label = this.addLabel(this.axisLabels, item.label, labelPosition, item.color);
        if (vectorLabelDirection) this.vectorLabels.push({ label, origin: origin.clone(), direction: vectorLabelDirection });
      }
    });
  }

  private updateVectorLabelOffsets(): void {
    if (this.vectorLabels.length === 0) return;
    this.world.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this.vectorLabels.forEach(({ label, origin, direction }) => {
      const start = this.world.localToWorld(origin.clone()).project(this.camera);
      const end = this.world.localToWorld(origin.clone().add(direction)).project(this.camera);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      const element = label.element as HTMLDivElement;
      if (length < 1e-6) {
        element.setCssStyles({ marginLeft: "12px", marginTop: "-12px" });
      } else {
        element.setCssStyles({
          marginLeft: `${dy / length * 14}px`,
          marginTop: `${-dx / length * 14}px`
        });
      }
    });
  }

  private addLabel(group: THREE.Group, text: string, position: THREE.Vector3, color: string): CSS2DObject {
    const element = this.labelsElement.createDiv({ cls: "math-webgl-label" });
    element.setCssStyles({ borderColor: color, color });
    renderMathLabel(element, text);
    const label = new CSS2DObject(element);
    label.position.copy(position);
    group.add(label);
    return label;
  }
}