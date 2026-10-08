import type { PokemonEventMethods, ConditionData, ModdedConditionData } from './dex-conditions';
import { BasicEffect } from './dex-data';
interface AbilityEventMethods {
    onCheckShow?: (this: Battle, pokemon: Pokemon) => void;
    onEnd?: (this: Battle, target: Pokemon & Side & Field) => void;
    onStart?: (this: Battle, target: Pokemon) => void;
}
interface AbilityFlags {
    breakable?: 1;
    cantsuppress?: 1;
    failroleplay?: 1;
    failskillswap?: 1;
    noentrain?: 1;
    noreceiver?: 1;
    notrace?: 1;
    notransform?: 1;
}
export interface AbilityData extends Partial<Ability>, AbilityEventMethods, PokemonEventMethods {
    name: string;
}
export type ModdedAbilityData = AbilityData | Partial<AbilityData> & {
    inherit: true;
    condition?: ModdedConditionData;
};
export interface AbilityDataTable {
    [abilityid: IDEntry]: AbilityData;
}
export interface ModdedAbilityDataTable {
    [abilityid: IDEntry]: ModdedAbilityData;
}
export declare class Ability extends BasicEffect implements Readonly<BasicEffect> {
    readonly effectType: 'Ability';
    /** Rating from -1 Detrimental to +5 Essential; see `data/abilities.ts` for details. */
    readonly rating: number;
    readonly suppressWeather: boolean;
    readonly flags: AbilityFlags;
    readonly condition?: ConditionData;
    constructor(data: AnyObject);
}
export declare class DexAbilities {
    readonly dex: ModdedDex;
    readonly abilityCache: Map<ID, Ability>;
    allCache: readonly Ability[] | null;
    constructor(dex: ModdedDex);
    get(name?: string | Ability): Ability;
    getByID(id: ID): Ability;
    all(): readonly Ability[];
}
export {};
