/**
 * Stable model hash computation for flicker-free widget updates.
 *
 * ONLY contains fields that represent structural changes to the agent list.
 * NEVER contains volatile fields: timeBucket, elapsed, spinnerIdx, Date.now().
 */

import { getCounts, type SubagentState } from "./state.js";

export function computeStableHash(state: SubagentState): string {
	const counts = getCounts(state);
	const parts: string[] = [
		`${counts.running}:${counts.done}:${counts.error}`,
	];

	// Per-agent fingerprint: status + model presence + usage presence
	// (NOT model value changes — only arrival matters for structural change)
	for (const child of state.children.values()) {
		parts.push(
			`${child.id}:${child.status}:${child.model ? "m" : ""}:${child.usage ? "u" : ""}`,
		);
	}
	return parts.join("|");
}
