/**
 * Sub-agent statusline rendering with semantic theming.
 *
 * Uses pi's ctx.ui.theme API for consistent, themed output.
 * Design influences: design-principles, typeui-minimal, typeui-clean,
 * typeui-neon, typeui-shadcn, typeui-bold, typeui-sleek.
 */

import type { ChildAgent, SubagentState } from "./state.js";
import {
	childDisplayName,
	formatElapsed,
	formatTokens,
	getCounts,
} from "./state.js";

/** pi's ctx.ui.theme API surface. */
export interface ThemeAPI {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
	bold(text: string): string;
}

// ── Icons: typeui-neon (spinner) + typeui-bold (emphasis) ──
// P0-2: Animated braille spinner for running agents
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DONE_ICON = "\u2713"; // ✓
const ERROR_ICON = "\u2717"; // ✗

const STATUS_ORDER: ChildAgent["status"][] = ["running", "error", "done"];

// ── Spinner state (advanced by tick) ──
let spinnerIdx = 0;

export function advanceSpinner(): void {
	spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
}

export function resetSpinner(): void {
	spinnerIdx = 0;
}

export function resetModelCache(): void {
	modelCache.clear();
}

function statusIcon(status: ChildAgent["status"], theme: ThemeAPI): string {
	if (status === "running") {
		// Static dot for detail rows — spinner only in aggregate
		return theme.fg("accent", "●");
	}
	if (status === "error") {
		return theme.fg("error", ERROR_ICON);
	}
	return theme.fg("success", DONE_ICON);
}

// ── Column alignment constants (P0-3 typeui-clean) ──

// ── Model shortening ──

// P3-2: Cache shortened model names
const modelCache = new Map<string, string>();

export function shortenModel(raw: string): string {
	let model = raw;
	if (model.length > 200) model = model.slice(0, 200); // SEC2: limit pathological input
	const cached = modelCache.get(model);
	if (cached) return cached;

	const noProvider = model.split("/").pop() ?? model;
	const noDate = noProvider.replace(/-\d{8,}$/, "");
	const trimmed = noDate.replace(/^(deepseek-|claude-|gpt-|gemini-)/, "");
	const result = trimmed || noDate || model;
	modelCache.set(model, result);
	return result;
}

// ── Meta line: P1-2 (shadcn ·) + P2-2 (sleek compact) ──

function buildMetaLine(child: ChildAgent, theme: ThemeAPI): string {
	const parts: string[] = [];

	if (child.usage) {
		const u = child.usage;
		if (u.input || u.output) {
			const tokens: string[] = [];
			// P1-2 shadcn: · separator between values
			if (u.input) tokens.push(`↑${formatTokens(u.input)}`);
			if (u.output) tokens.push(`↓${formatTokens(u.output)}`);
			parts.push(theme.fg("dim", tokens.join(theme.fg("dim", "·"))));
		}
		if (u.cost) parts.push(theme.fg("dim", `$${u.cost.toFixed(4)}`));
	}

	if (child.model) {
		// P2-2 sleek: model at end with dim color
		parts.push(theme.fg("dim", shortenModel(child.model)));
	}

	return parts.join(" ");
}

// ── Sort ──

export function sortChildren(state: SubagentState): ChildAgent[] {
	const all = [...state.children.values()];
	return all.sort((a, b) => {
		const ia = STATUS_ORDER.indexOf(a.status);
		const ib = STATUS_ORDER.indexOf(b.status);
		if (ia !== ib) return ia - ib;
		return b.startedAt - a.startedAt;
	});
}

// ── Pad + truncate helpers: P0-3 typeui-clean ──

/** Visible length after stripping ANSI */
function visibleLen(str: string): number {
	return str
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\]8;;[^\x07]*\x07/g, "").length;
}

/** Truncate string to max visible width, preserving ANSI codes */
function truncateAnsi(str: string, maxVisible: number): string {
	let visLen = 0;
	let i = 0;
	while (i < str.length) {
		if (str[i] === "\x1b") {
			// Handle OSC sequences (\x1b]...\x07)
			if (i + 1 < str.length && str[i + 1] === "]") {
				const j = str.indexOf("\x07", i);
				if (j !== -1) {
					i = j + 1;
					continue;
				}
			}
			// Handle CSI sequences (\x1b[...m)
			const j = str.indexOf("m", i);
			if (j !== -1) {
				i = j + 1;
				continue;
			}
		}
		visLen++;
		if (visLen > maxVisible) return str.slice(0, i);
		i++;
	}
	return str;
}

function padRight(str: string, len: number): string {
	const vis = visibleLen(str);
	if (vis > len) return truncateAnsi(str, len); // truncate oversize
	const pad = Math.max(0, len - vis);
	return str + " ".repeat(pad);
}

// ── Widget render ──

export function renderStatusLine(
	state: SubagentState,
	theme: ThemeAPI,
	nowMs?: number,
): string[] {
	const counts = getCounts(state);
	const total = counts.running + counts.done + counts.error;
	if (total === 0) return [];

	const ms = nowMs ?? Date.now();
	const children = sortChildren(state);
	const lines: string[] = [];

	// Visual separation from pi's own UI
	lines.push("");

	// Title bar — identifies the widget
	lines.push(theme.fg("accent", theme.bold("[ agents ]")));

	// P0-1 design-principles: aggregate bar with · separator
	const parts: string[] = [];
	if (counts.running > 0) {
		const icon = theme.fg("accent", theme.bold(SPINNER_FRAMES[spinnerIdx]));
		parts.push(`${icon} ${counts.running} running`);
	}
	if (counts.done > 0) {
		parts.push(theme.fg("success", `${DONE_ICON}${counts.done} done`));
	}
	if (counts.error > 0) {
		parts.push(theme.fg("error", `${ERROR_ICON}${counts.error} error`));
	}
	lines.push(parts.join(theme.fg("dim", " · ")));

	// P1-3 typeui-minimal: conditional aggregate tokens (only if >1 agent with usage)
	const agentsWithUsage = children.filter((c) => c.usage).length;
	if (agentsWithUsage > 1) {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCost = 0;
		for (const c of children) {
			if (c.usage) {
				totalInput += c.usage.input;
				totalOutput += c.usage.output;
				totalCost += c.usage.cost;
			}
		}
		if (totalInput || totalOutput || totalCost) {
			const aggParts: string[] = [];
			if (totalInput) aggParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) aggParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCost) aggParts.push(`$${totalCost.toFixed(4)}`);
			lines.push(theme.fg("dim", `  ${aggParts.join(" · ")}`));
		}
	}

	// P0-1 design-principles: subtle separator before detail rows
	lines.push(theme.fg("dim", "  ─────────────────────"));

	// Detail rows (max 6)
	const maxRows = Math.min(children.length, 6);
	for (let i = 0; i < maxRows; i++) {
		const child = children[i];
		const icon = statusIcon(child.status, theme);
		const name = childDisplayName(child);
		const meta = buildMetaLine(child, theme);

		let row = `  ${icon} ${theme.fg("text", name)}`;
		if (meta) {
			row += ` ${theme.fg("dim", "│")} ${meta}`;
		}
		lines.push(row);
	}

	if (children.length > 6) {
		lines.push(theme.fg("dim", `  +${children.length - 6} more`));
	}

	return lines;
}

// ── Overlay render: P1-1 progressive-disclosure full table ──

export function renderFullTable(
	state: SubagentState,
	theme: ThemeAPI,
	nowMs?: number,
	width: number = 80,
): string[] {
	const ms = nowMs ?? Date.now();
	const children = sortChildren(state);
	if (children.length === 0) return [theme.fg("dim", "No agents tracked.")];

	const lines: string[] = [];

	// Header
	lines.push(theme.fg("accent", theme.bold("  Subagent Status")));
	lines.push(
		theme.fg(
			"dim",
			`  ${children.length} agents · ${new Date().toLocaleTimeString()}`,
		),
	);
	lines.push("");

	// Column headers — widths must match detail rows
	const NAME_W = 24;
	const ELAPSED_W = 9;
	const TOKEN_W = 18;
	const headerLine = theme.fg(
			"dim",
			`  ${padRight("Stat", 4)}  ${padRight("Name", NAME_W)} ${padRight("Elapsed", ELAPSED_W)} ${padRight("Tokens", TOKEN_W)} Model`,
		);
		lines.push(truncateAnsi(headerLine, width));
		const sepLine = theme.fg(
			"dim",
			`  ${padRight("────", 4)}  ${padRight("─".repeat(NAME_W), NAME_W)} ${padRight("─".repeat(ELAPSED_W), ELAPSED_W)} ${padRight("─".repeat(TOKEN_W), TOKEN_W)} ${"─".repeat(10)}`,
		);
		lines.push(truncateAnsi(sepLine, width));

	for (const child of children) {
		const icon = statusIcon(child.status, theme);
		const name = childDisplayName(child);
		const elapsed = formatElapsed(child, ms);

		let tokenStr = "";
		if (child.usage) {
			const parts: string[] = [];
			if (child.usage.input) parts.push(`↑${formatTokens(child.usage.input)}`);
			if (child.usage.output)
				parts.push(`↓${formatTokens(child.usage.output)}`);
			if (child.usage.cost) parts.push(`$${child.usage.cost.toFixed(4)}`);
			tokenStr = parts.join(" · ");
		}
		const model = child.model ? shortenModel(child.model) : "";

		// Fixed-width columns with explicit spacing
		const row = `  ${icon}  ${padRight(theme.fg("text", name), NAME_W)} ${padRight(theme.fg("muted", elapsed), ELAPSED_W)} ${padRight(theme.fg("dim", tokenStr), TOKEN_W)} ${theme.fg("dim", model)}`;
		lines.push(truncateAnsi(row, width));
	}

	return lines;
}

// ── Footer ──

export function renderFooterStatus(
	state: SubagentState,
	theme: ThemeAPI,
): string {
	const counts = getCounts(state);
	const total = counts.running + counts.done + counts.error;
	if (total === 0) return "";

	const parts: string[] = [];
	if (counts.running > 0) {
		parts.push(theme.fg("accent", `${counts.running} running`));
	}
	if (counts.done > 0) {
		parts.push(theme.fg("success", `${counts.done} done`));
	}
	if (counts.error > 0) {
		parts.push(theme.fg("error", `${counts.error} error`));
	}

	const label = theme.fg("dim", "Agents ");
	return label + parts.join(theme.fg("dim", " · "));
}
