/**
 * REPL
 *
 * Documented in logs/repl/README.md
 * https://github.com/smogon/pokemon-showdown/blob/master/logs/repl/README.md
 *
 * @author kota
 * @license MIT
 */
export type EvalType = (script: string) => unknown;
export declare const Repl: {
    /**
     * Contains the pathnames of all active REPL sockets.
     */
    socketPathnames: Set<string>;
    listenersSetup: boolean;
    setupListeners(filename: string): void;
    /**
     * Delete old sockets in the REPL directory (presumably from a crashed
     * previous launch of PS).
     */
    cleanup(): Promise<void>;
    /**
     * Starts a REPL server, using a UNIX socket for IPC. The eval function
     * parameter is passed in because there is no other way to access a file's
     * non-global context.
     */
    start(filename: string, evalFunction: EvalType): void;
    startGlobal(filename: string): void;
};
