/**
 * Simulator Pokemon
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * @license MIT license
 */
import type { DynamaxOptions, MoveRequestData, PokemonMoveRequestData, PokemonSwitchRequestData } from './side';
/** A Pokemon's move slot. */
interface MoveSlot {
    id: ID;
    move: string;
    pp: number;
    maxpp: number;
    target?: string;
    disabled: boolean | 'hidden';
    disabledSource?: string;
    used: boolean;
    virtual?: boolean;
}
interface Attacker {
    source: Pokemon;
    damage: number;
    thisTurn: boolean;
    move?: ID;
    slot: PokemonSlot;
    damageValue?: (number | boolean | undefined);
}
export interface EffectState {
    id: string;
    effectOrder: number;
    duration?: number;
    [k: string]: any;
}
export declare const RESTORATIVE_BERRIES: Set<ID>;
export declare class Pokemon {
    readonly side: Side;
    readonly battle: Battle;
    readonly set: PokemonSet;
    readonly name: string;
    /** `` `${sideid}: ${name}` `` - used to refer to pokemon in the protocol */
    readonly fullname: string;
    readonly level: number;
    readonly gender: GenderName;
    readonly happiness: number;
    readonly pokeball: ID;
    readonly dynamaxLevel: number;
    readonly gigantamax: boolean;
    /** Transform keeps the original pre-transformed Hidden Power in Gen 2-4. */
    readonly baseHpType: string;
    readonly baseHpPower: number;
    readonly baseMoveSlots: MoveSlot[];
    moveSlots: MoveSlot[];
    /** Only track for base move slots */
    ppUps: number[];
    hpType: string;
    hpPower: number;
    /**
     * Index of `pokemon.side.pokemon` and `pokemon.side.active`, which are
     * guaranteed to be the same for active pokemon. Note that this isn't
     * its field position in multi battles - use `getSlot()` for that.
     */
    position: number;
    /**
     * Information about this pokemon visible to opponents when in battle
     * (species, gender, level, shininess, tera state).
     * @see https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md#identifying-pok%C3%A9mon
     */
    details: string;
    baseSpecies: Species;
    species: Species;
    speciesState: EffectState;
    status: ID;
    statusState: EffectState;
    volatiles: {
        [id: string]: EffectState;
    };
    showCure?: boolean;
    /**
     * These are the basic stats that appear on the in-game stats screen:
     * calculated purely from the species base stats, level, IVs, EVs,
     * and Nature, before modifications from item, ability, etc.
     *
     * Forme changes affect these, but Transform doesn't.
     */
    baseStoredStats: StatsTable;
    /**
     * These are pre-modification stored stats in-battle. At switch-in,
     * they're identical to `baseStoredStats`, but can be temporarily changed
     * until switch-out by effects such as Power Trick and Transform.
     *
     * Stat multipliers from abilities, items, and volatiles, such as
     * Solar Power, Choice Band, or Swords Dance, are not stored in
     * `storedStats`, but applied on top and accessed by `pokemon.getStat`.
     *
     * (Except in Gen 1, where stat multipliers are stored, leading
     * to several famous glitches.)
     */
    storedStats: StatsExceptHPTable;
    boosts: BoostsTable;
    baseAbility: ID;
    ability: ID;
    abilityState: EffectState;
    item: ID;
    itemState: EffectState;
    lastItem: ID;
    usedItemThisTurn: boolean;
    ateBerry: boolean;
    itemKnockedOff: boolean;
    trapped: boolean | "hidden";
    maybeTrapped: boolean;
    maybeDisabled: boolean;
    /** true = locked,  */
    maybeLocked: boolean | null;
    illusion: Pokemon | null;
    transformed: boolean;
    maxhp: number;
    /** This is the max HP before Dynamaxing; it's updated for Power Construct etc */
    baseMaxhp: number;
    hp: number;
    fainted: boolean;
    faintQueued: boolean;
    subFainted: boolean | null;
    /** If this Pokemon should revert to its set species when it faints */
    formeRegression: boolean;
    types: string[];
    addedType: string;
    knownType: boolean;
    /** Keeps track of what type the client sees for this Pokemon. */
    apparentType: string;
    /**
     * If the switch is called by an effect with a special switch
     * message, like U-turn or Baton Pass, this will be the ID of
     * the calling effect.
     */
    switchFlag: ID | boolean;
    forceSwitchFlag: boolean;
    skipBeforeSwitchOutEventFlag: boolean;
    draggedIn: number | null;
    newlySwitched: boolean;
    beingCalledBack: boolean;
    lastMove: ActiveMove | null;
    lastMoveEncore?: ActiveMove | null;
    lastMoveUsed: ActiveMove | null;
    lastMoveTargetLoc?: number;
    moveThisTurn: string | boolean;
    statsRaisedThisTurn: boolean;
    statsLoweredThisTurn: boolean;
    /**
     * The result of the last move used on the previous turn by this
     * Pokemon. Stomping Tantrum checks this property for a value of false
     * when determine whether to double its power, but it has four
     * possible values:
     *
     * undefined indicates this Pokemon was not active last turn. It should
     * not be used to indicate that a move was attempted and failed, either
     * in a way that boosts Stomping Tantrum or not.
     *
     * null indicates that the Pokemon's move was skipped in such a way
     * that does not boost Stomping Tantrum, either from having to recharge
     * or spending a turn trapped by another Pokemon's Sky Drop.
     *
     * false indicates that the move completely failed to execute for any
     * reason not mentioned above, including missing, the target being
     * immune, the user being immobilized by an effect such as paralysis, etc.
     *
     * true indicates that the move successfully executed one or more of
     * its effects on one or more targets, including hitting with an attack
     * but dealing 0 damage to the target in cases such as Disguise, or that
     * the move was blocked by one or more moves such as Protect.
     */
    moveLastTurnResult: boolean | null | undefined;
    /**
     * The result of the most recent move used this turn by this Pokemon.
     * At the start of each turn, the value stored here is moved to its
     * counterpart, moveLastTurnResult, and this property is reinitialized
     * to undefined. This property can have one of four possible values:
     *
     * undefined indicates that this Pokemon has not yet finished an
     * attempt to use a move this turn. As this value is only overwritten
     * after a move finishes execution, it is not sufficient for an event
     * to examine only this property when checking if a Pokemon has not
     * moved yet this turn if the event could take place during that
     * Pokemon's move.
     *
     * null indicates that the Pokemon's move was skipped in such a way
     * that does not boost Stomping Tantrum, either from having to recharge
     * or spending a turn trapped by another Pokemon's Sky Drop.
     *
     * false indicates that the move completely failed to execute for any
     * reason not mentioned above, including missing, the target being
     * immune, the user being immobilized by an effect such as paralysis, etc.
     *
     * true indicates that the move successfully executed one or more of
     * its effects on one or more targets, including hitting with an attack
     * but dealing 0 damage to the target in cases such as Disguise. It can
     * also mean that the move was blocked by one or more moves such as
     * Protect. Uniquely, this value can also be true if this Pokemon mega
     * evolved or ultra bursted this turn, but in that case the value should
     * always be overwritten by a move action before the end of that turn.
     */
    moveThisTurnResult: boolean | null | undefined;
    /**
     * The undynamaxed HP value this Pokemon was reduced to by damage this turn,
     * or false if it hasn't taken damage yet this turn
     *
     * Used for Assurance, Emergency Exit, and Wimp Out
     */
    hurtThisTurn: number | null;
    lastDamage: number;
    attackedBy: Attacker[];
    timesAttacked: number;
    isActive: boolean;
    activeTurns: number;
    /**
     * This is for Fake-Out-likes specifically - it mostly counts how many move
     * actions you've had since the last time you switched in, so 1/turn normally,
     * +1 for Dancer/Instruct, -1 for shifting/Sky Drop.
     *
     * Incremented before the move is used, so the first move use has
     * `activeMoveActions === 1`.
     *
     * Unfortunately, Truant counts Mega Evolution as an action and Fake
     * Out doesn't, meaning that Truant can't use this number.
     */
    activeMoveActions: number;
    previouslySwitchedIn: number;
    truantTurn: boolean;
    bondTriggered: boolean;
    heroMessageDisplayed: boolean;
    swordBoost: boolean;
    shieldBoost: boolean;
    syrupTriggered: boolean;
    stellarBoostedTypes: string[];
    /** Have this pokemon's Start events run yet? (Start events run every switch-in) */
    isStarted: boolean;
    duringMove: boolean;
    weighthg: number;
    speed: number;
    canMegaEvo: string | false | null | undefined;
    canMegaEvoX: string | false | null | undefined;
    canMegaEvoY: string | false | null | undefined;
    canUltraBurst: string | null | undefined;
    readonly canGigantamax: string | null;
    /**
     * A Pokemon's Tera type if it can Terastallize, false if it is temporarily unable to tera and should have its
     * ability restored upon switching out, or null if its inability to tera is permanent.
     */
    canTerastallize: string | false | null;
    teraType: string;
    baseTypes: string[];
    terastallized?: string;
    /** A Pokemon's currently 'staleness' with respect to the Endless Battle Clause. */
    staleness?: 'internal' | 'external';
    /** Staleness that will be set once a future action occurs (eg. eating a berry). */
    pendingStaleness?: 'internal' | 'external';
    /** Temporary staleness that lasts only until the Pokemon switches. */
    volatileStaleness?: 'external';
    modifiedStats?: StatsExceptHPTable;
    modifyStat?: (this: Pokemon, statName: StatIDExceptHP, modifier: number) => void;
    recalculateStats?: (this: Pokemon) => void;
    /**
     * An object for storing untyped data, for mods to use.
     */
    m: {
        innate?: string;
        originalSpecies?: string;
        [key: string]: any;
    };
    constructor(set: string | AnyObject, side: Side);
    toJSON(): AnyObject;
    get moves(): readonly string[];
    get baseMoves(): readonly string[];
    getSlot(): PokemonSlot;
    getFieldPositionValue(): number;
    toString(): string;
    getUpdatedDetails(level?: number): string;
    getFullDetails: () => {
        side: SideID;
        secret: string;
        shared: string;
    };
    updateSpeed(): void;
    calculateStat(statName: StatIDExceptHP, boost: number, modifier?: number, statUser?: Pokemon): number;
    getStat(statName: StatIDExceptHP, unboosted?: boolean, unmodified?: boolean): number;
    getActionSpeed(): number;
    /**
     * Gets the Pokemon's best stat.
     * Moved to its own method due to frequent use of the same code.
     * Used by Beast Boost, Quark Drive, and Protosynthesis.
     */
    getBestStat(unboosted?: boolean, unmodified?: boolean): StatIDExceptHP;
    getWeight(): number;
    getMoveData(move: string | Move): MoveSlot | null;
    getMoveSlot(slotIndex: number): MoveSlot | null;
    getMoveHitData(move: ActiveMove): {
        crit: boolean;
        typeMod: number;
        bypassProtect: boolean | Effect;
    };
    alliesAndSelf(): Pokemon[];
    allies(): Pokemon[];
    adjacentAllies(): Pokemon[];
    foes(all?: boolean): Pokemon[];
    adjacentFoes(): Pokemon[];
    isAlly(pokemon: Pokemon | null): boolean;
    isAdjacent(pokemon2: Pokemon): boolean;
    getUndynamaxedHP(amount?: number): number;
    /** Get targets for Dragon Darts */
    getSmartTargets(target: Pokemon, move: ActiveMove): Pokemon[];
    getAtLoc(targetLoc: number): Pokemon;
    /**
     * Returns a relative location: 1-3, positive for foe, and negative for ally.
     * Use `getAtLoc` to reverse.
     */
    getLocOf(target: Pokemon): number;
    getMoveTargets(move: ActiveMove, target: Pokemon): {
        targets: Pokemon[];
        pressureTargets: Pokemon[];
    };
    ignoringAbility(): boolean;
    ignoringItem(isFling?: boolean): boolean;
    deductPP(move: string | Move, amount?: number | null, target?: Pokemon | null | false): number;
    moveUsed(move: ActiveMove, targetLoc?: number): void;
    gotAttacked(move: string | Move, damage: number | false | undefined, source: Pokemon): void;
    getLastAttackedBy(): Attacker | undefined;
    getLastDamagedBy(filterOutSameSide: boolean): Attacker | undefined;
    /**
     * This refers to multi-turn moves like SolarBeam and Outrage and
     * Sky Drop, which remove all choice (no dynamax, switching, etc).
     * Don't use it for "soft locks" like Choice Band.
     */
    getLockedMove(): ID | null;
    /**
     * Moves that lock you when you select the Fight button, but don't prevent you from switching out.
     * Those are Gen 1 trapping moves, Gen 1 and 2 Bide, and Gen 2-4 Encore. Gen 1 freeze and sleep also semi-lock you.
     */
    getSemiLockedMove(restrictData?: boolean): ID | null;
    getMoves(lockedMove?: ID | null, restrictData?: boolean): MoveRequestData[];
    /** This should be passed the base move and not the corresponding max move so we can check how much PP is left. */
    maxMoveDisabled(baseMove: Move | string): boolean;
    getDynamaxRequest(skipChecks?: boolean): DynamaxOptions | undefined;
    getMoveRequestData(): PokemonMoveRequestData;
    getSwitchRequestData(forAlly?: boolean): PokemonSwitchRequestData;
    isLastActive(): boolean;
    positiveBoosts(): number;
    getCappedBoost(boosts: SparseBoostsTable): Partial<BoostsTable>;
    boostBy(boosts: SparseBoostsTable): number;
    clearBoosts(): void;
    setBoost(boosts: SparseBoostsTable): void;
    copyVolatileFrom(pokemon: Pokemon, switchCause?: string | boolean): void;
    transformInto(pokemon: Pokemon, effect?: Effect): boolean;
    /**
     * Changes this Pokemon's species to the given speciesId (or species).
     * This function only handles changes to stats and type.
     * Use formeChange to handle changes to ability and sending client messages.
     */
    setSpecies(rawSpecies: Species, source?: Effect | null, isTransform?: boolean): any;
    /**
     * Changes this Pokemon's forme to match the given speciesId (or species).
     * This function handles all changes to stats, ability, type, species, etc.
     * as well as sending all relevant messages sent to the client.
     */
    formeChange(speciesId: string | Species, source?: Effect | null, isPermanent?: boolean, abilitySlot?: string, message?: string): boolean;
    updateMaxHp(): void;
    clearVolatile(includeSwitchFlags?: boolean): void;
    hasType(type: string | string[]): boolean;
    /**
     * This function only puts the pokemon in the faint queue;
     * actually setting of this.fainted comes later when the
     * faint queue is resolved.
     *
     * Returns the amount of damage actually dealt
     */
    faint(source?: Pokemon | null, effect?: Effect | null): number;
    damage(d: number, source?: Pokemon | null, effect?: Effect | null): number;
    tryTrap(isHidden?: boolean): boolean;
    hasMove(moveid: string): false | "";
    disableMove(moveid: string, isHidden?: boolean, sourceEffect?: Effect): void;
    /** Returns the amount of damage actually healed */
    heal(d: number, source?: Pokemon | null, effect?: Effect | null): number | false;
    /** Sets HP, returns delta */
    sethp(d: number): number | undefined;
    trySetStatus(status: string | Condition, source?: Pokemon | null, sourceEffect?: Effect | null): boolean;
    /** Unlike clearStatus, gives cure message */
    cureStatus(silent?: boolean): boolean;
    setStatus(status: string | Condition, source?: Pokemon | null, sourceEffect?: Effect | null, ignoreImmunities?: boolean): boolean;
    /**
     * Unlike cureStatus, does not give cure message
     */
    clearStatus(): boolean;
    getStatus(): import("./dex-conditions").Condition;
    eatItem(force?: boolean, source?: Pokemon, sourceEffect?: Effect): boolean;
    useItem(source?: Pokemon, sourceEffect?: Effect): boolean;
    takeItem(source?: Pokemon): false | import("./dex-items").Item | undefined;
    setItem(item: string | Item, source?: Pokemon, effect?: Effect): boolean;
    getItem(): import("./dex-items").Item;
    hasItem(item: string | string[]): boolean;
    clearItem(): boolean;
    setAbility(ability: string | Ability, source?: Pokemon | null, sourceEffect?: Effect | null, isFromFormeChange?: boolean, isTransform?: boolean): false | ID | null;
    getAbility(): import("./dex-abilities").Ability;
    hasAbility(ability: string | string[]): boolean;
    clearAbility(): false | ID | null;
    getNature(): import("./dex-data").Nature;
    addVolatile(status: string | Condition, source?: Pokemon | null, sourceEffect?: Effect | null, linkedStatus?: string | Condition | null): boolean | any;
    getVolatile(status: string | Effect): Effect | null;
    removeVolatile(status: string | Effect): boolean;
    removeLinkedVolatiles(linkedStatus: string | Effect, linkedPokemon: Pokemon[]): void;
    getHealth: () => {
        side: SideID;
        secret: string;
        shared: string;
    };
    /**
     * Sets a type (except on Arceus, who resists type changes)
     */
    setType(newType: string | string[], enforce?: boolean): boolean;
    /** Removes any types added previously and adds another one. */
    addType(newType: string): boolean;
    getTypes(excludeAdded?: boolean, preterastallized?: boolean): string[];
    isGrounded(negateImmunity?: boolean): boolean | null;
    isSemiInvulnerable(): EffectState;
    isSkyDropped(): boolean;
    /** Specifically: is protected against a single-target damaging move */
    isProtected(): boolean;
    /**
     * Like Field.effectiveWeather(), but ignores sun and rain if
     * the Utility Umbrella is active for the Pokemon.
     */
    effectiveWeather(sourceEffect?: Effect, message?: string | boolean): ID;
    runEffectiveness(move: ActiveMove): number;
    /** false = immune, true = not immune */
    runImmunity(source: ActiveMove | string, message?: string | boolean): boolean;
    runStatusImmunity(type: string, message?: string): boolean;
    destroy(): void;
}
export {};
