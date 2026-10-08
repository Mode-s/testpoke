/**
 * Dex
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * Handles getting data about pokemon, items, etc. Also contains some useful
 * helper functions for using dex data.
 *
 * By default, nothing is loaded until you call Dex.mod(mod) or
 * Dex.forFormat(format).
 *
 * You may choose to preload some things:
 * - Dex.includeMods() ~10ms
 *   This will preload `Dex.dexes`, giving you a list of possible mods.
 * - Dex.includeFormats() ~30ms
 *   As above, but will also preload `Dex.formats.all()`.
 * - Dex.includeData() ~500ms
 *   As above, but will also preload all of Dex.data for Gen 8, so
 *   functions like `Dex.species.get`, etc will be instantly usable.
 * - Dex.includeModData() ~1500ms
 *   As above, but will also preload `Dex.dexes[...].data` for all mods.
 *
 * Note that preloading is never necessary. All the data will be
 * automatically preloaded when needed, preloading will just spend time
 * now so you don't need to spend time later.
 *
 * @license MIT
 */
import * as Data from './dex-data';
import { Condition, DexConditions } from './dex-conditions';
import { DataMove, DexMoves } from './dex-moves';
import { Item, DexItems } from './dex-items';
import { Ability, DexAbilities } from './dex-abilities';
import { Species, DexSpecies } from './dex-species';
import { Format, DexFormats } from './dex-formats';
type DataType = 'Abilities' | 'Rulesets' | 'FormatsData' | 'Items' | 'Learnsets' | 'Moves' | 'Natures' | 'Pokedex' | 'Scripts' | 'Conditions' | 'TypeChart' | 'PokemonGoData';
/** Unfortunately we do for..in too much to want to deal with the casts */
export interface DexTable<T> {
    [id: string]: T;
}
export interface AliasesTable {
    [id: IDEntry]: string;
}
interface DexTableData {
    Abilities: DexTable<import('./dex-abilities').AbilityData>;
    Rulesets: DexTable<import('./dex-formats').FormatData>;
    Items: DexTable<import('./dex-items').ItemData>;
    Learnsets: DexTable<import('./dex-species').LearnsetData>;
    Moves: DexTable<import('./dex-moves').MoveData>;
    Natures: DexTable<import('./dex-data').NatureData>;
    Pokedex: DexTable<import('./dex-species').SpeciesData>;
    FormatsData: DexTable<import('./dex-species').SpeciesFormatsData>;
    PokemonGoData: DexTable<import('./dex-species').PokemonGoData>;
    Scripts: DexTable<AnyObject>;
    Conditions: DexTable<import('./dex-conditions').ConditionData>;
    TypeChart: DexTable<import('./dex-data').TypeData>;
}
interface TextTableData {
    Abilities: DexTable<AbilityText>;
    Items: DexTable<ItemText>;
    Moves: DexTable<MoveText>;
    Pokedex: DexTable<PokedexText>;
    Default: DexTable<DefaultText>;
}
export declare const toID: typeof Data.toID;
export declare class ModdedDex {
    readonly Data: typeof Data;
    readonly Condition: typeof Condition;
    readonly Ability: typeof Ability;
    readonly Item: typeof Item;
    readonly Move: typeof DataMove;
    readonly Species: typeof Species;
    readonly Format: typeof Format;
    readonly ModdedDex: typeof ModdedDex;
    readonly name = "[ModdedDex]";
    readonly isBase: boolean;
    readonly currentMod: string;
    readonly dataDir: string;
    readonly toID: typeof Data.toID;
    gen: number;
    parentMod: string;
    modsLoaded: boolean;
    dataCache: DexTableData | null;
    textCache: TextTableData | null;
    deepClone: typeof import("../lib/utils").deepClone;
    deepFreeze: typeof import("../lib/utils").deepFreeze;
    Multiset: typeof import("../lib/utils").Multiset;
    readonly formats: DexFormats;
    readonly abilities: DexAbilities;
    readonly items: DexItems;
    readonly moves: DexMoves;
    readonly species: DexSpecies;
    readonly conditions: DexConditions;
    readonly natures: Data.DexNatures;
    readonly types: Data.DexTypes;
    readonly stats: Data.DexStats;
    readonly aliases: Map<ID, ID> | null;
    readonly fuzzyAliases: Map<ID, ID[]> | null;
    constructor(mod?: string);
    get data(): DexTableData;
    get dexes(): {
        [mod: string]: ModdedDex;
    };
    mod(mod: string | undefined): ModdedDex;
    forGen(gen: number): ModdedDex;
    forFormat(format: Format | string): ModdedDex;
    /**
     * Lets the `this` ModdedDex own the requested data entry, by deep-cloning it,
     * and returns it.
     *
     * Includes a fast path in case a copy has already been performed.
     * If the data entry was copied by `loadData` rather than `modData`
     * (for instance, if pokedex.ts with inherit: true is used on the same Pokémon),
     * the fast path will return an unsafe (not owned) shallow clone.
     *
     * Make sure the arguments passed to `modData` are safe according to the architecture
     * of your mod, because the dex loader will not check them for you.
     *
     * Note that the `force` parameter disables the fast path, thus
     * enabling piecewise modding through both techniques: data files and `scripts.ts`.
     */
    modData(dataType: DataType, id: string, force?: boolean): any;
    effectToString(): string;
    /**
     * Sanitizes a username or Pokemon nickname
     *
     * Returns the passed name, sanitized for safe use as a name in the PS
     * protocol.
     *
     * Such a string must uphold these guarantees:
     * - must not contain any ASCII whitespace character other than a space
     * - must not start or end with a space character
     * - must not contain any of: | , [ ]
     * - must not be the empty string
     * - must not contain Unicode RTL control characters
     *
     * If no such string can be found, returns the empty string. Calling
     * functions are expected to check for that condition and deal with it
     * accordingly.
     *
     * getName also enforces that there are not multiple consecutive space
     * characters in the name, although this is not strictly necessary for
     * safety.
     */
    getName(name: any): string;
    /**
     * Returns false if the target is immune; true otherwise.
     * Also checks immunity to some statuses.
     */
    getImmunity(source: {
        type: string;
    } | string, target: {
        getTypes: () => string[];
    } | {
        types: string[];
    } | string[] | string): boolean;
    getEffectiveness(source: {
        type: string;
    } | string, target: {
        getTypes: () => string[];
    } | {
        types: string[];
    } | string[] | string): number;
    isTagged(thing: Species | Move | Item | Ability, tagName: string): boolean | undefined;
    getDescs(table: keyof TextTableData, id: ID, dataEntry: AnyObject): {
        desc: any;
        shortDesc: any;
    } | null;
    /**
     * Ensure we're working on a copy of a move (and make a copy if we aren't)
     *
     * Remember: "ensure" - by default, it won't make a copy of a copy:
     *     moveCopy === Dex.getActiveMove(moveCopy)
     *
     * If you really want to, use:
     *     moveCopyCopy = Dex.getActiveMove(moveCopy.id)
     */
    getActiveMove(move: Move | string): ActiveMove;
    getHiddenPower(ivs: StatsTable): {
        type: string;
        power: number;
    };
    /**
     * Truncate a number into an unsigned 32-bit integer, for
     * compatibility with the cartridge games' math systems.
     */
    trunc(this: void, num: number, bits?: number): number;
    dataSearch(target: string, searchIn?: ('Pokedex' | 'Moves' | 'Abilities' | 'Items' | 'Natures' | 'TypeChart')[] | null, isInexact?: boolean): AnyObject[] | null;
    loadDataFile(basePath: string, dataType: DataType): AnyObject | void;
    loadTextFile(name: string, exportName: string): DexTable<MoveText | ItemText | AbilityText | PokedexText | DefaultText>;
    includeMods(): this;
    includeModData(): this;
    includeData(): this;
    loadTextData(): TextTableData;
    getAlias(id: ID): ID | undefined;
    loadAliases(): NonNullable<ModdedDex['aliases']>;
    loadData(): DexTableData;
    includeFormats(): this;
}
export declare const Dex: ModdedDex;
export declare namespace Dex {
    type Species = import('./dex-species').Species;
    type Item = import('./dex-items').Item;
    type Move = import('./dex-moves').Move;
    type Ability = import('./dex-abilities').Ability;
    type HitEffect = import('./dex-moves').HitEffect;
    type SecondaryEffect = import('./dex-moves').SecondaryEffect;
    type RuleTable = import('./dex-formats').RuleTable;
    type GenderName = 'M' | 'F' | 'N' | '';
    type StatIDExceptHP = 'atk' | 'def' | 'spa' | 'spd' | 'spe';
    type StatID = 'hp' | StatIDExceptHP;
    type StatsExceptHPTable = {
        [stat in StatIDExceptHP]: number;
    };
    type StatsTable = {
        [stat in StatID]: number;
    };
    type SparseStatsTable = Partial<StatsTable>;
    type BoostID = StatIDExceptHP | 'accuracy' | 'evasion';
    type BoostsTable = {
        [boost in BoostID]: number;
    };
    type SparseBoostsTable = Partial<BoostsTable>;
}
export default Dex;
