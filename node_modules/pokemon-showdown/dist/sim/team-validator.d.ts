/**
 * Team Validator
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Handles team validation, and specifically learnset checking.
 *
 * @license MIT
 */
import { type RuleTable } from './dex-formats';
/**
 * Describes a possible way to get a pokemon. Is not exhaustive!
 * sourcesBefore covers all sources that do not have exclusive
 * moves (like catching wild pokemon).
 *
 * First character is a generation number, 1-8.
 * Second character is a source ID, one of:
 *
 * - E = egg, 3rd char+ is the father in gen 2-5, empty in gen 6-7
 *   because egg moves aren't restricted to fathers anymore
 * - S = event, 3rd char+ is the index in .eventData
 * - D = Dream World, only 5D is valid
 * - V = Virtual Console or Let's Go transfer, only 7V/8V is valid
 *
 * Designed to match MoveSource where possible.
 */
export type PokemonSource = string;
/**
 * Represents a set of possible ways to get a Pokémon with a given
 * set.
 *
 * `new PokemonSources()` creates an empty set;
 * `new PokemonSources(dex.gen)` allows all Pokemon.
 *
 * The set mainly stored as an Array `sources`, but for sets that
 * could be sourced from anywhere (for instance, TM moves), we
 * instead just set `sourcesBefore` to a number meaning "any
 * source at or before this gen is possible."
 *
 * In other words, this variable represents the set of all
 * sources in `sources`, union all sources at or before
 * gen `sourcesBefore`.
 */
export declare class PokemonSources {
    /**
     * A set of specific possible PokemonSources; implemented as
     * an Array rather than a Set for perf reasons.
     */
    sources: PokemonSource[];
    /**
     * if nonzero: the set also contains all possible sources from
     * this gen and earlier.
     */
    sourcesBefore: number;
    /**
     * the set requires sources from this gen or later
     * this should be unchanged from the format's minimum past gen
     * (3 in modern games, 6 if pentagon is required, etc)
     */
    sourcesAfter: number;
    isHidden: boolean | null;
    /**
     * `limitedEggMoves` is a list of moves that can only be obtained from an
     * egg with another father in gen 2-5. If there are multiple such moves,
     * potential fathers need to be checked to see if they can actually
     * learn the move combination in question.
     *
     * `null` = the current move is definitely not a limited egg move
     *
     * `undefined` = the current move may or may not be a limited egg move
     */
    limitedEggMoves?: ID[] | null;
    /**
     * Moves that should be in limitedEggMoves that would otherwise be skipped
     * because they can be learned universally in a past generation
     */
    possiblyLimitedEggMoves?: ID[] | null;
    /**
     * Moves that should be in limitedEggMoves that would otherwise be skipped
     * because they can be learned via Gen 1-2 tradeback
     */
    tradebackLimitedEggMoves?: ID[] | null;
    /**
     * Tracks level up egg moves for female-only Pokemon
     */
    levelUpEggMoves?: ID[] | null;
    /**
     * Moves that can be learned via Pomeg glitch and does not require a
     * particular parent to learn
     */
    pomegEggMoves?: ID[] | null;
    /**
     * Event egg source that may be used with the Pomeg glitch
     *
     * `null` = definitely not an event egg that can be used with the Pomeg glitch
     */
    pomegEventEgg?: string | null;
    /**
     * For event-only Pokemon that do not have a minimum source gen identified by its moves
     */
    eventOnlyMinSourceGen?: number;
    /**
     * A list of movepools, identified by gen and species, which moves can be pulled from.
     * Used to deal with compatibility issues for prevo/evo-exclusive moves
     */
    learnsetDomain?: string[] | null;
    /**
     * A list of moves which are incompatible with a Pokemon GO origin,
     * used to generate error messages
     */
    goIncompatibleMoves?: string[];
    /**
     * Some Pokemon evolve by having a move in their learnset (like Piloswine
     * with Ancient Power). These can only carry three other moves from their
     * prevo, because the fourth move must be the evo move. This restriction
     * doesn't apply to gen 6+ eggs, which can get around the restriction with
     * the relearner.
     */
    moveEvoCarryCount: number;
    babyOnly?: string;
    sketchMove?: string;
    dreamWorldMoveCount: number;
    hm?: string;
    isFromPokemonGo?: boolean;
    pokemonGoSource?: string;
    restrictiveMoves?: string[];
    /** Obscure learn methods */
    restrictedMove?: ID;
    constructor(sourcesBefore?: number, sourcesAfter?: number);
    size(): number;
    add(source: PokemonSource, limitedEggMove?: ID | null): void;
    addGen(sourceGen: number): void;
    minSourceGen(): number;
    maxSourceGen(): number;
    intersectWith(other: PokemonSources): void;
    addGoIncompatibleMove(move: string): void;
}
export declare class TeamValidator {
    readonly format: Format;
    readonly dex: ModdedDex;
    readonly gen: number;
    readonly ruleTable: RuleTable;
    readonly minSourceGen: number;
    readonly toID: (str: any) => ID;
    constructor(format: string | Format, dex?: import("./dex").ModdedDex);
    validateTeam(team: PokemonSet[] | null, options?: {
        removeNicknames?: boolean;
        skipSets?: {
            [name: string]: {
                [key: string]: boolean;
            };
        };
    }): string[] | null;
    baseValidateTeam(team: PokemonSet[] | null, options?: {
        removeNicknames?: boolean;
        skipSets?: {
            [name: string]: {
                [key: string]: boolean;
            };
        };
    }): string[] | null;
    getEventOnlyData(species: Species, noRecurse?: boolean): {
        species: Species;
        eventData: EventInfo[];
    } | null;
    getValidationSpecies(set: PokemonSet): {
        outOfBattleSpecies: Species;
        tierSpecies: Species;
    };
    validateSet(set: PokemonSet, teamHas: AnyObject): string[] | null;
    validateStats(set: PokemonSet, species: Species, setSources: PokemonSources, pokemonGoProblems: string[] | null): string[];
    /**
     * Not exhaustive, just checks Atk and Spe, which are the only competitively
     * relevant IVs outside of extremely obscure situations.
     */
    possibleBottleCapHpType(type: string, ivs: StatsTable): boolean;
    validateSource(set: PokemonSet, source: PokemonSource, setSources: PokemonSources, species: Species, because: string): string[] | undefined;
    validateSource(set: PokemonSet, source: PokemonSource, setSources: PokemonSources, species: Species): true | undefined;
    findEggMoveFathers(source: PokemonSource, species: Species, setSources: PokemonSources, getAll?: false, pokemonBlacklist?: ID[], noRecurse?: true): boolean;
    findEggMoveFathers(source: PokemonSource, species: Species, setSources: PokemonSources, getAll?: true): ID[] | null;
    /**
     * We could, if we wanted, do a complete move validation of the father's
     * moveset to see if it's valid. This would recurse and be NP-Hard so
     * instead we won't. We'll instead use a simplified algorithm: The father
     * is allowed to have multiple egg moves and a maximum of one move from
     * any other restrictive source; recursion is done only if there are less
     * egg moves to validate or if the father has an egg group it doesn't
     * share with the egg Pokemon. Recursion is also limited to two iterations
     * of calling findEggMoveFathers.
     */
    fatherCanLearn(baseSpecies: Species, species: Species, moves: ID[], eggGen: number, pokemonBlacklist: ID[], noRecurse: boolean | undefined): boolean;
    motherCanLearn(species: ID, move: ID): boolean;
    validateForme(set: PokemonSet): string[];
    checkSpecies(set: PokemonSet, species: Species, tierSpecies: Species, setHas: {
        [k: string]: true;
    }): string | null;
    checkTagRules(set: PokemonSet, thing: Species | Item | Move, setHas?: {
        [k: string]: true;
    }): string | null | undefined;
    checkItem(set: PokemonSet, item: Item, setHas: {
        [k: string]: true;
    }): string | null;
    checkMove(set: PokemonSet, move: Move, setHas: {
        [k: string]: true;
    }): string | null;
    checkAbility(set: PokemonSet, ability: Ability, setHas: {
        [k: string]: true;
    }): string | null;
    checkNature(set: PokemonSet, nature: Nature, setHas: {
        [k: string]: true;
    }): string | null;
    validateEvent(set: PokemonSet, setSources: PokemonSources, eventData: EventInfo, eventSpecies: Species): true | undefined;
    validateEvent(set: PokemonSet, setSources: PokemonSources, eventData: EventInfo, eventSpecies: Species, because: string, from?: string): string[] | undefined;
    allSources(species?: Species): PokemonSources;
    validateMoves(species: Species, moves: string[], setSources: PokemonSources, set?: Partial<PokemonSet>, name?: string, moveLegalityWhitelist?: {
        [k: string]: true | undefined;
    }): string[];
    /**
     * Returns a list of problems regarding a Pokemon's availability in Pokemon GO (empty list if no problems)
     * If the Pokemon cannot be obtained from Pokemon GO, returns null
     */
    validatePokemonGo(species: Species, set: PokemonSet, setSources: PokemonSources, name?: string): string[] | null;
    omCheckCanLearn(move: Move, s: Species, setSources?: PokemonSources, set?: Partial<PokemonSet>, problem?: string): string | null;
    /** Returns null if you can learn the move, or a string explaining why you can't learn it */
    checkCanLearn(move: Move, originalSpecies: Species, setSources?: PokemonSources, set?: Partial<PokemonSet>): string | null;
    getExternalLearnsetData(species: ID, mod: string): import("./dex-species").Learnset | null;
    static fillStats(stats: SparseStatsTable | null, fillNum?: number): StatsTable;
    static get(format: string | Format): TeamValidator;
}
