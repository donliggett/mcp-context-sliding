/** Error taxonomy. Handlers translate these into tool errors the model reads. */

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export class NotFoundError extends ToolError {
  constructor(what: string) {
    super('NOT_FOUND', what);
    this.name = 'NotFoundError';
  }
}

export class InvalidError extends ToolError {
  constructor(message: string) {
    super('INVALID', message);
    this.name = 'InvalidError';
  }
}

export class LimitError extends ToolError {
  constructor(message: string) {
    super('LIMIT', message);
    this.name = 'LimitError';
  }
}

export function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
