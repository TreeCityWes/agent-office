import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The hash a journal starts from. */
const GENESIS = '0'.repeat(64);

const hashOf = (prev: string, entry: unknown) => createHash('sha256').update(`${prev}\n${JSON.stringify(entry)}`).digest('hex');

/** What reading a journal found: its entries, and whether the chain held. */
export interface JournalRead<T> {
  entries: T[];
  ok: boolean;
  /** Why the chain didn't hold, or what was put right (a line half-written when the office stopped). */
  problem?: string;
  repaired?: string;
}

/**
 * An append-only JSONL file where each line carries the hash of the line before it, the way the
 * fund keeps its fills and its activity log (see docs/fund.md#audit). Nothing is ever rewritten, so
 * an edit anywhere breaks the chain from there on, and reading it says where.
 */
export class Journal<T extends object> {
  private head = GENESIS;

  constructor(readonly file: string) {}

  /** Reads every entry and checks the chain. A last line cut short (the office stopped mid-write) is dropped. */
  read(): JournalRead<T> {
    if (!existsSync(this.file)) return { entries: [], ok: true };
    const text = readFileSync(this.file, 'utf8');
    const lines = text.split('\n');
    const entries: T[] = [];
    let prev = GENESIS;
    let repaired: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let parsed: (T & { prev?: string; hash?: string }) | undefined;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Only the very last line may be torn; anywhere else it's damage.
        if (i === lines.length - 1) {
          writeFileSync(this.file, lines.slice(0, i).join('\n') + (i ? '\n' : ''), { mode: 0o600 });
          repaired = `dropped line ${i + 1}, cut short when the office stopped`;
          break;
        }
        this.head = prev;
        return { entries, ok: false, problem: `line ${i + 1} of ${this.file} isn't JSON` };
      }
      const { prev: p, hash, ...entry } = parsed!;
      if (p !== prev || hash !== hashOf(prev, entry)) {
        this.head = prev;
        return { entries, ok: false, problem: `line ${i + 1} of ${this.file} doesn't match the chain: it, or a line before it, was changed outside the office` };
      }
      entries.push(entry as T);
      prev = hash;
    }
    this.head = prev;
    return { entries, ok: true, ...(repaired ? { repaired } : {}) };
  }

  /** Adds an entry at the end, chained to the one before (making its folder the first time). */
  append(entry: T) {
    if (this.head === GENESIS) mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const hash = hashOf(this.head, entry);
    appendFileSync(this.file, `${JSON.stringify({ ...entry, prev: this.head, hash })}\n`, { mode: 0o600 });
    this.head = hash;
  }
}
