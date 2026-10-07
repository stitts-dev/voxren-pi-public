/**
 * Web search with no search key: a worker Pi (src/pi-worker.ts) asks the model provider to run its own hosted web
 * search and to answer with page titles, links, and sentences copied from the pages. The provider does the crawling;
 * the coach gets quotes it can screen and cite.
 */
import { logEvent } from "./coach-log";
import { COACH_YAML, fillTemplate } from "./contracts";
import type { PiWorker } from "./pi-worker";
import { SafeToolError, stripTerminalControl } from "./policy";

/** Providers whose request the worker extension knows how to add hosted search to (OpenAI's Responses API). */
export const HOSTED_SEARCH_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex", "openai"]);
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_QUOTES = 3;
const MAX_QUOTE_CHARS = 300;

export interface SearchHit {
	title: string;
	url: string;
	date: string;
	/** What the page says about the question: the quotes joined, or a provider's own snippet. */
	snippet: string;
}

export interface SearchAnswer {
	provider: string;
	answer: string;
	hits: SearchHit[];
}

export interface SearchQuery {
	query: string;
	domains?: string[];
	freshnessDays?: number;
	maxResults: number;
}

export type HostedSearch = (query: SearchQuery, signal?: AbortSignal) => Promise<SearchAnswer>;

export function hostedSearchPrompt({ query, domains, freshnessDays, maxResults }: SearchQuery): string {
	const tool = COACH_YAML.tools.web_search;
	const scope = `${domains?.length ? fillTemplate(tool.hostedSearchDomains!, { domains: domains.join(", ") }) : ""}${freshnessDays ? fillTemplate(tool.hostedSearchFreshness!, { days: String(freshnessDays) }) : ""}`;
	return fillTemplate(tool.hostedSearch!, { scope, max: String(maxResults), query });
}

const text = (value: unknown, max: number) => {
	const clean = stripTerminalControl(typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const MAX_URL_CHARS = 512;

/** A result link as given, when it is a whole http(s) address with a host and short enough to keep whole; a clipped link is a dead link. */
function pageUrl(value: unknown): string | undefined {
	const raw = stripTerminalControl(typeof value === "string" ? value : "").trim();
	if (!raw || raw.length > MAX_URL_CHARS) return undefined;
	try {
		// Deliberate, documented parse probe: `new URL` is the test for "is this a usable link", not a fallible
		// operation on a value we expect to parse. Most hosted-search hits are fine, but an occasional malformed
		// one is routine model output, not a bug worth a diagnostic line.
		const parsed = new URL(raw);
		return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname.includes(".") ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** A host in the form `new URL` gives (lowercase, punycode), minus one trailing dot of a fully-qualified name. */
function hostForm(host: string): string {
	return host.replace(/\.$/, "");
}

/** An allowlist entry in the same form as a URL host; undefined for a blank entry. */
function domainForm(domain: string): string | undefined {
	const trimmed = domain.trim();
	if (!trimmed) return undefined;
	try {
		return hostForm(new URL(`http://${trimmed}`).hostname);
	} catch (error) {
		logEvent("warn", "hosted-search", "bad-domain-entry", { length: trimmed.length }, error); // not a host: compared as typed, so it matches nothing real
		return trimmed.toLowerCase();
	}
}

/** True when the page is on one of the sites, or a subdomain of one. */
export function onDomains(url: string, domains: string[]): boolean {
	const host = hostForm(new URL(url).hostname);
	return domains.some((entry) => {
		const domain = domainForm(entry);
		return domain !== undefined && (host === domain || host.endsWith(`.${domain}`));
	});
}

/** The end of the balanced `{...}` that starts at `start`, counting braces outside strings; -1 when it never closes. */
function objectEnd(output: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < output.length; i++) {
		const char = output[i];
		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return i;
	}
	return -1;
}

/** The first balanced top-level object in the text that has a `results` array, or undefined. */
function firstResultsObject(output: string): any {
	for (let start = output.indexOf("{"); start !== -1; start = output.indexOf("{", start + 1)) {
		const end = objectEnd(output, start);
		if (end === -1) continue;
		try {
			const parsed = JSON.parse(output.slice(start, end + 1));
			if (parsed && typeof parsed === "object" && Array.isArray(parsed.results)) return parsed;
		} catch {
			// Deliberate, documented parse probe: prose like `{as asked}` is balanced but not JSON, so the scan moves on; no match at all ends in MALFORMED_RESPONSE below.
		}
	}
	return undefined;
}

/** The worker's answer as hits. The model was told to answer with JSON only; a code fence or a stray sentence around it is tolerated, anything else is malformed. */
export function parseHostedSearch(output: string): { answer: string; hits: SearchHit[] } {
	const parsed = firstResultsObject(output);
	if (!parsed) throw new SafeToolError("MALFORMED_RESPONSE");
	const hits: SearchHit[] = [];
	let dropped = 0;
	for (const entry of parsed.results) {
		const url = pageUrl(entry?.url);
		if (!url) {
			dropped++;
			continue;
		}
		const quotes = (Array.isArray(entry?.quotes) ? entry.quotes : typeof entry?.quotes === "string" ? [entry.quotes] : []).map((quote: unknown) => text(quote, MAX_QUOTE_CHARS)).filter(Boolean).slice(0, MAX_QUOTES);
		hits.push({ title: text(entry?.title, 160), url, date: text(entry?.date, 40), snippet: quotes.join(" … ") });
	}
	if (dropped) logEvent("warn", "hosted-search", "links-dropped", { dropped, total: parsed.results.length, reason: "not a whole http(s) link with a host, or over 512 chars" });
	return { answer: text(parsed.answer, 600), hits };
}

export function createHostedSearch(worker: PiWorker): HostedSearch {
	return async (query, signal) => {
		const output = await worker({ prompt: hostedSearchPrompt(query), system: COACH_YAML.tools.web_search.searchSystem, hostedSearch: true, tier: "quick", timeoutMs: SEARCH_TIMEOUT_MS, signal });
		const { answer, hits } = parseHostedSearch(output);
		// The site filter is only a sentence in the prompt to the worker, so it is enforced here: a hit from another site is dropped, and so is the
		// answer when any hit went (or none is left), since the worker may have written it from that page.
		const filtered = Boolean(query.domains?.length);
		const kept = filtered ? hits.filter((hit) => onDomains(hit.url, query.domains as string[])) : hits;
		return { provider: "hosted web search (model provider)", answer: filtered && (kept.length === 0 || kept.length < hits.length) ? "" : answer, hits: kept };
	};
}
