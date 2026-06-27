# Pace Themes — the `.pacetheme` format

A **theme** restyles Pace itself (its chrome: toolbar, tabs, menus, sidebar). It is a
separate format from `.paceaddon` — addons run on web pages, themes restyle the browser.

A `.pacetheme` file is a single JSON document.

## Schema (format version 1)

```jsonc
{
  "pacetheme": 1,                 // required, must be 1
  "id": "obsidian-gold",          // required, unique slug  [a-z0-9-_.]
  "name": "Obsidian Gold",        // required, display name
  "version": "1.0.0",
  "author": "Your Name",
  "description": "Black glass, warm gold.",
  "mode": "dark",                 // "dark" | "light" — the base the palette targets
  "design": {                     // every key optional; omit a key to keep the mode default
    "accent":    "#d8b46a",       // primary accent (hex) — also derives soft/glow tints
    "accent2":   "#f0d488",       // secondary accent (hex)
    "bg0":       "#09090b",       // window backdrop, dark end
    "bg1":       "#131214",       // window backdrop, light end
    "glass":     "rgba(24,22,20,.60)",    // panel surface
    "glass2":    "rgba(34,31,27,.66)",    // raised panel surface
    "glassHi":   "rgba(255,255,255,.06)", // top edge highlight
    "glassLine": "rgba(216,180,106,.12)", // hairline borders
    "hover":     "rgba(255,255,255,.05)", // hover wash
    "active":    "rgba(216,180,106,.14)", // pressed/active wash
    "text1":     "#f4efe4",       // primary text
    "text2":     "#b6ac96",       // secondary text
    "text3":     "#6f6857",       // tertiary text
    "glassBlur": "30px",          // backdrop blur radius
    "glassSat":  "160%",          // backdrop saturation
    "radius":    "14px",          // medium corner radius
    "radiusLg":  "18px",          // large corner radius
    "font":      "'Segoe UI', system-ui, sans-serif"
  }
}
```

## Notes

- **accent / accent2** should be hex (`#rrggbb`). Pace derives the soft and glow tints from `accent`.
- The other color tokens accept any CSS color; `rgba(...)` is recommended for the glass surfaces.
- Unspecified tokens fall back to the defaults for the chosen `mode`.

## Installing

In Pace, open **pace://themes** → **Install theme**, and choose your `.pacetheme` file.
Built-in themes are always present and cannot be removed.

## Making your own

Start from one of the files in this folder (e.g. `obsidian-gold.pacetheme`), give it a new
`id` and `name`, edit the `design` values, and install it. To share it, publish it to the Shop.

This folder ships four themes you can install or upload: Obsidian Gold, Rosé Noir, Emerald,
and Midnight Mono.
