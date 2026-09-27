import { parse } from "mathjs";
import { App, finishRenderMath, MarkdownPostProcessorContext, MarkdownRenderChild, Modal, Plugin, renderMath, TFile } from "obsidian";
import type { MathPlotConfig } from "./types";

interface PlotRowElement {
  row: HTMLDivElement;
  colorPickerWrapper: HTMLDivElement;
  colorBadge: HTMLDivElement;
  colorBox: HTMLInputElement;
  bodyContainer: HTMLDivElement;
  type: string;
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

const ALLOWED_MATH_FUNCTIONS = new Set([
  "abs", "acos", "asin", "atan", "ceil", "cos", "cosh", "exp", "floor", "log", "max", "min",
  "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh"
]);
const ALLOWED_MATH_OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);
const RESERVED_VARIABLE_NAMES = new Set(["x", "y", "z", "e", "pi"]);

function isValidVariableName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return /^[a-z][a-z0-9_]{0,31}$/i.test(name) &&
    !RESERVED_VARIABLE_NAMES.has(normalizedName) &&
    !ALLOWED_MATH_FUNCTIONS.has(normalizedName);
}

export default class MultiPlotterPlugin extends Plugin {
  blockRegistry: WeakMap<HTMLElement, { skipNextRender: boolean }> = new WeakMap();
  private compiledExpressions = new Map<string, ((scope: Record<string, number>) => unknown) | null>();

  async onload() {
    this.blockRegistry = new WeakMap();

    this.addCommand({
      id: "open-math-plot-modal",
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
          el.createEl("pre", { text: "Math-Plot Configuration Error:\n" + e.message });
          return;
        }
      }

      this.buildUI(el, config, ctx, null);
    });
  }

  parseConfig(raw: string): MathPlotConfig {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {}

    if (parsed === undefined) {
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
      parsed = JSON.parse(sanitized);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configuration must be a JSON object.");
    }
    if (parsed.items === undefined) parsed.items = [];
    if (!Array.isArray(parsed.items)) throw new Error("'items' must be an array.");
    if (parsed.type !== undefined && parsed.type !== "2d" && parsed.type !== "3d") {
      throw new Error("'type' must be '2d' or '3d'.");
    }
    if (parsed.renderStyle !== undefined && !["wireframe", "solid", "points"].includes(parsed.renderStyle)) {
      throw new Error("'renderStyle' must be 'wireframe', 'solid' or 'points'.");
    }
    if (parsed.axisMode !== undefined && !["ticks", "grid", "none"].includes(parsed.axisMode)) {
      throw new Error("'axisMode' must be 'ticks', 'grid' or 'none'.");
    }
    if (parsed.resolution !== undefined && (!Number.isFinite(parsed.resolution) || parsed.resolution < 1)) {
      throw new Error("'resolution' must be a positive finite number.");
    }
    if (parsed.bounds !== undefined && (!Array.isArray(parsed.bounds) || ![2, 4].includes(parsed.bounds.length) ||
      !parsed.bounds.every(Number.isFinite) || parsed.bounds[0] >= parsed.bounds[1] ||
      (parsed.bounds.length === 4 && parsed.bounds[2] >= parsed.bounds[3]))) {
      throw new Error("'bounds' must contain two or four finite values in ascending order.");
    }

    parsed.items.forEach((item: any, index: number) => {
      const prefix = `Item ${index + 1}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${prefix} must be an object.`);
      if (item.type === "var") {
        if (typeof item.name !== "string" || !isValidVariableName(item.name) || !Number.isFinite(item.value)) {
          throw new Error(`${prefix} must have a valid non-reserved variable name and finite value.`);
        }
      } else if (item.type === "fn") {
        if (typeof item.fn !== "string") throw new Error(`${prefix} must have a string 'fn'.`);
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

    return parsed as MathPlotConfig;
  }

  attachLatexSuiteShortcuts(inputEl: HTMLInputElement, onUpdate: () => void) {
    const snippets = [
      { trigger: "->", replace: "\\to " },
      { trigger: "|->", replace: "\\mapsto " },
      { trigger: "+-", replace: "\\pm " },
      { trigger: "inf", replace: "\\infty " },
      { trigger: "sq", replace: "\\sqrt{}" },
      { trigger: "fr", replace: "\\frac{}{}" },
      { trigger: "sin", replace: "\\sin(" },
      { trigger: "cos", replace: "\\cos(" },
      { trigger: "tan", replace: "\\tan(" },
      { trigger: "exp", replace: "\\exp(" }
    ];

    inputEl.addEventListener("input", () => {
      const cursor = inputEl.selectionStart;
      const text = inputEl.value;

      for (let i = 0; i < snippets.length; i++) {
        const s = snippets[i];
        const len = s.trigger.length;
        if (cursor >= len && text.slice(cursor - len, cursor) === s.trigger) {
          const before = text.slice(0, cursor - len);
          const after = text.slice(cursor);
          inputEl.value = before + s.replace + after;

          let newPos = before.length + s.replace.length;
          if (s.replace.indexOf("{}") !== -1) {
            newPos = before.length + s.replace.indexOf("{}") + 1;
          } else if (s.replace.endsWith("(")) {
            newPos = before.length + s.replace.length;
          }
          inputEl.setSelectionRange(newPos, newPos);
          break;
        }
      }
      onUpdate();
    });
  }

  latexToJS(latex: string, vars: Record<string, number> = {}): (x: number, y: number) => number | null {
    const source = (latex || "").trim();
    if (!source) return () => null;

    const cacheKey = `${source}\u0000${Object.keys(vars).sort().join(",")}`;
    let evaluate = this.compiledExpressions.get(cacheKey);
    if (evaluate === undefined) {
      let expr = source.replace(/^(z|y|f\([xXyY,\s]+\))\s*=\s*/i, "");
      while (/\\sqrt\{([^}]+)\}/.test(expr)) {
        expr = expr.replace(/\\sqrt\{([^}]+)\}/g, "sqrt(($1))");
      }
      expr = expr.replace(/\\sqrt\s*([a-zA-Z0-9])/g, "sqrt($1)");

      while (/\\frac\{([^}]+)\}\{([^}]+)\}/.test(expr)) {
        expr = expr.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "(($1)/($2))");
      }

      expr = expr.replace(/\\ln\b/g, "log");
      expr = expr.replace(/\\(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|exp|log|abs)/g, "$1");
      expr = expr.replace(/\\cdot|\\times/g, "*");
      expr = expr.replace(/\\pi/g, "pi");
      expr = expr.replace(/\\left|\\right/g, "");
      expr = expr.replace(/\bMath\.PI\b/gi, "pi").replace(/\bMath\.E\b/g, "e");
      expr = expr.replace(/\bMath\./g, "");
      expr = expr.replace(/\{/g, "(").replace(/\}/g, ")");
      expr = expr.replace(/([xXyY])\s+([xXyY])/g, "$1*$2");

      try {
        const node = parse(expr);
        const allowedSymbols = new Set(["e", "pi", "x", "y", ...Object.keys(vars), ...ALLOWED_MATH_FUNCTIONS]);
        let isSafe = true;

        node.traverse((child) => {
          const childNode = child as { type: string; name?: string; op?: string };
          if (childNode.type === "ConstantNode" || childNode.type === "ParenthesisNode") return;
          if (childNode.type === "SymbolNode") {
            if (!allowedSymbols.has(childNode.name || "")) isSafe = false;
            return;
          }
          if (childNode.type === "OperatorNode") {
            if (!ALLOWED_MATH_OPERATORS.has(childNode.op || "")) isSafe = false;
            return;
          }
          if (childNode.type === "FunctionNode") {
            if (!ALLOWED_MATH_FUNCTIONS.has(childNode.name || "")) isSafe = false;
            return;
          }
          isSafe = false;
        });

        if (isSafe) {
          const compiled = node.compile();
          evaluate = (scope) => compiled.evaluate(scope);
        } else {
          evaluate = null;
        }
      } catch (_) {
        evaluate = null;
      }

      this.compiledExpressions.set(cacheKey, evaluate);
      if (this.compiledExpressions.size > 256) {
        const oldestKey = this.compiledExpressions.keys().next().value;
        if (oldestKey !== undefined) this.compiledExpressions.delete(oldestKey);
      }
    }

    if (!evaluate) return () => null;
    return (x: number, y: number) => {
      try {
        const value = evaluate({ ...vars, x, y });
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      } catch (_) {
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
    const addPtBtn = toolbar.createEl("button", { text: "+ Point" });
    const addVecBtn = toolbar.createEl("button", { text: "+ Vector" });

    let insertBtn = null;
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

    const closeDropdownHandler = (e) => {
      if (!wrapper.contains(e.target)) {
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

    const state = {
      type: initialConfig.type || "3d",
      renderStyle: initialConfig.renderStyle || "wireframe",
      resolution: Number(initialConfig.resolution) || 50,
      showIntersections: Boolean(initialConfig.showIntersections),
      axisMode: initialConfig.axisMode || "ticks",
      showAxisNumbers: initialConfig.showAxisNumbers !== undefined ? Boolean(initialConfig.showAxisNumbers) : true,
      axesEnabled: Object.assign({}, defaultAxes, initialConfig.axesEnabled || {}),
      viewOnly: Boolean(initialConfig.viewOnly),
      bounds: Array.isArray(initialConfig.bounds) ? initialConfig.bounds.slice() : [-4, 4, -4, 4],
      rows: [],
      rotX: initialCam.rotX !== undefined ? initialCam.rotX : defaultCam.rotX,
      rotZ: initialCam.rotZ !== undefined ? initialCam.rotZ : defaultCam.rotZ,
      scale: initialCam.scale !== undefined ? initialCam.scale : defaultCam.scale,
      panX: initialCam.panX !== undefined ? initialCam.panX : defaultCam.panX,
      panY: initialCam.panY !== undefined ? initialCam.panY : defaultCam.panY,
      locked: false
    };

    const tracker = { skipNextRender: false };
    this.blockRegistry.set(rootEl, tracker);

    const createOptionRow = (labelText, controlEl) => {
      const row = dropdownMenu.createDiv({ cls: "math-option-row" });
      const lbl = row.createSpan({ text: labelText, cls: "math-option-label" });
      row.appendChild(controlEl);
      return row;
    };

    const typeSelect = document.createElement("select");
    ["3d", "2d"].forEach(t => {
      const opt = document.createElement("option");
      opt.value = t;
      opt.text = t.toUpperCase();
      if (t === state.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    createOptionRow("Graph type:", typeSelect);

    const styleSelect = document.createElement("select");
    const styleOptions = [
      { val: "wireframe", label: "Wireframe (Grid)" },
      { val: "solid", label: "Solid (Surface)" },
      { val: "points", label: "Point cloud" }
    ];
    styleOptions.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s.val;
      opt.text = s.label;
      if (s.val === state.renderStyle) opt.selected = true;
      styleSelect.appendChild(opt);
    });
    createOptionRow("Render style:", styleSelect);

    const resSelect = document.createElement("select");
    const resOptions = [
      { val: 24, label: "Low (24)" },
      { val: 40, label: "Medium (40)" },
      { val: 50, label: "Default (50)" },
      { val: 60, label: "High (60)" },
      { val: 80, label: "Ultra (80)" }
    ];
    resOptions.forEach(r => {
      const opt = document.createElement("option");
      opt.value = String(r.val);
      opt.text = r.label;
      if (r.val === state.resolution) opt.selected = true;
      resSelect.appendChild(opt);
    });
    createOptionRow("Resolution:", resSelect);

    const axisModeSelect = document.createElement("select");
    const axisModeOptions = [
      { val: "ticks", label: "Ticks (Reliefs)" },
      { val: "grid", label: "Full Grid" },
      { val: "none", label: "None" }
    ];
    axisModeOptions.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m.val;
      opt.text = m.label;
      if (m.val === state.axisMode) opt.selected = true;
      axisModeSelect.appendChild(opt);
    });
    createOptionRow("Axes style:", axisModeSelect);

    const axisNumRow = dropdownMenu.createDiv({ cls: "math-axis-row" });
    const axisNumLabel = axisNumRow.createSpan({ text: "Show axis numbers:", cls: "math-option-label" });
    const axisNumToggle = axisNumRow.createEl("input", { type: "checkbox" });
    axisNumToggle.checked = state.showAxisNumbers;
    axisNumToggle.classList.add("math-checkbox");

    const axesSelectRow = dropdownMenu.createDiv({ cls: "math-axis-row" });
    const axesLabel = axesSelectRow.createSpan({ text: "Visible axes:", cls: "math-option-label" });

    const axesGroup = axesSelectRow.createDiv({ cls: "math-axis-group" });

    const createAxisCheckbox = (name) => {
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

    const lockBtn = overlayControls.createEl("button", { text: "🔓", cls: "math-overlay-button" });
    lockBtn.title = "Lock / Unlock view interaction";

    const resetViewBtn = overlayControls.createEl("button", { text: "↺", cls: "math-overlay-button" });
    resetViewBtn.title = "Reset View to standard";

    const canvas = canvasContainer.createEl("canvas", { cls: "math-canvas" });

    lockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.locked = !state.locked;
      lockBtn.setText(state.locked ? "🔒" : "🔓");
      canvas.classList.toggle("is-locked", state.locked);
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
          rotX: Math.round(state.rotX * 100) / 100,
          rotZ: Math.round(state.rotZ * 100) / 100,
          scale: Math.round(state.scale),
          panX: Math.round(state.panX),
          panY: Math.round(state.panY)
        },
        items: items
      };
    };

    let saveTimer = null;
    const debouncedSave = () => {
      if (!ctx || !ctx.sourcePath) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          if (lifecycleController.signal.aborted) return;
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
      zWrap.classList.toggle("math-hidden", state.type !== "3d");
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

    let draggedRowEl = null;

    const attachDragEvents = (rowEl, dragHandle) => {
      dragHandle.draggable = true;

      dragHandle.addEventListener("dragstart", (e) => {
        draggedRowEl = rowEl;
        e.dataTransfer.effectAllowed = "move";
        rowEl.classList.add("is-dragging");
      });

      dragHandle.addEventListener("dragend", () => {
        draggedRowEl = null;
        rowEl.classList.remove("is-dragging");
        rowsContainer.querySelectorAll<HTMLElement>(".math-row").forEach(r => r.classList.remove("is-drop-target"));
      });

      rowEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
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

    const updateMathPreview = (previewEl, text, prefix) => {
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
      } catch (_) {
        previewEl.setText(formula);
      }
    };

    const createRow = (itemData = null, rowType = "fn", startWithFocus = false) => {
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
      alphaSlider.value = (itemData && itemData.opacity !== undefined) ? itemData.opacity : 1.0;
      alphaSlider.classList.add("math-opacity-slider");

      colorBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        colorPopover.classList.toggle("is-open");
      });
      colorPopover.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", () => colorPopover.classList.remove("is-open"), { signal: lifecycleController.signal });

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

        const onVal = (val) => {
          itemRef.value = Number(val);
          slider.value = val;
          numInput.value = val;
          this.drawCanvas(canvas, state);
          debouncedSave();
        };

        slider.addEventListener("input", (e) => onVal((e.target as HTMLInputElement).value));
        numInput.addEventListener("input", (e) => onVal((e.target as HTMLInputElement).value));
        return;
      }

      const prefix = state.type === "3d" ? "z = " : "y = ";

      const input = bodyContainer.createEl("input", {
        type: "text",
        placeholder: state.type === "3d" ? "\\sqrt{x^2+y^2} or a = 2" : "\\sin(x) or a = 2",
        cls: "math-equation-input"
      });
      input.value = (itemData && itemData.fn) || "";

      row.classList.add("math-equation-row");
      const previewEl = bodyContainer.createDiv({ cls: "math-equation-preview" });

      itemRef.input = input;
      itemRef.previewEl = previewEl;

      const setMode = (isEditing) => {
        row.classList.toggle("is-editing", isEditing);
        if (isEditing) input.focus();
        else updateMathPreview(previewEl, input.value, prefix);
      };

      if (startWithFocus) setMode(true);
      else setMode(false);

      previewEl.addEventListener("click", () => setMode(true));

      const testAndTransformSlider = () => {
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
      initialConfig.items.forEach(it => createRow(it, it.type || "fn", false));
    } else {
      createRow({ type: "fn", fn: state.type === "3d" ? "\\sqrt{x^2 + y^2}" : "\\sin(x)" }, "fn", false);
    }

    addBtn.addEventListener("click", () => {
      createRow(null, "fn", true);
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

    canvas.addEventListener("mousedown", (e) => {
      if (state.locked) return;
      isDragging = true;
      isPanning = Boolean(e.shiftKey || e.button === 1);
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.classList.toggle("is-panning", isPanning);
      canvas.classList.add("is-dragging");
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging || state.locked) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;

      if (isPanning) {
        state.panX += dx;
        state.panY += dy;
      } else if (state.type === "3d") {
        state.rotZ += dx * 0.01;
        state.rotX += dy * 0.01;
        state.rotX = Math.max(0.1, Math.min(Math.PI - 0.1, state.rotX));
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
      }
    }, { signal: lifecycleController.signal });

    canvas.addEventListener("wheel", (e) => {
      if (state.locked) return;
      e.preventDefault();
      state.scale = Math.max(2, Math.min(200, state.scale * (e.deltaY > 0 ? 0.9 : 1.1)));
      this.drawCanvas(canvas, state);
    });

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText("```math-plot\n" + JSON.stringify(buildExportJSON(), null, 2) + "\n```\n");
      copyBtn.setText("Copied!");
      setTimeout(() => copyBtn.setText("Copy Markdown"), 2000);
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
      if (saveTimer) clearTimeout(saveTimer);
      clearTimeout(initialDrawTimer);
    };
    if (ctx) {
      const renderChild = new MarkdownRenderChild(rootEl);
      renderChild.register(cleanup);
      ctx.addChild(renderChild);
    }
    return cleanup;
  }

  drawCanvas(canvas, state) {
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

    const labelsToDraw = [];
    const overlaysToDraw = [];

    const currentVars = {};
    state.rows.forEach(r => {
      if (r.type === "var") currentVars[r.name] = r.value;
    });

    const hexToRgba = (hex, alpha = 1.0) => {
      let num = parseInt((hex || "#4caf50").replace("#", ""), 16);
      if (isNaN(num)) return `rgba(76, 175, 80, ${alpha})`;
      let r = (num >> 16) & 255;
      let g = (num >> 8) & 255;
      let b = num & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const shadeRgba = (hex, percent, alpha = 1.0) => {
      let num = parseInt((hex || "#4caf50").replace("#", ""), 16);
      if (isNaN(num)) return `rgba(76, 175, 80, ${alpha})`;
      let r = Math.max(0, Math.min(255, ((num >> 16) & 255) + percent));
      let g = Math.max(0, Math.min(255, ((num >> 8) & 255) + percent));
      let b = Math.max(0, Math.min(255, (num & 255) + percent));
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const queueLabel = (text, px, py, color = "#ffffff") => {
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
        if (!r.input || r.visible === false) return;
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
      const xMin = bounds[0];
      const xMax = bounds[1];
      const yMin = bounds[2];
      const yMax = bounds[3];

      const project = (x, y, z) => {
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

      const drawAxis3D = (axisName, endX, endY, endZ, label, col) => {
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
            let px0, py0, px1, py1, labelPos;

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
      drawAxis3D("z", 0, 0, 4.5, "Z", "#2196f3");

      const steps = Math.max(16, Math.min(100, state.resolution || 50));
      const stepX = (xMax - xMin) / steps;
      const stepY = (yMax - yMin) / steps;

      const activeFns = [];

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
        const fn = this.latexToJS(val, currentVars);
        const op = r.opacity !== undefined ? r.opacity : 1.0;

        const gridZ = [];
        for (let j = 0; j <= steps; j++) {
          const rowZ = [];
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
        const polygons = [];

        activeFns.forEach(({ col, op, gridZ }) => {
          for (let j = 0; j < steps; j++) {
            for (let i = 0; i < steps; i++) {
              const z00 = gridZ[j][i];
              const z10 = gridZ[j][i + 1];
              const z11 = gridZ[j + 1][i + 1];
              const z01 = gridZ[j + 1][i];

              if (z00 !== null && z10 !== null && z11 !== null && z01 !== null) {
                const x0 = xMin + i * stepX;
                const x1 = xMin + (i + 1) * stepX;
                const y0 = yMin + j * stepY;
                const y1 = yMin + (j + 1) * stepY;

                const p00 = project(x0, y0, z00);
                const p10 = project(x1, y0, z10);
                const p11 = project(x1, y1, z11);
                const p01 = project(x0, y1, z01);

                const slope = (z11 - z00);
                const shade = Math.round(Math.max(-40, Math.min(40, slope * 15)));
                const avgDepth = (p00.depth + p10.depth + p11.depth + p01.depth) / 4;

                polygons.push({
                  pts: [p00, p10, p11, p01],
                  color: shadeRgba(col, shade, op * 0.85),
                  edgeColor: shadeRgba(col, -30, op * 0.4),
                  depth: avgDepth
                });
              }
            }
          }
        });

        polygons.sort((a, b) => a.depth - b.depth);

        polygons.forEach(p => {
          ctx.beginPath();
          ctx.moveTo(p.pts[0].px, p.pts[0].py);
          ctx.lineTo(p.pts[1].px, p.pts[1].py);
          ctx.lineTo(p.pts[2].px, p.pts[2].py);
          ctx.lineTo(p.pts[3].px, p.pts[3].py);
          ctx.closePath();

          ctx.fillStyle = p.color;
          ctx.fill();

          ctx.strokeStyle = p.edgeColor;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        });

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

      // DISEGNA INTERSEZIONI 3D
      if (state.showIntersections && activeFns.length >= 2) {
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";

        for (let a = 0; a < activeFns.length; a++) {
          for (let b = a + 1; b < activeFns.length; b++) {
            const gA = activeFns[a].gridZ;
            const gB = activeFns[b].gridZ;

            const diffGrid = [];
            for (let j = 0; j <= steps; j++) {
              const rowDiff = [];
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

                const edges = [];

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