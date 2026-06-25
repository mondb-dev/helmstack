/**
 * Minimal inline-SVG icon set (Lucide paths, styleguide §1.7).
 *
 * `icon(name)` returns a fresh `<svg aria-hidden stroke="currentColor">` built
 * with `createElementNS` (robust in both jsdom and the renderer). Icons inherit
 * colour from `currentColor`, so they are theme-aware for free.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

type Shape = [tag: string, attrs: Record<string, string>];

const ICONS = {
  x: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }],
  ],
  plus: [
    ["path", { d: "M5 12h14" }],
    ["path", { d: "M12 5v14" }],
  ],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  sun: [
    ["circle", { cx: "12", cy: "12", r: "4" }],
    ["path", { d: "M12 2v2" }],
    ["path", { d: "M12 20v2" }],
    ["path", { d: "m4.93 4.93 1.41 1.41" }],
    ["path", { d: "m17.66 17.66 1.41 1.41" }],
    ["path", { d: "M2 12h2" }],
    ["path", { d: "M20 12h2" }],
    ["path", { d: "m6.34 17.66-1.41 1.41" }],
    ["path", { d: "m19.07 4.93-1.41 1.41" }],
  ],
  moon: [["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }]],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export interface IconOptions {
  size?: number;
  className?: string;
}

export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const { size = 16, className } = options;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className ? `icon ${className}` : "icon");

  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      shape.setAttribute(key, value);
    }
    svg.appendChild(shape);
  }
  return svg;
}

export function iconNames(): IconName[] {
  return Object.keys(ICONS) as IconName[];
}
