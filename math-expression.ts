import { parse } from "mathjs";

export const ALLOWED_MATH_FUNCTIONS = new Set([
  "abs", "acos", "asin", "atan", "ceil", "cos", "cosh", "exp", "floor", "log", "max", "min",
  "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh"
]);

const ALLOWED_MATH_OPERATORS = new Set(["+", "-", "*", "/", "%", "^"]);

function replaceLatexCommandGroups(
  expression: string,
  command: string,
  argumentCount: number,
  convert: (args: string[]) => string
): string {
  const token = `\\${command}`;
  let result = "";
  let index = 0;

  while (index < expression.length) {
    const commandIndex = expression.indexOf(token, index);
    if (commandIndex === -1) return result + expression.slice(index);

    result += expression.slice(index, commandIndex);
    let cursor = commandIndex + token.length;
    if (/[a-zA-Z]/.test(expression[cursor] || "")) {
      result += token;
      index = cursor;
      continue;
    }

    const args: string[] = [];
    let matched = true;
    for (let argIndex = 0; argIndex < argumentCount; argIndex++) {
      while (/\s/.test(expression[cursor] || "")) cursor++;
      if (expression[cursor] !== "{") {
        matched = false;
        break;
      }

      const start = ++cursor;
      let depth = 1;
      while (cursor < expression.length && depth > 0) {
        if (expression[cursor] === "{") depth++;
        else if (expression[cursor] === "}") depth--;
        cursor++;
      }
      if (depth !== 0) {
        matched = false;
        break;
      }
      args.push(expression.slice(start, cursor - 1));
    }

    if (matched) {
      result += convert(args);
      index = cursor;
    } else {
      result += token;
      index = commandIndex + token.length;
    }
  }

  return result;
}

function unwrapOuterParentheses(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return expression;

  let depth = 0;
  for (let index = 0; index < trimmed.length; index++) {
    if (trimmed[index] === "(") depth++;
    else if (trimmed[index] === ")") depth--;
    if (depth === 0 && index < trimmed.length - 1) return expression;
  }

  return depth === 0 ? trimmed.slice(1, -1) : expression;
}

export class MathExpressionCompiler {
  private compiled = new Map<string, ((scope: Record<string, number>) => unknown) | null>();

  compile(
    source: string,
    vars: Record<string, number>,
    coordinates: string[]
  ): ((scope: Record<string, number>) => unknown) | null {
    if (!source.trim()) return null;
    if (/(^|[^\\])\b(?:abs|acos|asin|atan|ceil|cos|cosh|exp|floor|log|max|min|pow|round|sign|sin|sinh|sqrt|tan|tanh)\s*(?:\(|\{)/.test(source)) {
      return null;
    }

    const cacheKey = `${source}\u0000${Object.keys(vars).sort().join(",")}\u0000${coordinates.join(",")}`;
    let evaluate = this.compiled.get(cacheKey);
    if (evaluate === undefined) {
      let expression = replaceLatexCommandGroups(source, "sqrt", 1, args => `sqrt((${args[0]}))`);
      expression = expression.replace(/\\sqrt\s*([a-zA-Z0-9])/g, "sqrt($1)");
      expression = replaceLatexCommandGroups(expression, "frac", 2, args => `((${args[0]})/(${args[1]}))`);
      expression = replaceLatexCommandGroups(expression, "max", 1, args => `max(${unwrapOuterParentheses(args[0])})`);
      expression = replaceLatexCommandGroups(expression, "min", 1, args => `min(${unwrapOuterParentheses(args[0])})`);

      while (/\|([^|]+)\|/.test(expression)) {
        expression = expression.replace(/\|([^|]+)\|/g, "abs($1)");
      }

      expression = expression.replace(/\\ln\b/g, "log");
      expression = expression.replace(/\\(arcsin|arccos|arctan)\b/g, (_match, name: string) => name.slice(3));
      expression = expression.replace(/\\(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|exp|log|max|min|ceil|floor|pow|round|sign)\b/g, "$1");
      expression = expression.replace(/\\cdot|\\times/g, "*");
      expression = expression.replace(/\\pi/g, "pi");
      expression = expression.replace(/\\left|\\right/g, "");
      expression = expression.replace(/\bMath\.PI\b/gi, "pi").replace(/\bMath\.E\b/g, "e");
      expression = expression.replace(/\bMath\./g, "");
      expression = expression.replace(/\{/g, "(").replace(/\}/g, ")");
      expression = expression.replace(/([xXyY])\s+([xXyY])/g, "$1*$2");

      try {
        const node = parse(expression);
        const allowedSymbols = new Set(["e", "pi", ...coordinates, ...Object.keys(vars), ...ALLOWED_MATH_FUNCTIONS]);
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
          evaluate = scope => compiled.evaluate(scope);
        } else {
          evaluate = null;
        }
      } catch {
        evaluate = null;
      }

      this.compiled.set(cacheKey, evaluate);
      if (this.compiled.size > 256) {
        const oldestKey = this.compiled.keys().next().value as string | undefined;
        if (oldestKey !== undefined) this.compiled.delete(oldestKey);
      }
    }
    return evaluate;
  }
}