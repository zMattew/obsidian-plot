# Plot

Plot is an Obsidian plugin for creating interactive 2D graphs and 3D surfaces directly in your notes.

## Features

- Plot equations as 2D curves or 3D surfaces.
- Render 3D scenes with WebGL; generate meshes in a background worker, with Canvas2D fallback.
- Choose wireframe, solid-surface, or point-cloud rendering.
- Add points, vectors, and adjustable variables.
- Visualize 2D/3D vector fields with normalized arrows and adjustable sampling density.
- Define 3D piecewise surfaces with one equation and condition per branch.
- Group equations into systems and choose which equations, intersections, and approximate solutions to show.
- Configure keyboard zoom, panning, reset, and movement steps in plugin settings.
- Render inline LaTeX in labels with `$...$` delimiters.
- Change the camera, axes, grid, resolution, and intersection display.
- Edit a graph through the visual controls or directly in its JSON code block.
- Evaluate expressions with a restricted mathematical parser.

## Install

Download `main.js`, `plot-worker.js`, `manifest.json`, and `styles.css` from a release and place them in your vault at:

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

### Vector fields

Use `vectorField` with two components in 2D or three in 3D. Arrows are normalized so direction remains readable; `density` controls the sample count per axis (3–16, default 6).

```json
{
  "type": "2d",
  "items": [
    { "type": "vectorField", "components": "-y, x", "density": 8, "color": "#00e676", "label": "$\\vec F$" }
  ]
}
```

### Piecewise surfaces

In 3D, each `piecewise` branch contains an explicit equation such as `x + y` (interpreted as `z = x + y`) or an implicit equation such as `x^2 + y^2 + z^2 = 1`, plus a boolean `condition` over `x`, `y`, and `z`. Comparisons (`<`, `<=`, `>`, `>=`, `=`, `!=`) and `and`/`or` are supported; common LaTeX commands include `\\leq`, `\\geq`, `\\land`, and `\\lor`. The editor can switch between branch rows and a `\\begin{cases}...\\end{cases}` representation.

```json
{
  "type": "3d",
  "items": [
    {
      "type": "piecewise",
      "branches": [
        { "equation": "x + y", "condition": "z >= 0" },
        { "equation": "x - y", "condition": "z < 0" }
      ]
    }
  ]
}
```

### Systems

Use a `system` item to group equations. Each equation has its own visibility checkbox; intersections and solution markers are independently switchable. In 2D, equations are explicit curves (`y = f(x)`). In 3D, use explicit surfaces (`z = f(x,y)`) or implicit surfaces (`F(x,y,z) = 0`). The editor also supports a `\\begin{aligned}...\\end{aligned}` LaTeX representation.

Intersection and solution calculations are numerical and bounds-limited. The 2D solver samples explicit curves; the 3D solution marker solver uses multistart Newton iteration and requires at least three equations. These methods may miss tangencies or roots, and do not guarantee uniqueness or completeness. 3D intersection curves are currently calculated for explicit surfaces; implicit surfaces can still be visualized and used for isolated solution markers.

Keyboard navigation defaults to `=`/`-` for zoom, arrow keys for panning, and `0` to reset. Bindings and zoom/pan steps are configurable under **Settings > Plot**; shortcuts act only while the plot is focused or under the pointer.

Supported expressions include arithmetic, powers, implicit multiplication, and constants `pi` and `e`. Function calls use LaTeX commands such as `\\sqrt{x}`, `\\sin(x)`, and `\\max{(a,b)}`; absolute values use `|x|`. Raw calls such as `max(x, y)` and `abs(x)` are not accepted.

Implicit 3D surfaces use an `implicit` item with an equation `F(x,y,z)=0`. Existing `fn` items containing a `z`-dependent equality are detected automatically too. Their sampling volume expands automatically when the zero surface crosses one of its faces, so explicit bounds are normally unnecessary. Six-value 3D bounds can still set the starting x, y, and z intervals:

```json
{
  "type": "3d",
  "renderStyle": "solid",
  "bounds": [-2, 2, -2, 2, -2, 2],
  "items": [
    {
      "type": "implicit",
      "equation": "x^2 + y^2 + z^2 + x + y + z = 0",
      "color": "#f59e0b"
    }
  ]
}
```

## Development

Requires Node.js 20.19 or later for the development and lint toolchain.

```sh
npm install
npm run dev
```

The development build watches for changes. To create a production build in `dist/`, run:

```sh
npm run build
```

To build the plugin and run the mesh-worker tests, run:

```sh
npm run test:worker
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).