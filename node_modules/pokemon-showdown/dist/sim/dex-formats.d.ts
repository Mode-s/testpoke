import { BasicEffect } from './dex-data';
import type { EventMethods } from './dex-conditions';
export interface FormatData extends Partial<Format>, EventMethods {
    name: string;
}
export type FormatList = (FormatData | {
    section: string;
    column?: number;
})[];
export type ModdedFormatData = FormatData | Omit<FormatData, 'name'> & {
    inherit: true;
};
export interface FormatDataTable {
    [id: IDEntry]: FormatData;
}
export interface ModdedFormatDataTable {
    [id: IDEntry]: ModdedFormatData;
}
type FormatEffectType = 'Format' | 'Ruleset' | 'Rule' | 'ValidatorRule';
/** rule, source, limit, bans */
export type ComplexBan = [string, string, number, string[]];
export type ComplexTeamBan = ComplexBan;
type NumericTagRule = [tagid: ID, operator: '<' | '<=' | '=' | '>=' | '>', number: number];
type TagRule = [type: '+' | '*' | '-', match: ID | NumericTagRule];
export interface GameTimerSettings {
    dcTimer: boolean;
    dcTimerBank: boolean;
    starting: number;
    grace: number;
    addPerTurn: number;
    maxPerTurn: number;
    maxFirstTurn: number;
    timeoutAutoChoose: boolean;
    accelerate: boolean;
}
/**
 * A RuleTable keeps track of the rules that a format has. The key can be:
 * - '[ruleid]' the ID of a rule in effect
 * - '-[thing]' or '-[category]:[thing]' ban a thing
 * - '+[thing]' or '+[category]:[thing]' allow a thing (override a ban)
 * [category] is one of: item, move, ability, species, basespecies, tag
 *
 * The value is the name of the parent rule (blank for the active format).
 */
export declare class RuleTable extends Map<string, string> {
    complexBans: ComplexBan[];
    complexTeamBans: ComplexTeamBan[];
    checkCanLearn: [TeamValidator['checkCanLearn'], string] | null;
    onChooseTeam: [NonNullable<Format['onChooseTeam']>, string] | null;
    timer: [Partial<GameTimerSettings>, string] | null;
    /** Sorted by precedence, in reverse order from a format's ban/unbanlist
     *  DO NOT search this; just use ruleTable.has(...). This is purely for tag rule precedence. */
    tagRules: TagRule[];
    valueRules: Map<string, string>;
    minTeamSize: number;
    maxTeamSize: number;
    pickedTeamSize: number | null;
    maxTotalLevel: number | null;
    maxMoveCount: number;
    minSourceGen: number;
    minLevel: number;
    maxLevel: number;
    defaultLevel: number;
    adjustLevel: number | null;
    adjustLevelDown: number | null;
    evLimit: number | null;
    constructor();
    isBanned(thing: string): boolean;
    isBannedSpecies(species: Species, baseSpecies?: Species): boolean;
    isRestricted(thing: string): boolean;
    isRestrictedSpecies(species: Species): boolean;
    getTagRules(): TagRule[];
    getNumericTagValue([tagid]: NumericTagRule, thing: Species | Move | Item | Ability): number | undefined;
    matchesTagRule(match: ID | NumericTagRule, thing: Species | Move | Item | Ability): boolean;
    describeTagRule(match: ID | NumericTagRule): string;
    static parseTagRule(ruleid: string): TagRule | null;
    /**
     * - non-empty string: banned, string is the reason
     * - '': whitelisted
     * - null: neither whitelisted nor banned
     */
    check(thing: string, setHas?: {
        [id: string]: true;
    } | null): string | null;
    getReason(key: string): string | null;
    blame(key: string): string;
    getComplexBanIndex(complexBans: ComplexBan[], rule: string): number;
    addComplexBan(rule: string, source: string, limit: number, bans: string[]): void;
    addComplexTeamBan(rule: string, source: string, limit: number, bans: string[]): void;
    /** After a RuleTable has been filled out, resolve its hardcoded numeric properties */
    resolveNumbers(format: Format, dex: ModdedDex): void;
    hasComplexBans(): boolean;
}
export declare class Format extends BasicEffect implements Readonly<BasicEffect> {
    readonly mod: string;
    /**
     * Name of the team generator algorithm, if this format uses
     * random/fixed teams. null if players can bring teams.
     */
    readonly team?: string;
    readonly effectType: FormatEffectType;
    readonly debug: boolean;
    /**
     * Whether or not a format will update ladder points if searched
     * for using the "Battle!" button.
     * (Challenge and tournament games will never update ladder points.)
     * (Defaults to `true`.)
     */
    readonly rated: boolean | string;
    /** Game type. */
    readonly gameType: GameType;
    /** Number of players, based on game type, for convenience */
    readonly playerCount: 2 | 4;
    /** List of rule names. */
    readonly ruleset: string[];
    /**
     * Base list of rule names as specified in "./config/formats.ts".
     * Used in a custom format to correctly display the altered ruleset.
     */
    readonly baseRuleset: string[];
    /** List of banned effects. */
    readonly banlist: string[];
    /** List of effects that aren't completely banned. */
    readonly restricted: string[];
    /** List of inherited banned effects to override. */
    readonly unbanlist: string[];
    /** List of ruleset and banlist changes in a custom format. */
    readonly customRules: string[] | null;
    /** Table of rule names and banned effects. */
    ruleTable: RuleTable | null;
    /** An optional function that runs at the start of a battle. */
    readonly onBegin?: (this: Battle) => void;
    readonly noLog: boolean;
    /**
     * Only applies to rules, not formats
     */
    readonly hasValue?: boolean | 'integer' | 'positive-integer';
    readonly onValidateRule?: (this: {
        format: Format;
        ruleTable: RuleTable;
        dex: ModdedDex;
    }, value: string) => string | void;
    /** ID of rule that can't be combined with this rule */
    readonly mutuallyExclusiveWith?: string;
    readonly battle?: ModdedBattleScriptsData;
    readonly pokemon?: ModdedBattlePokemon;
    readonly queue?: ModdedBattleQueue;
    readonly field?: ModdedField;
    readonly actions?: ModdedBattleActions;
    readonly side?: ModdedBattleSide;
    readonly challengeShow?: boolean;
    readonly searchShow?: boolean;
    readonly bestOfDefault?: boolean;
    readonly teraPreviewDefault?: boolean;
    readonly itemClauseDefault?: boolean;
    readonly threads?: string[];
    readonly tournamentShow?: boolean;
    readonly checkCanLearn?: (this: TeamValidator, move: Move, species: Species, setSources: PokemonSources, set: PokemonSet) => string | null;
    readonly getEvoFamily?: (this: Format, speciesid: string) => ID;
    readonly getSharedPower?: (this: Format, pokemon: Pokemon) => Set<string>;
    readonly getSharedItems?: (this: Format, pokemon: Pokemon) => Set<string>;
    readonly onChangeSet?: (this: TeamValidator, set: PokemonSet, format: Format, setHas?: AnyObject, teamHas?: AnyObject) => string[] | void;
    readonly onModifySpeciesPriority?: number;
    readonly onModifySpecies?: (this: Battle, species: Species, target?: Pokemon, source?: Pokemon, effect?: Effect) => Species | void;
    readonly onBattleStart?: (this: Battle) => void;
    readonly onTeamPreview?: (this: Battle) => void;
    readonly onChooseTeam?: (this: Battle, positions: number[], pokemon: Pokemon[], autoChoose?: boolean) => number[] | string | void;
    readonly onValidateSet?: (this: TeamValidator, set: PokemonSet, format: Format, setHas: AnyObject, teamHas: AnyObject) => string[] | void;
    readonly onValidateTeam?: (this: TeamValidator, team: PokemonSet[], format: Format, teamHas: AnyObject) => string[] | void;
    readonly validateSet?: (this: TeamValidator, set: PokemonSet, teamHas: AnyObject) => string[] | null;
    readonly validateTeam?: (this: TeamValidator, team: PokemonSet[], options?: {
        removeNicknames?: boolean;
        skipSets?: {
            [name: string]: {
                [key: string]: boolean;
            };
        };
    }) => string[] | void;
    readonly section?: string;
    readonly column?: number;
    constructor(data: AnyObject);
}
export declare class DexFormats {
    readonly dex: ModdedDex;
    rulesetCache: Map<ID, Format>;
    formatsListCache: readonly Format[] | null;
    constructor(dex: ModdedDex);
    load(): this;
    checkDeprecated(format: AnyObject): void;
    /**
     * Returns a sanitized format ID if valid, or throws if invalid.
     */
    validate(name: string): string;
    /**
     * The default mode is `isTrusted = false`, which is a bit of a
     * footgun. PS will never do anything unsafe, but `isTrusted = true`
     * will throw if the format string is invalid, while
     * `isTrusted = false` will silently fall back to the original format.
     */
    get(name?: string | Format, isTrusted?: boolean): Format;
    all(): readonly Format[];
    isPokemonRule(ruleSpec: string): boolean;
    getRuleTable(format: Format, depth?: number, repeals?: Map<string, number>): RuleTable;
    validateRule(rule: string, format?: Format | null): string | (string | number | string[])[];
    validTag(tagid: ID): boolean;
    validateNumericRule(rule: string): string | null;
    validateBanRule(rule: string): string;
}
export {};
