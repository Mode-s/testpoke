/**
 * Async worker thread wrapper around SQLite, written to improve concurrent performance.
 * @author mia-pi-git
 */
import { QueryProcessManager } from './process-manager';
import type * as sqlite from 'better-sqlite3';
import type { SQLStatement } from 'sql-template-strings';
export declare const DB_NOT_FOUND: null;
export interface SQLOptions {
    file: string;
    /** file to import database functions from - this should be relative to this filename. */
    extension?: string;
    /** options to be passed to better-sqlite3 */
    sqliteOptions?: sqlite.Options;
    /**
     * You can choose to return custom error information, or just crashlog and return void.
     * doing that will make it reject in main as normal.
     * (it only returns a diff result if you do, otherwise it's a default error).
     * You can also choose to only handle errors in the parent - see the third param, isParentProcess.
     */
    onError?: ErrorHandler;
}
type DataType = unknown[] | Record<string, unknown>;
export type SQLInput = string | number | null;
export interface ResultRow {
    [k: string]: SQLInput;
}
export interface TransactionEnvironment {
    db: sqlite.Database;
    statements: Map<string, sqlite.Statement>;
}
export type DatabaseQuery = {
    /** Prepare a statement - data is the statement. */
    type: 'prepare';
    data: string;
} | {
    /** Get all lines from a statement. Data is the params. */
    type: 'all';
    data: DataType;
    statement: string;
    noPrepare?: boolean;
} | {
    /** Execute raw SQL in the database. */
    type: "exec";
    data: string;
} | {
    /** Get one line from a prepared statement. */
    type: 'get';
    data: DataType;
    statement: string;
    noPrepare?: boolean;
} | {
    /** Run a prepared statement. */
    type: 'run';
    data: DataType;
    statement: string;
    noPrepare?: boolean;
} | {
    type: 'transaction';
    name: string;
    data: DataType;
} | {
    type: 'start';
    options: SQLOptions;
} | {
    type: 'load-extension';
    data: string;
};
type ErrorHandler = (error: Error, data: DatabaseQuery, isParentProcess: boolean) => any;
export declare class Statement<R extends DataType = DataType, T = any> {
    private db;
    private statement;
    constructor(statement: string, db: SQLDatabaseManager);
    run(data: R): Promise<sqlite.RunResult>;
    all(data: R): Promise<T[]>;
    get(data: R): Promise<T>;
    toString(): string;
    toJSON(): string;
}
export declare class SQLDatabaseManager extends QueryProcessManager<DatabaseQuery, any> {
    options: SQLOptions;
    database: null | sqlite.Database;
    state: {
        transactions: Map<string, sqlite.Transaction>;
        statements: Map<string, sqlite.Statement>;
    };
    private dbReady;
    constructor(id: string, module: NodeJS.Module, options: SQLOptions);
    private onError;
    private cacheStatement;
    registerFunction(key: string, cb: (...args: any) => any): void;
    private extractStatement;
    setupDatabase(): void;
    loadExtensionFile(extension: string): void;
    handleExtensions(imports: any): void;
    query(input: DatabaseQuery): Promise<any>;
    all<T = any>(statement: string | Statement, data?: DataType, noPrepare?: boolean): Promise<T[]>;
    get<T = any>(statement: string | Statement, data?: DataType, noPrepare?: boolean): Promise<T>;
    run(statement: string | Statement, data?: DataType, noPrepare?: boolean): Promise<sqlite.RunResult>;
    transaction<T = any>(name: string, data?: DataType): Promise<T>;
    prepare(statement: string): Promise<Statement | null>;
    exec(data: string): Promise<{
        changes: number;
    }>;
    loadExtension(filepath: string): Promise<any>;
    runFile(file: string): Promise<any>;
}
export declare const tables: Map<string, DatabaseTable<any>>;
export declare class DatabaseTable<T> {
    database: SQLDatabaseManager;
    name: string;
    primaryKeyName: string;
    constructor(name: string, primaryKeyName: string, database: SQLDatabaseManager);
    selectOne<R = T>(entries: string | string[], where?: SQLStatement): Promise<R | null>;
    selectAll<R = T>(entries: string | string[], where?: SQLStatement): Promise<R[]>;
    get(entries: string | string[], keyId: SQLInput): Promise<T | null>;
    updateAll(toParams: Partial<T>, where?: SQLStatement, limit?: number): Promise<{
        changes: number;
    }>;
    updateOne(to: Partial<T>, where?: SQLStatement): Promise<{
        changes: number;
    }>;
    deleteAll(where?: SQLStatement, limit?: number): Promise<{
        changes: number;
    }>;
    delete(keyEntry: SQLInput): Promise<{
        changes: number;
    }>;
    deleteOne(where: SQLStatement): Promise<{
        changes: number;
    }>;
    insert(colMap: Partial<T>, rest?: SQLStatement, isReplace?: boolean): Promise<sqlite.RunResult>;
    replace(cols: Partial<T>, rest?: SQLStatement): Promise<sqlite.RunResult>;
    update(primaryKey: SQLInput, data: Partial<T>): Promise<{
        changes: number;
    }>;
    run(sql: SQLStatement): Promise<{
        changes: number;
    }>;
    all<R = T>(sql: SQLStatement): Promise<R[]>;
}
declare function getSQL(id: string, module: NodeJS.Module, input: SQLOptions): SQLDatabaseManager;
export declare const SQL: typeof getSQL & {
    DatabaseTable: typeof DatabaseTable;
    SQLDatabaseManager: typeof SQLDatabaseManager;
    tables: Map<string, DatabaseTable<any>>;
    SQL: typeof import("sql-template-strings").SQL;
};
export declare namespace SQL {
    type DatabaseManager = import('./sql').SQLDatabaseManager;
    type Statement = import('./sql').Statement;
    type Options = import('./sql').SQLOptions;
    type TransactionEnvironment = import('./sql').TransactionEnvironment;
    type Query = import('./sql').DatabaseQuery;
    type DatabaseTable<T> = import('./sql').DatabaseTable<T>;
}
export {};
