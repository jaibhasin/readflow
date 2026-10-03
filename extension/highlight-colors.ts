type Color = { red: number; green: number; blue: number; alpha: number };

export type HighlightPalette = { sentence: string; passage: string };

function parseColor(value: string, document: Document): Color | null {
  if (!value) return null;
  const match = value.match(/^rgba?\(\s*([\d.]+%?)[, ]+([\d.]+%?)[, ]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (match) {
    const channel = (part: string): number => Number.parseFloat(part) * (part.endsWith("%") ? 2.55 : 1);
    const alpha = match[4] ?? "1";
    return {
      red: channel(match[1]), green: channel(match[2]), blue: channel(match[3]),
      alpha: Number.parseFloat(alpha) / (alpha.endsWith("%") ? 100 : 1),
    };
  }
  if (value === "transparent") return { red: 0, green: 0, blue: 0, alpha: 0 };
  // Canvas converts modern CSS colors (including oklch and display-p3) to sRGB.
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  return { red, green, blue, alpha: alpha / 255 };
}

function composite(foreground: Color, background: Color): Color {
  const alpha = foreground.alpha;
  return {
    red: foreground.red * alpha + background.red * (1 - alpha),
    green: foreground.green * alpha + background.green * (1 - alpha),
    blue: foreground.blue * alpha + background.blue * (1 - alpha),
    alpha: 1,
  };
}

function luminance(color: Color): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}

function contrast(text: Color, background: Color): number {
  const a = luminance(composite(text, background));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function adaptiveHighlightPalette(element: Element): HighlightPalette {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  const scheme = view.getComputedStyle(document.documentElement).colorScheme.split(/\s+/);
  const prefersDark = view.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const darkCanvas = scheme.includes("dark") && (!scheme.includes("light") || prefersDark);
  let background: Color = darkCanvas
    ? { red: 18, green: 18, blue: 18, alpha: 1 }
    : { red: 255, green: 255, blue: 255, alpha: 1 };
  const layers: Color[] = [];
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const color = parseColor(view.getComputedStyle(ancestor).backgroundColor, document);
    if (color && color.alpha > 0) layers.push(color);
    if (color?.alpha === 1) break;
  }
  for (const layer of layers.reverse()) background = composite(layer, background);

  const dark = luminance(background) < 0.35;
  const tint: Color = dark
    ? { red: 167, green: 139, blue: 250, alpha: 1 }
    : { red: 59, green: 130, blue: 246, alpha: 1 };
  const text = parseColor(view.getComputedStyle(element).color, document);
  const minimumContrast = text ? Math.min(4.5, contrast(text, background)) : 0;
  const shade = (opacity: number): string => {
    // Keep the site's text color and reduce tint strength when contrast is marginal.
    while (text && opacity > 0 && contrast(text, composite({ ...tint, alpha: opacity }, background)) < minimumContrast) {
      opacity = Math.max(0, Number((opacity - 0.01).toFixed(2)));
    }
    return `rgba(${tint.red}, ${tint.green}, ${tint.blue}, ${opacity})`;
  };
  return { sentence: shade(dark ? 0.30 : 0.28), passage: shade(dark ? 0.14 : 0.12) };
}
