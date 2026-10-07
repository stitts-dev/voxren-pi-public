import { describe, expect, test } from "bun:test";
import { parseKeySourceTag, resolveKeySource } from "./key-source";

describe("resolveKeySource", () => {
	test("all 6 reachable (envTag, stored) combinations", () => {
		expect(resolveKeySource({ envTag: "env", stored: false })).toEqual({ source: "env", active: true, shadowsStore: false });
		expect(resolveKeySource({ envTag: "env", stored: true })).toEqual({ source: "env", active: true, shadowsStore: true });
		expect(resolveKeySource({ envTag: "dotenv", stored: false })).toEqual({ source: "dotenv", active: true, shadowsStore: false });
		expect(resolveKeySource({ envTag: "dotenv", stored: true })).toEqual({ source: "dotenv", active: true, shadowsStore: true });
		expect(resolveKeySource({ stored: true })).toEqual({ source: "store", active: true, shadowsStore: false });
		expect(resolveKeySource({ stored: false })).toEqual({ active: false, shadowsStore: false });
	});
});

describe("parseKeySourceTag", () => {
	test("decodes every string bin/coach.mjs can emit, and the unset case", () => {
		expect(parseKeySourceTag("env")).toEqual({ envTag: "env", stored: false });
		expect(parseKeySourceTag("dotenv")).toEqual({ envTag: "dotenv", stored: false });
		expect(parseKeySourceTag("env+store")).toEqual({ envTag: "env", stored: true });
		expect(parseKeySourceTag("dotenv+store")).toEqual({ envTag: "dotenv", stored: true });
		expect(parseKeySourceTag("store")).toEqual({ stored: true });
		expect(parseKeySourceTag(undefined)).toEqual({ stored: false });
	});

	test("round-trips into resolveKeySource for every emitted string", () => {
		expect(resolveKeySource(parseKeySourceTag("env"))).toEqual({ source: "env", active: true, shadowsStore: false });
		expect(resolveKeySource(parseKeySourceTag("env+store"))).toEqual({ source: "env", active: true, shadowsStore: true });
		expect(resolveKeySource(parseKeySourceTag("dotenv+store"))).toEqual({ source: "dotenv", active: true, shadowsStore: true });
		expect(resolveKeySource(parseKeySourceTag("store"))).toEqual({ source: "store", active: true, shadowsStore: false });
		expect(resolveKeySource(parseKeySourceTag(undefined))).toEqual({ active: false, shadowsStore: false });
	});
});
