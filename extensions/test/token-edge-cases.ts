import {
	renderFooterStatus,
	renderStatusLine,
	shortenModel,
} from "../render.ts";
import type { TokenUsage } from "../state.ts";
import {
	addChild,
	createState,
	formatTokens,
	markChildDone,
	markChildError,
} from "../state.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, fn: () => boolean): void {
	const ok = fn();
	if (ok) {
		passed++;
		console.log(`  \x1b[32m✅\x1b[0m ${label}`);
	} else {
		failed++;
		failures.push(label);
		console.log(`  \x1b[31m❌\x1b[0m ${label}`);
	}
}

function section(name: string): void {
	console.log(`\n=== ${name} ===`);
}

const plainTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

// ═══════════════════════════════════════════════════════════

section("1. formatTokens boundary values");

assert('0 → "0"', () => formatTokens(0) === "0");
assert('1 → "1"', () => formatTokens(1) === "1");
assert('999 → "999"', () => formatTokens(999) === "999");
assert('1000 → "1.0k"', () => formatTokens(1000) === "1.0k");
assert('1500 → "1.5k"', () => formatTokens(1500) === "1.5k");
assert('9999 → "10.0k"', () => formatTokens(9999) === "10.0k");
assert('10000 → "10k"', () => formatTokens(10000) === "10k");
assert('1000000 → "1.0M"', () => formatTokens(1000000) === "1.0M");
assert('1500000 → "1.5M"', () => formatTokens(1500000) === "1.5M");

section("2. shortenModel known patterns");

assert(
	"deepseek/deepseek-chat-v4-flash → chat-v4-flash",
	() => shortenModel("deepseek/deepseek-chat-v4-flash") === "chat-v4-flash",
);
assert(
	"anthropic/claude-sonnet-4-20250514 → sonnet-4",
	() => shortenModel("anthropic/claude-sonnet-4-20250514") === "sonnet-4",
);
assert("openai/gpt-4o → 4o", () => shortenModel("openai/gpt-4o") === "4o");
assert(
	"google/gemini-2.5-pro → 2.5-pro",
	() => shortenModel("google/gemini-2.5-pro") === "2.5-pro",
);
assert(
	"deepseek/deepseek-reasoner → reasoner",
	() => shortenModel("deepseek/deepseek-reasoner") === "reasoner",
);
assert(
	"no-slash-model → no-slash-model",
	() => shortenModel("no-slash-model") === "no-slash-model",
);

section("3. shortenModel edge cases");

assert("empty string → empty", () => shortenModel("") === "");
assert(
	'slash only "anthropic/" → "anthropic/" (fallback)',
	() => shortenModel("anthropic/") === "anthropic/",
);
assert("double slash → last segment", () => shortenModel("a/b/c") === "c");
assert(
	"model with date no prefix",
	() => shortenModel("my-model-20250514") === "my-model",
);

section("4. Render with no usage");

{
	const state = createState();
	addChild(state, "sub:a:1", "agent-a", "subagent", "call-A");
	const c = state.children.get("sub:a:1")!;
	// No usage, no model
	markChildDone(state, "sub:a:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("no usage → still renders", () => lines.length >= 2);
	assert("no token info in detail row", () => {
		// Detail row should just have icon, name, elapsed — no ↑↓ or $
		const detail = lines.find((l) => l.includes("agent-a"));
		return detail && !detail.includes("↑") && !detail.includes("$");
	});
}

section("5. Render with usage but zero tokens");

{
	const state = createState();
	addChild(state, "sub:b:1", "agent-b", "subagent", "call-B");
	const c = state.children.get("sub:b:1")!;
	c.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
	markChildDone(state, "sub:b:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("zero usage → no token line", () => {
		const detail = lines.find((l) => l.includes("agent-b"));
		return detail && !detail.includes("↑") && !detail.includes("$");
	});
}

section("6. Render with cost but no tokens");

{
	const state = createState();
	addChild(state, "sub:c:1", "agent-c", "subagent", "call-C");
	const c = state.children.get("sub:c:1")!;
	c.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.005,
		contextTokens: 0,
		turns: 0,
	};
	markChildDone(state, "sub:c:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("cost-only → shows $0.0050", () => {
		const detail = lines.find((l) => l.includes("agent-c"));
		return detail && detail.includes("$0.0050");
	});
}

section("7. Render with model but no usage");

{
	const state = createState();
	addChild(state, "sub:d:1", "agent-d", "subagent", "call-D");
	const c = state.children.get("sub:d:1")!;
	c.model = "deepseek/deepseek-chat-v4-flash";
	markChildDone(state, "sub:d:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("model-only → shows model name", () => {
		const detail = lines.find((l) => l.includes("agent-d"));
		return detail && detail.includes("chat-v4-flash");
	});
}

section("8. Aggregate totals accuracy");

{
	const state = createState();

	addChild(state, "sub:p1:1", "p1", "parallel", "call-P");
	const c1 = state.children.get("sub:p1:1")!;
	c1.usage = {
		input: 50000,
		output: 3000,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.01,
		contextTokens: 0,
		turns: 0,
	};
	markChildDone(state, "sub:p1:1");

	addChild(state, "sub:p2:2", "p2", "parallel", "call-P");
	const c2 = state.children.get("sub:p2:2")!;
	c2.usage = {
		input: 75000,
		output: 5400,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.0134,
		contextTokens: 0,
		turns: 0,
	};
	markChildDone(state, "sub:p2:2");

	const lines = renderStatusLine(state, plainTheme);
	assert("aggregate: ↑125k ↓8.4k $0.0234", () => {
		const agg = lines.find(
			(l) => l.includes("↑") && !l.includes("●") && !l.includes("✓"),
		);
		return (
			agg &&
			agg.includes("↑125k") &&
			agg.includes("↓8.4k") &&
			agg.includes("$0.0234")
		);
	});
}

section("9. Mixed agents: some with usage, some without");

{
	const state = createState();

	// tmux agent (no usage)
	addChild(state, "tmux:explorer", "explorer", "explorer");

	// subagent with usage
	addChild(state, "sub:x:1", "analyst", "subagent", "call-X");
	const c = state.children.get("sub:x:1")!;
	c.usage = {
		input: 100000,
		output: 20000,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.05,
		contextTokens: 0,
		turns: 0,
	};
	c.model = "anthropic/claude-sonnet-4-20250514";
	markChildDone(state, "sub:x:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("tmux agent has no meta", () => {
		const row = lines.find((l) => l.includes("explorer"));
		return row && !row.includes("↑");
	});
	assert("subagent has meta", () => {
		const row = lines.find((l) => l.includes("analyst"));
		return row && row.includes("↑100k") && row.includes("sonnet-4");
	});
}

section("10. shortenModel with empty result guard");

{
	// This tests the bug where shortenModel returns "" for "provider/"
	// and buildMetaLine would push empty string
	const result = shortenModel("anthropic/");
	assert(
		"empty model shortening → fallback to original",
		() => result === "anthropic/",
	);
}

section("11. Large token counts");

{
	assert(
		'formatTokens(999999999) → "1000.0M"',
		() => formatTokens(999_999_999) === "1000.0M",
	);
	assert('formatTokens(100) → "100"', () => formatTokens(100) === "100");
}

section("12. Cost formatting precision");

{
	const state = createState();
	addChild(state, "sub:e:1", "agent-e", "subagent", "call-E");
	const c = state.children.get("sub:e:1")!;
	c.usage = {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.0001,
		contextTokens: 0,
		turns: 0,
	};
	markChildDone(state, "sub:e:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("tiny cost $0.0001 shows", () => {
		const row = lines.find((l) => l.includes("agent-e"));
		return row && row.includes("$0.0001");
	});
}

// ═══════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log("\n\x1b[31mFailures:\x1b[0m");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
} else {
	console.log("\n\x1b[32m✅ ALL TOKEN/MODEL EDGE CASE TESTS PASSED\x1b[0m");
}
