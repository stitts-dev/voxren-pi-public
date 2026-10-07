/** The smoke replay's network block, on its own so a plain Node process can load it (smoke-extension.test.ts does). */
import { appendFileSync } from "node:fs";
import net from "node:net";

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/;

/** Refuses every connection (the returned function puts the real fetch and sockets back, for a test) that is not to this machine, and says so in `logFile`. `serve` answers a URL from a file on disk instead (a fixture), before the block applies. A refusal is an error to the caller and a line to the test. */
export function blockNetwork(logFile: string | undefined, serve: (url: string) => Response | undefined | Promise<Response | undefined> = () => undefined, sockets = true): () => void {
	const refuse = (what: string): never => {
		if (logFile) appendFileSync(logFile, `${what}\n`);
		throw new Error(`offline replay: refused ${what}`);
	};
	const realFetch = globalThis.fetch;
	const connect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
	const unblock = () => {
		globalThis.fetch = realFetch;
		net.Socket.prototype.connect = connect as typeof net.Socket.prototype.connect;
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const served = await serve(url);
		if (served) return served;
		if (!LOOPBACK.test(new URL(url).hostname)) refuse(`fetch ${url}`);
		return realFetch(input, init);
	}) as typeof fetch;
	if (!sockets) return unblock; // a warm run: the cache fills over the real network, through serve
	net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
		// net.connect hands connect() its arguments already normalized: [options, callback].
		const first = Array.isArray(args[0]) ? args[0][0] : args[0];
		const options = typeof first === "object" && first !== null ? (first as { host?: string; path?: string }) : { host: typeof args[1] === "string" ? args[1] : undefined };
		const host = options.path ? "127.0.0.1" : (options.host ?? "127.0.0.1");
		if (!LOOPBACK.test(host)) refuse(`socket ${host}`);
		return connect.apply(this, args);
	} as typeof net.Socket.prototype.connect;
	return unblock;
}
