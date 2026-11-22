# New Tab Container Picker

A lightweight **Manifest V3** Firefox extension for opening new tabs in any Firefox Multi-Account Container via a fast, keyboard-searchable picker — on demand with a customizable keyboard shortcut or toolbar button, and optionally directly inside every new tab (`Cmd+T` / `Ctrl+T`).

## Highlights

- **Independent Activation Options (Coexist Seamlessly)**:
  - **Keyboard shortcut & Toolbar Button** *(Always active)*: Press `Ctrl+Shift+Y` (`Command+Shift+Y` on macOS) or click the toolbar icon to open the native Firefox toolbar popup, leaving `Cmd+T` / `Ctrl+T` and `Cmd+Shift+T` / `Ctrl+Shift+T` untouched. Customize, reset, or clear the shortcut right in Preferences (synced with Firefox's **Manage Extension Shortcuts**). Uses minimal install permissions (`cookies`, `contextualIdentities`, `storage`).
  - **Open picker on new tabs (`Cmd+T` / `Ctrl+T`)** *(Optional toggle, off by default)*: Opens the container picker directly inside new tabs (`+`, `Cmd+T`, `Ctrl+T`), requests optional `tabs` and `sessions` permissions on demand, and purges closed picker tabs from Recently Closed history so `Cmd+Shift+T` / `Ctrl+Shift+T` always reopens your last closed tab.
- **Instant Keyboard Search & Navigation**: Opens focused on the search bar with exact, prefix, substring, and fuzzy matching. Navigate with `ArrowUp`/`ArrowDown` (or `Ctrl+P`/`Ctrl+N`) and select with `Enter` or click.
- **Containers First**: Highlights your first configured container immediately on open and places **Default** (no container) at the bottom, using Firefox container colors and icons and adapting automatically to light and dark modes.
- **Auto-Open & Graceful Fallback**: Optional **Auto-open on single search match** preference, plus clear guidance when Container Tabs are disabled or in Private Windows.

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
