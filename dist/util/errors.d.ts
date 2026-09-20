/** Error taxonomy. Handlers translate these into tool errors the model reads. */
export declare class ToolError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class NotFoundError extends ToolError {
    constructor(what: string);
}
export declare class InvalidError extends ToolError {
    constructor(message: string);
}
export declare class LimitError extends ToolError {
    constructor(message: string);
}
export declare function errnoCode(err: unknown): string | undefined;
