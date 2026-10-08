import { BasicEffect } from './dex-data';
interface SpeciesAbility {
    0: string;
    1?: string;
    H?: string;
    S?: string;
}
export interface SpeciesData extends Partial<Species> {
    name: string;
    /** National Dex number */
    num: number;
    types: string[];
    abilities: SpeciesAbility;
    baseStats: StatsTable;
    eggGroups: string[];
    weightkg: number;
}
export interface CosmeticFormeData {
    isCosmeticForme: boolean;
    name: string;
    baseSpecies: string;
    forme: string;
    color: string;
}
export type ModdedSpeciesData = SpeciesData | CosmeticFormeData | Partial<Omit<SpeciesData, 'name'>> & {
    inherit: true;
} | Partial<Omit<CosmeticFormeData, 'isCosmeticForme'>> & {
    inherit: true;
};
export interface SpeciesFormatsData {
    doublesTier?: TierTypes.Doubles | TierTypes.Other;
    gmaxUnreleased?: boolean;
    isNonstandard?: Nonstandard | null;
    natDexTier?: TierTypes.Singles | TierTypes.Other;
    tier?: TierTypes.Singles | TierTypes.Other;
}
export type ModdedSpeciesFormatsData = SpeciesFormatsData & {
    inherit?: true;
};
export interface LearnsetData {
    learnset?: {
        [moveid: IDEntry]: MoveSource[];
    };
    eventData?: EventInfo[];
    eventOnly?: boolean;
    encounters?: EventInfo[];
    exists?: boolean;
}
export type ModdedLearnsetData = LearnsetData & {
    inherit?: true;
};
export interface PokemonGoData {
    encounters?: string[];
    LGPERestrictiveMoves?: {
        [moveid: string]: number | null;
    };
}
export interface SpeciesDataTable {
    [speciesid: IDEntry]: SpeciesData | CosmeticFormeData;
}
export interface ModdedSpeciesDataTable {
    [speciesid: IDEntry]: ModdedSpeciesData;
}
export interface SpeciesFormatsDataTable {
    [speciesid: IDEntry]: SpeciesFormatsData;
}
export interface ModdedSpeciesFormatsDataTable {
    [speciesid: IDEntry]: ModdedSpeciesFormatsData;
}
export interface LearnsetDataTable {
    [speciesid: IDEntry]: LearnsetData;
}
export interface ModdedLearnsetDataTable {
    [speciesid: IDEntry]: ModdedLearnsetData;
}
export interface PokemonGoDataTable {
    [speciesid: IDEntry]: PokemonGoData;
}
/**
 * Describes a possible way to get a move onto a pokemon.
 *
 * First character is a generation number, 1-9.
 * Second character is a source ID, one of:
 *
 * - M = TM/HM
 * - T = tutor
 * - L = start or level-up, 3rd char+ is the level
 * - R = restricted (special moves like Rotom moves)
 * - E = egg
 * - D = Dream World, only 5D is valid
 * - S = event, 3rd char+ is the index in .eventData
 * - V = Virtual Console or Let's Go transfer, only 7V/8V is valid
 * - C = NOT A REAL SOURCE, see note, only 3C/4C is valid
 *
 * C marks certain moves learned by a pokemon's prevo. It's used to
 * work around the chainbreeding checker's shortcuts for performance;
 * it lets the pokemon be a valid father for teaching the move, but
 * is otherwise ignored by the learnset checker (which will actually
 * check prevos for compatibility).
 */
export type MoveSource = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${'M' | 'T' | 'L' | 'R' | 'E' | 'D' | 'S' | 'V' | 'C'}${string}`;
export declare class Species extends BasicEffect implements Readonly<BasicEffect & SpeciesFormatsData> {
    readonly effectType: 'Pokemon';
    /**
     * Species ID. Identical to ID. Note that this is the full ID, e.g.
     * 'basculinbluestriped'. To get the base species ID, you need to
     * manually read toID(species.baseSpecies).
     */
    readonly id: ID;
    /**
     * Name. Note that this is the full name with forme,
     * e.g. 'Basculin-Blue-Striped'. To get the name without forme, see
     * `species.baseSpecies`.
     */
    readonly name: string;
    /**
     * Base species. Species, but without the forme name.
     *
     * DO NOT ASSUME A POKEMON CAN TRANSFORM FROM `baseSpecies` TO
     * `species`. USE `changesFrom` FOR THAT.
     */
    readonly baseSpecies: string;
    /**
     * Forme name. If the forme exists,
     * `species.name === species.baseSpecies + '-' + species.forme`
     *
     * The games make a distinction between Forme (foorumu) (legendary Pokémon)
     * and Form (sugata) (non-legendary Pokémon). PS does not use the same
     * distinction – they're all "Forme" to PS, reflecting current community
     * use of the term.
     *
     * This property only tracks non-cosmetic formes, and will be `''` for
     * cosmetic formes.
     */
    readonly forme: string;
    /**
     * Base forme name (e.g. 'Altered' for Giratina).
     */
    readonly baseForme: string;
    /**
     * Other forms. List of names of cosmetic forms. These should have
     * `aliases.js` aliases to this entry, but not have their own
     * entry in `pokedex.js`.
     */
    readonly cosmeticFormes?: string[];
    /**
     * Other formes. List of names of formes, appears only on the base
     * forme. Unlike forms, these have their own entry in `pokedex.js`.
     */
    readonly otherFormes?: string[];
    /**
     * List of forme speciesNames in the order they appear in the game data -
     * the union of baseSpecies, otherFormes and cosmeticFormes. Appears only on
     * the base species forme.
     *
     * A species's alternate formeindex may change from generation to generation -
     * the forme with index N in Gen A is not guaranteed to be the same forme as the
     * forme with index in Gen B.
     *
     * Gigantamaxes are not considered formes by the game (see data/FORMES.md - PS
     * labels them as such for convenience) - Gigantamax "formes" are instead included at
     * the end of the formeOrder list so as not to interfere with the correct index numbers.
     */
    readonly formeOrder?: string[];
    /**
     * Sprite ID. Basically the same as ID, but with a dash between
     * species and forme.
     */
    readonly spriteid: string;
    /** Abilities. */
    readonly abilities: SpeciesAbility;
    /** Types. */
    readonly types: string[];
    /** Added type (added by Trick-Or-Treat or Forest's Curse, but only listed in species by OMs). */
    readonly addedType?: string;
    /** Pre-evolution. '' if nothing evolves into this Pokemon. */
    readonly prevo: string;
    /** Evolutions. Array because many Pokemon have multiple evolutions. */
    readonly evos: string[];
    readonly evoType?: 'trade' | 'useItem' | 'levelMove' | 'levelExtra' | 'levelFriendship' | 'levelHold' | 'other';
    /** Evolution condition. falsy if doesn't evolve. */
    readonly evoCondition?: string;
    /** Evolution item. falsy if doesn't evolve. */
    readonly evoItem?: string;
    /** Evolution move. falsy if doesn't evolve. */
    readonly evoMove?: string;
    /** Region required to be in for evolution. falsy if doesn't evolve. */
    readonly evoRegion?: 'Alola' | 'Galar';
    /** Evolution level. falsy if doesn't evolve. */
    readonly evoLevel?: number;
    /** Is NFE? True if this Pokemon can evolve (Mega evolution doesn't count). */
    readonly nfe: boolean;
    /** Egg groups. */
    readonly eggGroups: string[];
    /** True if this species can hatch from an Egg. */
    readonly canHatch: boolean;
    /** True if this species is a purely cosmetic forme. */
    readonly isCosmeticForme: boolean;
    /**
     * Gender. M = always male, F = always female, N = always
     * genderless, '' = sometimes male sometimes female.
     */
    readonly gender: GenderName;
    /** Gender ratio. Should add up to 1 unless genderless. */
    readonly genderRatio: {
        M: number;
        F: number;
    };
    /** Base stats. */
    readonly baseStats: StatsTable;
    /** Max HP. Overrides usual HP calculations (for Shedinja). */
    readonly maxHP?: number;
    /** A Pokemon's Base Stat Total */
    readonly bst: number;
    /** Weight (in kg). Not valid for OMs; use weighthg / 10 instead. */
    readonly weightkg: number;
    /** Weight (in integer multiples of 0.1kg). */
    readonly weighthg: number;
    /** Height (in m). */
    readonly heightm: number;
    /** Color. */
    readonly color: string;
    /**
     * Tags, boolean "are you or are you not on this list" data.
     */
    readonly tags: (TableGenericTag | TableSpeciesTag)[];
    /** Does this Pokemon have an unreleased hidden ability? */
    readonly unreleasedHidden: boolean | 'Past';
    /**
     * Is it only possible to get the hidden ability on a male pokemon?
     * This is mainly relevant to Gen 5.
     */
    readonly maleOnlyHidden: boolean;
    /** Possible mother for a male-only Pokemon. */
    readonly mother?: string;
    /** True if a pokemon is mega. */
    readonly isMega?: boolean;
    /** True if a pokemon is primal. */
    readonly isPrimal?: boolean;
    /** Name of its Gigantamax move, if a pokemon is capable of gigantamaxing. */
    readonly canGigantamax?: string;
    /** If this Pokemon can gigantamax, is its gigantamax released? */
    readonly gmaxUnreleased?: boolean;
    /** True if a Pokemon species is incapable of dynamaxing */
    readonly cannotDynamax?: boolean;
    /** The Tera Type this Pokemon is forced to use */
    readonly requiredTeraType?: string;
    /** What it transforms from, if a pokemon is a forme that is only accessible in battle. */
    readonly battleOnly?: string | string[];
    /** Required item. Do not use this directly; see requiredItems. */
    readonly requiredItem?: string;
    /** Required move. Move required to use this forme in-battle. */
    readonly requiredMove?: string;
    /** Required ability. Ability required to use this forme in-battle. */
    readonly requiredAbility?: string;
    /**
     * Required items. Items required to be in this forme, e.g. a mega
     * stone, or Griseous Orb. Array because Arceus formes can hold
     * either a Plate or a Z-Crystal.
     */
    readonly requiredItems?: string[];
    /**
     * Formes that can transform into this Pokemon, to inherit learnsets
     * from. (Like `prevo`, but for transformations that aren't
     * technically evolution. Includes in-battle transformations like
     * Zen Mode and out-of-battle transformations like Rotom.)
     *
     * Not filled out for megas/primals - fall back to baseSpecies
     * for in-battle formes.
     */
    readonly changesFrom?: string;
    /**
     * List of sources and other availability for a Pokemon transferred from
     * Pokemon GO.
     */
    readonly pokemonGoData?: string[];
    /**
     * Singles Tier. The Pokemon's location in the Smogon tier system.
     */
    readonly tier: TierTypes.Singles | TierTypes.Other;
    /**
     * Doubles Tier. The Pokemon's location in the Smogon doubles tier system.
     */
    readonly doublesTier: TierTypes.Doubles | TierTypes.Other;
    /**
     * National Dex Tier. The Pokemon's location in the Smogon National Dex tier system.
     */
    readonly natDexTier: TierTypes.Singles | TierTypes.Other;
    constructor(data: AnyObject);
}
export declare class Learnset {
    readonly effectType: 'Learnset';
    /**
     * Keeps track of exactly how a pokemon might learn a move, in the
     * form moveid:sources[].
     */
    readonly learnset?: {
        [moveid: string]: MoveSource[];
    };
    /** True if the only way to get this Pokemon is from events. */
    readonly eventOnly: boolean;
    /** List of event data for each event. */
    readonly eventData?: EventInfo[];
    readonly encounters?: EventInfo[];
    readonly exists: boolean;
    readonly species: Species;
    constructor(data: AnyObject, species: Species);
}
export declare class DexSpecies {
    readonly dex: ModdedDex;
    readonly speciesCache: Map<ID, Species>;
    readonly learnsetCache: Map<ID, Learnset>;
    allCache: readonly Species[] | null;
    constructor(dex: ModdedDex);
    get(name?: string | Species): Species;
    getByID(id: ID): Species;
    /**
     * @param id the ID of the species the move pool belongs to
     * @param isNatDex
     * @returns a Set of IDs of the full valid movepool of the given species for the current generation/mod.
     * Note that inter-move incompatibilities, such as those from exclusive events, are not considered and all moves are
     * lumped together. However, Necturna and Necturine's Sketchable moves are omitted from this pool, as their fundamental
     * incompatibility with each other is essential to the nature of those species.
     */
    getMovePool(id: ID, isNatDex?: boolean): Set<ID>;
    getFullLearnset(id: ID): (Learnset & {
        learnset: NonNullable<Learnset['learnset']>;
    })[];
    learnsetParent(species: Species, checkingMoves?: boolean): Species | null;
    /**
     * Gets the raw learnset data for the species.
     *
     * In practice, if you're trying to figure out what moves a pokemon learns,
     * you probably want to `getFullLearnset` or `getMovePool` instead.
     */
    getLearnsetData(id: ID): Learnset;
    getPokemonGoData(id: ID): PokemonGoData;
    all(): readonly Species[];
    eggMovesOnly(child: Species, father: Species | null): boolean;
}
export {};
