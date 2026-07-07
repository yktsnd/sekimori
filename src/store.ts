// store.ts - Store interface + MemoryStore + FileStore
//
// Persists token records and daily accounting (usage). FileStore's
// isHealthy() goes false if a disk write fails (fail-closed, section 5). The
// process itself keeps running.

import { dirname } from "node:path";
import * as fsPromises from "node:fs/promises";

export interface TokenRecord {
  id: string;
  name?: string;
  tokenHash: string;
  dailyUsd: number;
  createdAt: string;
  revokedAt?: string;
}

interface StoreData {
  tokens: TokenRecord[];
  /** tokenId -> (YYYY-MM-DD -> USD) */
  usage: Record<string, Record<string, number>>;
}

export interface Store {
  /** Startup initialization (FileStore reads from disk here). */
  init(): Promise<void>;
  /** Whether the most recent persist succeeded. If false, callers must respond 503. */
  isHealthy(): boolean;
  createToken(record: TokenRecord): Promise<void>;
  listTokens(): Promise<TokenRecord[]>;
  findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined>;
  getToken(id: string): Promise<TokenRecord | undefined>;
  /** Sets revokedAt and returns the record if it exists; undefined otherwise. */
  revokeToken(id: string): Promise<TokenRecord | undefined>;
  addUsage(tokenId: string, dateKey: string, usd: number): Promise<void>;
  getUsageForDate(tokenId: string, dateKey: string): Promise<number>;
  /** Current month's usage (USD) summed across all tokens. Used for the monthly kill switch. */
  getGlobalMonthlyUsage(monthKey: string): Promise<number>;
}

function sumMonthlyUsage(usage: StoreData["usage"], monthKey: string): number {
  let total = 0;
  for (const perToken of Object.values(usage)) {
    for (const [dateKey, usd] of Object.entries(perToken)) {
      if (dateKey.startsWith(monthKey)) {
        total += usd;
      }
    }
  }
  return total;
}

/** In-memory implementation. Lost on process exit. For tests and trying things out. */
export class MemoryStore implements Store {
  private data: StoreData = { tokens: [], usage: {} };

  async init(): Promise<void> {
    // no-op
  }

  isHealthy(): boolean {
    return true;
  }

  async createToken(record: TokenRecord): Promise<void> {
    this.data.tokens.push(record);
  }

  async listTokens(): Promise<TokenRecord[]> {
    return [...this.data.tokens];
  }

  async findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined> {
    return this.data.tokens.find((t) => t.tokenHash === tokenHash);
  }

  async getToken(id: string): Promise<TokenRecord | undefined> {
    return this.data.tokens.find((t) => t.id === id);
  }

  async revokeToken(id: string): Promise<TokenRecord | undefined> {
    const record = this.data.tokens.find((t) => t.id === id);
    if (!record) return undefined;
    if (!record.revokedAt) record.revokedAt = new Date().toISOString();
    return record;
  }

  async addUsage(tokenId: string, dateKey: string, usd: number): Promise<void> {
    const perToken = this.data.usage[tokenId] ?? (this.data.usage[tokenId] = {});
    perToken[dateKey] = (perToken[dateKey] ?? 0) + usd;
  }

  async getUsageForDate(tokenId: string, dateKey: string): Promise<number> {
    return this.data.usage[tokenId]?.[dateKey] ?? 0;
  }

  async getGlobalMonthlyUsage(monthKey: string): Promise<number> {
    return sumMonthlyUsage(this.data.usage, monthKey);
  }
}

/** Minimal file-operation interface FileStore depends on, so tests can swap it out. */
export interface FileStoreFS {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export const nodeFileStoreFS: FileStoreFS = {
  readFile: (path) => fsPromises.readFile(path, "utf8"),
  writeFile: (path, data) => fsPromises.writeFile(path, data, "utf8"),
  mkdir: async (dir) => {
    await fsPromises.mkdir(dir, { recursive: true });
  },
};

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Store that persists to a JSON file. isHealthy() goes false when a write fails. */
export class FileStore implements Store {
  private data: StoreData = { tokens: [], usage: {} };
  private healthy = true;

  constructor(
    private readonly filePath: string,
    private readonly fs: FileStoreFS = nodeFileStoreFS,
  ) {}

  isHealthy(): boolean {
    return this.healthy;
  }

  async init(): Promise<void> {
    try {
      const text = await this.fs.readFile(this.filePath);
      const parsed = JSON.parse(text) as Partial<StoreData>;
      this.data = {
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
        usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {},
      };
      this.healthy = true;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        // First run: create empty state and write it out. If that write
        // fails, fail-closed at startup (refuse to start the process).
        this.data = { tokens: [], usage: {} };
        await this.persist();
        return;
      }
      throw err;
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.fs.mkdir(dirname(this.filePath));
      await this.fs.writeFile(this.filePath, JSON.stringify(this.data));
      this.healthy = true;
    } catch (err) {
      this.healthy = false;
      throw err;
    }
  }

  async createToken(record: TokenRecord): Promise<void> {
    this.data.tokens.push(record);
    await this.persist();
  }

  async listTokens(): Promise<TokenRecord[]> {
    return [...this.data.tokens];
  }

  async findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined> {
    return this.data.tokens.find((t) => t.tokenHash === tokenHash);
  }

  async getToken(id: string): Promise<TokenRecord | undefined> {
    return this.data.tokens.find((t) => t.id === id);
  }

  async revokeToken(id: string): Promise<TokenRecord | undefined> {
    const record = this.data.tokens.find((t) => t.id === id);
    if (!record) return undefined;
    if (!record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      await this.persist();
    }
    return record;
  }

  async addUsage(tokenId: string, dateKey: string, usd: number): Promise<void> {
    const perToken = this.data.usage[tokenId] ?? (this.data.usage[tokenId] = {});
    perToken[dateKey] = (perToken[dateKey] ?? 0) + usd;
    await this.persist();
  }

  async getUsageForDate(tokenId: string, dateKey: string): Promise<number> {
    return this.data.usage[tokenId]?.[dateKey] ?? 0;
  }

  async getGlobalMonthlyUsage(monthKey: string): Promise<number> {
    return sumMonthlyUsage(this.data.usage, monthKey);
  }
}
