import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

/**
 * Every champion id Data Dragon 16.19.1 (patch 26.19) listed on 2026-09-27, frozen here so this test
 * stays offline. Refresh this list by hand alongside data/championRoles.json whenever
 * src/lab/refresh-champion-roles.ts runs against a newer Data Dragon version.
 */
const DATA_DRAGON_CHAMPION_IDS_16_19_1 = [
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 48, 50, 51, 53, 54, 55, 56,
	57, 58, 59, 60, 61, 62, 63, 64, 67, 68, 69, 72, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 89, 90, 91, 92, 96, 98, 99, 101, 102, 103, 104, 105, 106, 107, 110, 111, 112, 113, 114, 115, 117,
	119, 120, 121, 122, 126, 127, 131, 133, 134, 136, 141, 142, 143, 145, 147, 150, 154, 157, 161, 163, 164, 166, 200, 201, 202, 203, 221, 222, 223, 233, 234, 235, 236, 238, 240, 245, 246, 254, 266,
	267, 268, 350, 360, 412, 420, 421, 427, 429, 432, 497, 498, 516, 517, 518, 523, 526, 555, 711, 777, 799, 800, 804, 805, 875, 876, 887, 888, 893, 895, 897, 901, 902, 904, 910, 950,
].map(String);

describe("data/championRoles.json (D-25)", () => {
	test("every Data Dragon 26.19 champion id has a roles entry in the checked-in file", () => {
		const path = fileURLToPath(new URL("../../data/championRoles.json", import.meta.url));
		const file = JSON.parse(readFileSync(path, "utf8")) as { roles: Record<string, unknown> };
		const missing = DATA_DRAGON_CHAMPION_IDS_16_19_1.filter((id) => !(id in file.roles));
		expect(missing).toEqual([]);
	});

	test("every row has all five lane keys as finite numbers", () => {
		const path = fileURLToPath(new URL("../../data/championRoles.json", import.meta.url));
		const file = JSON.parse(readFileSync(path, "utf8")) as { roles: Record<string, Record<string, unknown>> };
		for (const [id, row] of Object.entries(file.roles)) {
			for (const lane of ["top", "jungle", "middle", "bottom", "support"]) {
				expect(typeof row[lane], `${id}.${lane}`).toBe("number");
				expect(Number.isFinite(row[lane] as number), `${id}.${lane}`).toBe(true);
			}
		}
	});
});
