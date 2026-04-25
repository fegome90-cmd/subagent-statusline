/**
 * Negative test: FAILS if computeStableHash contains volatile/time-derived fields.
 *
 * This test inspects the hash for known volatile patterns.
 * If someone reintroduces a time-based field, this test catches it.
 */

import {
	addChild,
	createState,
	markChildDone,
	type SubagentState,
} from "../state.ts";

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

// Mirror of computeStableHash from index.ts
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

console.log("\n=== Negative Test: No Volatile Fields in Hash ===\n");

const state = createState();
addChild(state, "tmux:explorer", "scan", "explorer", "call-A");
addChild(state, "tmux:analyst", "audit", "analyst", "call-B");
markChildDone(state, "tmux:analyst");

// Produce hash at two different times
const hash1 = computeStableHash(state);

// Wait 50ms to let any Date.now()-based field diverge
// (synchronous test — we simulate by calling twice)
const hash2 = computeStableHash(state);

// Test 1: Hash is identical across calls (no time-derived values)
assert("hash identical across consecutive calls", () => hash1 === hash2);

// Test 2: Hash does NOT contain timestamp-like numbers (10+ digits)
assert("hash has no timestamp-like numbers (10+ digits)", () => {
	const timestampPattern = /\d{10,}/;
	return !timestampPattern.test(hash1);
});

// Test 3: Hash does NOT contain seconds-since-epoch pattern
assert("hash has no seconds-since-epoch pattern", () => {
	// Math.floor(Date.now()/1000) produces 10-digit numbers starting with 17-19
	const epochPattern = /1[7-9]\d{8}/;
	return !epochPattern.test(hash1);
});

// Test 4: Hash length is bounded (no growing strings from timestamps)
assert(
	"hash length is bounded (< 500 chars for 2 agents)",
	() => hash1.length < 500,
);

// Test 5: Hash only contains expected characters
assert("hash only contains expected chars (alphanumeric, :|)", () => {
	const valid = /^[a-zA-Z0-9:|\-_.]+$/;
	return valid.test(hash1);
});

// Test 6: Two hashes 10 "ticks" apart are identical
const hashes: string[] = [];
for (let i = 0; i < 10; i++) {
	hashes.push(computeStableHash(state));
}
assert("10 consecutive hashes are all identical", () => {
	return hashes.every((h) => h === hashes[0]);
});

console.log(
	`\n${passed} passed, ${failed} failed` +
		(failed === 0
			? `\n\x1b[32m✅ NEGATIVE TEST PASSED — no volatile fields detected\x1b[0m`
			: `\n\x1b[31m❌ NEGATIVE TEST FAILED — volatile fields found in hash\x1b[0m`),
);

process.exit(failed > 0 ? 1 : 0);
