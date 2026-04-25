# subagent-statusline

> Pi extension for monitoring sub-agent status with semantic theming and flicker-free rendering.

## Overview

Monitors sub-agents spawned via tmux-live or pi's built-in subagent tool and shows their status in the pi footer. Features three rendering modes: compact statusline widget, full table overlay (`/agents` command), and minimal footer.

## Features

- **Flicker-free design** — `setWidget()` only fires on structural changes, never on timers
- **Semantic theming** — Uses pi's `ctx.ui.theme` API for consistent colors
- **Progressive disclosure** — Compact widget by default, full table on demand
- **Token tracking** — Displays input/output tokens and cost per agent
- **Stale cleanup** — Auto-resolves orphaned agents after 3 minutes

## Installation

Copy into your pi extensions directory or install as a dependency.

## Usage

The extension activates automatically. Use the `/agents` command to see the full status table.

## Architecture

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry: event handlers, lifecycle, `/agents` command |
| `render.ts` | Pure rendering: statusline widget, full table overlay, footer |
| `state.ts` | State types and mutation helpers (no side effects) |

## License

MIT
