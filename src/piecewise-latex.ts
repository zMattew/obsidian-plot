import type { PlotPiecewiseBranch } from "./types";

export interface ParsedSystemEquation {
  equation: string;
  visible: boolean;
}

function unwrapTextCommand(condition: string): string {
  const trimmed = condition.trim();
  const match = trimmed.match(/^\\text\s*\{([\s\S]*)\}$/);
  return match ? match[1].trim() : trimmed;
}

export function parsePiecewiseLatex(source: string): PlotPiecewiseBranch[] | null {
  const trimmed = source.trim();
  const start = "\\begin{cases}";
  const end = "\\end{cases}";
  if (!trimmed.startsWith(start) || !trimmed.endsWith(end)) return null;

  const body = trimmed.slice(start.length, -end.length).trim();
  const branches = body.split(/\\\\/).map(row => {
    const separator = row.indexOf("&");
    if (separator < 1) return null;
    const equation = row.slice(0, separator).trim();
    const condition = unwrapTextCommand(row.slice(separator + 1));
    return equation && condition ? { equation, condition } : null;
  });

  if (branches.length === 0 || branches.some(branch => branch === null)) return null;
  return branches;
}

export function serializePiecewiseLatex(branches: PlotPiecewiseBranch[]): string {
  const rows = branches.map(branch => `${branch.equation.trim()} & \\text{${branch.condition.trim()}}`);
  return `\\begin{cases}\n${rows.join(" \\\\\n")}\n\\end{cases}`;
}

export function parseSystemLatex(source: string): string[] | null {
  const trimmed = source.trim();
  const start = "\\begin{aligned}";
  const end = "\\end{aligned}";
  if (!trimmed.startsWith(start) || !trimmed.endsWith(end)) return null;
  const body = trimmed.slice(start.length, -end.length).trim();
  const equations = body.split(/\\\\/).map(row => row.replace(/&/g, "").trim());
  return equations.length > 0 && equations.every(Boolean) ? equations : null;
}

export function serializeSystemLatex(equations: string[]): string {
  return `\\begin{aligned}\n${equations.map(equation => equation.trim()).join(" \\\\\n")}\n\\end{aligned}`;
}