import { App, finishRenderMath, MarkdownPostProcessorContext, MarkdownRenderChild, Modal, Plugin, renderMath, TFile } from "obsidian";
import type { AxesVisibility, MathPlotConfig, PlotItem } from "./types";
import { ALLOWED_MATH_FUNCTIONS, MathExpressionCompiler } from "./math-expression";
import { expandImplicitBounds } from "./implicit-bounds";
import { WebGLPlotRenderer, type WebGLOverlayItem, type WebGLViewState } from "./webgl-renderer";
import type { MeshRequest, MeshRequestItem, MeshResponse, PlotBounds3D, RenderedMeshData } from "./plot-protocol";

declare const require: (moduleName: string) => unknown;

interface Mesh {
  positions: number[][];
  cells: number[][];
}

interface IsosurfaceModule {
  surfaceNets: (
    dimensions: [number, number, number],
    potential: (x: number, y: number, z: number) => number,
    bounds?: [[number, number, number], [number, number, number]]
  ) => Mesh;
}

const { surfaceNets } = require("isosurface") as IsosurfaceModule;

type PlotItemData = {
  type?: PlotItem["type"];
  fn?: string;
  equation?: string;
  coords?: string;
  origin?: string;
  dir?: string;
  color?: string;
  opacity?: number;
  label?: string;
  visible?: boolean;
  name?: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
};

interface PlotRowElement {
  row: HTMLDivElement;
  colorPickerWrapper: HTMLDivElement;
  colorBadge: HTMLDivElement;
  colorBox: HTMLInputElement;
  bodyContainer: HTMLDivElement;
  type: PlotItem["type"];
  color: string;
  opacity: number;
  visible: boolean;
  labelInput: HTMLInputElement;
  input: HTMLInputElement | null;
  dirInput: HTMLInputElement | null;
  name?: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  previewEl?: HTMLDivElement;
}

interface PlotUIState {
  type: MathPlotConfig["type"];
  renderStyle: NonNullable<MathPlotConfig["renderStyle"]>;
  resolution: number;
  showIntersections: boolean;
  axisMode: NonNullable<MathPlotConfig["axisMode"]>;
  showAxisNumbers: boolean;
  axesEnabled: Required<AxesVisibility>;
  viewOnly: boolean;
  bounds: number[];
  rows: PlotRowElement[];
  rotX: number;
  rotZ: number;
  scale: number;
  panX: number;
  panY: number;
  locked: boolean;
  webglRenderer: WebGLPlotRenderer | null;
  meshWorker: Worker | null;
  meshRequestId: number;
  meshRequestSignature: string;
  webglMeshes: RenderedMeshData[];
    webglIntersections: ArrayBuffer;
  webglBounds: PlotBounds3D;
  webglRenderStyle: PlotUIState["renderStyle"] | null;
}

interface ProjectedPoint {
  px: number;
  py: number;
  depth: number;
}

interface ActiveFunction {
  fn: (x: number, y: number) => number | null;
  col: string;
  op: number;
  label: string;
  gridZ: Array<Array<number | null>>;
}

interface RenderedImplicitSurface {
  points: ProjectedPoint[];
  cells: number[][];
  color: string;
  opacity: number;
  label: string;
}

const RESERVED_VARIABLE_NAMES = new Set(["x", "y", "z", "e", "pi"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return isUnknownArray(value) && value.every(isFiniteNumber);
}

function isValidVariableName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return /^[a-z][a-z0-9_]{0,31}$/i.test(name) &&
    !RESERVED_VARIABLE_NAMES.has(normalizedName) &&
    !ALLOWED_MATH_FUNCTIONS.has(normalizedName);
}

const TWO_PI = Math.PI * 2;

function normalizeAngle(rad: number): number {
  let a = rad % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a < -Math.PI) a += TWO_PI;
  return a;
}

export default class MultiPlotterPlugin extends Plugin {
  blockRegistry: WeakMap<HTMLElement, { skipNextRender: boolean }> = new WeakMap();
  private expressionCompiler = new MathExpressionCompiler();
  private implicitMeshCache = new Map<string, Mesh>();

  async onload() {
    this.blockRegistry = new WeakMap();

    this.addCommand({
      id: "create-new-graph",
      name: "Create new graph (Modal UI)",
      editorCallback: (editor) => {
        new MathPlotModal(this.app, this, (markdown) => {
          editor.replaceSelection(markdown);
        }).open();
      }
    });

    this.registerMarkdownCodeBlockProcessor("math-plot", (source, el, ctx) => {
      const stateObj = this.blockRegistry.get(el);
      if (stateObj && stateObj.skipNextRender) {
        stateObj.skipNextRender = false;
        return;
      }

      let config: MathPlotConfig = {
        type: "3d",
        renderStyle: "wireframe",
        resolution: 50,
        showIntersections: false,
        axisMode: "ticks",
        showAxisNumbers: true,
        axesEnabled: { x: true, y: true, z: true },
        viewOnly: false,
        bounds: [-4, 4, -4, 4],
        camera: { rotX: 1.05, rotZ: -1.95, scale: 38, panX: -40, panY: 20 },
        items: []
      };

      if (source && source.trim()) {
        try {
          config = this.parseConfig(source);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          el.createEl("pre", { text: "Math-Plot Configuration Error:\n" + message });
          return;
        }
      }

      this.buildUI(el, config, ctx, null);
    });
  }

  parseConfig(raw: string): MathPlotConfig {
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parseFailed = true;
    }

    if (parseFailed) {
      let sanitized = "";
      let inString = false;
      for (let i = 0; i < raw.length; i++) {
        const char = raw[i];
        if (char === '"' && raw[i - 1] !== "\\") {
          inString = !inString;
          sanitized += char;
        } else if (inString && char === "\\") {
          const next = raw[i + 1];
          if (next === '"' || next === "\\" || next === "/" || next === "b" || next === "f" || next === "n" || next === "r" || next === "t") {
            sanitized += char;
          } else {
            sanitized += "\\\\";
          }
        } else {
          sanitized += char;
        }
      }
      parsed = JSON.parse(sanitized) as unknown;
    }

    if (!isRecord(parsed)) {
      throw new Error("Configuration must be a JSON object.");
    }
    if (parsed.items === undefined) parsed.items = [];
    const items = parsed.items;
    if (!isUnknownArray(items)) throw new Error("'items' must be an array.");
    if (parsed.type !== undefined && parsed.type !== "2d" && parsed.type !== "3d") {
      throw new Error("'type' must be '2d' or '3d'.");
    }
    if (parsed.renderStyle !== undefined && (typeof parsed.renderStyle !== "string" ||
      !["wireframe", "solid", "points"].includes(parsed.renderStyle))) {
      throw new Error("'renderStyle' must be 'wireframe', 'solid' or 'points'.");
    }
    if (parsed.axisMode !== undefined && (typeof parsed.axisMode !== "string" ||
      !["ticks", "grid", "none"].includes(parsed.axisMode))) {
      throw new Error("'axisMode' must be 'ticks', 'grid' or 'none'.");
    }
    if (parsed.resolution !== undefined && (!isFiniteNumber(parsed.resolution) || parsed.resolution < 1)) {
      throw new Error("'resolution' must be a positive finite number.");
    }
    if (parsed.bounds !== undefined) {
      const bounds = parsed.bounds;
      if (!isFiniteNumberArray(bounds) || ![2, 4, 6].includes(bounds.length) || bounds[0] >= bounds[1] ||
        (bounds.length >= 4 && bounds[2] >= bounds[3]) || (bounds.length === 6 && bounds[4] >= bounds[5])) {
        throw new Error("'bounds' must contain two, four or six finite values in ascending order.");
      }
    }

    items.forEach((item, index) => {
      const prefix = `Item ${index + 1}`;
      if (!isRecord(item)) throw new Error(`${prefix} must be an object.`);
      if (item.type === "var") {
        if (typeof item.name !== "string" || !isValidVariableName(item.name) || !isFiniteNumber(item.value)) {
          throw new Error(`${prefix} must have a valid non-reserved variable name and finite value.`);
        }
      } else if (item.type === "fn") {
        if (typeof item.fn !== "string") throw new Error(`${prefix} must have a string 'fn'.`);
      } else if (item.type === "implicit") {
        if (parsed.type === "2d" || typeof item.equation !== "string") {
          throw new Error(`${prefix} must have a string 'equation' and be used in 3D mode.`);
        }
      } else if (item.type === "point") {
        if (typeof item.coords !== "string") throw new Error(`${prefix} must have string 'coords'.`);
      } else if (item.type === "vector") {
        if (typeof item.origin !== "string" || typeof item.dir !== "string") {
          throw new Error(`${prefix} must have string 'origin' and 'dir'.`);
        }
      } else {
        throw new Error(`${prefix} has an unsupported type.`);
      }
    });

    return parsed as unknown as MathPlotConfig;
  }

  attachLatexSuiteShortcuts(inputEl: HTMLInputElement, onUpdate: () => void) {
    const snippets = [
      { trigger: "->", replace: "\\to " },
      { trigger: "|->", replace: "\\mapsto " },
      { trigger: "+-", replace: "\\pm " },
      { trigger: "inf", replace: "\\infty " },
      { trigger: "sq", replace: "\\sqrt{}" },
      { trigger: "fr", replace: "\\frac{}{}" },
      { trigger: "max", replace: "\\max{}" },
      { trigger: "min", replace: "\\min{}" },
      { trigger: "abs", replace: "||" },
      { trigger: "sin", replace: "\\sin(" },
      { trigger: "cos", replace: "\\cos(" },
      { trigger: "tan", replace: "\\tan(" },
      { trigger: "exp", replace: "\\exp(" }
    ];

    inputEl.addEventListener("input", (event: Event) => {
      const cursor = inputEl.selectionStart;
      const text = inputEl.value;

      if (event instanceof InputEvent && event.inputType === "insertText" && cursor !== null) {
        for (let i = 0; i < snippets.length; i++) {
          const s = snippets[i];
          const len = s.trigger.length;
          if (cursor >= len && text.slice(cursor - len, cursor) === s.trigger) {
            const before = text.slice(0, cursor - len);
            if (/[a-zA-Z\\]$/.test(before)) continue;
            const after = text.slice(cursor);
            inputEl.value = before + s.replace + after;

            let newPos = before.length + s.replace.length;
            if (s.replace.indexOf("{}") !== -1) {
              newPos = before.length + s.replace.indexOf("{}") + 1;
            } else if (s.replace === "||") {
              newPos = before.length + 1;
            } else if (s.replace.endsWith("(")) {
              newPos = before.length + s.replace.length;
            }
            inputEl.setSelectionRange(newPos, newPos);
            break;
          }
        }
      }
      onUpdate();
    });
  }

  latexToJS(latex: string, vars: Record<string, number> = {}): (x: number, y: number) => number | null {
    const source = (latex || "").trim();
    if (!source) return () => null;
    const expression = source.replace(/^(z|y|f\([xXyY,\s]+\))\s*=\s*/i, "");
    const evaluate = this.expressionCompiler.compile(expression, vars, ["x", "y"]);
    if (!evaluate) return () => null;
    return (x: number, y: number) => {
      try {
        const value = evaluate({ ...vars, x, y });
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    };
  }

  latexToImplicit(equation: string, vars: Record<string, number> = {}): ((x: number, y: number, z: number) => number | null) | null {
    const source = (equation || "").trim();
    const equalsIndex = source.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex !== source.lastIndexOf("=")) return null;

    const left = source.slice(0, equalsIndex).trim();
    const right = source.slice(equalsIndex + 1).trim();
    if (!left || !right) return null;
    const evaluate = this.expressionCompiler.compile(`(${left}) - (${right})`, vars, ["x", "y", "z"]);
    if (!evaluate) return null;
    const scope = { ...vars, x: 0, y: 0, z: 0 };

    return (x: number, y: number, z: number) => {
      try {
        scope.x = x;
        scope.y = y;
        scope.z = z;
        const value = evaluate(scope);
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    };
  }

  evalVectorExpr(exprStr: string, vars: Record<string, number> = {}): number[] {
    if (!exprStr) return [0, 0, 0];
    const parts = exprStr.split(",").map(p => p.trim());
    return parts.map(p => {
      const fn = this.latexToJS(p, vars);
      const res = fn(0, 0);
      return res !== null && isFinite(res) ? res : 0;
    });
  }

  buildUI(
    rootEl: HTMLElement,
    initialConfig: MathPlotConfig,
    ctx: MarkdownPostProcessorContext | null,
    onInsertCallback: ((markdown: string) => void) | null
  ): () => void {
    const lifecycleController = new AbortController();
    rootEl.empty();

    const wrapper = rootEl.createDiv({ cls: "math-plot-container" });

    const toolbar = wrapper.createDiv({ cls: "math-toolbar" });

    const addBtn = toolbar.createEl("button", { text: "+ Equation" });
    const addImplicitBtn = toolbar.createEl("button", { text: "+ Implicit" });
    const addPtBtn = toolbar.createEl("button", { text: "+ Point" });
    const addVecBtn = toolbar.createEl("button", { text: "+ Vector" });

    let insertBtn: HTMLButtonElement | null = null;
    if (onInsertCallback) {
      insertBtn = toolbar.createEl("button", { text: "Insert into note", cls: "mod-cta" });
    }
    const viewModeBtn = toolbar.createEl("button", { text: initialConfig.viewOnly ? "Show UI" : "Hide UI", cls: "math-view-mode-button" });

    const menuBtn = toolbar.createEl("button", { text: "⚙ Plot options ▾" });
    menuBtn.classList.add("math-plot-menu-button");

    const dropdownMenu = wrapper.createDiv({ cls: "math-dropdown-panel" });

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasVisible = dropdownMenu.classList.contains("is-open");
      dropdownMenu.classList.toggle("is-open", !wasVisible);
      menuBtn.setText(wasVisible ? "⚙ Plot options ▾" : "⚙ Plot options ▴");
    });

    dropdownMenu.addEventListener("click", (e) => e.stopPropagation());

    const closeDropdownHandler = (e: MouseEvent): void => {
      if (!(e.target instanceof Node) || !wrapper.contains(e.target)) {
        dropdownMenu.classList.remove("is-open");
        menuBtn.setText("⚙ Plot options ▾");
      }
    };
    document.addEventListener("click", closeDropdownHandler, { signal: lifecycleController.signal });

    const defaultAxes = { x: true, y: true, z: true };
    const initialCam = initialConfig.camera || {};

    const defaultCam = {
      rotX: 1.05,
      rotZ: -1.95,
      scale: 38,
      panX: -40,
      panY: 20
    };
    const configuredBounds = Array.isArray(initialConfig.bounds) ? initialConfig.bounds.slice() : [-4, 4, -4, 4];
    const webglBounds: PlotBounds3D = configuredBounds.length >= 6
      ? configuredBounds.slice(0, 6) as PlotBounds3D
      : [configuredBounds[0], configuredBounds[1], configuredBounds[2], configuredBounds[3], -4, 4];

    const initialLocked = initialCam.locked !== undefined
      ? Boolean(initialCam.locked)
      : (initialConfig.locked !== undefined ? Boolean(initialConfig.locked) : false);

    const state: PlotUIState = {
      type: initialConfig.type || "3d",
      renderStyle: initialConfig.renderStyle || "wireframe",
      resolution: Number(initialConfig.resolution) || 50,
      showIntersections: Boolean(initialConfig.showIntersections),
      axisMode: initialConfig.axisMode || "ticks",
      showAxisNumbers: initialConfig.showAxisNumbers !== undefined ? Boolean(initialConfig.showAxisNumbers) : true,
      axesEnabled: Object.assign({}, defaultAxes, initialConfig.axesEnabled || {}),
      viewOnly: Boolean(initialConfig.viewOnly),
      bounds: configuredBounds,
      rows: [],
      rotX: initialCam.rotX !== undefined ? initialCam.rotX : defaultCam.rotX,
      rotZ: initialCam.rotZ !== undefined ? initialCam.rotZ : defaultCam.rotZ,
      scale: initialCam.scale !== undefined ? initialCam.scale : defaultCam.scale,
      panX: initialCam.panX !== undefined ? initialCam.panX : defaultCam.panX,
      panY: initialCam.panY !== undefined ? initialCam.panY : defaultCam.panY,
      locked: initialLocked,
      webglRenderer: null,
      meshWorker: null,
      meshRequestId: 0,
      meshRequestSignature: "",
      webglMeshes: [],
      webglIntersections: new ArrayBuffer(0),
      webglBounds,
      webglRenderStyle: null
    };
    addImplicitBtn.disabled = state.type !== "3d";

    const tracker = { skipNextRender: false };
    this.blockRegistry.set(rootEl, tracker);

    const createOptionRow = (labelText: string, controlEl: HTMLElement): HTMLDivElement => {
      const row = dropdownMenu.createDiv({ cls: "math-option-row" });
      row.createSpan({ text: labelText, cls: "math-option-label" });
      row.appendChild(controlEl);
      return row;
    };

    const typeSelect = dropdownMenu.createEl("select");
    ["3d", "2d"].forEach(t => {
      const opt = typeSelect.createEl("option", { text: t.toUpperCase() });
      opt.value = t;
      if (t === state.type) opt.selected = true;
    });
    createOptionRow("Graph type:", typeSelect);

    const styleSelect = dropdownMenu.createEl("select");
    const styleOptions = [
      { val: "wireframe", label: "Wireframe (Grid)" },
      { val: "solid", label: "Solid (Surface)" },
      { val: "points", label: "Point cloud" }
    ];
    styleOptions.forEach(s => {
      const opt = styleSelect.createEl("option", { text: s.label });
      opt.value = s.val;
      if (s.val === state.renderStyle) opt.selected = true;
    });
    createOptionRow("Render style:", styleSelect);

    const resSelect = dropdownMenu.createEl("select");
    const resOptions = [
      { val: 24, label: "Low (24)" },
      { val: 40, label: "Medium (40)" },
      { val: 50, label: "Default (50)" },
      { val: 60, label: "High (60)" },
      { val: 80, label: "Ultra (80)" }
    ];
    resOptions.forEach(r => {
      const opt = resSelect.createEl("option", { text: r.label });
      opt.value = String(r.val);
      if (r.val === state.resolution) opt.selected = true;
    });
    createOptionRow("Resolution:", resSelect);

    const axisModeSelect = dropdownMenu.createEl("select");
    const axisModeOptions = [
      { val: "ticks", label: "Ticks (Reliefs)" },
      { val: "grid", label: "Full Grid" },
      { val: "none", label: "None" }
    ];
    axisModeOptions.forEach(m => {
      const opt = axisModeSelect.createEl("option", { text: m.label });
      opt.value = m.val;
      if (m.val === state.axisMode) opt.selected = true;
    });
    createOptionRow("Axes style:", axisModeSelect);

    const axisNumRow = dropdownMenu.createDiv({ cls: "math-axis-row" });
    axisNumRow.createSpan({ text: "Show axis numbers:", cls: "math-option-label" });
    const axisNumToggle = axisNumRow.createEl("input", { type: "checkbox" });
    axisNumToggle.checked = state.showAxisNumbers;
    axisNumToggle.classList.add("math-checkbox");

    const axesSelectRow = dropdownMenu.createDiv({ cls: "math-axis-row" });
    axesSelectRow.createSpan({ text: "Visible axes:", cls: "math-option-label" });

    const axesGroup = axesSelectRow.createDiv({ cls: "math-axis-group" });

    const createAxisCheckbox = (name: keyof Required<AxesVisibility>): HTMLDivElement => {
      const wrap = axesGroup.createDiv({ cls: "math-axis-option" });
      const cb = wrap.createEl("input", { type: "checkbox" });
      cb.checked = state.axesEnabled[name] !== false;
      cb.classList.add("math-checkbox");
      wrap.createSpan({ text: name.toUpperCase(), cls: "math-axis-name" });

      cb.addEventListener("change", (e) => {
        state.axesEnabled[name] = (e.target as HTMLInputElement).checked;
        this.drawCanvas(canvas, state);
        debouncedSave();
      });
      return wrap;
    };

    createAxisCheckbox("x");
    createAxisCheckbox("y");
    const zWrap = createAxisCheckbox("z");
    zWrap.classList.toggle("math-hidden", state.type !== "3d");

    const isectRow = dropdownMenu.createDiv({ cls: "math-intersection-row" });
    isectRow.createSpan({ text: "Highlight intersections:", cls: "math-option-label" });
    const isectToggle = isectRow.createEl("input", { type: "checkbox" });
    isectToggle.checked = state.showIntersections;
    isectToggle.classList.add("math-checkbox");

    const copyRow = dropdownMenu.createDiv({ cls: "math-copy-row" });

    const copyBtn = copyRow.createEl("button", { text: "Copy Markdown", cls: "math-copy-button" });

    const rowsContainer = wrapper.createDiv({ cls: "math-rows-container" });

    const canvasContainer = wrapper.createDiv({ cls: "math-canvas-container" });

    const overlayControls = canvasContainer.createDiv({ cls: "math-overlay-controls" });

    const lockBtn = overlayControls.createEl("button", { text: state.locked ? "🔒" : "🔓", cls: "math-overlay-button" });
    lockBtn.title = "Lock / Unlock view interaction";

    const resetViewBtn = overlayControls.createEl("button", { text: "↺", cls: "math-overlay-button" });
    resetViewBtn.title = "Reset View to standard";

    const canvas = canvasContainer.createEl("canvas", { cls: "math-canvas" });
    canvas.classList.toggle("is-locked", state.locked);
    let webglUnavailable = false;

    const disableWebGL = (): void => {
      state.meshWorker?.terminate();
      state.meshWorker = null;
      state.webglRenderer?.dispose();
      state.webglRenderer = null;
      state.webglMeshes = [];
      state.webglIntersections = new ArrayBuffer(0);
      state.meshRequestSignature = "";
      state.webglRenderStyle = null;
      canvas.style.display = "block";
      this.drawCanvas(canvas, state);
    };

    const initializeWebGL = (): void => {
      if (state.type !== "3d" || webglUnavailable || state.webglRenderer) return;
      let renderer: WebGLPlotRenderer | null = null;
      let worker: Worker | null = null;
      try {
        const pluginDirectory = this.manifest.dir;
        if (!pluginDirectory) throw new Error("Plugin directory is not available for the mesh worker.");
        renderer = new WebGLPlotRenderer(canvasContainer);
        const workerPath = `${pluginDirectory.replace(/[\\/]+$/, "")}/plot-worker.js`;
        const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & {
          getResourcePath?: (normalizedPath: string) => string;
        };
        if (!adapter.getResourcePath) throw new Error("This Obsidian version cannot resolve plugin worker assets.");
        worker = new Worker(adapter.getResourcePath.call(adapter, workerPath));

        state.webglRenderer = renderer;
        state.meshWorker = worker;
        state.webglRenderStyle = state.renderStyle;
        canvas.style.display = "none";
        renderer.canvas.classList.toggle("is-locked", state.locked);
        renderer.canvas.addEventListener("webglcontextlost", event => {
          event.preventDefault();
          webglUnavailable = true;
          disableWebGL();
        }, { once: true });

        worker.onmessage = (event: MessageEvent<MeshResponse>) => {
          const response = event.data;
          if (response.requestId !== state.meshRequestId || !state.webglRenderer) return;
          if (response.error) {
            console.error("Plot mesh worker error:", response.error);
            webglUnavailable = true;
            disableWebGL();
            return;
          }
          state.webglMeshes = response.meshes;
          state.webglIntersections = response.intersections;
          state.webglBounds = response.bounds;
          state.webglRenderStyle = null;
          this.drawCanvas(canvas, state);
        };
        worker.onerror = (event) => {
          console.error("Plot mesh worker failed:", event.message);
          webglUnavailable = true;
          disableWebGL();
        };
      } catch (error) {
        worker?.terminate();
        renderer?.dispose();
        webglUnavailable = true;
        console.warn("WebGL renderer unavailable; using Canvas2D fallback.", error);
      }
    };

    initializeWebGL();
    const resizeObserver = new ResizeObserver(() => this.drawCanvas(canvas, state));
    resizeObserver.observe(canvasContainer);

    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.locked = !state.locked;
      lockBtn.setText(state.locked ? "🔒" : "🔓");
      canvas.classList.toggle("is-locked", state.locked);
      state.webglRenderer?.canvas.classList.toggle("is-locked", state.locked);
      debouncedSave();
    });

    resetViewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.rotX = defaultCam.rotX;
      state.rotZ = defaultCam.rotZ;
      state.scale = defaultCam.scale;
      state.panX = defaultCam.panX;
      state.panY = defaultCam.panY;
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    const palette = ["#e91e63", "#00e676", "#2196f3", "#ff9800", "#9c27b0", "#ffeb3b"];

    const buildExportJSON = () => {
      const items = state.rows.map(r => {
        if (r.type === "var") {
          return {
            type: "var",
            name: r.name,
            value: r.value,
            min: r.min,
            max: r.max,
            step: r.step
          };
        } else if (r.type === "implicit") {
          return {
            type: "implicit",
            equation: r.input ? r.input.value.trim() : "",
            color: r.color || palette[0],
            opacity: r.opacity !== undefined ? r.opacity : 1.0,
            label: r.labelInput ? r.labelInput.value.trim() : "",
            visible: r.visible !== undefined ? r.visible : true
          };
        } else if (r.type === "point") {
          return {
            type: "point",
            coords: r.input ? r.input.value.trim() : "",
            color: r.color || "#ffffff",
            label: r.labelInput ? r.labelInput.value.trim() : "",
            visible: r.visible !== undefined ? r.visible : true
          };
        } else if (r.type === "vector") {
          return {
            type: "vector",
            origin: r.input ? r.input.value.trim() : "",
            dir: r.dirInput ? r.dirInput.value.trim() : "",
            color: r.color || "#00e676",
            label: r.labelInput ? r.labelInput.value.trim() : "",
            visible: r.visible !== undefined ? r.visible : true
          };
        } else {
          return {
            type: "fn",
            fn: r.input ? r.input.value.trim() : "",
            color: r.color || palette[0],
            opacity: r.opacity !== undefined ? r.opacity : 1.0,
            label: r.labelInput ? r.labelInput.value.trim() : "",
            visible: r.visible !== undefined ? r.visible : true
          };
        }
      }).filter(item => {
        if (item.type === "var") return true;
        if (item.type === "implicit") return item.equation.length > 0;
        if (item.type === "point") return item.coords.length > 0;
        if (item.type === "vector") return item.origin.length > 0;
        return item.fn && item.fn.length > 0;
      });

      return {
        type: state.type,
        renderStyle: state.renderStyle,
        resolution: state.resolution,
        showIntersections: state.showIntersections,
        axisMode: state.axisMode,
        showAxisNumbers: state.showAxisNumbers,
        axesEnabled: state.axesEnabled,
        viewOnly: state.viewOnly,
        bounds: state.bounds,
        camera: {
          rotX: Math.round(normalizeAngle(state.rotX) * 100) / 100,
          rotZ: Math.round(normalizeAngle(state.rotZ) * 100) / 100,
          scale: Math.round(state.scale),
          panX: Math.round(state.panX),
          panY: Math.round(state.panY),
          locked: state.locked
        },
        items: items
      };
    };

    let saveTimer: number | null = null;
    const debouncedSave = () => {
      if (!ctx || !ctx.sourcePath) return;
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        try {
          if (lifecycleController.signal.aborted) return;
          if (document.activeElement instanceof HTMLInputElement && wrapper.contains(document.activeElement)) {
            saveTimer = window.setTimeout(debouncedSave, 1500);
            return;
          }
          const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (!(file instanceof TFile)) return;

          const section = ctx.getSectionInfo(rootEl);
          if (!section) return;

          const content = await this.app.vault.read(file);
          if (lifecycleController.signal.aborted) return;
          const lines = content.split("\n");

          const newBlock = [
            "```math-plot",
            JSON.stringify(buildExportJSON(), null, 2),
            "```"
          ];

          tracker.skipNextRender = true;
          lines.splice(section.lineStart, section.lineEnd - section.lineStart + 1, ...newBlock);
          await this.app.vault.modify(file, lines.join("\n"));
        } catch (err) {
          console.error("Auto-save error:", err);
          tracker.skipNextRender = false;
        }
      }, 1500);
    };

    const updateViewModeUI = () => {
      wrapper.classList.toggle("is-view-only", state.viewOnly);
      if (state.viewOnly) {
        dropdownMenu.classList.remove("is-open");
        menuBtn.setText("⚙ Plot options ▾");
        viewModeBtn.setText("Show UI");
        viewModeBtn.classList.add("mod-cta");
      } else {
        viewModeBtn.setText("Hide UI");
        viewModeBtn.classList.remove("mod-cta");
      }
    };
    updateViewModeUI();

    viewModeBtn.addEventListener("click", () => {
      state.viewOnly = !state.viewOnly;
      updateViewModeUI();
      debouncedSave();
    });

    typeSelect.addEventListener("change", (e) => {
      state.type = (e.target as HTMLSelectElement).value as MathPlotConfig["type"];
      state.bounds = state.type === "2d" ? [-8, 8] : [-4, 4, -4, 4];
      state.webglBounds = [-4, 4, -4, 4, -4, 4];
      state.meshRequestSignature = "";
      addImplicitBtn.disabled = state.type !== "3d";
      zWrap.classList.toggle("math-hidden", state.type !== "3d");
      initializeWebGL();
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    styleSelect.addEventListener("change", (e) => {
      state.renderStyle = (e.target as HTMLSelectElement).value as NonNullable<MathPlotConfig["renderStyle"]>;
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    resSelect.addEventListener("change", (e) => {
      state.resolution = Number((e.target as HTMLSelectElement).value);
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    axisModeSelect.addEventListener("change", (e) => {
      state.axisMode = (e.target as HTMLSelectElement).value as NonNullable<MathPlotConfig["axisMode"]>;
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    axisNumToggle.addEventListener("change", (e) => {
      state.showAxisNumbers = (e.target as HTMLInputElement).checked;
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    isectToggle.addEventListener("change", (e) => {
      state.showIntersections = (e.target as HTMLInputElement).checked;
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    let draggedRowEl: HTMLDivElement | null = null;

    const attachDragEvents = (rowEl: HTMLDivElement, dragHandle: HTMLSpanElement): void => {
      dragHandle.draggable = true;

      dragHandle.addEventListener("dragstart", (e) => {
        draggedRowEl = rowEl;
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        rowEl.classList.add("is-dragging");
      });

      dragHandle.addEventListener("dragend", () => {
        draggedRowEl = null;
        rowEl.classList.remove("is-dragging");
        rowsContainer.querySelectorAll<HTMLElement>(".math-row").forEach(r => r.classList.remove("is-drop-target"));
      });

      rowEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (draggedRowEl && draggedRowEl !== rowEl) {
          rowEl.classList.add("is-drop-target");
        }
      });

      rowEl.addEventListener("dragleave", () => {
        rowEl.classList.remove("is-drop-target");
      });

      rowEl.addEventListener("drop", (e) => {
        e.preventDefault();
        rowEl.classList.remove("is-drop-target");
        if (draggedRowEl && draggedRowEl !== rowEl) {
          const fromIndex = Array.from(rowsContainer.children).indexOf(draggedRowEl);
          const toIndex = Array.from(rowsContainer.children).indexOf(rowEl);
          if (fromIndex > -1 && toIndex > -1) {
            rowsContainer.insertBefore(draggedRowEl, toIndex > fromIndex ? rowEl.nextSibling : rowEl);
            const [movedItem] = state.rows.splice(fromIndex, 1);
            state.rows.splice(toIndex, 0, movedItem);
            this.drawCanvas(canvas, state);
            debouncedSave();
          }
        }
      });
    };

    const updateMathPreview = (previewEl: HTMLDivElement, text: string, prefix: string): void => {
      previewEl.empty();
      const raw = text.trim();
      if (!raw) {
        previewEl.createSpan({ text: "Enter equation, variable, point...", cls: "text-muted" });
        return;
      }

      let formula = raw;
      if (prefix && !formula.startsWith(prefix) && !formula.includes("=")) {
        formula = `${prefix}${formula}`;
      }

      try {
        const mathNode = renderMath(formula, false);
        previewEl.appendChild(mathNode);
        finishRenderMath();
      } catch {
        previewEl.setText(formula);
      }
    };

    const createRow = (
      itemData: PlotItemData | null = null,
      rowType: PlotItem["type"] = "fn",
      startWithFocus = false
    ): void => {
      const row = rowsContainer.createDiv({ cls: "math-row" });

      const dragHandle = row.createSpan({ text: "⠿", cls: "drag-handle math-row-drag-handle" });

      const visWrap = row.createDiv({ cls: "math-row-visibility" });
      const visCheck = visWrap.createEl("input", { type: "checkbox" });
      visCheck.checked = (itemData && itemData.visible !== undefined) ? Boolean(itemData.visible) : true;
      visCheck.classList.add("math-checkbox");
      visCheck.title = "Toggle visibility";

      const colorPickerWrapper = row.createDiv({ cls: "math-color-picker-wrapper" });

      const colorBadge = colorPickerWrapper.createDiv({ cls: "math-color-badge" });

      const colorPopover = colorPickerWrapper.createDiv({ cls: "math-color-popover" });

      const hexRow = colorPopover.createDiv({ cls: "math-color-popover-row" });
      hexRow.createSpan({ text: "Color:", cls: "math-color-label" });

      const colorBox = hexRow.createEl("input", { type: "color" });
      colorBox.value = (itemData && itemData.color) || palette[state.rows.length % palette.length];
      colorBox.classList.add("math-color-box");

      const alphaHeader = colorPopover.createDiv({ cls: "math-opacity-header" });
      alphaHeader.createSpan({ text: "Opacity:" });
      const alphaValueSpan = alphaHeader.createSpan();

      const alphaSlider = colorPopover.createEl("input", { type: "range" });
      alphaSlider.min = "0";
      alphaSlider.max = "1";
      alphaSlider.step = "0.05";
      alphaSlider.value = String((itemData && itemData.opacity !== undefined) ? itemData.opacity : 1.0);
      alphaSlider.classList.add("math-opacity-slider");

      colorBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = colorPopover.classList.toggle("is-open");
        row.classList.toggle("is-color-picker-open", isOpen);
      });
      colorPopover.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", () => {
        colorPopover.classList.remove("is-open");
        row.classList.remove("is-color-picker-open");
      }, { signal: lifecycleController.signal });

      const bodyContainer = row.createDiv({ cls: "math-row-body" });

      const labelInput = row.createEl("input", { type: "text", placeholder: "Label", cls: "math-row-label" });
      labelInput.value = (itemData && itemData.label) || "";

      const delBtn = row.createEl("button", { text: "✕", cls: "math-row-delete" });

      const itemRef: PlotRowElement = {
        row,
        colorPickerWrapper,
        colorBadge,
        colorBox,
        bodyContainer,
        type: (itemData && itemData.type) || rowType,
        color: colorBox.value,
        opacity: (itemData && itemData.opacity !== undefined) ? Number(itemData.opacity) : 1.0,
        visible: visCheck.checked,
        labelInput: labelInput,
        input: null,
        dirInput: null
      };
      state.rows.push(itemRef);

      const updateBadgeVisual = () => {
        colorBadge.style.backgroundColor = itemRef.color;
        colorBadge.style.opacity = String(Math.max(0.2, itemRef.opacity));
        alphaValueSpan.setText(`${Math.round(itemRef.opacity * 100)}%`);
      };
      updateBadgeVisual();

      visCheck.addEventListener("change", () => {
        itemRef.visible = visCheck.checked;
        row.classList.toggle("is-invisible", !itemRef.visible);
        this.drawCanvas(canvas, state);
        debouncedSave();
      });

      attachDragEvents(row, dragHandle);

      delBtn.addEventListener("click", () => {
        row.remove();
        state.rows = state.rows.filter(r => r !== itemRef);
        this.drawCanvas(canvas, state);
        debouncedSave();
      });

      colorBox.addEventListener("input", () => {
        itemRef.color = colorBox.value;
        updateBadgeVisual();
        this.drawCanvas(canvas, state);
        debouncedSave();
      });

      alphaSlider.addEventListener("input", (e) => {
        itemRef.opacity = Number((e.target as HTMLInputElement).value);
        updateBadgeVisual();
        this.drawCanvas(canvas, state);
        debouncedSave();
      });

      labelInput.addEventListener("input", () => {
        this.drawCanvas(canvas, state);
        debouncedSave();
      });

      if (itemRef.type === "point") {
        bodyContainer.createSpan({ text: "Pt:", cls: "math-item-type-badge" });

        const ptInput = bodyContainer.createEl("input", {
          type: "text",
          placeholder: "x, y, z",
          cls: "math-coordinate-input"
        });
        ptInput.value = (itemData && itemData.coords) || "1, 1, 2";
        itemRef.input = ptInput;

        ptInput.addEventListener("input", () => {
          this.drawCanvas(canvas, state);
          debouncedSave();
        });
        return;
      }

      if (itemRef.type === "vector") {
        bodyContainer.createSpan({ text: "Vec:", cls: "math-item-type-badge" });

        const originInput = bodyContainer.createEl("input", {
          type: "text",
          placeholder: "Orig x,y,z",
          cls: "math-vector-input"
        });
        originInput.value = (itemData && itemData.origin) || "1, 1, 2";
        itemRef.input = originInput;

        const dirInput = bodyContainer.createEl("input", {
          type: "text",
          placeholder: "Dir dx,dy,dz",
          cls: "math-vector-input"
        });
        dirInput.value = (itemData && itemData.dir) || "1, 0, -0.7";
        itemRef.dirInput = dirInput;

        originInput.addEventListener("input", () => {
          this.drawCanvas(canvas, state);
          debouncedSave();
        });
        dirInput.addEventListener("input", () => {
          this.drawCanvas(canvas, state);
          debouncedSave();
        });
        return;
      }

      if (itemRef.type === "var") {
        row.classList.add("math-variable-row");

        const name = (itemData && itemData.name) || "a";
        itemRef.name = name;
        itemRef.value = Number((itemData && itemData.value) !== undefined ? itemData.value : 1);
        itemRef.min = Number((itemData && itemData.min) !== undefined ? itemData.min : -5);
        itemRef.max = Number((itemData && itemData.max) !== undefined ? itemData.max : 5);
        itemRef.step = Number((itemData && itemData.step) !== undefined ? itemData.step : 0.1);

        bodyContainer.createSpan({ text: `${name} = `, cls: "math-variable-badge" });

        const numInput = bodyContainer.createEl("input", { type: "number" });
        numInput.value = String(itemRef.value);
        numInput.step = String(itemRef.step);
        numInput.classList.add("math-variable-number");

        const slider = bodyContainer.createEl("input", { type: "range" });
        slider.min = String(itemRef.min);
        slider.max = String(itemRef.max);
        slider.step = String(itemRef.step);
        slider.value = String(itemRef.value);
        slider.classList.add("math-variable-slider");

        slider.addEventListener("mousedown", (e) => e.stopPropagation());

        let pendingVariableDraw = 0;
        const onVal = (val: string, interactive = false): void => {
          itemRef.value = Number(val);
          slider.value = val;
          numInput.value = val;
          if (pendingVariableDraw) window.cancelAnimationFrame(pendingVariableDraw);
          if (interactive) {
            pendingVariableDraw = window.requestAnimationFrame(() => {
              pendingVariableDraw = 0;
              this.drawCanvas(canvas, state, true);
            });
          } else {
            pendingVariableDraw = 0;
            this.drawCanvas(canvas, state);
          }
          debouncedSave();
        };

        slider.addEventListener("input", (e) => onVal((e.target as HTMLInputElement).value, true));
        slider.addEventListener("change", (e) => onVal((e.target as HTMLInputElement).value));
        numInput.addEventListener("input", (e) => onVal((e.target as HTMLInputElement).value, true));
        numInput.addEventListener("change", (e) => onVal((e.target as HTMLInputElement).value));
        return;
      }

      if (itemRef.type === "implicit") {
        bodyContainer.createSpan({ text: "F=0:", cls: "math-item-type-badge" });
      }

      const prefix = itemRef.type === "implicit" ? "" : state.type === "3d" ? "z = " : "y = ";

      const input = bodyContainer.createEl("input", {
        type: "text",
        placeholder: itemRef.type === "implicit" ? "x^2 + y^2 + z^2 = 1" : state.type === "3d" ? "\\sqrt{x^2+y^2} or a = 2" : "\\sin(x) or a = 2",
        cls: "math-equation-input"
      });
      input.value = (itemData && (itemRef.type === "implicit" ? itemData.equation : itemData.fn)) || "";

      row.classList.add("math-equation-row");
      const previewEl = bodyContainer.createDiv({ cls: "math-equation-preview" });

      itemRef.input = input;
      itemRef.previewEl = previewEl;

      const setMode = (isEditing: boolean): void => {
        row.classList.toggle("is-editing", isEditing);
        if (isEditing) input.focus();
        else updateMathPreview(previewEl, input.value, prefix);
      };

      if (startWithFocus) setMode(true);
      else setMode(false);

      previewEl.addEventListener("click", () => setMode(true));

      const testAndTransformSlider = (): boolean => {
        if (itemRef.type === "implicit") return false;
        if (transformedToSlider) return true;
        const txt = input.value.trim();
        const match = txt.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*(-?\d*\.?\d+)$/);
        if (match) {
          if (!isValidVariableName(match[1])) return false;
          transformedToSlider = true;
          row.remove();
          state.rows = state.rows.filter(r => r !== itemRef);
          createRow({ type: "var", name: match[1], value: parseFloat(match[2]), min: -5, max: 5, step: 0.1 });
          this.drawCanvas(canvas, state);
          debouncedSave();
          return true;
        }
        return false;
      };

      let transformedToSlider = false;
      input.addEventListener("input", () => {
        if (!testAndTransformSlider()) {
          this.drawCanvas(canvas, state);
          debouncedSave();
        }
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          if (!testAndTransformSlider()) setMode(false);
        }
      });

      input.addEventListener("blur", () => {
        if (!testAndTransformSlider()) setMode(false);
      });

      this.attachLatexSuiteShortcuts(input, () => {
        this.drawCanvas(canvas, state);
        debouncedSave();
      });
    };

    if (initialConfig.items && initialConfig.items.length > 0) {
      initialConfig.items.forEach(it => createRow(it, it.type, false));
    } else {
      createRow({ type: "fn", fn: state.type === "3d" ? "\\sqrt{x^2 + y^2}" : "\\sin(x)" }, "fn", false);
    }

    addBtn.addEventListener("click", () => {
      createRow(null, "fn", true);
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    addImplicitBtn.addEventListener("click", () => {
      createRow({ type: "implicit", equation: "x^2 + y^2 + z^2 = 1" }, "implicit", true);
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    addPtBtn.addEventListener("click", () => {
      createRow({ type: "point", coords: "1, 1, 2", color: "#ffffff", label: "P0" }, "point", false);
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    addVecBtn.addEventListener("click", () => {
      createRow({ type: "vector", origin: "1, 1, 2", dir: "1, 0, -0.7", color: "#00e676", label: "df/dx" }, "vector", false);
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    let isDragging = false;
    let isPanning = false;
    let lastX = 0;
    let lastY = 0;
    let drawFrame = 0;
    const scheduleDraw = () => {
      if (drawFrame) return;
      drawFrame = window.requestAnimationFrame(() => {
        drawFrame = 0;
        if (canvas.isConnected) this.drawCanvas(canvas, state);
      });
    };

    const isPlotSurface = (target: EventTarget | null): boolean =>
      target === canvas || target === state.webglRenderer?.canvas;

    canvasContainer.addEventListener("mousedown", (e) => {
      if (!isPlotSurface(e.target)) return;
      if (state.locked) return;
      isDragging = true;
      isPanning = Boolean(e.shiftKey || e.button === 1);
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.classList.toggle("is-panning", isPanning);
      canvas.classList.add("is-dragging");
      state.webglRenderer?.canvas.classList.toggle("is-panning", isPanning);
      state.webglRenderer?.canvas.classList.add("is-dragging");
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging || state.locked) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;

      if (isPanning) {
        state.panX += dx;
        state.panY += dy;
      } else if (state.type === "3d") {
        state.rotZ = normalizeAngle(state.rotZ + dx * 0.01);
        state.rotX = normalizeAngle(state.rotX + dy * 0.01);
      } else {
        state.panX += dx;
        state.panY += dy;
      }

      lastX = e.clientX;
      lastY = e.clientY;
      scheduleDraw();
    }, { signal: lifecycleController.signal });

    window.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        isPanning = false;
        canvas.classList.remove("is-panning", "is-dragging");
        state.webglRenderer?.canvas.classList.remove("is-panning", "is-dragging");
        debouncedSave();
      }
    }, { signal: lifecycleController.signal });

    canvasContainer.addEventListener("wheel", (e) => {
      if (!isPlotSurface(e.target)) return;
      if (state.locked) return;
      e.preventDefault();
      state.scale = Math.max(2, Math.min(200, state.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
      this.drawCanvas(canvas, state);
      debouncedSave();
    });

    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText("```math-plot\n" + JSON.stringify(buildExportJSON(), null, 2) + "\n```\n");
      copyBtn.setText("Copied!");
      window.setTimeout(() => copyBtn.setText("Copy Markdown"), 2000);
    });

    if (insertBtn && onInsertCallback) {
      insertBtn.addEventListener("click", () => {
        onInsertCallback("```math-plot\n" + JSON.stringify(buildExportJSON(), null, 2) + "\n```\n");
      });
    }

    const initialDrawTimer = window.setTimeout(() => this.drawCanvas(canvas, state), 50);

    const cleanup = () => {
      lifecycleController.abort();
      if (drawFrame) window.cancelAnimationFrame(drawFrame);
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      window.clearTimeout(initialDrawTimer);
      resizeObserver.disconnect();
      state.meshWorker?.terminate();
      state.webglRenderer?.dispose();
      state.meshWorker = null;
      state.webglRenderer = null;
    };
    if (ctx) {
      const renderChild = new MarkdownRenderChild(rootEl);
      renderChild.register(cleanup);
      ctx.addChild(renderChild);
    }
    return cleanup;
  }

  drawCanvas(canvas: HTMLCanvasElement, state: PlotUIState, interactive = false): void {
    if (state.type === "3d" && state.webglRenderer && state.meshWorker) {
      canvas.style.display = "none";
      state.webglRenderer.canvas.style.display = "block";
      state.webglRenderer.labelsElement.style.display = "block";
      this.drawWebGL(canvas, state, interactive);
      return;
    }

    canvas.style.display = "block";
    if (state.webglRenderer) {
      state.webglRenderer.canvas.style.display = "none";
      state.webglRenderer.labelsElement.style.display = "none";
    }

    const rect = canvas.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const cx = (w / 2) + (state.panX || 0);
    const cy = (h / 2) + (state.panY || 0);

    ctx.clearRect(0, 0, w, h);

    const labelsToDraw: Array<{ text: string; px: number; py: number; color: string }> = [];
    const overlaysToDraw: Array<() => void> = [];

    const currentVars: Record<string, number> = {};
    state.rows.forEach(r => {
      if (r.type === "var") currentVars[r.name] = r.value;
    });

    const hexToRgba = (hex: string, alpha = 1.0): string => {
      let num = parseInt((hex || "#4caf50").replace("#", ""), 16);
      if (isNaN(num)) return `rgba(76, 175, 80, ${alpha})`;
      let r = (num >> 16) & 255;
      let g = (num >> 8) & 255;
      let b = num & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const queueLabel = (text: string, px: number, py: number, color = "#ffffff"): void => {
      if (!text) return;
      labelsToDraw.push({ text, px, py, color });
    };

    if (state.type === "2d") {
      const bounds = state.bounds.length >= 2 ? state.bounds : [-8, 8];
      const xMin = bounds[0];
      const xMax = bounds[1];
      const xRange = xMax - xMin;
      const pxPerX = (w / xRange) * (state.scale / 35);
      const pyPerY = pxPerX;
      const xStep = Math.max(1, Math.round(xRange / 10));

      const yRange = (h / pxPerX);
      const yMin = -yRange / 2;
      const yMax = yRange / 2;
      const yStep = xStep;

      if (state.axisMode === "grid") {
        ctx.strokeStyle = "rgba(150, 150, 150, 0.15)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);

        if (state.axesEnabled.x) {
          const firstX = Math.ceil(xMin / xStep) * xStep;
          for (let gx = firstX; gx <= xMax; gx += xStep) {
            const px = cx + gx * pxPerX;
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, h);
            ctx.stroke();
          }
        }

        if (state.axesEnabled.y) {
          const firstY = Math.ceil(yMin / yStep) * yStep;
          for (let gy = firstY; gy <= yMax; gy += yStep) {
            const py = cy - gy * pyPerY;
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(w, py);
            ctx.stroke();
          }
        }
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = "rgba(150, 150, 150, 0.4)";
      ctx.lineWidth = 1.5;

      if (state.axesEnabled.x) {
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(w, cy);
        ctx.stroke();

        if (state.axisMode === "ticks") {
          ctx.strokeStyle = "rgba(150, 150, 150, 0.7)";
          ctx.fillStyle = "rgba(150, 150, 150, 0.85)";
          ctx.font = "10px var(--font-monospace)";
          ctx.textAlign = "center";

          const firstX = Math.ceil((xMin * 2) / xStep) * xStep;
          for (let gx = firstX; gx <= xMax * 2; gx += xStep) {
            if (Math.abs(gx) < 0.001) continue;
            const px = cx + gx * pxPerX;
            ctx.beginPath();
            ctx.moveTo(px, cy - 4);
            ctx.lineTo(px, cy + 4);
            ctx.stroke();
            if (state.showAxisNumbers) ctx.fillText(String(gx), px, cy + 14);
          }
        }
      }

      if (state.axesEnabled.y) {
        ctx.strokeStyle = "rgba(150, 150, 150, 0.4)";
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();

        if (state.axisMode === "ticks") {
          ctx.strokeStyle = "rgba(150, 150, 150, 0.7)";
          ctx.fillStyle = "rgba(150, 150, 150, 0.85)";
          ctx.font = "10px var(--font-monospace)";
          ctx.textAlign = "right";

          const firstY = Math.ceil((yMin * 2) / yStep) * yStep;
          for (let gy = firstY; gy <= yMax * 2; gy += yStep) {
            if (Math.abs(gy) < 0.001) continue;
            const py = cy - gy * pyPerY;
            ctx.beginPath();
            ctx.moveTo(cx - 4, py);
            ctx.lineTo(cx + 4, py);
            ctx.stroke();
            if (state.showAxisNumbers) ctx.fillText(String(gy), cx - 6, py + 3);
          }
        }
      }

      state.rows.forEach(r => {
        if (!r.input || r.visible === false || r.type === "implicit") return;
        const col = r.color || "#4caf50";
        const label = r.labelInput ? r.labelInput.value.trim() : "";

        if (r.type === "point") {
          const pt = this.evalVectorExpr(r.input.value, currentVars);
          const px = cx + pt[0] * pxPerX;
          const py = cy - pt[1] * pyPerY;

          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(px, py, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#000000";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          queueLabel(label, px, py, col);
          return;
        }

        if (r.type === "vector") {
          const orig = this.evalVectorExpr(r.input.value, currentVars);
          const dir = this.evalVectorExpr(r.dirInput ? r.dirInput.value : "1,0", currentVars);

          const p0x = cx + orig[0] * pxPerX;
          const p0y = cy - orig[1] * pyPerY;
          const p1x = cx + (orig[0] + dir[0]) * pxPerX;
          const p1y = cy - (orig[1] + dir[1]) * pyPerY;

          ctx.strokeStyle = col;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(p0x, p0y);
          ctx.lineTo(p1x, p1y);
          ctx.stroke();

          // Punta freccia
          const angle = Math.atan2(p1y - p0y, p1x - p0x);
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(p1x, p1y);
          ctx.lineTo(p1x - 10 * Math.cos(angle - Math.PI / 6), p1y - 10 * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(p1x - 10 * Math.cos(angle + Math.PI / 6), p1y - 10 * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fill();

          queueLabel(label, p1x, p1y, col);
          return;
        }

        const val = r.input.value.trim();
        if (!val) return;
        const fn = this.latexToJS(val, currentVars);
        const op = r.opacity !== undefined ? r.opacity : 1.0;

        ctx.strokeStyle = hexToRgba(col, op);
        ctx.lineWidth = 2.5;
        ctx.beginPath();

        let started = false;
        let labelPoint: { px: number; py: number } | null = null;

        for (let px = 0; px <= w; px += 2) {
          const mathX = (px - cx) / pxPerX;
          const mathY = fn(mathX, 0);
          if (mathY !== null && isFinite(mathY)) {
            const py = cy - mathY * pyPerY;
            if (!started) { ctx.moveTo(px, py); started = true; }
            else { ctx.lineTo(px, py); }
            if (px >= cx && !labelPoint) labelPoint = { px, py };
          } else {
            started = false;
          }
        }
        ctx.stroke();
        if (labelPoint) queueLabel(label, labelPoint.px, labelPoint.py, col);
      });

    } else {
      // 3D
      const bounds = state.bounds.length >= 4 ? state.bounds : [-4, 4, -4, 4];
      let xMin = bounds[0];
      let xMax = bounds[1];
      let yMin = bounds[2];
      let yMax = bounds[3];
      const initialZMin = bounds.length >= 6 ? bounds[4] : -4;
      const initialZMax = bounds.length >= 6 ? bounds[5] : 4;
      let zMax = initialZMax;
      const implicitVolumes = new Map<PlotRowElement, {
        field: (x: number, y: number, z: number) => number | null;
        bounds: PlotBounds3D;
      }>();

      state.rows.forEach(row => {
        if (!row.input || row.visible === false || row.type === "var" || row.type === "point" || row.type === "vector") return;
        const equation = row.input.value.trim();
        const isImplicitEquation = row.type === "implicit" ||
          (row.type === "fn" && equation.includes("=") && /[zZ]/.test(equation) && !/^\s*z\s*=/i.test(equation));
        if (!isImplicitEquation) return;

        const field = this.latexToImplicit(equation, currentVars);
        if (!field) return;
        const volumeBounds = expandImplicitBounds(field, [xMin, xMax, yMin, yMax, initialZMin, initialZMax]);
        implicitVolumes.set(row, { field, bounds: volumeBounds });
        xMin = Math.min(xMin, volumeBounds[0]);
        xMax = Math.max(xMax, volumeBounds[1]);
        yMin = Math.min(yMin, volumeBounds[2]);
        yMax = Math.max(yMax, volumeBounds[3]);
        zMax = Math.max(zMax, volumeBounds[5]);
      });

      const project = (x: number, y: number, z: number): ProjectedPoint => {
        const radX = state.rotX;
        const radZ = state.rotZ;

        const x1 = x * Math.cos(radZ) - y * Math.sin(radZ);
        const y1 = x * Math.sin(radZ) + y * Math.cos(radZ);
        const z1 = z;

        const y2 = y1 * Math.cos(radX) - z1 * Math.sin(radX);
        const z2 = y1 * Math.sin(radX) + z1 * Math.cos(radX);

        return {
          px: cx + x1 * state.scale,
          py: cy - (z2 * state.scale),
          depth: y2
        };
      };

      if (state.axisMode === "grid") {
        ctx.strokeStyle = "rgba(180, 180, 180, 0.15)";
        ctx.lineWidth = 1;
        const gridStep = Math.max(1, Math.round((xMax - xMin) / 8));

        if (state.axesEnabled.x) {
          for (let gx = Math.ceil(xMin); gx <= xMax; gx += gridStep) {
            const pStart = project(gx, yMin, 0);
            const pEnd = project(gx, yMax, 0);
            ctx.beginPath();
            ctx.moveTo(pStart.px, pStart.py);
            ctx.lineTo(pEnd.px, pEnd.py);
            ctx.stroke();
          }
        }

        if (state.axesEnabled.y) {
          for (let gy = Math.ceil(yMin); gy <= yMax; gy += gridStep) {
            const pStart = project(xMin, gy, 0);
            const pEnd = project(xMax, gy, 0);
            ctx.beginPath();
            ctx.moveTo(pStart.px, pStart.py);
            ctx.lineTo(pEnd.px, pEnd.py);
            ctx.stroke();
          }
        }
      }

      const drawAxis3D = (
        axisName: keyof Required<AxesVisibility>,
        endX: number,
        endY: number,
        endZ: number,
        label: string,
        col: string
      ): void => {
        if (!state.axesEnabled[axisName]) return;

        const p0 = project(0, 0, 0);
        const p1 = project(endX, endY, endZ);

        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p0.px, p0.py);
        ctx.lineTo(p1.px, p1.py);
        ctx.stroke();

        ctx.fillStyle = col;
        ctx.font = "bold 12px sans-serif";
        ctx.fillText(label, p1.px + 4, p1.py - 4);

        if (state.axisMode === "ticks") {
          ctx.strokeStyle = col;
          ctx.fillStyle = col;
          ctx.font = "9px var(--font-monospace)";
          ctx.lineWidth = 1.2;

          const maxVal = Math.max(Math.abs(endX), Math.abs(endY), Math.abs(endZ));
          const tickStep = Math.max(1, Math.round(maxVal / 5));

          for (let v = tickStep; v < maxVal; v += tickStep) {
            let px0: number;
            let py0: number;
            let px1: number;
            let py1: number;
            let labelPos: ProjectedPoint;

            if (axisName === "x") {
              const ptA = project(v, 0, 0);
              const ptB = project(v, 0.25, 0);
              px0 = ptA.px; py0 = ptA.py;
              px1 = ptB.px; py1 = ptB.py;
              labelPos = ptB;
            } else if (axisName === "y") {
              const ptA = project(0, v, 0);
              const ptB = project(0.25, v, 0);
              px0 = ptA.px; py0 = ptA.py;
              px1 = ptB.px; py1 = ptB.py;
              labelPos = ptB;
            } else {
              const ptA = project(0, 0, v);
              const ptB = project(0.25, 0, v);
              px0 = ptA.px; py0 = ptA.py;
              px1 = ptB.px; py1 = ptB.py;
              labelPos = ptB;
            }

            ctx.beginPath();
            ctx.moveTo(px0, py0);
            ctx.lineTo(px1, py1);
            ctx.stroke();

            if (state.showAxisNumbers) {
              ctx.fillText(String(v), labelPos.px + 2, labelPos.py + 3);
            }
          }
        }
      };

      drawAxis3D("x", xMax + 1, 0, 0, "X", "#e91e63");
      drawAxis3D("y", 0, yMax + 1, 0, "Y", "#4caf50");
      drawAxis3D("z", 0, 0, Math.max(4.5, zMax), "Z", "#2196f3");

      const steps = Math.max(16, Math.min(100, state.resolution || 50));
      const stepX = (xMax - xMin) / steps;
      const stepY = (yMax - yMin) / steps;

      const activeFns: ActiveFunction[] = [];
      const implicitSurfaces: RenderedImplicitSurface[] = [];

      state.rows.forEach(r => {
        if (!r.input || r.visible === false) return;
        if (r.type === "var") return;

        const col = r.color || "#4caf50";
        const label = r.labelInput ? r.labelInput.value.trim() : "";

        // PUNTI 3D (Accodati in primo piano)
        if (r.type === "point") {
          const pt = this.evalVectorExpr(r.input.value, currentVars);
          overlaysToDraw.push(() => {
            const p = project(pt[0], pt[1], pt[2] || 0);

            // Linea di proiezione verticale tratteggiata verso la base
            const pBase = project(pt[0], pt[1], 0);
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(pBase.px, pBase.py);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(p.px, p.py, 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#000000";
            ctx.lineWidth = 1.5;
            ctx.stroke();

            queueLabel(label, p.px, p.py, col);
          });
          return;
        }

        // VETTORI 3D CON FRECCIA (Accodati in primo piano)
        if (r.type === "vector") {
          const orig = this.evalVectorExpr(r.input.value, currentVars);
          const dir = this.evalVectorExpr(r.dirInput ? r.dirInput.value : "1,0,0", currentVars);

          overlaysToDraw.push(() => {
            const p0 = project(orig[0], orig[1], orig[2] || 0);
            const p1 = project(orig[0] + dir[0], orig[1] + dir[1], (orig[2] || 0) + (dir[2] || 0));

            ctx.strokeStyle = col;
            ctx.lineWidth = 4;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(p0.px, p0.py);
            ctx.lineTo(p1.px, p1.py);
            ctx.stroke();

            // Punta della freccia 3D
            const angle = Math.atan2(p1.py - p0.py, p1.px - p0.px);
            const arrowLen = 12;
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p1.px - arrowLen * Math.cos(angle - Math.PI / 6), p1.py - arrowLen * Math.sin(angle - Math.PI / 6));
            ctx.lineTo(p1.px - arrowLen * Math.cos(angle + Math.PI / 6), p1.py - arrowLen * Math.sin(angle + Math.PI / 6));
            ctx.closePath();
            ctx.fill();

            queueLabel(label, p1.px, p1.py, col);
          });
          return;
        }

        const val = r.input.value.trim();
        if (!val) return;
        const isImplicitEquation = r.type === "implicit" ||
          (r.type === "fn" && val.includes("=") && /[zZ]/.test(val) && !/^\s*z\s*=/i.test(val));
        if (isImplicitEquation) {
          const implicitVolume = implicitVolumes.get(r);
          if (!implicitVolume) return;
          const { field, bounds: volumeBounds } = implicitVolume;
          const meshResolution = interactive ? 12 : Math.max(24, Math.min(32, steps));
          const variableKey = Object.keys(currentVars).sort().map(name => [name, currentVars[name]]);
          const spans = [volumeBounds[1] - volumeBounds[0], volumeBounds[3] - volumeBounds[2], volumeBounds[5] - volumeBounds[4]];
          const longestSpan = Math.max(...spans);
          const meshDimensions = spans.map(span => Math.max(12, Math.ceil(meshResolution * span / longestSpan))) as [number, number, number];
          const cacheKey = JSON.stringify([val, variableKey, volumeBounds, meshDimensions]);
          let mesh = this.implicitMeshCache.get(cacheKey);
          if (!mesh) {
            try {
              mesh = surfaceNets(
                meshDimensions,
                (x, y, z) => field(x, y, z) ?? 1e6,
                [[volumeBounds[0], volumeBounds[2], volumeBounds[4]], [volumeBounds[1], volumeBounds[3], volumeBounds[5]]]
              );
            } catch {
              return;
            }
            if (!interactive) {
              this.implicitMeshCache.set(cacheKey, mesh);
              if (this.implicitMeshCache.size > 12) {
                const oldestKey = this.implicitMeshCache.keys().next().value as string | undefined;
                if (oldestKey !== undefined) this.implicitMeshCache.delete(oldestKey);
              }
            }
          }

          const points = mesh.positions.map(vertex => project(vertex[0], vertex[1], vertex[2]));
          implicitSurfaces.push({
            points,
            cells: mesh.cells,
            color: col,
            opacity: r.opacity !== undefined ? r.opacity : 1,
            label
          });
          if (label && points.length > 0) {
            const center = points.reduce((sum, point) => ({ px: sum.px + point.px, py: sum.py + point.py }), { px: 0, py: 0 });
            queueLabel(label, center.px / points.length, center.py / points.length, col);
          }
          return;
        }

        const fn = this.latexToJS(val, currentVars);
        const op = r.opacity !== undefined ? r.opacity : 1.0;

        const gridZ: Array<Array<number | null>> = [];
        for (let j = 0; j <= steps; j++) {
          const rowZ: Array<number | null> = [];
          const my = yMin + j * stepY;
          for (let i = 0; i <= steps; i++) {
            const mx = xMin + i * stepX;
            const mz = fn(mx, my);
            rowZ.push(mz !== null && isFinite(mz) ? mz : null);
          }
          gridZ.push(rowZ);
        }

        activeFns.push({ fn, col, op, label, gridZ });
      });

      if (state.renderStyle === "solid") {
        const rasterScale = Math.max(1, Math.min(Math.max(2, dpr), Math.sqrt(4000000 / (w * h))));
        const rasterWidth = Math.ceil(w * rasterScale);
        const rasterHeight = Math.ceil(h * rasterScale);
        const pixelCount = rasterWidth * rasterHeight;
        const surfaceCanvas = document.createElement("canvas");
        surfaceCanvas.width = rasterWidth;
        surfaceCanvas.height = rasterHeight;
        const surfaceCtx = surfaceCanvas.getContext("2d");
        if (!surfaceCtx) return;

        const surfaceImage = surfaceCtx.createImageData(rasterWidth, rasterHeight);
        const depthBuffer = new Float32Array(pixelCount);
        depthBuffer.fill(Number.NEGATIVE_INFINITY);
        const surfacePixels = surfaceImage.data;

        const rasterizeTriangle = (
          point0: ProjectedPoint,
          point1: ProjectedPoint,
          point2: ProjectedPoint,
          red: number,
          green: number,
          blue: number,
          alpha: number
        ): void => {
          const x0 = point0.px * rasterScale;
          const y0 = point0.py * rasterScale;
          const x1 = point1.px * rasterScale;
          const y1 = point1.py * rasterScale;
          const x2 = point2.px * rasterScale;
          const y2 = point2.py * rasterScale;
          const denominator = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
          if (Math.abs(denominator) < 1e-8 || alpha <= 0) return;

          const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
          const maxX = Math.min(rasterWidth - 1, Math.ceil(Math.max(x0, x1, x2)));
          const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
          const maxY = Math.min(rasterHeight - 1, Math.ceil(Math.max(y0, y1, y2)));

          for (let py = minY; py <= maxY; py++) {
            for (let px = minX; px <= maxX; px++) {
              const sampleX = px + 0.5;
              const sampleY = py + 0.5;
              const weight0 = ((y1 - y2) * (sampleX - x2) + (x2 - x1) * (sampleY - y2)) / denominator;
              const weight1 = ((y2 - y0) * (sampleX - x2) + (x0 - x2) * (sampleY - y2)) / denominator;
              const weight2 = 1 - weight0 - weight1;
              if (weight0 < 0 || weight1 < 0 || weight2 < 0) continue;

              const depth = weight0 * point0.depth + weight1 * point1.depth + weight2 * point2.depth;
              const pixelIndex = py * rasterWidth + px;
              if (depth <= depthBuffer[pixelIndex]) continue;

              depthBuffer[pixelIndex] = depth;
              const colorIndex = pixelIndex * 4;
              surfacePixels[colorIndex] = red;
              surfacePixels[colorIndex + 1] = green;
              surfacePixels[colorIndex + 2] = blue;
              surfacePixels[colorIndex + 3] = alpha;
            }
          }
        };

        activeFns.forEach(({ col, op, gridZ }) => {
          const colorNumber = parseInt((col || "#4caf50").replace("#", ""), 16);
          const baseRed = Number.isNaN(colorNumber) ? 76 : (colorNumber >> 16) & 255;
          const baseGreen = Number.isNaN(colorNumber) ? 175 : (colorNumber >> 8) & 255;
          const baseBlue = Number.isNaN(colorNumber) ? 80 : colorNumber & 255;
          const alpha = Math.round(Math.max(0, Math.min(1, op * 0.85)) * 255);

          for (let j = 0; j < steps; j++) {
            for (let i = 0; i < steps; i++) {
              const z00 = gridZ[j][i];
              const z10 = gridZ[j][i + 1];
              const z11 = gridZ[j + 1][i + 1];
              const z01 = gridZ[j + 1][i];
              if (z00 === null || z10 === null || z11 === null || z01 === null) continue;

              const x0 = xMin + i * stepX;
              const x1 = xMin + (i + 1) * stepX;
              const y0 = yMin + j * stepY;
              const y1 = yMin + (j + 1) * stepY;
              const p00 = project(x0, y0, z00);
              const p10 = project(x1, y0, z10);
              const p11 = project(x1, y1, z11);
              const p01 = project(x0, y1, z01);
              const shade = Math.round(Math.max(-40, Math.min(40, (z11 - z00) * 15)));
              const red = Math.max(0, Math.min(255, baseRed + shade));
              const green = Math.max(0, Math.min(255, baseGreen + shade));
              const blue = Math.max(0, Math.min(255, baseBlue + shade));

              rasterizeTriangle(p00, p10, p11, red, green, blue, alpha);
              rasterizeTriangle(p00, p11, p01, red, green, blue, alpha);
            }
          }
        });

        implicitSurfaces.forEach(surface => {
          const colorNumber = parseInt(surface.color.replace("#", ""), 16);
          const red = Number.isNaN(colorNumber) ? 76 : (colorNumber >> 16) & 255;
          const green = Number.isNaN(colorNumber) ? 175 : (colorNumber >> 8) & 255;
          const blue = Number.isNaN(colorNumber) ? 80 : colorNumber & 255;
          const alpha = Math.round(Math.max(0, Math.min(1, surface.opacity * 0.85)) * 255);

          surface.cells.forEach(cell => {
            if (cell.length < 3) return;
            const point0 = surface.points[cell[0]];
            for (let index = 1; index < cell.length - 1; index++) {
              const point1 = surface.points[cell[index]];
              const point2 = surface.points[cell[index + 1]];
              if (point0 && point1 && point2) {
                rasterizeTriangle(point0, point1, point2, red, green, blue, alpha);
              }
            }
          });
        });

        surfaceCtx.putImageData(surfaceImage, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(surfaceCanvas, 0, 0, rasterWidth, rasterHeight, 0, 0, w, h);

      } else if (state.renderStyle === "points") {
        activeFns.forEach(({ col, op, gridZ }) => {
          ctx.fillStyle = hexToRgba(col, op);
          for (let j = 0; j <= steps; j++) {
            const my = yMin + j * stepY;
            for (let i = 0; i <= steps; i++) {
              const mx = xMin + i * stepX;
              const mz = gridZ[j][i];
              if (mz !== null) {
                const p = project(mx, my, mz);
                ctx.beginPath();
                ctx.arc(p.px, p.py, 1.8, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          }
        });

        implicitSurfaces.forEach(surface => {
          ctx.fillStyle = hexToRgba(surface.color, surface.opacity);
          surface.points.forEach(point => {
            ctx.beginPath();
            ctx.arc(point.px, point.py, 1.8, 0, Math.PI * 2);
            ctx.fill();
          });
        });

      } else {
        activeFns.forEach(({ col, op, label, gridZ }) => {
          ctx.strokeStyle = hexToRgba(col, op);
          ctx.lineWidth = 1;

          for (let j = 0; j <= steps; j++) {
            const my = yMin + j * stepY;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i <= steps; i++) {
              const mx = xMin + i * stepX;
              const mz = gridZ[j][i];
              if (mz !== null) {
                const p = project(mx, my, mz);
                if (!started) { ctx.moveTo(p.px, p.py); started = true; }
                else { ctx.lineTo(p.px, p.py); }
              } else {
                started = false;
              }
            }
            ctx.stroke();
          }

          for (let i = 0; i <= steps; i++) {
            const mx = xMin + i * stepX;
            ctx.beginPath();
            let started = false;
            for (let j = 0; j <= steps; j++) {
              const my = yMin + j * stepY;
              const mz = gridZ[j][i];
              if (mz !== null) {
                const p = project(mx, my, mz);
                if (!started) { ctx.moveTo(p.px, p.py); started = true; }
                else { ctx.lineTo(p.px, p.py); }
              } else {
                started = false;
              }
            }
            ctx.stroke();
          }

          const midZ = gridZ[Math.floor(steps / 2)][Math.floor(steps / 2)];
          if (midZ !== null && label) {
            const pMid = project(0, 0, midZ);
            queueLabel(label, pMid.px, pMid.py, col);
          }
        });
      }

      if (state.renderStyle === "wireframe") {
        implicitSurfaces.forEach(surface => {
          ctx.strokeStyle = hexToRgba(surface.color, surface.opacity);
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          const drawnEdges = new Set<string>();

          surface.cells.forEach(cell => {
            for (let index = 0; index < cell.length; index++) {
              const startIndex = cell[index];
              const endIndex = cell[(index + 1) % cell.length];
              const edgeKey = startIndex < endIndex ? `${startIndex}:${endIndex}` : `${endIndex}:${startIndex}`;
              if (drawnEdges.has(edgeKey)) continue;
              drawnEdges.add(edgeKey);

              const start = surface.points[startIndex];
              const end = surface.points[endIndex];
              if (!start || !end) continue;
              ctx.moveTo(start.px, start.py);
              ctx.lineTo(end.px, end.py);
            }
          });

          ctx.stroke();
        });
      }

      // DISEGNA INTERSEZIONI 3D
      if (state.showIntersections && activeFns.length >= 2) {
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";

        for (let a = 0; a < activeFns.length; a++) {
          for (let b = a + 1; b < activeFns.length; b++) {
            const gA = activeFns[a].gridZ;
            const gB = activeFns[b].gridZ;

            const diffGrid: Array<number | null> = [];
            for (let j = 0; j <= steps; j++) {
              for (let i = 0; i <= steps; i++) {
                const za = gA[j][i];
                const zb = gB[j][i];
                if (za !== null && zb !== null) diffGrid.push(za - zb);
                else diffGrid.push(null);
              }
            }

            for (let j = 0; j < steps; j++) {
              const y0 = yMin + j * stepY;
              const y1 = yMin + (j + 1) * stepY;

              for (let i = 0; i < steps; i++) {
                const x0 = xMin + i * stepX;
                const x1 = xMin + (i + 1) * stepX;

                const d00 = diffGrid[j * (steps + 1) + i];
                const d10 = diffGrid[j * (steps + 1) + i + 1];
                const d11 = diffGrid[(j + 1) * (steps + 1) + i + 1];
                const d01 = diffGrid[(j + 1) * (steps + 1) + i];

                if (d00 === null || d10 === null || d11 === null || d01 === null) continue;

                const edges: ProjectedPoint[] = [];

                if ((d00 >= 0 && d10 < 0) || (d00 < 0 && d10 >= 0)) {
                  const t = d00 / (d00 - d10);
                  edges.push(project(x0 + t * stepX, y0, gA[j][i] * (1 - t) + gA[j][i + 1] * t));
                }
                if ((d10 >= 0 && d11 < 0) || (d10 < 0 && d11 >= 0)) {
                  const t = d10 / (d10 - d11);
                  edges.push(project(x1, y0 + t * stepY, gA[j][i + 1] * (1 - t) + gA[j + 1][i + 1] * t));
                }
                if ((d01 >= 0 && d11 < 0) || (d01 < 0 && d11 >= 0)) {
                  const t = d01 / (d01 - d11);
                  edges.push(project(x0 + t * stepX, y1, gA[j + 1][i] * (1 - t) + gA[j + 1][i + 1] * t));
                }
                if ((d00 >= 0 && d01 < 0) || (d00 < 0 && d01 >= 0)) {
                  const t = d00 / (d00 - d01);
                  edges.push(project(x0, y0 + t * stepY, gA[j][i] * (1 - t) + gA[j + 1][i] * t));
                }

                if (edges.length >= 2) {
                  ctx.beginPath();
                  ctx.moveTo(edges[0].px, edges[0].py);
                  ctx.lineTo(edges[1].px, edges[1].py);
                  ctx.stroke();
                }
              }
            }
          }
        }
      }

      // Disegna tutti i vettori e punti sopra la griglia
      overlaysToDraw.forEach(fn => fn());
    }

    // DISEGNO DELLE LABEL SEMPRE AL LIVELLO PIÙ ALTO
    labelsToDraw.forEach(({ text, px, py, color }) => {
      ctx.font = "bold 11px sans-serif";
      const metrics = ctx.measureText(text);
      const padX = 5;
      const padY = 3;
      const boxW = metrics.width + padX * 2;
      const boxH = 14 + padY * 2;

      ctx.fillStyle = "rgba(18, 18, 18, 0.95)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;

      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(px + 6, py - 12, boxW, boxH, 4) : ctx.rect(px + 6, py - 12, boxW, boxH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.fillText(text, px + 6 + padX, py);
    });
  }

  private drawWebGL(canvas: HTMLCanvasElement, state: PlotUIState, interactive: boolean): void {
    const renderer = state.webglRenderer;
    const worker = state.meshWorker;
    const container = canvas.parentElement;
    const rect = container?.getBoundingClientRect();
    if (!renderer || !worker || !rect || rect.width === 0 || rect.height === 0) return;

    const variables: Record<string, number> = {};
    state.rows.forEach(row => {
      if (row.type === "var") variables[row.name] = row.value;
    });

    const surfaces: MeshRequestItem[] = [];
    const overlays: WebGLOverlayItem[] = [];
    state.rows.forEach((row, index) => {
      if (!row.input || row.visible === false || row.type === "var") return;
      const label = row.labelInput.value.trim();
      if (row.type === "point") {
        const point = this.evalVectorExpr(row.input.value, variables);
        overlays.push({
          type: "point",
          origin: [point[0] || 0, point[1] || 0, point[2] || 0],
          color: row.color,
          label
        });
        return;
      }
      if (row.type === "vector") {
        const origin = this.evalVectorExpr(row.input.value, variables);
        const direction = this.evalVectorExpr(row.dirInput ? row.dirInput.value : "1,0,0", variables);
        overlays.push({
          type: "vector",
          origin: [origin[0] || 0, origin[1] || 0, origin[2] || 0],
          direction: [direction[0] || 0, direction[1] || 0, direction[2] || 0],
          color: row.color,
          label
        });
        return;
      }

      const expression = row.input.value.trim();
      if (!expression) return;
      const isImplicit = row.type === "implicit" ||
        (expression.includes("=") && /[zZ]/.test(expression) && !/^\s*z\s*=/i.test(expression));
      surfaces.push({
        id: index,
        kind: isImplicit ? "implicit" : "explicit",
        expression: row.type === "implicit" ? expression : expression,
        color: row.color,
        opacity: row.opacity,
        label
      });
    });

    const bounds = state.bounds.length >= 4
      ? [state.bounds[0], state.bounds[1], state.bounds[2], state.bounds[3], state.bounds.length >= 6 ? state.bounds[4] : -4, state.bounds.length >= 6 ? state.bounds[5] : 4] as PlotBounds3D
      : [-4, 4, -4, 4, -4, 4] as PlotBounds3D;
    const resolution = interactive ? 12 : Math.max(24, Math.min(32, state.resolution));
    const signature = JSON.stringify([surfaces, variables, bounds, resolution, state.showIntersections]);
    if (signature !== state.meshRequestSignature) {
      state.meshRequestSignature = signature;
      state.meshRequestId++;
      const request: MeshRequest = {
        requestId: state.meshRequestId,
        resolution,
        bounds,
        variables,
        showIntersections: state.showIntersections,
        items: surfaces
      };
      try {
        worker.postMessage(request);
      } catch (error) {
        console.error("Could not send plot mesh request:", error);
        worker.terminate();
        state.meshWorker = null;
        renderer.dispose();
        state.webglRenderer = null;
        state.webglMeshes = [];
        state.webglIntersections = new ArrayBuffer(0);
        canvas.style.display = "block";
        this.drawCanvas(canvas, state);
        return;
      }
    }

    if (state.webglRenderStyle !== state.renderStyle) {
      renderer.setMeshes(state.webglMeshes, state.renderStyle, state.webglIntersections);
      state.webglRenderStyle = state.renderStyle;
    }
    const view: WebGLViewState = {
      width: rect.width,
      height: rect.height,
      rotX: state.rotX,
      rotZ: state.rotZ,
      scale: state.scale,
      panX: state.panX,
      panY: state.panY,
      bounds: state.webglBounds,
      renderStyle: state.renderStyle,
      axisMode: state.axisMode,
      axesEnabled: state.axesEnabled,
      showAxisNumbers: state.showAxisNumbers
    };
    renderer.render(view, overlays);
  }
}

class MathPlotModal extends Modal {
  plugin: MultiPlotterPlugin;
  onInsert: (markdown: string) => void;
  private disposeUI: (() => void) | null = null;

  constructor(app: App, plugin: MultiPlotterPlugin, onInsert: (markdown: string) => void) {
    super(app);
    this.plugin = plugin;
    this.onInsert = onInsert;
  }

  onOpen() {
    const contentEl = this.contentEl;
    contentEl.empty();
    this.modalEl.classList.add("math-plot-modal");

    contentEl.createEl("h2", { text: "Math Plotter - New Graph" });

    const freshConfig: MathPlotConfig = {
      type: "3d",
      renderStyle: "wireframe",
      resolution: 50,
      showIntersections: true,
      axisMode: "ticks",
      showAxisNumbers: true,
      axesEnabled: { x: true, y: true, z: true },
      viewOnly: false,
      bounds: [-4, 4, -4, 4],
      camera: { rotX: 1.05, rotZ: -1.95, scale: 38, panX: -40, panY: 20 },
      items: [
        { type: "fn", fn: "\\sqrt{x^2 + y^2}", color: "#4caf50", opacity: 0.85, visible: true },
        { type: "var", name: "c", value: 3, min: -5, max: 5, step: 0.1 },
        { type: "fn", fn: "c", color: "#2196f3", opacity: 0.5, visible: true }
      ]
    };

    this.disposeUI = this.plugin.buildUI(contentEl, freshConfig, null, (markdown) => {
      this.onInsert(markdown);
      this.close();
    });
  }

  onClose() {
    this.disposeUI?.();
    this.disposeUI = null;
    this.contentEl.empty();
  }
}