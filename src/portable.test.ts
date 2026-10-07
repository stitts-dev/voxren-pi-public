import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * Shipped files stay portable: no address or home path from the machine that wrote them. Our own setup's values belong in
 * environment variables, the way src/lab/devbox.sh reads its host from VOXREN_DEVBOX. Plans and specs under
 * docs/superpowers are working notes, not shipped. Runs only in a git checkout (a copied mirror has no history to list).
 */
const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" });
const files = listed.status === 0 ? listed.stdout.split("\n").filter((file) => file && existsSync(file) && !/^(docs\/superpowers|docs\/walkthrough|services)\//.test(file) && !/\.(png|jpe?g|gif|ico|webp|lock)$|package-lock\.json$/.test(file)) : [];

// A Tailscale (CGNAT) or home-network address, and a path inside a real user's home folder ("me", "j", and other short or
// stock names are placeholders).
const MACHINE_SPECIFIC = [
	/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
	/\b192\.168\.\d{1,3}\.\d{1,3}\b/,
	/(?:\/Users\/|\/home\/)(?!(?:you|user|player|name|example)\/)[A-Za-z][\w.-]{2,}\//,
	/[A-Za-z]:\\{1,2}Users\\{1,2}(?!(?:you|user|player|name|example)\\)[A-Za-z][\w.-]{2,}\\/,
];

describe("portable", () => {
	test.skipIf(listed.status !== 0)("shipped files carry no machine-specific address or home path", () => {
		const hits = files.flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) => (MACHINE_SPECIFIC.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}: ${line.trim().slice(0, 120)}`] : [])),
		);
		expect(hits).toEqual([]);
	});
});
