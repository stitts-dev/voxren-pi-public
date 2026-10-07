import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { COACH_YAML, RESEARCH_CONTRACT_VERSION, VOXREN_COMMAND_FRAME_TOOL, VOXREN_OTP_BUILD_TOOL, VOXREN_PLAYER_AUDIT_TOOL, VOXREN_REMEMBER_TOOL, type GatewayOperation, type ResearchGateway, type VoxrenToolName } from "./contracts";
import { type ChartGame, itemTimings, prepareAuditCharts, sceneChampions } from "./charts";
import { prefetchChampionIcons, prefetchItemIcons } from "./icons";
import { logEvent } from "./coach-log";
import { SafeToolError, assertAbortNotRequested, assertGatewayResponse, modelText, safeToolFailure } from "./policy";
import { ResearchServiceError } from "./research-service";
import { createToolCall, createToolResult, toolResultView, type CardDetail, type CardMotion, type ToolRenderState } from "./ui";

const strict = { additionalProperties: false };
const entitySchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("item"), Type.Literal("champion"), Type.Literal("rune"), Type.Literal("spell")]),
		name: Type.String({ minLength: 1, maxLength: 80 }),
	},
	strict,
);
const evidenceIdSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) }, strict);

const webSearchSchema = Type.Object(
	{
		query: Type.String({ minLength: 3, maxLength: 300 }),
		domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253, pattern: "^[A-Za-z0-9.-]+$" }), { maxItems: 10 })),
		freshness_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
		max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
	},
	strict,
);
const videoResearchParams = COACH_YAML.tools.voxren_video_research.parameters!;
const videoResearchSchema = Type.Object(
	{
		query: Type.String({ minLength: 3, maxLength: 200, description: videoResearchParams.query }),
		focus: Type.Optional(Type.String({ minLength: 3, maxLength: 300, description: videoResearchParams.focus })),
		title_terms: Type.Optional(Type.Array(Type.String({ minLength: 2, maxLength: 40, pattern: "^[A-Za-z0-9' .&-]+$" }), { maxItems: 4, description: videoResearchParams.title_terms })),
	},
	strict,
);
const gameFactsSchema = Type.Object(
	{
		entities: Type.Array(entitySchema, { minItems: 1, maxItems: 20 }),
		patch: Type.Optional(Type.String({ minLength: 1, maxLength: 24, pattern: "^[0-9]+\\.[0-9]+(?:\\.[0-9]+)?$" })),
		detail: Type.Literal("compact"),
	},
	strict,
);
/** One list feeds both the model-visible schema and Value.Check, so they cannot drift. */
function literals(values: readonly string[], description?: string) {
	return Type.Union(values.map((value) => Type.Literal(value)), description ? { description } : {});
}
const POSITIONS = ["top", "jungle", "middle", "bottom", "support"] as const;
/** OP.GG rank filters (probed live 2026-09-26); omitting tier returns OP.GG's default Emerald+ sample. */
const OPGG_TIERS = ["all", "iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger", "platinum_plus", "emerald_plus", "diamond_plus", "master_plus"] as const;
/** OP.GG server slugs. */
const OPGG_REGIONS = ["na", "euw", "eune", "kr", "jp", "br", "lan", "las", "oce", "tr", "ru", "me", "sg", "ph", "th", "tw", "vn"] as const;
const championName = Type.String({ minLength: 1, maxLength: 80 });

/**
 * voxren_meta_research covers five OP.GG query types in one schema; query_type
 * picks the variant, so each carries only the fields that query needs.
 */
/** query_type-specific parameter descriptions live in coach.yaml (AGENTS.md rule 1), not here. */
const metaResearchParams = COACH_YAML.tools.voxren_meta_research.parameters!;
const championOverviewQuery = Type.Object(
	{
		query_type: Type.Literal("champion_overview"),
		champion: championName,
		position: Type.Optional(literals(POSITIONS)),
		tier: Type.Optional(literals(OPGG_TIERS, metaResearchParams.tier)),
	},
	strict,
);
const matchupQuery = Type.Object(
	{
		query_type: Type.Literal("matchup"),
		champion: championName,
		opponent: Type.String({ minLength: 1, maxLength: 80, description: metaResearchParams.opponent }),
		position: literals(POSITIONS),
	},
	strict,
);
const tierListQuery = Type.Object({ query_type: Type.Literal("tier_list"), position: literals(POSITIONS) }, strict);
const synergyQuery = Type.Object(
	{
		query_type: Type.Literal("synergy"),
		champion: championName,
		position: literals(POSITIONS),
		ally_position: literals(POSITIONS, metaResearchParams.ally_position),
	},
	strict,
);
const topPlayersQuery = Type.Object({ query_type: Type.Literal("top_players"), champion: championName, region: literals(OPGG_REGIONS) }, strict);
const proPlayerRiotIdQuery = Type.Object(
	{
		query_type: Type.Literal("pro_player_riot_id"),
		player_name: Type.String({ minLength: 1, maxLength: 80, description: metaResearchParams.player_name }),
		region: literals(OPGG_REGIONS),
	},
	strict,
);

const metaResearchSchema = Type.Union([championOverviewQuery, matchupQuery, tierListQuery, synergyQuery, topPlayersQuery, proPlayerRiotIdQuery]);

/** query_type -> the internal gateway operation voxren_meta_research dispatches to. */
const META_OPERATION: Record<string, GatewayOperation> = {
	champion_overview: "meta.champion_overview",
	matchup: "meta.matchup",
	tier_list: "meta.tier_list",
	synergy: "meta.synergy",
	top_players: "meta.top_players",
	pro_player_riot_id: "meta.pro_player_riot_id",
};
const strategyFrameSchema = Type.Object(
	{
		question: Type.String({ minLength: 3, maxLength: 1200 }),
		claims: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 8, description: COACH_YAML.tools.voxren_strategy_frame.parameters!.claims }),
		evidence: Type.Array(evidenceIdSchema, { minItems: 1, maxItems: 12 }),
	},
	strict,
);

const playerAuditSchema = Type.Object(
	{
		// No \p{..} classes: the openai-codex schema validator rejects them ("is not a 'regex'") and the whole launch fails. The gateway's RIOT_ID_PATTERN check is the real one; this copy only refuses what is plainly not a Riot ID.
		riot_id: Type.Optional(Type.String({ minLength: 3, maxLength: 22, pattern: "^[^#\\r\\n\"\\x00-\\x1f\\x7f]{3,16}#[^#\\s\"]{3,5}$" })),
		count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		champion: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
	},
	strict,
);

const otpBuildSchema = Type.Object(
	{
		player: Type.String({ minLength: 3, maxLength: 200, description: COACH_YAML.tools.voxren_otp_build.parameters!.player }),
		champion: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
		count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		region: Type.Optional(Type.Union([Type.Literal("americas"), Type.Literal("asia"), Type.Literal("europe"), Type.Literal("sea")])),
	},
	strict,
);

const rememberSchema = Type.Object({ text: Type.String({ minLength: 1, maxLength: 200, description: COACH_YAML.tools.voxren_remember.parameters!.text }) }, strict);

/** Every command some client phase offers as a frame (jev.command.phases); the phase at call time decides which of them load (src/index.ts). */
const FRAME_COMMANDS = [...new Set(Object.values(COACH_YAML.jev.command.phases).flat())].filter((name) => name !== "none");
const commandFrameSchema = Type.Object({ command: literals(FRAME_COMMANDS, COACH_YAML.tools.voxren_command_frame.parameters!.command) }, strict);

function tool(
	name: VoxrenToolName,
	label: string,
	parameters: TSchema,
	operation: GatewayOperation | ((input: Record<string, unknown>) => GatewayOperation),
	gateway: ResearchGateway,
	motion?: CardMotion,
	detail?: CardDetail,
) {
	const { description } = COACH_YAML.tools[name];
	return {
		name,
		label,
		description,
		promptSnippet: description,
		parameters,
		async execute(_toolCallId: string, rawInput: unknown, signal?: AbortSignal) {
			try {
				// The schema the model sees is the trust boundary: one definition of what each tool accepts.
				if (!Value.Check(parameters, rawInput)) throw new SafeToolError("VALIDATION");
				const input = rawInput as Record<string, unknown>;
				const resolvedOperation = typeof operation === "function" ? operation(input) : operation;
				const response = await gateway.call(resolvedOperation, input, signal);
				assertGatewayResponse(response, resolvedOperation);
				if (resolvedOperation === "player_audit") {
					const dd = gateway.dataDragonInfo?.();
					const timings = itemTimings(response.data);
					const names = [...new Set([...Object.keys(timings?.mine ?? {}), ...Object.keys(timings?.reference ?? {})])];
					const games = Array.isArray(response.data.games) ? (response.data.games as ChartGame[]) : [];
					// Icons first: the tracks chart and the per-death maps embed them when they render.
					if (dd) await Promise.all([prefetchItemIcons(names, dd.version, dd.base), prefetchChampionIcons(sceneChampions(games), dd.version, dd.base)]);
					await prepareAuditCharts(games, timings);
				}
				return {
					content: [{ type: "text" as const, text: modelText(response) }],
					details: {
						contractVersion: RESEARCH_CONTRACT_VERSION,
						operation: resolvedOperation,
						evidence: response.evidence.map((entry) => entry.id),
						response,
					},
				};
			} catch (error) {
				// The model and the card get the fixed text for the code; the log keeps the cause (AGENTS.md rule 12).
				logEvent("warn", "tools", "tool-failed", { tool: name, ...(error instanceof ResearchServiceError ? { cause: error.serviceCode } : {}) }, error);
				return safeToolFailure(error);
			}
		},
		// Width-aware cards instead of raw contract JSON; see ui.ts.
		renderShell: "self" as const, // no padding rows and no background: the card draws its own bar (ui.ts)
		renderCall(args: Record<string, unknown> | undefined, theme: any, context?: ToolRenderState) {
			return createToolCall(theme, name, args, context, motion);
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context?: ToolRenderState & { args?: Record<string, unknown> }) {
			return createToolResult(theme, name, context?.args, toolResultView(result), options.expanded, context, motion, detail);
		},
	};
}

/** `gateway` plus the one operation no data source answers, command_frame: `load` (src/index.ts) returns its data, the frame or why there is none. */
export function withCommandFrames(gateway: ResearchGateway, load: (command: string) => Promise<Record<string, unknown>>): ResearchGateway {
	return {
		call: async (operation, input, signal) => {
			if (operation !== "command_frame") return gateway.call(operation, input, signal);
			assertAbortNotRequested(signal);
			return { version: RESEARCH_CONTRACT_VERSION, operation, data: await load(String(input.command)), evidence: [] };
		},
		close: () => gateway.close(),
		dataDragonInfo: () => gateway.dataDragonInfo?.(),
		championLane: (name) => gateway.championLane?.(name) ?? Promise.resolve(undefined),
	};
}

/** `motion` is the session's card clock (index.ts); without one, pending cards draw static lines. `detail` is the level an expanded card opens at (VOXREN_COACH_CARD_DETAIL); without one, the claims level. */
export function createCoachTools(gateway: ResearchGateway, motion?: CardMotion, detail?: CardDetail) {
	return [
		tool("web_search", "Web Search", webSearchSchema, "research_web_search", gateway, motion, detail),
		tool("voxren_game_facts", "Game Facts", gameFactsSchema, "gamedata.lookup", gateway, motion, detail),
		tool("voxren_meta_research", "Meta Research", metaResearchSchema, (input) => META_OPERATION[String(input.query_type)], gateway, motion, detail),
		tool("voxren_strategy_frame", "Strategy Frame", strategyFrameSchema, "strategy_frame", gateway, motion, detail),
		tool(VOXREN_PLAYER_AUDIT_TOOL, "Player Audit", playerAuditSchema, "player_audit", gateway, motion, detail),
		tool(VOXREN_OTP_BUILD_TOOL, "OTP Build", otpBuildSchema, "otp_build", gateway, motion, detail),
		tool(VOXREN_REMEMBER_TOOL, "Remember", rememberSchema, "remember", gateway, motion, detail),
		// The video tool and the frame tool come last, so the tools before them keep the positions tests and labs index them by.
		tool("voxren_video_research", "Video Research", videoResearchSchema, "research_video", gateway, motion, detail),
		tool(VOXREN_COMMAND_FRAME_TOOL, "Command Frame", commandFrameSchema, "command_frame", gateway, motion, detail),
	];
}
