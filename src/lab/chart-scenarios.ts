import type { DeathMark } from "../audit-metrics";
import type { ChartGame, ItemTimings } from "../charts";

/**
 * Audit shapes the charts must survive, shared by the chart gallery (`just charts`) and coach.test.ts so a
 * picture a human checked and a layout a test checks come from the same data. Positions are Riot map units.
 */

export interface ChartScenario {
	name: string;
	about: string;
	games: ChartGame[];
	timings?: ItemTimings;
}

/**
 * A death with its scene: the lane opponent on the kill beside it, the enemy jungler arriving on every other one, an
 * ally near every third, and the frame anywhere from 28 s before to 28 s after, so fresh and faded tiles both draw.
 * Its damage: the laner's ability first, then the jungler's attacks on a gank, a tower otherwise.
 */
const death = (min: number, x: number, y: number): DeathMark => {
	const n = Math.round(min * 10);
	const gank = n % 2 === 0;
	return {
		min,
		x,
		y,
		afterAllyDeath: false,
		traded: false,
		scene: {
			killers: gank ? ["TwistedFate", "LeeSin"] : ["TwistedFate"],
			offsetSec: ((n * 7) % 57) - 28,
			champions: [
				{ name: "TwistedFate", ally: false, x: x + 500, y: y + 350 },
				...(gank ? [{ name: "LeeSin", ally: false, x: x - 900, y: y + 1300 }] : []),
				...(n % 3 === 0 ? [{ name: "Vi", ally: true, x: x - 1700, y: y - 1100 }] : []),
			],
		},
		damage: gank
			? [{ from: "TwistedFate", how: "Q", pct: 41 }, { from: "LeeSin", how: "autos", pct: 27 }, { from: "LeeSin", how: "R", pct: 18 }]
			: [{ from: "TwistedFate", how: "W", pct: 46 }, { from: "tower", how: "", pct: 31 }],
	};
};
/** A gold curve that drifts by `slope` a minute with a swing, so no two games draw the same line. */
const curve = (minutes: number, slope: number, swing = 250, phase = 0) => Array.from({ length: minutes + 1 }, (_, m) => Math.round(m * slope + Math.sin(m / 2 + phase) * swing * Math.min(1, m / 4)));

/** The same death with no scene and no damage, as a timeline Riot sent no positions for: most scenarios stay this way, so the chart tests draw the maps a few times, not for every game. */
const bare = ({ scene: _scene, damage: _damage, ...mark }: DeathMark): DeathMark => mark;
const MID = [death(3.5, 4200, 11800), death(16, 7300, 7400), death(17, 7600, 7100), death(24, 9800, 4600)];
const BUILD = [
	{ name: "Dark Seal", min: 3.5 },
	{ name: "Blackfire Torch", min: 10.3 },
	{ name: "Seeker's Armguard", min: 16.5 },
	{ name: "Zhonya's Hourglass", min: 21 },
];
const OPPONENTS = ["TwistedFate", "Ahri", "Syndra", "Zed", "Orianna", "LeBlanc", "Viktor", "Azir", "Sylas", "Yasuo"];
const TIMINGS: ItemTimings = {
	games: 5,
	mine: { "Dark Seal": 3.6, "Blackfire Torch": 11, "Sorcerer's Shoes": 13, "Zhonya's Hourglass": 22 },
	counts: { "Dark Seal": 5, "Blackfire Torch": 5, "Sorcerer's Shoes": 4, "Zhonya's Hourglass": 3 },
	reference: { "Dark Seal": 3, "Blackfire Torch": 9.5, "Zhonya's Hourglass": 18.9, "Rabadon's Deathcap": 24 },
};

/** Deaths spread over the whole map, for the busiest heat map. */
const everywhere = (n: number) => Array.from({ length: n }, (_, i) => death(2 + (i % 30), 1500 + ((i * 3701) % 12000), 1500 + ((i * 5923) % 12000)));

export const CHART_SCENARIOS: ChartScenario[] = [
	{
		name: "one-loss",
		about: "one lost game: four items, deaths early and late, two in the same fight",
		games: [{ id: "one-loss", win: false, vs: "TwistedFate", gd15: -904, chart: { gd: curve(25, -120), deaths: MID, kills: [2, 3, 7, 8, 17, 18, 20], items: BUILD } }],
	},
	{
		name: "one-stomp",
		about: "one won game far ahead: no deaths, gold only above zero",
		games: [{ id: "one-stomp", win: true, vs: "Ahri", gd15: 2600, chart: { gd: curve(22, 180, 120), deaths: [], kills: [4, 6, 9, 11, 14, 19], items: BUILD.slice(0, 3) } }],
	},
	{
		name: "one-short",
		about: "one six-minute game: no items finished, one death",
		games: [{ id: "one-short", win: false, vs: "Zed", gd15: -300, chart: { gd: curve(6, -50), deaths: [bare(death(4.2, 5200, 9800))], kills: [], items: [] } }],
	},
	{
		name: "one-long",
		about: "one 45-minute game: seven items, a dozen deaths, labels crowding the timeline",
		games: [
			{
				id: "one-long",
				win: true,
				vs: "Viktor",
				gd15: -150,
				chart: {
					gd: curve(45, 40, 600),
					deaths: everywhere(12),
					kills: [5, 9, 14, 21, 22, 30, 36, 41],
					items: [...BUILD, { name: "Rabadon's Deathcap", min: 27 }, { name: "Void Staff", min: 33 }, { name: "Mejai's Soulstealer", min: 38 }],
				},
			},
		],
	},
	{
		name: "five-games",
		about: "five games with item timings: collapsed, gold strips in the table; expanded, the worst card, heat map, and item tracks",
		games: OPPONENTS.slice(0, 5).map((vs, i) => ({ id: `five-${i}`, vs, win: i % 2 === 1, gd15: (i - 2) * 600, chart: { gd: curve(24 + i * 2, (i - 2) * 60, 300, i), deaths: MID.slice(i % 3, (i % 3) + 3), kills: [4, 9, 14], items: BUILD } })),
		timings: TIMINGS,
	},
	{
		name: "ten-with-remake",
		about: "ten games, one a three-minute remake: the remake stays off every chart and gets no gold strip",
		games: [
			{ id: "remake", vs: "Lux", win: false, remake: true, gd15: 0, chart: { gd: [0, 20, -10, 0], deaths: [], kills: [], items: [] } },
			...OPPONENTS.slice(0, 9).map((vs, i) => ({ id: `ten-${i}`, vs, win: i % 2 === 0, gd15: (i - 4) * 400, chart: { gd: curve(22 + i, (i - 4) * 50, 250, i), deaths: MID.slice(i % 4, (i % 4) + 2).map(bare), kills: [5, 11], items: BUILD.slice(0, 3) } })),
		],
	},
	{
		name: "twenty-games",
		about: "twenty games: twenty gold strips once expanded, and a dense heat map",
		games: Array.from({ length: 20 }, (_, i) => ({ id: `twenty-${i}`, vs: OPPONENTS[i % OPPONENTS.length], win: i % 3 !== 0, gd15: ((i * 7) % 11 - 5) * 300, chart: { gd: curve(20 + (i % 15), ((i * 7) % 11 - 5) * 40, 300, i), deaths: everywhere(40).slice(i * 2, i * 2 + 4).map(bare), kills: [6, 12], items: BUILD.slice(0, 2) } })),
	},
];
