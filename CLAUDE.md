# subagent-statusline

Pi package for monitoring sub-agent status with flicker-free rendering.

## Stack

- TypeScript (ESM)
- `@mariozechner/pi-coding-agent` (ExtensionAPI)
- `@mariozechner/pi-tui` (Container, Text)

## Structure

```
extensions/
  index.ts   — Extension entry: event handlers, lifecycle, /agents command
  render.ts  — Pure rendering: statusline widget, full table overlay, footer
  state.ts   — State types and mutation helpers (no side effects)
  test/      — Test files
  scripts/   — smoke-flicker.sh
```

## Installation

```bash
pi install -l git:github.com/fegome90-cmd/subagent-statusline@v0.1.0
# Or for development:
pi -e ./extensions/index.ts
```

## Testing

```bash
node --test extensions/test/*.ts
```

## Design Principles

- Flicker-free: `setWidget()` only on structural changes, never on timers
- Spinner animation via cheap `setStatus()` in footer
- Stable hash prevents redundant re-renders
- Pi package: installed via `pi install`, not manual copy
