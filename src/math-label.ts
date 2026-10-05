import { finishRenderMath, renderMath } from "obsidian";

export function renderMathLabel(element: HTMLElement, text: string): void {
  const delimiter = /\$([^$]+)\$/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(text)) !== null) {
    if (match.index > cursor) element.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    try {
      element.appendChild(renderMath(match[1], false));
      void finishRenderMath();
    } catch {
      element.appendChild(document.createTextNode(match[0]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) element.appendChild(document.createTextNode(text.slice(cursor)));
}