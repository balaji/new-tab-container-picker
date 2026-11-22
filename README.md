# New Tab Container Picker

A lightweight **Manifest V3** Firefox extension that opens a fast, keyboard-searchable popup to choose a container whenever you open a new tab (`+`, `Cmd+T`, or `Ctrl+T`).

## Highlights

- **Instant Keyboard Search & Navigation**: Opens focused on the search bar with exact, prefix, substring, and fuzzy matching. Navigate with `ArrowUp`/`ArrowDown` (or `Ctrl+P`/`Ctrl+N`) and select with `Enter` or click.
- **Native Firefox Styling**: Lists **Default** first, followed by configured containers using their Firefox container colors and icons, adapting automatically to light and dark modes.
- **Smart Interception & Dismiss**: Dismisses cleanly to **Default** on `Escape` or clicking back into Firefox, preserves the popup across app switches (`Cmd+Tab`/`Alt+Tab`), and ignores middle-clicked links, Private Browsing, and session restore.
- **Pause & Preferences**: Click the toolbar icon to pause/resume interception (`OFF` badge), or open Preferences via `about:addons` or the picker footer's gear button to configure options including **Auto-open on single search match**.
- **Graceful Fallback**: New tabs open normally without interruption if Firefox Container Tabs are disabled or no containers exist.

## Prerequisites

- **Firefox 142+** with Container Tabs enabled (**Settings → General → Tabs → Enable Container Tabs**, or Firefox Multi-Account Containers).
- **Node.js** (for running via `web-ext`, tests, and linting).

## How to Run

### With `web-ext` (temporary Firefox profile)

```sh
npm install
npm start
```

### Manually in Firefox

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json`.

## Development

- `npm test` — Run unit and integration tests (`node --test`).
- `npm run lint` — Lint the extension with `web-ext`.
- `npm run build` — Build a packaged `.zip` into `web-ext-artifacts/`.
