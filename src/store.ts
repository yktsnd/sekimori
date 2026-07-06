// store.ts — Store インターフェース + MemoryStore + FileStore
//
// トークンレコードと日次会計（usage）を永続化する。FileStore はディスク書き込みに
// 失敗した場合 isHealthy() が false になる（fail-closed。§5）。プロセスは落とさない。

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
  /** 起動時の初期化（FileStore はここでディスクから読み込む）。 */
  init(): Promise<void>;
  /** 直近の永続化が成功しているか。false の場合、呼び出し側は 503 で遮断する。 */
  isHealthy(): boolean;
  createToken(record: TokenRecord): Promise<void>;
  listTokens(): Promise<TokenRecord[]>;
  findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined>;
  getToken(id: string): Promise<TokenRecord | undefined>;
  /** 存在すれば revokedAt を立てて返す。存在しなければ undefined。 */
  revokeToken(id: string): Promise<TokenRecord | undefined>;
  addUsage(tokenId: string, dateKey: string, usd: number): Promise<void>;
  getUsageForDate(tokenId: string, dateKey: string): Promise<number>;
  /** 全トークン合算の当月実績（USD）。月次キルスイッチの判定に使う。 */
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

/** インメモリ実装。プロセス終了で消える。テスト・お試し用途向け。 */
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

/** FileStore が使うファイル操作の最小インターフェース。テストで差し替え可能にするための抽象化。 */
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

/** JSON ファイルへ永続化するストア。書き込み失敗時は isHealthy() が false になる。 */
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
        // 初回起動: 空の状態を作って書き出す。ここで書き込みに失敗するなら
        // 起動時点で fail-closed（プロセスを起動させない）にする。
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
