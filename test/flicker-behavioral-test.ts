/**
 * Behavioral test: validates pushWidgetIfChanged / pushFooter / clearWidget
 * with a mock ctx that counts setWidget and setStatus calls.
 *
 * Simulates:
 *   - 10 ticks with no structural change → setWidget called 0 times
 *   - Agent start → setWidget called 1 time
 *   - 10 more ticks → setWidget called 0 times
 *   - Agent done → setWidget called 1 time
 *   - Prune → setWidget called 1 time + clear
 */

import {
	addChild,
	createState,
	getCounts,
	markChildDone,
	type SubagentState,
} from "../state.ts";

// ── Mock context ──

interface MockCall {
	method: string;
	args: unknown[];
}

function createMockCtx() {
	const calls: MockCall[] = [];
	const theme = {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};

	return {
		calls,
		ui: {
			theme,
			setStatus: (id: string, text: string | undefined) => {
				calls.push({ method: "setStatus", args: [id, text] });
			},
			setWidget: (id: string, lines: string[] | undefined) => {
				calls.push({ method: "setWidget", args: [id, lines?.length] });
			},
		},
	};
}

// ── Hash computation (mirrors index.ts) ──

function computeStableHash(state: SubagentState): string {
	const counts = getCounts(state);
	const parts: string[] = [`${counts.running}:${counts.done}:${counts.error}`];
	for (const child of state.children.values()) {
		parts.push(
			`${child.id}:${child.status}:${child.model ? "m" : ""}:${child.usage ? "u" : ""}`,
		);
	}
	return parts.join("|");
}

// ── Simulated push functions (mirrors index.ts logic) ──

function pushWidgetIfChanged(
	state: SubagentState,
	ctx: ReturnType<typeof createMockCtx>,
	lastHash: { value: string },
	reason: string,
): string {
	const hash = computeStableHash(state);
	if (hash === lastHash.value) return lastHash.value;

	lastHash.value = hash;

	// setStatus (footer)
	ctx.ui.setStatus("subagent-status", `footer-${reason}`);

	// setWidget
	const lines = ["mock-line-1", "mock-line-2"];
	ctx.ui.setWidget("subagent-statusline", lines);

	return hash;
}

function pushFooter(ctx: ReturnType<typeof createMockCtx>) {
	ctx.ui.setStatus("subagent-status", "footer-spinner");
}

function clearWidget(
	ctx: ReturnType<typeof createMockCtx>,
	lastHash: { value: string },
) {
	lastHash.value = "";
	ctx.ui.setStatus("subagent-status", undefined);
	ctx.ui.setWidget("subagent-statusline", undefined);
}

// ── Test runner ──

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean) {
	if (fn()) {
		console.log(`  \x1b[32m✅\x1b[0m ${name}`);
		passed++;
	} else {
		console.log(`  \x1b[31m❌\x1b[0m ${name}`);
		failed++;
	}
}

console.log("\n=== Behavioral Test: setWidget call discipline ===\n");

const state = createState();
const ctx = createMockCtx();
const lastHash = { value: "" };

// Phase 1: Initial state — no agents, push should clear
pushWidgetIfChanged(state, ctx, lastHash, "init");
const initWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert("initial push calls setWidget once", () => initWidgetCalls === 1);

// Phase 2: Agent start — structural change
addChild(state, "tmux:explorer", "scan", "explorer", "call-A");
pushWidgetIfChanged(state, ctx, lastHash, "agent-start");
const afterStartWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert(
	"agent start calls setWidget (total 2)",
	() => afterStartWidgetCalls === 2,
);

// Phase 3: 10 ticks with no state change — only pushFooter
const beforeTickWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
for (let i = 0; i < 10; i++) {
	pushFooter(ctx); // tick: footer only
	pushWidgetIfChanged(state, ctx, lastHash, `tick-${i}`); // hash unchanged → skip
}
const afterTickWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert(
	"10 ticks: setWidget NOT called (still 2)",
	() => afterTickWidgetCalls === 2,
);

const tickFooterCalls = ctx.calls.filter(
	(c) => c.method === "setStatus" && c.args[1] === "footer-spinner",
).length;
assert(
	"10 ticks: setStatus called 10 times (spinner)",
	() => tickFooterCalls === 10,
);

// Phase 4: Agent done — structural change
markChildDone(state, "tmux:explorer");
pushWidgetIfChanged(state, ctx, lastHash, "agent-done");
const afterDoneWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert(
	"agent done calls setWidget (total 3)",
	() => afterDoneWidgetCalls === 3,
);

// Phase 5: Model arrival — structural change (model presence flips)
const child = state.children.get("tmux:explorer")!;
child.model = "deepseek/chat-v4-flash";
pushWidgetIfChanged(state, ctx, lastHash, "model-arrival");
const afterModelWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert(
	"model arrival calls setWidget (total 4)",
	() => afterModelWidgetCalls === 4,
);

// Phase 6: 10 more ticks — stable again
for (let i = 0; i < 10; i++) {
	pushFooter(ctx);
	pushWidgetIfChanged(state, ctx, lastHash, `tick2-${i}`);
}
const afterTick2WidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert(
	"10 more ticks: setWidget NOT called (still 4)",
	() => afterTick2WidgetCalls === 4,
);

// Phase 7: Prune (simulate by deleting child)
state.children.delete("tmux:explorer");
pushWidgetIfChanged(state, ctx, lastHash, "prune");
const afterPruneWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert("prune calls setWidget (total 5)", () => afterPruneWidgetCalls === 5);

// Phase 8: Clear
clearWidget(ctx, lastHash);
const afterClearWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
assert(
	"clear calls setWidget with undefined (total 6)",
	() => afterClearWidgetCalls === 6,
);

assert("lastHash reset to empty after clear", () => lastHash.value === "");

// Summary: total setWidget calls
const totalWidgetCalls = ctx.calls.filter(
	(c) => c.method === "setWidget",
).length;
const totalStatusCalls = ctx.calls.filter(
	(c) => c.method === "setStatus",
).length;

console.log(
	`\n  Summary: setWidget=${totalWidgetCalls} setStatus=${totalStatusCalls}`,
);

assert(
	"setWidget called 6 times total (init, start, done, model, prune, clear)",
	() => totalWidgetCalls === 6,
);

console.log(
	`\n${passed} passed, ${failed} failed` +
		(failed === 0
			? `\n\x1b[32m✅ BEHAVIORAL TEST PASSED — setWidget discipline correct\x1b[0m`
			: `\n\x1b[31m❌ BEHAVIORAL TEST FAILED\x1b[0m`),
);

process.exit(failed > 0 ? 1 : 0);
