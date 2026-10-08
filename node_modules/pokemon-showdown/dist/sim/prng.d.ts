/**
 * PRNG
 * Pokemon Showdown - http://pokemonshowdown.com/
 *
 * This simulates the on-cartridge PRNG used in the real games.
 *
 * In addition to potentially allowing us to read replays from in-game,
 * this also makes it possible to record an "input log" (a seed +
 * initial teams + move/switch decisions) and "replay" a simulation to
 * get the same result.
 *
 * @license MIT license
 */
export type PRNGSeed = `${'sodium' | 'gen5' | number},${string}`;
export type SodiumRNGSeed = ['sodium', string];
/** 64-bit big-endian [high -> low] int */
export type Gen5RNGSeed = [number, number, number, number];
/**
 * Low-level source of 32-bit random numbers.
 */
interface RNG {
    getSeed(): PRNGSeed;
    /** random 32-bit number */
    next(): number;
}
/**
 * High-level PRNG API, for getting random numbers.
 *
 * Chooses the RNG implementation based on the seed passed to the constructor.
 * Seeds starting with 'sodium' use sodium. Other seeds use the Gen 5 RNG.
 * If a seed isn't given, defaults to sodium.
 *
 * The actual randomness source is in this.rng.
 */
export declare class PRNG {
    readonly startingSeed: PRNGSeed;
    rng: RNG;
    /** Creates a new source of randomness for the given seed. */
    constructor(seed?: PRNGSeed | null, initialSeed?: PRNGSeed);
    setSeed(seed: PRNGSeed): void;
    getSeed(): PRNGSeed;
    /**
     * Creates a clone of the current PRNG.
     *
     * The new PRNG will have its initial seed set to the seed of the current instance.
     */
    clone(): PRNG;
    /**
     * Retrieves the next random number in the sequence.
     * This function has three different results, depending on arguments:
     * - random() returns a real number in [0, 1), just like Math.random()
     * - random(n) returns an integer in [0, n)
     * - random(m, n) returns an integer in [m, n)
     * m and n are converted to integers via Math.floor. If the result is NaN, they are ignored.
     */
    random(from?: number, to?: number): number;
    /**
     * Flip a coin (two-sided die), returning true or false.
     *
     * This function returns true with probability `P`, where `P = numerator
     * / denominator`. This function returns false with probability `1 - P`.
     *
     * The numerator must be a non-negative integer (`>= 0`).
     *
     * The denominator must be a positive integer (`> 0`).
     */
    randomChance(numerator: number, denominator: number): boolean;
    /**
     * Return a random item from the given array.
     *
     * This function chooses items in the array with equal probability.
     *
     * If there are duplicate items in the array, each duplicate is
     * considered separately. For example, sample(['x', 'x', 'y']) returns
     * 'x' 67% of the time and 'y' 33% of the time.
     *
     * The array must contain at least one item.
     *
     * The array must not be sparse.
     */
    sample<T>(items: readonly T[]): T;
    /**
     * A Fisher-Yates shuffle. This is how the game resolves speed ties.
     *
     * At least according to V4 in
     * https://github.com/smogon/pokemon-showdown/issues/1157#issuecomment-214454873
     */
    shuffle<T>(items: T[], start?: number, end?: number): void;
    static generateSeed(): PRNGSeed;
    static convertSeed(seed: SodiumRNGSeed | Gen5RNGSeed): PRNGSeed;
    static get(prng?: PRNG | PRNGSeed | null): PRNG;
}
/**
 * This is a drop-in replacement for libsodium's randombytes_buf_deterministic,
 * but it's implemented with ts-chacha20 instead, for a smaller dependency that
 * doesn't use NodeJS native modules, for better portability.
 */
export declare class SodiumRNG implements RNG {
    static readonly NONCE: Uint8Array<ArrayBuffer>;
    seed: Uint8Array;
    /** Creates a new source of randomness for the given seed. */
    constructor(seed: SodiumRNGSeed);
    setSeed(seed: SodiumRNGSeed): void;
    getSeed(): PRNGSeed;
    next(): number;
    static generateSeed(): SodiumRNGSeed;
}
/**
 * A PRNG intended to emulate the on-cartridge PRNG for Gen 5 with a 64-bit
 * initial seed.
 */
export declare class Gen5RNG implements RNG {
    seed: Gen5RNGSeed;
    /** Creates a new source of randomness for the given seed. */
    constructor(seed?: Gen5RNGSeed | null);
    getSeed(): PRNGSeed;
    next(): number;
    /**
     * Calculates `a * b + c` (with 64-bit 2's complement integers)
     */
    multiplyAdd(a: Gen5RNGSeed, b: Gen5RNGSeed, c: Gen5RNGSeed): Gen5RNGSeed;
    /**
     * The RNG is a Linear Congruential Generator (LCG) in the form: `x_{n + 1} = (a x_n + c) % m`
     *
     * Where: `x_0` is the seed, `x_n` is the random number after n iterations,
     *
     * ````
     * a = 0x5D588B656C078965
     * c = 0x00269EC3
     * m = 2^64
     * ````
     */
    nextFrame(seed: Gen5RNGSeed, framesToAdvance?: number): Gen5RNGSeed;
    static generateSeed(): Gen5RNGSeed;
}
export {};
