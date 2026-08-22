/**
 * Path containment for file ingestion.
 *
 * Reading files server-side is the point of `doc_ingest`: if the model had to
 * pull a 2 MB log through its own context just to hand it over, the tool would
 * have saved nothing. But that means this server opens paths a model chose,
 * so the same discipline as any filesystem sandbox applies.
 *
 * Ingestion is OFF unless the operator names roots explicitly. The check
 * resolves through `realpath` before deciding, so a symlink planted inside a
 * root cannot point out of it, and containment compares whole path segments so
 * `/data-secret` never matches a root of `/data`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { InvalidError } from './errors.js';

const IS_WINDOWS = process.platform === 'win32';

export class IngestSandbox {
  private readonly roots: string[];

  private constructor(roots: string[]) {
    this.roots = roots;
  }

  /** Resolve configured roots to their physical paths, dropping unusable ones. */
  static async create(rawRoots: string[]): Promise<IngestSandbox> {
    const resolved: string[] = [];
    for (const raw of rawRoots) {
      try {
        const real = await fs.realpath(path.resolve(raw));
        const stats = await fs.stat(real);
        if (stats.isDirectory() && !resolved.includes(real)) resolved.push(real);
      } catch {
        // A root that does not exist is skipped rather than fatal — the user
        // may configure several machines with one shared config.
      }
    }
    return new IngestSandbox(resolved);
  }

  get enabled(): boolean {
    return this.roots.length > 0;
  }

  get allowed(): readonly string[] {
    return this.roots;
  }

  private comparable(p: string): string {
    return IS_WINDOWS ? p.toLowerCase() : p;
  }

  private within(child: string, root: string): boolean {
    const c = this.comparable(child);
    const r = this.comparable(root);
    return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  }

  /** Verify a file path and return its physical location. Throws if refused. */
  async resolveFile(input: string): Promise<string> {
    if (!this.enabled) {
      throw new InvalidError(
        'file ingestion is disabled — start the server with --ingest-root <dir> to enable it, ' +
          'or pass the content directly via the text argument',
      );
    }
    if (input.includes('\0')) throw new InvalidError('path rejected');

    const absolute = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(this.roots[0]!, input);

    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      throw new InvalidError(`cannot read ${input} — it does not exist or is not accessible`);
    }

    if (!this.roots.some((root) => this.within(real, root))) {
      throw new InvalidError(
        `access denied: ${input} is outside the allowed ingest directories ` +
          `(${this.roots.join(', ')})`,
      );
    }

    const stats = await fs.stat(real);
    if (!stats.isFile()) throw new InvalidError(`${input} is not a regular file`);

    return real;
  }
}
