# Screen Annotator

A free, Epic Pen–style desktop app for drawing on top of your screen while teaching online
(Zoom, Teams, Google Meet, OBS, PowerPoint, a browser...). Built with Electron, runs on
Windows, macOS and Linux.

A transparent, always-on-top overlay covers the screen. A small floating toolbar switches
between **mouse mode** (clicks go through to your apps, annotations stay visible) and
**draw mode** (the overlay captures the mouse/pen).

## Features

- **Pen** with smoothed strokes, **highlighter** (semi-transparent)
- **Eraser** (removes whole strokes; also works with the eraser end of a pen-tablet stylus)
- **Laser pointer** with a fading trail, which leaves nothing behind
- **Line, arrow, rectangle, ellipse** (hold **Shift** for 45° lines, squares and circles)
- **Text** (click to place, Enter to finish, Shift+Enter for a new line)
- 8 preset colors and a custom color picker, 4 preset sizes (fine-tune with `[` / `]`)
- **Undo / redo / clear** (clear can be undone)
- **Whiteboard / blackboard / chalkboard** that keep their own drawings, separate from the
  annotations over your screen
- **Hide/show** annotations without losing them
- **Screenshot** of the screen plus annotations, saved to `Pictures/Screen Annotator`
- Global hotkeys that work while another app is focused
- Collapsible, draggable toolbar

## Run it

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
cd screen-annotator
npm install
npm start
```

Build an installer (`.exe` / `.dmg` / `.AppImage` in `dist/`):

```bash
npm run dist
```

Run the unit tests:

```bash
npm test
```

## Shortcuts

### Global (work from any app)

| Shortcut               | Action                            |
| ---------------------- | --------------------------------- |
| `Ctrl+Alt+D`           | Toggle draw mode / mouse mode     |
| `Ctrl+Alt+Z`           | Undo                              |
| `Ctrl+Alt+C`           | Clear                             |
| `Ctrl+Alt+H`           | Hide / show annotations           |
| `Ctrl+Alt+T`           | Hide / show toolbar               |
| `Ctrl+Alt+S`           | Save screenshot                   |
| `Ctrl+Alt+Q`           | Quit                              |

On macOS `Ctrl` is `Cmd`. Change them in `SHORTCUTS` at the top of `main.js`.

### In draw mode

| Key                         | Action                                  |
| --------------------------- | --------------------------------------- |
| `P` `H` `E` `K`             | Pen, highlighter, eraser, laser         |
| `L` `A` `R` `O` `T`         | Line, arrow, rectangle, ellipse, text   |
| `1`–`8`                     | Pick a palette color                    |
| `[` / `]`                   | Smaller / bigger                        |
| `B`                         | Cycle screen → whiteboard → blackboard → chalkboard |
| `Ctrl+Z` / `Ctrl+Y`         | Undo / redo (`Ctrl+Shift+Z` also redoes) |
| `Delete`                    | Clear                                   |
| `Esc`                       | Back to mouse mode                      |

## Tips for online teaching

- **Zoom / Teams / Meet:** share your *entire screen* (not a single window) so viewers see
  the overlay.
- **OBS:** use a *Display Capture* source.
- Use the **laser pointer** to point at things without leaving marks behind, and the
  **whiteboard** (`B`) for quick explanations away from your slides.

## Platform notes

- **macOS:** grant *Screen Recording* permission (System Settings → Privacy & Security) for
  screenshots to work.
- **Linux:** transparency needs a compositing window manager (GNOME, KDE and most modern
  desktops have one). On Wayland, screenshots go through the desktop's screen-share portal.
- The overlay covers the **primary display**.

## How it works

```
main.js            Electron main process: creates the windows, owns the shared state,
                   global shortcuts, click-through switching, screenshots
preload.js         The only bridge between pages and the main process (contextIsolation)
src/overlay.*      Full-screen transparent canvas: drawing tools, eraser, laser, history
src/toolbar.*      Floating toolbar UI
src/geometry.js    Hit-testing and Shift-constrain helpers (unit tested)
src/shared.js      Palette, sizes, boards and tool keys shared by both pages
```

Mouse mode uses `BrowserWindow.setIgnoreMouseEvents(true)`, so clicks pass through the
overlay to the apps underneath while the drawings stay on screen.

## Ideas for next steps

- Pressure-sensitive strokes for pen tablets
- Overlay on every monitor, not just the primary one
- Spotlight and zoom tools
- Save and load annotation pages
