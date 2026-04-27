/**
 * Sub-agent Statusline — Pi Extension
 *
 * Monitors tmux_fork sub-agents and shows their status in the pi footer.
 *
 * FLICKER-FREE DESIGN:
 *   - pushWidgetIfChanged() skips setWidget when stable hash is unchanged.
 *   - Stable hash includes: agent count, status, model/usage presence.
 *   - Hash contains ZERO volatile fields (no elapsed, no spinnerIdx).
 *   - The tick re-renders the widget for spinner + elapsed animation,
 *     but only when agents are running (and only the widget, not structural state).
 *   - Stale checks run at reduced rate (~5s) to minimize I/O.
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
import { computeStableHash } from "./hash.js";
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

// ── Debug logging ─────────────────────────────────────────
const DEBUG = !!process.env.SUBAGENT_STATUSLINE_DEBUG;

const debugStream = DEBUG
	? (() => {
			const dir = path.join(
				process.env.XDG_RUNTIME_DIR ?? "/tmp",
				"subagent-statusline",
			);
			fs.mkdirSync(dir, { recursive: true });
			return fs.createWriteStream(path.join(dir, "debug.log"), {
				flags: "a",
			});
		})()
	: null;

function debugLog(input: Record<string, unknown>): void {
	if (!DEBUG || !debugStream) return;
	try {
		const line = JSON.stringify({
			time: new Date().toISOString(),
			...input,
		});
		debugStream.write(`${line}\n`);
	} catch {
		// Debug logging must never crash the extension.
	}
}

// ── Constants ─────────────────────────────────────────────

const TICK_MS = 80; // Tick interval for stale checks + footer spinner
const STALE_MS = 3 * 60 * 1000; // Stale timeout: 3 min for orphaned agents
const PRUNE_MS = 2 * 60 * 1000; // Prune done/error agents after 2 min

// tmux-live metadata paths
const FORK_LIVE_REGISTRY = "/tmp/fork-live-registry";
const FORK_LIVE_SESSIONS = "/tmp/fork-live-sessions";

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

// Detect direct pi --mode json invocations (subagent launches via bash)
// Matches: "pi --provider X --model Y --mode json" or "timeout ... pi ... --mode json"
// Detect direct pi --mode json invocations (subagent launches via bash)
// Must match 'pi' as a command, not as an argument to other tools
const PI_SUBAGENT_RE =
	/(?:^|;\s*|&&\s*\|\s*|`|timeout\s+\S+\s+|env\s+\S+\s+)pi\s+(?:\S+\s+)*--mode\s+json/i;

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

	/** Read model from tmux-live .meta file */
	function readModelFromMeta(name: string): string | undefined {
		const metaPath = path.join(FORK_LIVE_REGISTRY, `fork-${name}.meta`);
		try {
			const raw = fs.readFileSync(metaPath, "utf-8");
			const meta = JSON.parse(raw);
			return typeof meta.model === "string" ? meta.model : undefined;
		} catch {
			return undefined;
		}
	}

	/** Read usage from tmux-live session JSONL */
	function readUsageFromSession(name: string): TokenUsage | undefined {
		try {
			// Find session dir: /tmp/fork-live-sessions/fork-{name}-*/
			const dirs = fs
				.readdirSync(FORK_LIVE_SESSIONS)
				.filter((d) => d.startsWith(`fork-${name}-`));
			if (dirs.length === 0) return undefined;

			// Read the JSONL file in the latest session dir
			const sessionDir = path.join(FORK_LIVE_SESSIONS, dirs[dirs.length - 1]);
			const jsonlFiles = fs
				.readdirSync(sessionDir)
				.filter((f) => f.endsWith(".jsonl"));
			if (jsonlFiles.length === 0) return undefined;

			const jsonlPath = path.join(sessionDir, jsonlFiles[0]);

			// Read JSONL and find last assistant usage
			// Optimization: read file and scan backwards for last usage
			const content = fs.readFileSync(jsonlPath, "utf-8");
			const lines = content.split("\n");

			// Scan from end — last usage is most relevant
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i];
				if (!line.trim()) continue;
				try {
					const evt = JSON.parse(line);
					if (
						evt.type === "message" &&
						evt.message?.role === "assistant" &&
						evt.message?.usage
					) {
						const u = evt.message.usage;
						return {
							input: u.input ?? u.inputTokens ?? 0,
							output: u.output ?? u.outputTokens ?? 0,
							cacheRead: u.cacheRead ?? u.cache_read ?? 0,
							cacheWrite: u.cacheWrite ?? u.cache_write ?? 0,
							cost: u.cost?.total ?? u.totalCost ?? 0,
							contextTokens: u.contextTokens ?? 0,
							turns: u.turns ?? 0,
						};
					}
				} catch {
					// Skip malformed lines
				}
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	function handleLaunch(cmd: string) {
		const match = cmd.match(LAUNCH_RE);
		if (!match) return;
		const role = match[1];
		const name = match[2];
		const id = `tmux:${name}`;

		if (state.children.has(id)) return;
		if (!VALID_ROLES.includes(role.toLowerCase())) return;

		addChild(state, id, name, role);

		// Enrich with model from .meta (written at spawn time)
		const model = readModelFromMeta(name);
		if (model) {
			const child = state.children.get(id);
			if (child) child.model = model;
		}

		debugLog({ kind: "launch", role, name, model });
		ensureTick();
	}

	/** Handle direct `pi --mode json` invocations as subagent launches */
	function handlePiDirectLaunch(cmd: string) {
		// Try to extract name from prompt file: fork-prompt-NAME.txt
		const promptMatch = cmd.match(
			/fork-prompt-(?:assembled-)?([a-zA-Z0-9_-]+)/,
		);
		const rawName = promptMatch ? promptMatch[1] : undefined;

		// Extract provider/model for role inference
		const providerMatch = cmd.match(/--provider\s+(\S+)/);
		const modelMatch = cmd.match(/--model\s+(\S+)/);
		const provider = providerMatch ? providerMatch[1] : "unknown";
		const model = modelMatch ? modelMatch[1] : undefined;

		// Generate a stable ID — use prompt file name or provider+counter
		const name = rawName || `agent-${provider}`;
		const id = `pidirect:${name}:${Date.now()}-${idCounter++}`;

		if (state.children.has(id)) return;

		addChild(state, id, name, "subagent");

		// Enrich with model info
		const child = state.children.get(id);
		if (child && model) {
			child.model = `${provider}/${model}`;
		}

		debugLog({ kind: "pi-direct-launch", name, provider, model });
		ensureTick();
	}

	/** Handle completion of direct `pi --mode json` invocations */
	function handlePiDirectEnd(cmd: string, isError: boolean) {
		// Find matching pidirect: agent by prompt file name
		const promptMatch = cmd.match(
			/fork-prompt-(?:assembled-)?([a-zA-Z0-9_-]+)/,
		);
		const rawName = promptMatch ? promptMatch[1] : undefined;
		const providerMatch = cmd.match(/--provider\s+(\S+)/);
		const fallbackName = providerMatch
			? `agent-${providerMatch[1]}`
			: undefined;

		// Match only the FIRST running pidirect agent with matching name
		for (const [id, child] of state.children) {
			if (child.status === "running" && id.startsWith("pidirect:")) {
				const nameMatch =
					(rawName && id.includes(rawName)) ||
					(!rawName && fallbackName && id.includes(fallbackName)) ||
					(!rawName && !fallbackName);
				if (nameMatch) {
					if (isError) markChildError(state, id);
					else markChildDone(state, id);
					debugLog({ kind: "pi-direct-end", id, rawName, isError });
					checkTickNeeded();
					return; // Only close the first match
				}
			}
		}
	}

	function handleResponse(cmd: string, isError: boolean) {
		const match = cmd.match(RESPONSE_RE);
		if (!match) return;
		const name = match[1];
		const id = `tmux:${name}`;

		const changed = isError
			? markChildError(state, id)
			: markChildDone(state, id);

		// Enrich with usage from session JSONL
		if (changed) {
			const child = state.children.get(id);
			if (child) {
				if (!child.model) {
					const model = readModelFromMeta(name);
					if (model) child.model = model;
				}
				const usage = readUsageFromSession(name);
				if (usage) child.usage = usage;
			}
			debugLog({ kind: "response", name, isError, hasUsage: !!child?.usage });
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

		// Counter to decouple spinner animation rate from stale check rate
		let tickCount = 0;
		const STALE_CHECK_INTERVAL = Math.round(5000 / TICK_MS); // ~every 5s

		tickInterval = setInterval(() => {
			const tickCtx = capturedCtx;
			if (!tickCtx || state.children.size === 0) return;

			tickCount++;

			// Advance spinner — footer-only update (cheap)
			advanceSpinner();

			const counts = getCounts(state);
			if (counts.running > 0) {
				// Re-render widget for spinner animation (elapsed + spinner icon)
				const widgetLines = renderStatusLine(state, tickCtx.ui.theme);
				if (widgetLines.length > 0) {
					tickCtx.ui.setWidget(widgetId, widgetLines);
				}
				pushFooter(tickCtx);
			}

			// Stale check at reduced rate (every ~5s, not every 80ms)
			if (tickCount % STALE_CHECK_INTERVAL === 0) {
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
			}

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

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		capturedCtx = ctx;
		state.children.clear();
		pendingSubagentCalls.clear();
		state.lastUpdate = Date.now();
		lastStableHash = "";
		resetSpinner();
		resetModelCache();

		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}

		debugLog({ kind: "session.start" });

		// Show heartbeat footer to confirm extension is alive
		ctx.ui.setStatus(statusId, ctx.ui.theme.fg("dim", "agents: idle"));

		pushWidgetIfChanged(ctx, "session.start");
	});

	pi.on("session_switch", async (_event: any, ctx: ExtensionContext) => {
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
		ctx.ui.setStatus(statusId, ctx.ui.theme.fg("dim", "agents: idle"));
		pushWidgetIfChanged(ctx, "session.switch");
	});

	pi.on("session_shutdown", async (_event: any, _ctx: ExtensionContext) => {
		if (tickInterval) {
			clearInterval(tickInterval);
			tickInterval = null;
		}
		state.children.clear();
		pendingSubagentCalls.clear();
		bashCommandByCallId.clear();
		lastStableHash = "";
		setWidgetCallCount = 0;
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
		try {
			capturedCtx = ctx;

			if (event.toolName === "subagent") {
				if (!event.args || typeof event.args !== "object") return;
				handleSubagentStart(
					event.args as Record<string, unknown>,
					event.toolCallId as string | undefined,
				);
				ensureTick();
				pushWidgetIfChanged(ctx, "tool_execution_start.subagent");
				return;
			}

			if (event.toolName !== "bash") return;

			const cmd = (event.args as Record<string, unknown> | undefined)
				?.command as string | undefined;

			if (!cmd) return;
			if (cmd.length > 1000) return;

			if (LAUNCH_RE.test(cmd)) {
				handleLaunch(cmd);
				pushWidgetIfChanged(ctx, "tool_execution_start.launch");
			}

			// Detect direct pi --mode json invocations as subagent launches
			if (PI_SUBAGENT_RE.test(cmd) && !LAUNCH_RE.test(cmd)) {
				handlePiDirectLaunch(cmd);
				pushWidgetIfChanged(ctx, "tool_execution_start.pi-direct");
			}

			if (event.toolCallId && cmd) {
				bashCommandByCallId.set(event.toolCallId, cmd);
			}
		} catch (err) {
			debugLog({ kind: "error.tool_execution_start", msg: String(err) });
		}
	});

	pi.on("tool_execution_end", async (event, ctx: ExtensionContext) => {
		try {
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
			} else if (PI_SUBAGENT_RE.test(cmd) && !LAUNCH_RE.test(cmd)) {
				// Direct pi --mode json invocation completed
				handlePiDirectEnd(cmd, event.isError === true);
				pushWidgetIfChanged(ctx, "tool_execution_end.pi-direct");
			} else if (FALLBACK_OUTPUT_READ && OUTPUT_FILE_RE.test(cmd)) {
				handleOutputRead();
				pushWidgetIfChanged(ctx, "tool_execution_end.fallback");
			}
		} catch (err) {
			debugLog({ kind: "error.tool_execution_end", msg: String(err) });
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

		// Age out bash command entries at turn boundary
		bashCommandByCallId.clear();
	});
}
