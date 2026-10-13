# Screen Annotator Pro

A professional, Epic Pen–style desktop app for drawing, highlighting and presenting on top
of any app while teaching online (Zoom, Teams, Google Meet, OBS, PowerPoint, a browser...).
Built with Electron and runs on Windows, macOS and Linux.

A transparent, always-on-top overlay covers your screens. A floating toolbar switches
between **mouse mode** (clicks go through to your apps, annotations stay visible) and
**draw mode** (the overlay captures the mouse or pen).

## Features

### Ink & shapes
- **Pen** with smooth strokes and **pressure sensitivity** for pen tablets (Wacom, Surface, iPad sidecar…)
- **Highlighter** (semi-transparent, no dark overlaps)
- **Line, arrow, rectangle, ellipse**: hold **Shift** for 45° lines, squares and circles
- **Fill shapes** (translucent fill) and **dashed lines** toggles
- **Text** boxes (Enter to finish, Shift+Enter for a new line)
- **Numbered step badges** (1, 2, 3…) to walk students through a procedure
- **Fading ink**: strokes disappear after a few seconds, so you can explain without cleaning up
- **Paste** images or text from the clipboard (`Ctrl+V`)

### Editing
- **Select tool**: click or drag a box to select, drag to move, `Shift` to add, arrow keys to
  nudge, `Ctrl+D` to duplicate, `Del` to delete, pick a color to recolor
- **Eraser** for whole shapes, including the eraser end of a pen-tablet stylus
- **Undo / redo** (200 steps, including clear)

### Presenting
- **Laser pointer** with a fading trail
- **Spotlight**: dims everything except a circle around the cursor (scroll to resize)
- **Magnifier**: a zoom lens over the screen (scroll to change zoom, click to refresh)
- **Cursor highlight**: a colored halo that follows the mouse, even in mouse mode
- **Whiteboard / blackboard / chalkboard** with **plain, grid, lined or dot** patterns
- **Multiple board pages**: Page Up / Page Down, or the page bar on the toolbar
- **Multi-monitor**: draw on every display, with separate drawings per screen
- **Hide / show** annotations without losing them

### Save & share
- **Screenshot** of the screen plus annotations, saved or **copied to the clipboard**
- **Export annotations** as transparent PNG (or with the board background)
- **Save / open sessions** (`.annotations.json`) to keep a lesson's drawings and board pages

### App
- **Settings window**: custom global shortcuts (with conflict detection), your own 8-color
  palette, start at sign-in, toolbar opacity, laser / fading-ink / spotlight / magnifier
  settings, output folder
- Remembers your last tool, color and options
- **Tray icon** with the full menu, and a collapsible, draggable toolbar
- Installers for Windows (NSIS), macOS (DMG) and Linux (AppImage, deb)

## Run it

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
cd screen-annotator
npm install
npm start
```

Build an installer (output in `dist/`):

```bash
npm run dist
```

Run the unit tests:

```bash
npm test
```

## Shortcuts

### Global (work from any app; change them in Settings)

| Shortcut     | Action                        |
| ------------ | ----------------------------- |
| `Ctrl+Alt+D` | Toggle draw mode / mouse mode |
| `Ctrl+Alt+Z` | Undo                          |
| `Ctrl+Alt+C` | Clear                         |
| `Ctrl+Alt+H` | Hide / show annotations       |
| `Ctrl+Alt+T` | Hide / show toolbar           |
| `Ctrl+Alt+W` | Whiteboard on / off           |
| `Ctrl+Alt+G` | Spotlight on / off            |
| `Ctrl+Alt+M` | Magnifier on / off            |
| `Ctrl+Alt+S` | Save screenshot               |
| `Ctrl+Alt+Q` | Quit                          |

On macOS `Ctrl` is `Cmd`.

### In draw mode

| Key                         | Action                                               |
| --------------------------- | ---------------------------------------------------- |
| `V` `P` `H` `E`             | Select, pen, highlighter, eraser                     |
| `K` `G` `Z`                 | Laser, spotlight, magnifier                          |
| `L` `A` `R` `O` `T` `N`     | Line, arrow, rectangle, ellipse, text, number badge  |
| `F` `D` `I` `C`             | Toggle fill, dashed, fading ink, cursor highlight    |
| `1`–`8`                     | Palette colors                                       |
| `[` / `]` or mouse wheel    | Smaller / bigger                                     |
| `B`                         | Cycle screen → whiteboard → blackboard → chalkboard  |
| `Page Up` / `Page Down`     | Previous / next (or new) board page                  |
| `Ctrl+Z` / `Ctrl+Y`         | Undo / redo                                          |
| `Ctrl+V` / `Ctrl+D` / `Ctrl+A` | Paste / duplicate selection / select all          |
| `Delete`                    | Delete selection (or clear everything)               |
| `Esc`                       | Deselect, then back to mouse mode                    |

The **⋯** button on the toolbar (or the tray icon) has everything else: board and
pattern, pages, toggles, screenshot to clipboard, PNG export, sessions, settings.

## Tips for online teaching

- **Zoom / Teams / Meet:** share your *entire screen* (not a single window) so viewers see
  the overlay.
- **OBS:** use a *Display Capture* source.
- Turn on **Cursor highlight** so students can follow your mouse.
- Use the **spotlight** and **magnifier** to focus attention on small details, and **fading
  ink** for quick explanations that clean themselves up.
- Use **board pages** like slides for worked examples, then **Save Session** to reuse them
  next lesson.

## Platform notes

- **macOS:** grant *Screen Recording* permission (System Settings → Privacy & Security) for
  screenshots and the magnifier.
- **Linux:** transparency needs a compositing window manager (GNOME, KDE and most modern
  desktops have one). On Wayland, screen capture goes through the desktop's portal.
- Settings are stored in the app's user-data folder (`settings.json`).

## How it works

```
main.js            Main process: windows (one overlay per display + toolbar + settings),
                   shared state, global shortcuts, tray & menus, capture, export, sessions
preload.js         The only bridge between pages and the main process (contextIsolation)
lib/settings.js    Settings defaults, validation and persistence (unit tested)
src/overlay.*      Transparent drawing surface: tools, selection, history, pages, effects
src/render.js      Canvas drawing of shapes and board patterns
src/geometry.js    Hit-testing, bounds, moving, session validation (unit tested)
src/toolbar.*      Floating toolbar
src/settings.*     Settings window
src/icons.js       Toolbar icons
build/             App icon used by the installers
```

Mouse mode uses `BrowserWindow.setIgnoreMouseEvents(true)`, so clicks pass through the
overlays to the apps underneath while the drawings stay on screen. Every renderer runs
sandboxed with context isolation, and session files are validated shape by shape before
they are loaded.
