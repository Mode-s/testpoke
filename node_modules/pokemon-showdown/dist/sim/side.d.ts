/**
 * Simulator Side
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * There's a lot of ambiguity between the terms "player", "side", "team",
 * and "half-field", which I'll try to explain here:
 *
 * These terms usually all mean the same thing. The exceptions are:
 *
 * - Multi-battle: there are 2 half-fields, 2 teams, 4 sides
 *
 * - Free-for-all: there are 2 half-fields, 4 teams, 4 sides
 *
 * "Half-field" is usually abbreviated to "half".
 *
 * Function naming will be very careful about which term to use. Pay attention
 * if it's relevant to your code.
 *
 * @license MIT
 */
import type { RequestState } from './battle';
import { Pokemon, type EffectState } from './pokemon';
import { type Move } from './dex-moves';
/** A single action that can be chosen. Choices will have one Action for each pokemon. */
export interface ChosenAction {
    choice: 'move' | 'switch' | 'instaswitch' | 'revivalblessing' | 'team' | 'shift' | 'pass';
    pokemon?: Pokemon;
    targetLoc?: number;
    moveid?: string;
    move?: ActiveMove;
    moveSlot?: number;
    target?: Pokemon;
    index?: number;
    side?: Side;
    mega?: boolean | null;
    megax?: boolean | null;
    megay?: boolean | null;
    zmove?: string;
    maxMove?: string;
    terastallize?: string;
    priority?: number;
}
/** One single turn's choice for one single player. */
export interface Choice {
    cantUndo: boolean;
    error: string;
    actions: ChosenAction[];
    forcedSwitchesLeft: number;
    forcedPassesLeft: number;
    switchIns: Set<number>;
    zMove: boolean;
    mega: boolean;
    ultra: boolean;
    dynamax: boolean;
    terastallize: boolean;
}
export interface PokemonSwitchRequestData {
    /**
     * `` `${sideid}: ${name}` ``
     * @see {Pokemon#fullname}
     */
    ident: string;
    /**
     * Details string.
     * @see {Pokemon#details}
     */
    details: string;
    condition: string;
    active: boolean;
    stats: StatsExceptHPTable;
    /**
     * Move IDs for choosable moves. Also includes Hidden Power Type, Frustration/Return power.
     */
    moves: ID[];
    /** Permanent ability (the one applied on switch-in). */
    baseAbility: ID;
    item: ID;
    pokeball: ID;
    /** Current ability. Only sent in Gen 7+. */
    ability?: ID;
    /** @see https://dex.pokemonshowdown.com/abilities/commander */
    commanding?: boolean;
    /** @see https://dex.pokemonshowdown.com/moves/revivalblessing */
    reviving?: boolean;
    teraType?: string;
    terastallized?: string;
}
export interface MoveRequestData {
    move: string;
    id: ID;
    pp?: number;
    maxpp?: number;
    target?: string;
    disabled?: string | boolean;
    disabledSource?: string;
}
export interface PokemonMoveRequestData {
    moves: MoveRequestData[];
    maybeDisabled?: boolean;
    maybeLocked?: boolean;
    trapped?: boolean;
    maybeTrapped?: boolean;
    canMegaEvo?: boolean;
    canMegaEvoX?: boolean;
    canMegaEvoY?: boolean;
    canUltraBurst?: boolean;
    canZMove?: AnyObject | null;
    canDynamax?: boolean;
    maxMoves?: DynamaxOptions;
    canTerastallize?: string;
}
export interface DynamaxOptions {
    maxMoves: ({
        move: string;
        target: MoveTarget;
        disabled?: boolean;
    })[];
    gigantamax?: string;
}
export interface SideRequestData {
    name: string;
    /** Side ID (`p1`, `p2`, `p3`, or `p4`), not the ID of the side's name. */
    id: SideID;
    pokemon: PokemonSwitchRequestData[];
    noCancel?: boolean;
}
export interface SwitchRequest {
    wait?: undefined;
    teamPreview?: undefined;
    forceSwitch: boolean[];
    side: SideRequestData;
    noCancel?: boolean;
    update?: boolean;
}
export interface TeamPreviewRequest {
    wait?: undefined;
    teamPreview: true;
    forceSwitch?: undefined;
    maxChosenTeamSize?: number;
    side: SideRequestData;
    noCancel?: boolean;
}
export interface MoveRequest {
    wait?: undefined;
    teamPreview?: undefined;
    forceSwitch?: undefined;
    active: PokemonMoveRequestData[];
    side: SideRequestData;
    ally?: SideRequestData;
    noCancel?: boolean;
    update?: boolean;
}
export interface WaitRequest {
    wait: true;
    teamPreview?: undefined;
    forceSwitch?: undefined;
    side: SideRequestData;
    noCancel?: boolean;
}
export type ChoiceRequest = SwitchRequest | TeamPreviewRequest | MoveRequest | WaitRequest;
export declare class Side {
    readonly battle: Battle;
    readonly id: SideID;
    /** Index in `battle.sides`: `battle.sides[side.n] === side` */
    readonly n: number;
    name: string;
    avatar: string;
    foe: Side;
    /** Only exists in multi battle, for the allied side */
    allySide: Side | null;
    team: PokemonSet[];
    pokemon: Pokemon[];
    active: Pokemon[];
    pokemonLeft: number;
    zMoveUsed: boolean;
    /**
     * This will be true in any gen before 8 or if the player (or their battle partner) has dynamaxed once already
     *
     * Use Side.canDynamaxNow() to check if a side can dynamax instead of this property because only one
     * player per team can dynamax on any given turn of a gen 8 Multi Battle.
     */
    dynamaxUsed: boolean;
    faintedLastTurn: Pokemon | null;
    faintedThisTurn: Pokemon | null;
    totalFainted: number;
    /** these point to the same object as the ally's, in multi battles */
    sideConditions: {
        [id: string]: EffectState;
    };
    slotConditions: {
        [id: string]: EffectState;
    }[];
    activeRequest: ChoiceRequest | null;
    choice: Choice;
    /**
     * In gen 1, all lastMove stuff is tracked on Side rather than Pokemon (this is for Counter)
     * This is also used for checking Self-KO clause in Pokemon Stadium 2.
     */
    lastMove: Move | null;
    /**
     * Same as lastMove but from the opponent's POV.
     */
    lastEnemyMove: Move | null;
    /**
     * In gen 1, the move and the slot are chosen during move selection
     * lastSelectedMove (wPlayerSelectedMove) never resets
     */
    lastSelectedMove: ID;
    /**
     * In gen 1, the move and the slot are chosen during move selection
     * lastSelectedMoveSlot (wPlayerMoveListIndex) resets on every switch
     */
    lastSelectedMoveSlot: number;
    /**
     * Same as lastSelectedMove but from the opponent's POV (wEnemySelectedMove).
     * There can be discrepancies between this and lastSelectedMove:
     * if the opponent switches to a Pokemon that is frozen or asleep, lastSelectedMove will not be updated,
     * but lastEnemySelectedMove will be updated to the move on the opponent's first slot during the next move selection.
     */
    lastEnemySelectedMove: ID;
    constructor(name: string, battle: Battle, sideNum: number, team: PokemonSet[]);
    toJSON(): AnyObject;
    get requestState(): RequestState;
    addPokemon(set: PokemonSet): Pokemon | null;
    canDynamaxNow(): boolean;
    /** convert a Choice into a choice string */
    getChoice(): string;
    toString(): string;
    getRequestData(forAlly?: boolean): SideRequestData;
    randomFoe(): Pokemon | null;
    /** Intended as a way to iterate through all foe side conditions - do not use for anything else. */
    foeSidesWithConditions(): Side[];
    foePokemonLeft(): number;
    allies(all?: boolean): Pokemon[];
    foes(all?: boolean): Pokemon[];
    activeTeam(): Pokemon[];
    hasAlly(pokemon: Pokemon): boolean;
    addSideCondition(status: string | Condition, source?: Pokemon | 'debug' | null, sourceEffect?: Effect | null): boolean;
    getSideCondition(status: string | Effect): Effect | null;
    getSideConditionData(status: string | Effect): AnyObject;
    removeSideCondition(status: string | Effect): boolean;
    addSlotCondition(target: Pokemon | number, status: string | Condition, source?: Pokemon | 'debug' | null, sourceEffect?: Effect | null): any;
    getSlotCondition(target: Pokemon | number, status: string | Effect): Effect | null;
    removeSlotCondition(target: Pokemon | number, status: string | Effect): boolean;
    send(...parts: (string | number | Function | AnyObject)[]): void;
    emitRequest(update?: ChoiceRequest, updatedRequest?: boolean): void;
    emitChoiceError(message: string, update?: {
        pokemon: Pokemon;
        update: (req: PokemonMoveRequestData) => boolean | void;
    }): boolean;
    isChoiceDone(): boolean;
    chooseMove(moveText?: string | number, targetLoc?: number, event?: 'mega' | 'megax' | 'megay' | 'zmove' | 'ultra' | 'dynamax' | 'terastallize' | ''): boolean;
    updateDisabledRequest(pokemon: Pokemon, req: PokemonMoveRequestData): boolean;
    updateRequestForPokemon(pokemon: Pokemon, update: (req: PokemonMoveRequestData) => boolean | void): boolean;
    chooseSwitch(slotText?: string): boolean | Side;
    /**
     * The number of pokemon you must choose in Team Preview.
     *
     * Note that PS doesn't support choosing fewer than this number of pokemon.
     * In the games, it is sometimes possible to bring fewer than this, but
     * since that's nearly always a mistake, we haven't gotten around to
     * supporting it.
     */
    pickedTeamSize(): number;
    chooseTeam(data?: string): boolean;
    chooseShift(): boolean;
    clearChoice(): void;
    commitChoices(): void;
    choose(input: string): boolean;
    getChoiceIndex(isPass?: boolean): number;
    choosePass(): boolean | Side;
    /** Automatically finish a choice if not currently complete. */
    autoChoose(): boolean;
    destroy(): void;
}
