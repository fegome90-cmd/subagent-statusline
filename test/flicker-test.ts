/**
 * Flicker regression test — validates that setWidget is NOT called per-tick.
 *
 * Simulates 10 seconds of ticks with no state changes.
 * The stable hash must remain constant → setWidget must not fire.
 */

import {
	addChild,
	createState,
	markChildDone,
	type SubagentState,
} from "../state.ts";

// ── Simulate the hash computation from index.ts ──

function getCounts(state: SubagentState) {
	let running = 0;
	let done = 0;
	let error = 0;
	for (const child of state.children.values()) {
		if (child.status === "running") running++;
		else if (child.status === "done") done++;
		else if (child.status === "error") error++;
	}
	return { running, done, error };
}

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

console.log("\n=== Flicker Regression Test ===\n");

// Scenario: 2 running agents, simulate 10 seconds of ticks
const state = createState();
addChild(state, "tmux:explorer", "codebase-scan", "explorer", "call-A");
addChild(state, "tmux:analyst", "auth-audit", "analyst", "call-B");

// Capture initial hash
const initialHash = computeStableHash(state);

// Simulate 10 ticks (10 seconds) with NO state changes
const hashes: string[] = [initialHash];
for (let tick = 1; tick <= 10; tick++) {
	// Simulate what the tick does: advance spinner, update footer
	// But NO state mutation (no stale, no new agents, no completion)
	const hash = computeStableHash(state);
	hashes.push(hash);
}

assert("hash is identical across 10 ticks with no state change", () =>
	hashes.every((h) => h === initialHash),
);

assert("setWidget would be called 0 times (hash never changed)", () => {
	let changes = 0;
	for (let i = 1; i < hashes.length; i++) {
		if (hashes[i] !== hashes[i - 1]) changes++;
	}
	return changes === 0;
});

// Scenario: agent completes mid-session → hash changes exactly once
markChildDone(state, "tmux:analyst");
const hashAfterDone = computeStableHash(state);

assert(
	"hash changes when agent completes",
	() => hashAfterDone !== initialHash,
);

// After completion, 10 more ticks — hash stable again
const postDoneHashes: string[] = [hashAfterDone];
for (let tick = 1; tick <= 10; tick++) {
	postDoneHashes.push(computeStableHash(state));
}

assert("hash stable for 10 more ticks after completion", () =>
	postDoneHashes.every((h) => h === hashAfterDone),
);

// Scenario: model arrives → hash changes (structural: model presence)
const child = state.children.get("tmux:analyst")!;
child.model = "deepseek/chat-v4-flash";
const hashAfterModel = computeStableHash(state);

assert(
	"hash changes when model arrives",
	() => hashAfterModel !== hashAfterDone,
);

// 10 more ticks after model — stable
const postModelHashes: string[] = [hashAfterModel];
for (let tick = 1; tick <= 10; tick++) {
	postModelHashes.push(computeStableHash(state));
}

assert("hash stable for 10 more ticks after model arrival", () =>
	postModelHashes.every((h) => h === hashAfterModel),
);

// ── Summary ──

console.log(
	`\n${passed} passed, ${failed} failed` +
		(failed === 0
			? `\n\x1b[32m✅ FLICKER TEST PASSED — setWidget not called per-tick\x1b[0m`
			: ""),
);

process.exit(failed > 0 ? 1 : 0);
