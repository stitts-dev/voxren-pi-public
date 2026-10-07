// Preloaded by bunfig.toml. A test that needs a response injects its own fetch; one that reaches the network by
// accident fails here, the same on CI, a sandbox, and a laptop, instead of passing only where the network is open.
const realFetch = globalThis.fetch;
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (LOOPBACK.test(url)) return realFetch(input, init);
	throw new Error(`Unmocked network call in a test: ${url}. Inject a fetch or a fixture.`);
}) as typeof fetch;

// The terminal the tests run in never picks a picture path: xterm.js pictures are opted into per test.
delete process.env.TERM_PROGRAM;

// No test reads or writes the real coach home (icon cache, keys): one that needs a coach home sets its own.
delete process.env.PI_CODING_AGENT_DIR;
