export type NavigationAction = "zoomIn" | "zoomOut" | "panUp" | "panDown" | "panLeft" | "panRight" | "resetView";

export interface PlotNavigationSettings {
  keys: Record<NavigationAction, string>;
  zoomFactor: number;
  panStep: number;
}

export const DEFAULT_NAVIGATION_SETTINGS: PlotNavigationSettings = {
  keys: {
    zoomIn: "=",
    zoomOut: "-",
    panUp: "ArrowUp",
    panDown: "ArrowDown",
    panLeft: "ArrowLeft",
    panRight: "ArrowRight",
    resetView: "0"
  },
  zoomFactor: 1.1,
  panStep: 20
};

export interface NavigationKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function normalizeKeybinding(binding: string): string {
  const parts = binding.split("+").map(part => part.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop() || "";
  const modifiers = new Set(parts.map(part => part === "control" ? "ctrl" : part));
  const orderedModifiers = ["ctrl", "alt", "shift", "meta"].filter(modifier => modifiers.has(modifier));
  return [...orderedModifiers, key].join("+");
}

export function resolveNavigationAction(event: NavigationKeyEvent, settings: PlotNavigationSettings): NavigationAction | null {
  const eventParts = [
    event.ctrlKey ? "ctrl" : "",
    event.altKey ? "alt" : "",
    event.shiftKey ? "shift" : "",
    event.metaKey ? "meta" : "",
    event.key.toLowerCase()
  ].filter(Boolean);
  const eventBinding = eventParts.join("+");
  return (Object.keys(settings.keys) as NavigationAction[]).find(action =>
    settings.keys[action] && normalizeKeybinding(settings.keys[action]) === eventBinding
  ) || null;
}