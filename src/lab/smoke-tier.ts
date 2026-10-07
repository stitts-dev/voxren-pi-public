/** The machine-readable result of a smoke run (tier.json): what a script reading the tiers of checks wants from one line of JSON. */
import type { Failure } from "./stories.ts";

export interface TierResult {
	tier: "smoke";
	pass: number;
	fail: number;
	skipped: number;
	seconds: number;
	/** What the run cost: the visual review's call (the replay itself is free). */
	costUsd: number;
	/** One entry per failed gate, by story. */
	findings: { story: string; gate: string; detail: string }[];
}

export function tierResult(stories: { id: string; failures: Failure[] }[], skipped: number, seconds: number, costUsd: number): TierResult {
	return {
		tier: "smoke",
		pass: stories.filter((story) => !story.failures.length).length,
		fail: stories.filter((story) => story.failures.length).length,
		skipped,
		seconds: Math.round(seconds * 10) / 10,
		costUsd: Math.round(costUsd * 1000) / 1000,
		findings: stories.flatMap((story) => story.failures.map((failure) => ({ story: story.id, gate: failure.gate, detail: failure.detail }))),
	};
}
