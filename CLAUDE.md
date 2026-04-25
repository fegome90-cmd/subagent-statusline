# subagent-statusline

Pi extension for monitoring sub-agent status in tmux_fork orchestration.

## Stack

- TypeScript (ESM)
- `@mariozechner/pi-coding-agent` (ExtensionAPI)
- `@mariozechner/pi-tui` (Container, Text)

## Architecture

- `index.ts` — Extension entry: event handlers, lifecycle, `/agents` command
- `render.ts` — Pure rendering: statusline widget, full table overlay, footer
- `state.ts` — State types and mutation helpers (no side effects)

## Testing

```bash
node --test test/*.ts
```

## Design Principles

- Flicker-free: `setWidget()` only on structural changes, never on timers
- Spinner animation via cheap `setStatus()` in footer
- Stable hash prevents redundant re-renders
