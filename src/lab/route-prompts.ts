/**
 * The route lab's hand-labelled prompts, apart from route-lab.ts so a test can read them without running the lab. Each row names the client phase it is
 * asked in, the command a player would want (or "none" for a plain turn) and the tier a player would want. Champion names are test data, not game constants in code.
 */
import type { CommandPhase, TierName } from "../contracts";

export interface RoutePrompt {
	phase: CommandPhase;
	command: string;
	label: TierName;
	prompt: string;
}

export const ROUTE_PROMPTS: RoutePrompt[] = [
	{ phase: "lobby", command: "none", label: "quick", prompt: "what's fizz's e cooldown at rank 3" },
	{ phase: "lobby", command: "none", label: "quick", prompt: "how much damage does fizz's w do at level 6" },
	{ phase: "lobby", command: "none", label: "quick", prompt: "what does riftmaker's passive do" },
	{ phase: "lobby", command: "none", label: "quick", prompt: "how long does ignite's burn last" },
	{ phase: "champSelect", command: "none", label: "quick", prompt: "what's the cooldown on flash" },
	{ phase: "champSelect", command: "none", label: "quick", prompt: "does black cleaver's passive stack" },
	{ phase: "champSelect", command: "none", label: "quick", prompt: "what patch are we on" },
	{ phase: "liveGame", command: "none", label: "quick", prompt: "how much magic resist does seeker's armguard give" },
	{ phase: "liveGame", command: "none", label: "quick", prompt: "what's fizz's base movement speed" },
	{ phase: "liveGame", command: "none", label: "quick", prompt: "is playful trickster fizz's ultimate" },
	{ phase: "champSelect", command: "matchup", label: "standard", prompt: "how do i play fizz into syndra" },
	{ phase: "champSelect", command: "build", label: "standard", prompt: "what should i build into a full ap team as fizz" },
	{ phase: "champSelect", command: "build", label: "standard", prompt: "should i take teleport or ignite into a lane bully" },
	{ phase: "lobby", command: "build", label: "standard", prompt: "what's the best rune page for fizz mid right now" },
	{ phase: "champSelect", command: "matchup", label: "standard", prompt: "how do i survive the fizz vs annie matchup" },
	{ phase: "liveGame", command: "none", label: "standard", prompt: "should i roam bot at level 6 or keep pushing top" },
	{ phase: "liveGame", command: "build", label: "standard", prompt: "what's a good build order into heavy poke" },
	{ phase: "liveGame", command: "matchup", label: "standard", prompt: "how do i punish a syndra who overextends" },
	{ phase: "liveGame", command: "build", label: "standard", prompt: "should i buy zhonya's or banshee's into zed" },
	{ phase: "champSelect", command: "matchup", label: "standard", prompt: "what's the right skill order into a short trade lane like lux" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "review my last 10 games and tell me my top 3 habits" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "compare my win rate on fizz to my win rate on other champions this season and tell me if i should one-trick" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "look at my deaths across my last 20 ranked games and find the pattern" },
	{ phase: "champSelect", command: "draft", label: "deep", prompt: "plan out my whole game from level 1 to the first baron for a fizz one-trick into a poke comp" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "which of my last 10 losses were decided in lane versus decided by a late-game teamfight" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "compare rushing lich bane against rushing riftmaker across my recent games and tell me which wins more" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "walk me through every objective decision i made in my last game and grade each one" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "am i dying more to ganks or to overextending on my own, based on my recent audits" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "build a plan for climbing out of my current rank based on my win rate by champion and role" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "compare my early death rate this patch to last patch and tell me what changed" },
	{ phase: "lobby", command: "patch", label: "standard", prompt: "what changed for fizz in the latest patch" },
	{ phase: "lobby", command: "patch", label: "quick", prompt: "which of fizz's abilities changed in the current patch" },
	{ phase: "lobby", command: "patch", label: "quick", prompt: "did fizz get nerfed this patch" },
	{ phase: "lobby", command: "build", label: "standard", prompt: "what's the first item i should rush on fizz right now" },
	{ phase: "lobby", command: "build", label: "standard", prompt: "which summoner spells and runes should i take on fizz this patch" },
	{ phase: "lobby", command: "review", label: "deep", prompt: "what is costing me the most games lately" },
	{ phase: "lobby", command: "review", label: "standard", prompt: "how did my last game go" },
	{ phase: "lobby", command: "none", label: "quick", prompt: "what does a rift herald do" },
	{ phase: "lobby", command: "none", label: "quick", prompt: "thanks, that helps" },
	{ phase: "lobby", command: "none", label: "quick", prompt: "what is a wave freeze" },
	{ phase: "champSelect", command: "pick", label: "standard", prompt: "is fizz a good pick into this draft" },
	{ phase: "champSelect", command: "pick", label: "standard", prompt: "do i need different runes for this draft" },
	{ phase: "champSelect", command: "draft", label: "deep", prompt: "what's our plan for this whole draft from lane to teamfights" },
	{ phase: "champSelect", command: "comp", label: "standard", prompt: "what's the win condition for our team comp" },
	{ phase: "champSelect", command: "comp", label: "standard", prompt: "how do the fights go between these two comps" },
	{ phase: "champSelect", command: "matchup", label: "standard", prompt: "how do i lane against the kassadin" },
	{ phase: "champSelect", command: "matchup", label: "standard", prompt: "can i all-in my lane opponent at level 3" },
	{ phase: "champSelect", command: "build", label: "standard", prompt: "what should i buy first against this team" },
	{ phase: "champSelect", command: "none", label: "quick", prompt: "what does ignite do" },
	{ phase: "champSelect", command: "none", label: "quick", prompt: "ok thanks" },
	{ phase: "liveGame", command: "none", label: "standard", prompt: "should i back now or push this wave" },
	{ phase: "liveGame", command: "none", label: "standard", prompt: "where should i be for the next dragon" },
	{ phase: "liveGame", command: "build", label: "standard", prompt: "what should i buy with my gold now" },
	{ phase: "liveGame", command: "build", label: "standard", prompt: "what's my next item against this team" },
	{ phase: "liveGame", command: "matchup", label: "standard", prompt: "how do i trade with my lane opponent right now" },
	{ phase: "liveGame", command: "matchup", label: "standard", prompt: "what beats the enemy mid laner" },
	{ phase: "liveGame", command: "none", label: "quick", prompt: "when does baron spawn" },
	{ phase: "liveGame", command: "none", label: "standard", prompt: "i just died, what went wrong" },
	{ phase: "liveGame", command: "none", label: "quick", prompt: "gg" },
	{ phase: "liveGame", command: "none", label: "standard", prompt: "should i fight the next teamfight or split" },
];
