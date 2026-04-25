/**
 * Sub-agent Statusline — Pi Extension
 *
 * Monitors tmux_fork sub-agents and shows their status in the pi footer.
 *
 * FLICKER-FREE DESIGN:
 *   - setWidget() is ONLY called when the stable model changes:
 *     agent added/removed, status transition, model/usage arrival.
 *   - setWidget() is NEVER called by timers, ticks, or elapsed updates.
 *   - Spinner animation lives in the footer via setStatus(), which is cheap.
 *   - The tick interval only handles: stale cleanup + footer spinner update.
 *   - Hash contains ZERO volatile fields (no timeBucket, no elapsed, no spinnerIdx).
 *
 * Authority chain:
 *   PRIMARY:  tool_execution_start/end events (launch, response, kill-all)
 *   FALLBACK: output-file heuristic (gated by SUBAGENT_STATUSLINE_FALLBACK=1)
 *             stale timeout (STALE_MS, last resort for orphans)
 */

import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import {
	advanceSpinner,
	renderFooterStatus,
	renderFullTable,
	renderStatusLine,
	resetModelCache,
	resetSpinner,
} from "./render.js";
import {
	addChild,
	createState,
	getCounts,
	markChildDone,
	markChildError,
	type SubagentState,
	type TokenUsage,
} from "./state.js";
import { computeStableHash } from "./hash.js";

// ── Debug logging ─────────────────────────────────────────
const DEBUG = !!process.env.SUBAGENT_STATUSLINE_DEBUG;

function debugLog(input: Record<string, unknown>): void {
	if (!DEBUG) return;
	try {
		const dir = path.join(
			process.env.XDG_RUNTIME_DIR ?? "/tmp",
			"subagent-statusline",
		);
		fs.mkdirSync(dir, { recursive: true });
		const line = JSON.stringify({
			time: new Date().toISOString(),
			...input,
		});
		fs.appendFileSync(path.join(dir, "debug.log"), `${line}\n`, "utf8");
	} catch {
		// Debug logging must never crash the extension.
	}
}

// ── Constants ─────────────────────────────────────────────

const TICK_MS = 1000; // Tick interval for stale checks + footer spinner
const STALE_MS = 3 * 60 * 1000; // Stale timeout: 3 min for orphaned agents
const PRUNE_MS = 2 * 60 * 1000; // Prune done/error agents after 2 min

// ── Patterns ──────────────────────────────────────────────

const IDENT = /[a-zA-Z0-9_-]+/;
const LAUNCH_RE = new RegExp(
	`tmux-live\\s+launch\\s+(${IDENT.source})\\s+(${IDENT.source})`,
	"i",
);
const RESPONSE_RE = new RegExp(
	`tmux-live\\s+(?:response|wait)\\s+(${IDENT.source})`,
	"i",
);
const KILLALL_RE = /tmux-live\s+kill-all/i;
const STATUS_RE = /tmux-live\s+(?:progress|list)/i;

const VALID_ROLES = [
	"explorer",
	"architect",
	"implementer",
	"verifier",
	"analyst",
];

// ── Extension ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const state: SubagentState = createState();
	let tickInterval: ReturnType<typeof setInterval> | null = null;
	let lastStableHash = "";
	let idCounter = 0;
	let capturedCtx: ExtensionContext | null = null;
	const widgetId = "subagent-statusline";
	const statusId = "subagent-status";

	// ── Instrumentation: setWidget call counter ──
	let setWidgetCallCount = 0;

	// Track pending subagent tool calls by toolCallId → child IDs
	const pendingSubagentCalls = new Map<string, Array<string>>();

	// Track bash commands by toolCallId so tool_execution_end can look them up
	// (tool_execution_end provides event.result, not event.args)
	const bashCommandByCallId = new Map<string, string>();

		// ── Stable model hash (see hash.ts) ──────────────────────
	// Stateless, testable function extracted to hash.ts.

// ── Widget push (stable-change only) ─────────────────
	// This is the ONLY function that calls setWidget().
	// It compares stable hash and skips if unchanged.

	function pushWidgetIfChanged(ctx: ExtensionContext, reason: string): void {
		const hash = computeStableHash(state);
		if (hash === lastStableHash) return;

		const prevHash = lastStableHash;
		lastStableHash = hash;
		setWidgetCallCount++;

		// Only update footer when agents exist — don't overwrite idle footer
		const counts = getCounts(state);
		const total = counts.running + counts.done + counts.error;
		if (total > 0) {
			const footer = renderFooterStatus(state, ctx.ui.theme);
			ctx.ui.setStatus(statusId, footer || "");
		}

		const lines = renderStatusLine(state, ctx.ui.theme);
		if (lines.length > 0) {
			ctx.ui.setWidget(widgetId, lines);
		} else {
			ctx.ui.setWidget(widgetId, undefined);
		}

		debugLog({
			kind: "widget.push",
			reason,
			setWidgetCallCount,
			prevHash: prevHash.slice(0, 30),
			newHash: hash.slice(0, 30),
		});
	}

	// ── Footer update (volatile, cheap) ──────────────────
	// setStatus() is cheap — safe to call every tick for spinner.

	function pushFooter(ctx: ExtensionContext): void {
		const footer = renderFooterStatus(state, ctx.ui.theme);
		ctx.ui.setStatus(statusId, footer || "");
	}

	// ── Clear widget ─────────────────────────────────────

	function clearWidget(ctx: ExtensionContext): void {
		lastStableHash = "";
		ctx.ui.setStatus(statusId, undefined);
		ctx.ui.setWidget(widgetId, undefined);
	}

	// ── Subagent tool tracking (PRIMARY authority) ──────

	function handleSubagentStart(
		args: Record<string, unknown>,
		toolCallId: string | undefined,
	) {
		const agents: Array<{ name: string; role: string }> = [];

		if (args.agent && args.task) {
			agents.push({ name: args.agent as string, role: "subagent" });
		}

		const tasks = args.tasks as Array<{ agent: string }> | undefined;
		if (tasks) {
			for (const t of tasks) agents.push({ name: t.agent, role: "parallel" });
		}

		const chain = args.chain as Array<{ agent: string }> | undefined;
		if (chain) {
			for (let i = 0; i < chain.length; i++) {
				agents.push({ name: chain[i].agent, role: `chain-${i + 1}` });
			}
		}

		const childIds: string[] = [];
		for (const a of agents) {
			const id = `sub:${a.name}:${Date.now()}-${idCounter++}`;
			if (!state.children.has(id)) {
				addChild(state, id, a.name, a.role, toolCallId);
				childIds.push(id);
			}
		}

		if (toolCallId && childIds.length > 0) {
			pendingSubagentCalls.set(toolCallId, childIds);
		}

		if (childIds.length > 0) {
			debugLog({
				kind: "subagent.start",
				toolCallId,
				agents: agents.map((a) => a.name),
			});
			ensureTick();
		}
	}

	function handleSubagentEnd(
		isError: boolean,
		toolCallId: string | undefined,
		result?: unknown,
	) {
		// Extract model and usage from result.details.results[]
		const details = (result as Record<string, unknown> | undefined)?.details as
			| Record<string, unknown>
			| undefined;
		const results = details?.results as
			| Array<Record<string, unknown>>
			| undefined;

		if (toolCallId) {
			const childIds = pendingSubagentCalls.get(toolCallId);
			if (childIds) {
				for (let i = 0; i < childIds.length; i++) {
					const id = childIds[i];
					if (isError) markChildError(state, id);
					else markChildDone(state, id);

					const child = state.children.get(id);
					if (child && results && results[i]) {
						const r = results[i];
						if (r.model) child.model = r.model as string;
						if (r.usage) child.usage = r.usage as TokenUsage;
					}
				}
				pendingSubagentCalls.delete(toolCallId);
				debugLog({ kind: "subagent.end.correlated", toolCallId, isError });
				checkTickNeeded();
				return;
			}
		}

		debugLog({
			kind: "subagent.end.no-correlation",
			toolCallId,
			isError,
			warning:
				"No toolCallId or no matching pending call — skipping blanket close",
		});
	}

	// ── tmux-live command parsing (PRIMARY authority) ───────

	function handleLaunch(cmd: string) {
		const match = cmd.match(LAUNCH_RE);
		if (!match) return;
		const role = match[1];
		const name = match[2];
		const id = `tmux:${name}`;

		if (state.children.has(id)) return;
		if (!VALID_ROLES.includes(role.toLowerCase())) return;

		addChild(state, id, name, role);
		debugLog({ kind: "launch", role, name });
		ensureTick();
	}

	function handleResponse(cmd: string, isError: boolean) {
		const match = cmd.match(RESPONSE_RE);
		if (!match) return;
		const name = match[1];
		const id = `tmux:${name}`;

		const changed = isError
			? markChildError(state, id)
			: markChildDone(state, id);

		if (changed) {
			debugLog({ kind: "response", name, isError });
			checkTickNeeded();
		}
	}

	function handleKillAll() {
		let changed = false;
		for (const child of state.children.values()) {
			if (child.status === "running") {
				changed = markChildDone(state, child.id) || changed;
			}
		}
		pendingSubagentCalls.clear();
		bashCommandByCallId.clear();
		if (changed) {
			debugLog({ kind: "kill-all" });
			checkTickNeeded();
		}
	}

	// ── Output file heuristic (FALLBACK only) ───────────────

	const OUTPUT_FILE_RE =
		/\/tmp\/fork-(?:explorer|architect|implementer|verifier|analyst|\w+)[-_.]/i;
	const FALLBACK_OUTPUT_READ = !!process.env.SUBAGENT_STATUSLINE_FALLBACK;

	function handleOutputRead() {
		if (!FALLBACK_OUTPUT_READ) return;

		let changed = false;
		for (const child of state.children.values()) {
			if (child.status === "running" && child.id.startsWith("tmux:")) {
				changed = markChildDone(state, child.id) || changed;
			}
		}
		if (changed) {
			debugLog({ kind: "fallback.output-read.orphan-cleanup" });
			checkTickNeeded();
		}
	}

	// ── Tick management ─────────────────────────────────────
	// Tick does TWO things only:
	//   1. Stale cleanup (state mutation → triggers pushWidgetIfChanged)
	//   2. Footer spinner update (cheap setStatus — NOT setWidget)

	function ensureTick() {
		if (tickInterval) return;
		startTick();
	}

	function checkTickNeeded() {
		const counts = getCounts(state);
		if (counts.running === 0 && tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		} else if (counts.running > 0 && !tickInterval) {
			startTick();
		}
	}

	function startTick() {
		const ctx = capturedCtx;
		if (!ctx) {
			debugLog({ kind: "tick.skip-no-ctx" });
			return;
		}

		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}

		tickInterval = setInterval(() => {
			const tickCtx = capturedCtx;
			if (!tickCtx || state.children.size === 0) return;

			// Advance spinner (volatile — only affects footer)
			advanceSpinner();

			// Stale timeout: state mutation — will trigger pushWidgetIfChanged
			const staleCutoff = Date.now() - STALE_MS;
			let staleFound = false;
			for (const child of state.children.values()) {
				if (child.status === "running" && child.startedAt < staleCutoff) {
					markChildDone(state, child.id);
					staleFound = true;
				}
			}

			if (staleFound) {
				debugLog({ kind: "tick.stale-cleanup" });
				pushWidgetIfChanged(tickCtx, "tick.stale");
			}

			// Footer spinner update — cheap, every tick, NO setWidget
			pushFooter(tickCtx);

			const counts = getCounts(state);
			if (counts.running === 0) {
				clearInterval(tickInterval!);
				tickInterval = null;
			}
		}, TICK_MS);
	}

	// ── /agents command: progressive-disclosure overlay ──

	pi.registerCommand("agents", {
		description: "Show full subagent status table",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const theme = ctx.ui.theme;
			const lines = renderFullTable(state, theme);

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				const container = new Container();

				for (const line of lines) {
					container.addChild(new Text(line, 0, 0));
				}
				container.addChild(
					new Text(_theme.fg("dim", "Press Escape to close"), 1, 0),
				);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (data === "\x1b") done();
						tui.requestRender();
					},
				};
			});
		},
	});

	// ── Session lifecycle ───────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		capturedCtx = ctx;
		state.children.clear();
		pendingSubagentCalls.clear();
		state.lastUpdate = Date.now();
		lastStableHash = "";

		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}

		debugLog({ kind: "session.start" });

		// Show heartbeat footer to confirm extension is alive
		ctx.ui.setStatus(statusId, ctx.ui.theme.fg("dim", "agents: idle"));

		pushWidgetIfChanged(ctx, "session.start");
	});

	pi.on("session_switch", async (_event, ctx: ExtensionContext) => {
		capturedCtx = ctx;
		state.children.clear();
		pendingSubagentCalls.clear();
		bashCommandByCallId.clear();
		resetSpinner();
		resetModelCache();
		state.lastUpdate = Date.now();
		lastStableHash = "";

		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}

		debugLog({ kind: "session.switch" });
		pushWidgetIfChanged(ctx, "session.switch");
	});

	pi.on("session_shutdown", async (_event, _ctx: ExtensionContext) => {
		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}
		debugLog({ kind: "session.shutdown" });
	});

	// ── tool_call — READ ONLY, no state mutation ─────────────

	pi.on("tool_call", async (event, _ctx: ExtensionContext) => {
		if (event.toolName !== "bash") return;

		const input = event.input as { command?: string } | undefined;
		const cmd = input?.command || "";
		if (!cmd) return;

		if (LAUNCH_RE.test(cmd)) {
			debugLog({ kind: "tool_call.launch.detected", cmd: cmd.slice(0, 80) });
		}
	});

	// ── Tool execution tracking (PRIMARY authority) ──────────

	pi.on("tool_execution_start", async (event, ctx: ExtensionContext) => {
		capturedCtx = ctx;

		if (event.toolName === "subagent") {
			handleSubagentStart(
				event.args as Record<string, unknown>,
				event.toolCallId as string | undefined,
			);
			ensureTick();
			pushWidgetIfChanged(ctx, "tool_execution_start.subagent");
			return;
		}

		if (event.toolName !== "bash") return;

		const cmd = (event.args as Record<string, unknown> | undefined)?.command as
			| string
			| undefined;

		if (!cmd) return;
		if (cmd.length > 1000) return;

		if (LAUNCH_RE.test(cmd)) {
			handleLaunch(cmd);
			pushWidgetIfChanged(ctx, "tool_execution_start.launch");
		}

		if (event.toolCallId && cmd) {
			bashCommandByCallId.set(event.toolCallId, cmd);
		}
	});

	pi.on("tool_execution_end", async (event, ctx: ExtensionContext) => {
		capturedCtx = ctx;

		if (event.toolName === "subagent") {
			handleSubagentEnd(
				event.isError === true,
				event.toolCallId as string | undefined,
				event.result as unknown | undefined,
			);
			pushWidgetIfChanged(ctx, "tool_execution_end.subagent");
			return;
		}

		if (event.toolName !== "bash") return;

		const cmd = event.toolCallId
			? bashCommandByCallId.get(event.toolCallId)
			: undefined;

		if (!cmd) return;
		if (cmd.length > 1000) return;

		if (event.toolCallId) bashCommandByCallId.delete(event.toolCallId);

		if (RESPONSE_RE.test(cmd) || STATUS_RE.test(cmd)) {
			handleResponse(cmd, event.isError === true);
			pushWidgetIfChanged(ctx, "tool_execution_end.response");
		} else if (KILLALL_RE.test(cmd) && !event.isError) {
			handleKillAll();
			pushWidgetIfChanged(ctx, "tool_execution_end.kill-all");
		} else if (FALLBACK_OUTPUT_READ && OUTPUT_FILE_RE.test(cmd)) {
			handleOutputRead();
			pushWidgetIfChanged(ctx, "tool_execution_end.fallback");
		}
	});

	// ── Turn tracking ───────────────────────────────────────

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		const now = Date.now();
		let changed = false;

		const staleIds: string[] = [];
		const pruneIds: string[] = [];
		for (const [id, child] of state.children) {
			if (child.status === "running" && child.startedAt < now - STALE_MS) {
				staleIds.push(id);
			}
			if (
				child.status !== "running" &&
				child.endedAt &&
				child.endedAt < now - PRUNE_MS
			) {
				pruneIds.push(id);
			}
		}
		for (const id of staleIds) {
			const child = state.children.get(id);
			if (child) {
				markChildDone(state, id);
				changed = true;
				debugLog({ kind: "turn-end.stale", id, name: child.name });
			}
		}
		for (const id of pruneIds) {
			state.children.delete(id);
			changed = true;
		}

		if (changed) {
			state.lastUpdate = Date.now();
			pushWidgetIfChanged(ctx, "turn_end.state-change");
		}

		if (state.children.size === 0 && lastStableHash !== "") {
			clearWidget(ctx);
		}
	});
}
