import { expect, test } from "bun:test";
import { fixtureLaneLookup } from "./test-fixtures";

test("a test that reaches a remote host fails instead of using the network", async () => {
	await expect(fetch("https://ddragon.leagueoflegends.com/api/versions.json")).rejects.toThrow("Unmocked network call in a test: https://ddragon.leagueoflegends.com");
});

test("loopback still works, so a test can serve its own fixture", async () => {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	try {
		expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("ok");
	} finally {
		server.stop(true);
	}
});

test("the lane fixture answers like championLane and misses like it", async () => {
	expect(await fixtureLaneLookup("Zed")).toBe("mid");
	expect(await fixtureLaneLookup("zed")).toBe("mid");
	expect(await fixtureLaneLookup("Nobody")).toBeUndefined();
});
