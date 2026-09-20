/** Error taxonomy. Handlers translate these into tool errors the model reads. */
export class ToolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ToolError';
        this.code = code;
    }
}
export class NotFoundError extends ToolError {
    constructor(what) {
        super('NOT_FOUND', what);
        this.name = 'NotFoundError';
    }
}
export class InvalidError extends ToolError {
    constructor(message) {
        super('INVALID', message);
        this.name = 'InvalidError';
    }
}
export class LimitError extends ToolError {
    constructor(message) {
        super('LIMIT', message);
        this.name = 'LimitError';
    }
}
export function errnoCode(err) {
    if (err && typeof err === 'object' && 'code' in err) {
        const code = err.code;
        if (typeof code === 'string')
            return code;
    }
    return undefined;
}
//# sourceMappingURL=errors.js.map