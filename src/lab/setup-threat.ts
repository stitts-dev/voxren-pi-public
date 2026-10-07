/**
 * F1 (docs/comp-lab.md): the `setupUngrounded` scorer only checks that a `/comp` setup row names a
 * threat, never that it's the RIGHT threat for the named item. A cleanse-family item's own Data Dragon
 * description names what it does NOT remove ("excluding Airborne"); a row claiming the item removes one
 * of those excluded threats is a factual error the string scorer otherwise can't catch.
 */
const THREAT_SYNONYMS: Record<string, RegExp> = { airborne: /knock-?up|knockback|airborne|displace/i };
const NEGATION_BEFORE = /\b(not|won'?t|will not|doesn'?t|does not|except|excluding|other than)\b[^.]{0,40}$/i;

/** The threats an item's own tooltip excludes from its cleanse/removal effect, e.g. `["airborne"]`. */
export function excludedThreats(description: string): string[] {
	const match = description.match(/excluding\s*<[^>]*>?\s*([a-z][a-z\s]*)</i) ?? description.match(/excluding ([a-z][a-z\s,]*)/i);
	if (!match) return [];
	return match[1].split(/,| and /).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

/** True when the row claims `item` removes/cleanses a threat that item's own description excludes, without
 * negating that claim (a row correctly saying "will not remove Wukong's knockup" must not flag). */
export function setupThreatMismatch(item: string, description: string, row: string): boolean {
	if (!row.includes(item)) return false;
	return excludedThreats(description).some((threat) => {
		const synonyms = THREAT_SYNONYMS[threat];
		if (!synonyms) return false;
		const match = synonyms.exec(row);
		return !!match && !NEGATION_BEFORE.test(row.slice(0, match.index));
	});
}
