/**
 * Perplexity/Typesafe/Gemini key precedence: process env > `.env` file > the key store behind the helper
 * child. `bin/coach.mjs`'s `loadCoachEnv` decides the two raw facts below once (it is the only place
 * env-vs-`.env` is knowable) and forwards them as one `VOXREN_KEY_SOURCE_<NAME>` string per secret.
 * `resolveKeySource` is the one place the actual precedence decision is made from those facts; both
 * `src/index.ts`'s header note and a later stage's `/config` Keys-row label call it with the same two
 * inputs, so they can never disagree.
 */

export type KeySourceTag = "env" | "dotenv";
export type KeySource = "env" | "dotenv" | "store";

export interface KeySourceInput {
	/** Which tier produced the active env-side value, if either did; undefined when neither env nor `.env` had one. */
	envTag?: KeySourceTag;
	/** Whether the key store also holds a value for this secret, independent of which tier is active. */
	stored: boolean;
}

export interface KeySourceResult {
	/** Where the active value came from; undefined when nothing is available anywhere. */
	source?: KeySource;
	/** Whether a usable value exists at all. */
	active: boolean;
	/** True only when env/`.env` won while the store also holds a value -- that stored value is shadowed. */
	shadowsStore: boolean;
}

export function resolveKeySource({ envTag, stored }: KeySourceInput): KeySourceResult {
	if (envTag) return { source: envTag, active: true, shadowsStore: stored };
	if (stored) return { source: "store", active: true, shadowsStore: false };
	return { active: false, shadowsStore: false };
}

/**
 * Decodes `bin/coach.mjs`'s `VOXREN_KEY_SOURCE_<NAME>` value back into the two raw facts
 * `resolveKeySource` needs: `"env"` / `"dotenv"` / `"store"`, or either env tag plus `"+store"` when
 * that tier is also shadowing a stored value (`"env+store"`, `"dotenv+store"`). Unset (undefined)
 * means bin/coach.mjs found no value anywhere for this secret.
 */
export function parseKeySourceTag(raw: string | undefined): KeySourceInput {
	if (!raw) return { stored: false };
	if (raw === "store") return { stored: true };
	const [tag, suffix] = raw.split("+");
	return { envTag: tag === "env" || tag === "dotenv" ? tag : undefined, stored: suffix === "store" };
}
