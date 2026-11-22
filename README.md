# New Tab Container Picker

A lightweight **Manifest V3** Firefox extension that opens a fast, searchable container picker popup whenever you open a new tab (`+`, `Cmd+T`, or `Ctrl+T`) while Firefox Container Tabs are enabled.

## Features

- **Automatic New Tab Interception**: Triggers when opening a new blank tab via `+`, `Cmd+T`, or `Ctrl+T` — without interfering with middle-clicked links, Private Browsing windows, session restore, or long-pressing `+` to pick a container directly.
- **Instant Keyboard Search**: Opens centered with the search input immediately focused. Supports exact, prefix, substring, and fuzzy subsequence matching.
- **Full Keyboard & Mouse Navigation**: Use `ArrowUp` / `ArrowDown` (or `Ctrl+P` / `Ctrl+N`) to move through containers, `Enter` or click to open Firefox's native New Tab page in the chosen container.
- **Native Firefox Container Styling**: Lists **Default** first with a transparent background, followed by all configured Firefox containers tinted with their exact Firefox container colors and icons. Automatically adapts to light and dark modes.
- **Consistent Dismiss Behavior**:
  - Pressing `Escape`, clicking outside into Firefox, or clicking another tab dismisses the popup and keeps the new tab open as **Default**.
  - Switching to another app via `Cmd+Tab` / `Alt+Tab` preserves the popup until you switch back.
- **Toolbar Toggle**: Click the extension's toolbar icon to pause/resume interception at any time (displays an `OFF` badge when paused).
- **Extension Settings**: Open Preferences in Firefox via `about:addons` or the gear button in the picker footer to toggle new-tab interception or enable **Auto-open on single search match** (automatically opens the matching container tab without pressing `Enter` as soon as the search filter narrows down to one result).
- **Graceful Fallback**: If Firefox Container Tabs are disabled or no containers are configured, new tabs open normally with zero interruption.

## Development & Testing

### Install dev tools (`web-ext`)

```sh
npm install
```

### Run automated tests

```sh
npm test
```

### Lint & package the extension

```sh
npm run lint
npm run build
```

The packaged `.zip` archive is written to `web-ext-artifacts/`.

### Run in Firefox

```sh
npm start
```

Or load `manifest.json` manually in Firefox via `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**.
