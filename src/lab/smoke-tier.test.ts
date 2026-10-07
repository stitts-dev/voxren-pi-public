import { expect, test } from "bun:test";
import { tierResult } from "./smoke-tier.ts";

test("tier.json has the tier, the counts, the seconds, the cost, and one finding per failed gate", () => {
	const result = tierResult([{ id: "a", failures: [] }, { id: "b", failures: [{ gate: "running", detail: "stuck" }, { gate: "tools", detail: "never called" }] }], 2, 41.234, 0.1234);
	expect(result).toEqual({
		tier: "smoke",
		pass: 1,
		fail: 1,
		skipped: 2,
		seconds: 41.2,
		costUsd: 0.123,
		findings: [{ story: "b", gate: "running", detail: "stuck" }, { story: "b", gate: "tools", detail: "never called" }],
	});
	expect(Object.keys(JSON.parse(JSON.stringify(result)))).toEqual(["tier", "pass", "fail", "skipped", "seconds", "costUsd", "findings"]);
});
