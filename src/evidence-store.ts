import type { EvidenceReference } from "./contracts";

export const MAX_STORED_EVIDENCE = 64;

export interface StoredEvidence {
	source: EvidenceReference["source"];
	title?: string;
	text?: string;
}

/** Ids the model may cite in voxren_strategy_frame, with passage text for the sources Jev may judge. Least recently remembered or recalled evicted past the bound. */
export class EvidenceStore {
	private readonly entries = new Map<string, StoredEvidence>();

	remember(id: string, entry: StoredEvidence): void {
		this.entries.delete(id);
		this.entries.set(id, entry);
		while (this.entries.size > MAX_STORED_EVIDENCE) this.entries.delete(this.entries.keys().next().value as string);
	}

	recall(id: string): StoredEvidence | undefined {
		const entry = this.entries.get(id);
		if (entry) this.remember(id, entry);
		return entry;
	}

	clear(): void {
		this.entries.clear();
	}
}
