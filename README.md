# Plot

Plot is an Obsidian plugin for creating interactive 2D graphs and 3D surfaces directly in your notes.

## Features

- Plot equations as 2D curves or 3D surfaces.
- Choose wireframe, solid-surface, or point-cloud rendering.
- Add points, vectors, and adjustable variables.
- Change the camera, axes, grid, resolution, and intersection display.
- Edit a graph through the visual controls or directly in its JSON code block.
- Evaluate expressions with a restricted mathematical parser.

## Install

Download `main.js`, `manifest.json`, and `styles.css` from a release and place them in your vault at:

```text
<Vault>/.obsidian/plugins/plot/
```

Restart Obsidian if needed, then enable **Plot** under **Settings > Community plugins**. The release may also include `prompt.md`; it is not required to load the plugin.

## Use

Run **Create new graph (Modal UI)** from the Command palette, or add a `math-plot` code block to a note. For example:

````markdown
```math-plot
{
  "type": "3d",
  "renderStyle": "wireframe",
  "resolution": 50,
  "axisMode": "ticks",
  "items": [
    {
      "type": "var",
      "name": "x0",
      "value": 1.5,
      "min": -3,
      "max": 3,
      "step": 0.1
    },
    {
      "type": "fn",
      "fn": "4 - 0.25 * x^2 - 0.25 * y^2",
      "color": "#e91e63",
      "opacity": 0.7,
      "label": "Paraboloid"
    },
    {
      "type": "point",
      "coords": "x0, 0, 4 - 0.25 * x0^2",
      "color": "#ff9800",
      "label": "P"
    }
  ]
}
```
````

Use `"type": "2d"` for a 2D graph. In 3D, `bounds` is `[xMin, xMax, yMin, yMax]`; in 2D, it is `[xMin, xMax]`. Point coordinates and vector origins/directions are comma-separated expressions and can use declared variables.

Supported expressions include arithmetic, powers, implicit multiplication, constants `pi` and `e`, and functions such as `sin`, `cos`, `tan`, `sqrt`, `abs`, `exp`, and `log`. LaTeX forms such as `\\sqrt{x^2 + y^2}`, `\\frac{1}{2}`, and `\\sin(x)` are also supported.

## Development

Requires Node.js 18 or later.

```sh
npm install
npm run dev
```

The development build watches for changes. To create a production build in `dist/`, run:

```sh
npm run build
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).