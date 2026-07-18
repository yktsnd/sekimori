// store.ts - Store interface + memory/file implementations
//
// Usage is reserved before an upstream request is sent, then settled to the
// actual cost afterwards. Reservations are part of the persisted usage total:
// if the process exits mid-request, the conservative debit remains and the
// budget cannot be silently reset or overspent after a restart. On startup,
// orphan reservation records are finalized at that already-debited amount.

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import * as fsPromises from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { MAX_USD_AMOUNT } from "./budget.js";

export interface TokenRecord {
  id: string;
  name?: string;
  tokenHash: string;
  dailyUsd: number;
  createdAt: string;
  revokedAt?: string;
}

interface UsageReservation {
  tokenId: string;
  dateKey: string;
  reservedUsd: number;
}

interface StoreData {
  tokens: TokenRecord[];
  /** tokenId -> (YYYY-MM-DD -> USD). Includes unsettled reservations. */
  usage: Record<string, Record<string, number>>;
  /** reservation id -> conservative amount already included in usage */
  reservations: Record<string, UsageReservation>;
}

export type BudgetRejectReason = "monthly_limit" | "daily_limit";

export interface ReserveUsageParams {
  tokenId: string;
  dateKey: string;
  monthKey: string;
  worstCostUsd: number;
  tokenDailyUsd: number;
  globalMonthlyUsd: number;
}

export type ReserveUsageResult =
  | { allowed: true; reservationId: string }
  | { allowed: false; reason: BudgetRejectReason };

export interface Store {
  /** Startup initialization (FileStore reads from disk here). */
  init(): Promise<void>;
  /** Releases process-lifetime resources such as the file-store lock. */
  close(): Promise<void>;
  /** Whether the most recent persist succeeded. If false, callers must respond 503. */
  isHealthy(): boolean;
  createToken(record: TokenRecord): Promise<void>;
  listTokens(): Promise<TokenRecord[]>;
  findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined>;
  getToken(id: string): Promise<TokenRecord | undefined>;
  /** Sets revokedAt and returns the record if it exists; undefined otherwise. */
  revokeToken(id: string): Promise<TokenRecord | undefined>;
  /** Atomically checks both budget limits and reserves worstCostUsd on success. */
  reserveUsage(params: ReserveUsageParams): Promise<ReserveUsageResult>;
  /** Replaces a prior reservation with the actual, successfully incurred cost. */
  settleUsage(reservationId: string, actualUsd: number): Promise<void>;
  /** Kept for small maintenance callers; normal request accounting uses reserveUsage/settleUsage. */
  addUsage(tokenId: string, dateKey: string, usd: number): Promise<void>;
  getUsageForDate(tokenId: string, dateKey: string): Promise<number>;
  /** Current month's usage (USD) summed across all tokens. Used for the monthly kill switch. */
  getGlobalMonthlyUsage(monthKey: string): Promise<number>;
}

function emptyData(): StoreData {
  return { tokens: [], usage: Object.create(null) as Record<string, Record<string, number>>, reservations: Object.create(null) as Record<string, UsageReservation> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_USD_AMOUNT;
}

function checkedAddUsd(current: number, increment: number): number {
  const next = current + increment;
  if (!Number.isFinite(next) || (increment > 0 && next <= current)) {
    throw new Error("USD accounting increment is not representable safely");
  }
  return next;
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}-01T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 7) === value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function cloneToken(record: TokenRecord): TokenRecord {
  return { ...record };
}

function sumMonthlyUsage(usage: StoreData["usage"], monthKey: string): number {
  let total = 0;
  for (const perToken of Object.values(usage)) {
    for (const [dateKey, usd] of Object.entries(perToken)) {
      if (dateKey.startsWith(monthKey)) total = checkedAddUsd(total, usd);
    }
  }
  return total;
}

function usageFor(data: StoreData, tokenId: string): Record<string, number> {
  const existing = data.usage[tokenId];
  if (existing) return existing;
  const created = Object.create(null) as Record<string, number>;
  data.usage[tokenId] = created;
  return created;
}

/**
 * Drops settled usage from earlier calendar months while retaining every
 * unresolved reservation. The gateway only enforces the current UTC month
 * and the current UTC day, so historical settled entries provide no runtime
 * value and would otherwise make a long-lived file store grow forever.
 *
 * A reservation can legitimately cross a month boundary (for example, if an
 * upstream request is still in flight at midnight). For those dates we retain
 * exactly the amount that is still reserved, so a later settlement remains
 * valid without keeping completed historical spend around.
 */
function pruneSettledUsageBeforeMonth(data: StoreData, monthKey: string): boolean {
  const reservedByUsageKey = new Map<string, number>();
  for (const reservation of Object.values(data.reservations)) {
    const key = `${reservation.tokenId}\u0000${reservation.dateKey}`;
    reservedByUsageKey.set(key, (reservedByUsageKey.get(key) ?? 0) + reservation.reservedUsd);
  }

  const firstDateInMonth = `${monthKey}-01`;
  let changed = false;
  for (const [tokenId, perToken] of Object.entries(data.usage)) {
    for (const dateKey of Object.keys(perToken)) {
      // Date keys are written internally as YYYY-MM-DD. Preserve malformed or
      // future entries defensively rather than deleting data we cannot reason
      // about from a lexical date comparison.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || dateKey >= firstDateInMonth) continue;

      const key = `${tokenId}\u0000${dateKey}`;
      const reservedUsd = reservedByUsageKey.get(key) ?? 0;
      if (reservedUsd > 0) {
        if (perToken[dateKey] !== reservedUsd) {
          perToken[dateKey] = reservedUsd;
          changed = true;
        }
      } else {
        delete perToken[dateKey];
        changed = true;
      }
    }
    if (Object.keys(perToken).length === 0) {
      delete data.usage[tokenId];
      changed = true;
    }
  }
  return changed;
}

function reserveUsage(data: StoreData, params: ReserveUsageParams): ReserveUsageResult {
  if (
    !isFinitePositive(params.worstCostUsd) ||
    !isFinitePositive(params.tokenDailyUsd) ||
    !isFinitePositive(params.globalMonthlyUsd)
  ) {
    throw new Error("invalid budget reservation values");
  }
  if (!data.tokens.some((token) => token.id === params.tokenId)) throw new Error("unknown token for usage reservation");
  if (!isDateKey(params.dateKey) || !isMonthKey(params.monthKey) || !params.dateKey.startsWith(`${params.monthKey}-`)) {
    throw new Error("reservation dateKey and monthKey must describe the same real UTC date");
  }

  const globalMonthUsd = sumMonthlyUsage(data.usage, params.monthKey);
  const globalAfterReservation = checkedAddUsd(globalMonthUsd, params.worstCostUsd);
  if (globalAfterReservation > params.globalMonthlyUsd) {
    return { allowed: false, reason: "monthly_limit" };
  }

  const perToken = usageFor(data, params.tokenId);
  const tokenTodayUsd = perToken[params.dateKey] ?? 0;
  const tokenAfterReservation = checkedAddUsd(tokenTodayUsd, params.worstCostUsd);
  if (tokenAfterReservation > params.tokenDailyUsd) {
    return { allowed: false, reason: "daily_limit" };
  }

  const reservationId = randomUUID();
  perToken[params.dateKey] = tokenAfterReservation;
  data.reservations[reservationId] = {
    tokenId: params.tokenId,
    dateKey: params.dateKey,
    reservedUsd: params.worstCostUsd,
  };
  return { allowed: true, reservationId };
}

function settleUsage(data: StoreData, reservationId: string, actualUsd: number): void {
  if (!isFiniteNonNegative(actualUsd)) throw new Error("invalid actual usage cost");
  const reservation = data.reservations[reservationId];
  if (!reservation) throw new Error("unknown usage reservation");

  const perToken = usageFor(data, reservation.tokenId);
  const current = perToken[reservation.dateKey] ?? 0;
  const afterReservationRemoval = current - reservation.reservedUsd;
  if (afterReservationRemoval < -Number.EPSILON) throw new Error("usage reservation would make accounting negative");
  const next = checkedAddUsd(Math.max(0, afterReservationRemoval), actualUsd);

  perToken[reservation.dateKey] = Math.max(0, next);
  delete data.reservations[reservationId];
}

function validateTokenRecord(value: unknown): TokenRecord {
  if (!isRecord(value)) throw new Error("invalid token record in state file");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.tokenHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.tokenHash) ||
    !isFinitePositive(value.dailyUsd) ||
    !isIsoTimestamp(value.createdAt)
  ) {
    throw new Error("invalid token record in state file");
  }
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 256)) {
    throw new Error("invalid token name in state file");
  }
  if (value.revokedAt !== undefined && !isIsoTimestamp(value.revokedAt)) throw new Error("invalid revokedAt in state file");
  return {
    id: value.id,
    ...(value.name !== undefined ? { name: value.name } : {}),
    tokenHash: value.tokenHash,
    dailyUsd: value.dailyUsd,
    createdAt: value.createdAt,
    ...(value.revokedAt !== undefined ? { revokedAt: value.revokedAt } : {}),
  };
}

function validateStoreData(value: unknown): StoreData {
  if (!isRecord(value) || !Array.isArray(value.tokens) || !isRecord(value.usage)) {
    throw new Error("state file must contain tokens and usage objects");
  }

  const tokens = value.tokens.map(validateTokenRecord);
  const seenTokenIds = new Set<string>();
  const seenTokenHashes = new Set<string>();
  for (const token of tokens) {
    if (seenTokenIds.has(token.id)) throw new Error("state file contains duplicate token ids");
    if (seenTokenHashes.has(token.tokenHash)) throw new Error("state file contains duplicate token hashes");
    seenTokenIds.add(token.id);
    seenTokenHashes.add(token.tokenHash);
  }

  const usage = Object.create(null) as Record<string, Record<string, number>>;
  for (const [tokenId, perTokenRaw] of Object.entries(value.usage)) {
    if (!seenTokenIds.has(tokenId)) throw new Error("state file usage references an unknown token");
    if (!isRecord(perTokenRaw)) throw new Error("invalid usage entry in state file");
    const perToken = Object.create(null) as Record<string, number>;
    for (const [dateKey, usd] of Object.entries(perTokenRaw)) {
      if (!isDateKey(dateKey) || !isFiniteNonNegative(usd)) throw new Error("invalid usage entry in state file");
      perToken[dateKey] = usd;
    }
    usage[tokenId] = perToken;
  }

  const reservations = Object.create(null) as Record<string, UsageReservation>;
  const reservationsRaw = value.reservations;
  if (reservationsRaw !== undefined) {
    if (!isRecord(reservationsRaw)) throw new Error("invalid reservations in state file");
    for (const [reservationId, reservationRaw] of Object.entries(reservationsRaw)) {
      if (
        !isRecord(reservationRaw) ||
        typeof reservationRaw.tokenId !== "string" ||
        !seenTokenIds.has(reservationRaw.tokenId) ||
        !isDateKey(reservationRaw.dateKey) ||
        !isFinitePositive(reservationRaw.reservedUsd)
      ) {
        throw new Error("invalid usage reservation in state file");
      }
      reservations[reservationId] = {
        tokenId: reservationRaw.tokenId,
        dateKey: reservationRaw.dateKey,
        reservedUsd: reservationRaw.reservedUsd,
      };
    }
  }

  const reservedByUsageKey = new Map<string, number>();
  for (const reservation of Object.values(reservations)) {
    const key = `${reservation.tokenId}\u0000${reservation.dateKey}`;
    const total = (reservedByUsageKey.get(key) ?? 0) + reservation.reservedUsd;
    if (!Number.isFinite(total)) throw new Error("state file reservation total is not finite");
    reservedByUsageKey.set(key, total);
  }
  for (const [key, reservedUsd] of reservedByUsageKey) {
    const [tokenId, dateKey] = key.split("\u0000");
    if ((usage[tokenId]?.[dateKey] ?? 0) + Number.EPSILON < reservedUsd) {
      throw new Error("state file has a reservation not reflected in usage");
    }
  }

  return { tokens, usage, reservations };
}

/**
 * Validates the exact state-file format FileStore accepts without mutating the
 * file. doctor uses this same parser so a successful self-check means startup
 * will not later fail solely because state.json is malformed.
 */
export function validateStoreFileText(text: string): void {
  validateStoreData(JSON.parse(text));
}

/** Serializes mutation functions without forcing reads to wait. */
class MutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** In-memory implementation. Lost on process exit. For tests and trying things out. */
export class MemoryStore implements Store {
  private data: StoreData = emptyData();
  private readonly mutations = new MutationQueue();

  async init(): Promise<void> {
    // no-op
  }

  async close(): Promise<void> {
    // no-op
  }

  isHealthy(): boolean {
    return true;
  }

  async createToken(record: TokenRecord): Promise<void> {
    await this.mutations.run(() => {
      this.data.tokens.push(cloneToken(record));
    });
  }

  async listTokens(): Promise<TokenRecord[]> {
    return this.data.tokens.map(cloneToken);
  }

  async findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined> {
    const record = this.data.tokens.find((t) => t.tokenHash === tokenHash);
    return record ? cloneToken(record) : undefined;
  }

  async getToken(id: string): Promise<TokenRecord | undefined> {
    const record = this.data.tokens.find((t) => t.id === id);
    return record ? cloneToken(record) : undefined;
  }

  async revokeToken(id: string): Promise<TokenRecord | undefined> {
    return this.mutations.run(() => {
      const record = this.data.tokens.find((t) => t.id === id);
      if (!record) return undefined;
      if (!record.revokedAt) record.revokedAt = new Date().toISOString();
      return cloneToken(record);
    });
  }

  async reserveUsage(params: ReserveUsageParams): Promise<ReserveUsageResult> {
    return this.mutations.run(() => {
      pruneSettledUsageBeforeMonth(this.data, params.monthKey);
      return reserveUsage(this.data, params);
    });
  }

  async settleUsage(reservationId: string, actualUsd: number): Promise<void> {
    await this.mutations.run(() => settleUsage(this.data, reservationId, actualUsd));
  }

  async addUsage(tokenId: string, dateKey: string, usd: number): Promise<void> {
    if (!isFiniteNonNegative(usd) || !isDateKey(dateKey)) throw new Error("invalid usage cost or date");
    await this.mutations.run(() => {
      if (!this.data.tokens.some((token) => token.id === tokenId)) throw new Error("unknown token for usage");
      const perToken = usageFor(this.data, tokenId);
      perToken[dateKey] = checkedAddUsd(perToken[dateKey] ?? 0, usd);
    });
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
  restrictFilePermissions(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  syncDirectory(dir: string): Promise<void>;
  acquireLock(path: string): Promise<() => Promise<void>>;
}

export const nodeFileStoreFS: FileStoreFS = {
  readFile: (path) => fsPromises.readFile(path, "utf8"),
  restrictFilePermissions: async (path) => {
    // Windows does not implement POSIX owner/group/other mode bits. Avoid
    // turning a valid state file into a startup failure there; the containing
    // directory's ACL remains the operator's protection boundary.
    if (process.platform !== "win32") await fsPromises.chmod(path, 0o600);
  },
  writeFile: async (path, data) => {
    const handle = await fsPromises.open(path, "wx", 0o600);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => fsPromises.rename(from, to),
  mkdir: async (dir) => {
    await fsPromises.mkdir(dir, { recursive: true });
  },
  removeFile: async (path) => {
    await fsPromises.rm(path, { force: true });
  },
  syncDirectory: async (dir) => {
    let handle: fsPromises.FileHandle | undefined;
    try {
      handle = await fsPromises.open(dir, "r");
      await handle.sync();
    } catch (err) {
      const code = isErrnoException(err) ? err.code : undefined;
      if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code ?? "")) {
        throw err;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  acquireLock: async (path) => {
    const nonce = randomUUID();
    let handle: fsPromises.FileHandle;
    try {
      handle = await fsPromises.open(path, "wx", 0o600);
    } catch (err) {
      if (isErrnoException(err) && err.code === "EEXIST") {
        throw new Error(
          `file store is already locked: ${path} (if the prior process was hard-killed, verify it is stopped before removing this stale lock)`,
        );
      }
      throw err;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }), "utf8");
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fsPromises.rm(path, { force: true }).catch(() => undefined);
      throw err;
    }

    let released = false;
    const lockStillOwnedSync = (): boolean => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { nonce?: unknown };
        return parsed.nonce === nonce;
      } catch {
        return false;
      }
    };
    const cleanupOnExit = (): void => {
      if (released) return;
      try {
        if (lockStillOwnedSync()) rmSync(path, { force: true });
      } catch {
        // Process exit is already in progress; an operator can remove a stale
        // lock after confirming no process still owns this state file.
      }
    };
    process.once("exit", cleanupOnExit);
    return async () => {
      if (released) return;
      released = true;
      process.removeListener("exit", cleanupOnExit);
      await handle.close().catch(() => undefined);
      let stillOwned = false;
      try {
        const parsed = JSON.parse(await fsPromises.readFile(path, "utf8")) as { nonce?: unknown };
        stillOwned = parsed.nonce === nonce;
      } catch {
        // Missing/replaced lock: never delete an object we cannot prove is ours.
      }
      if (stillOwned) await fsPromises.rm(path, { force: true });
    };
  },
};

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Store that persists to a JSON file. isHealthy() goes false when a write fails. */
export class FileStore implements Store {
  private data: StoreData = emptyData();
  private healthy = true;
  private readonly mutations = new MutationQueue();
  private releaseLock: (() => Promise<void>) | undefined;

  constructor(
    private readonly filePath: string,
    private readonly fs: FileStoreFS = nodeFileStoreFS,
  ) {}

  isHealthy(): boolean {
    return this.healthy;
  }

  async init(): Promise<void> {
    if (this.releaseLock !== undefined) throw new Error("file store is already initialized");
    await this.fs.mkdir(dirname(this.filePath));
    this.releaseLock = await this.fs.acquireLock(`${this.filePath}.lock`);
    try {
      let text: string;
      try {
        text = await this.fs.readFile(this.filePath);
      } catch (err) {
        if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
        // Only a missing initial read means first run. An ENOENT from later
        // permission hardening or persistence is a storage failure and must
        // never reset existing accounting to an empty state.
        this.data = emptyData();
        await this.persist();
        return;
      }
      this.data = validateStoreData(JSON.parse(text));
      // Older sekimori versions could leave an otherwise valid state file
      // readable by group/other. chmod is an atomic metadata-only migration:
      // it preserves the validated bytes and the existing snapshot/rename
      // durability path while tightening permissions before startup succeeds.
      await this.fs.restrictFilePermissions(this.filePath);
      if (Object.keys(this.data.reservations).length > 0) {
        // No request survives a process restart to present these reservation
        // IDs for settlement. The usage table already contains each worst-case
        // debit, so remove only the orphan metadata and persist that final
        // conservative charge.
        this.data.reservations = Object.create(null) as Record<string, UsageReservation>;
        await this.persist();
      }
      this.healthy = true;
    } catch (err) {
      this.healthy = false;
      await this.close().catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    const release = this.releaseLock;
    this.releaseLock = undefined;
    await release?.();
  }

  /** Writes a complete snapshot through a same-directory temp file. */
  private async persist(): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await this.fs.mkdir(dirname(this.filePath));
      await this.fs.writeFile(temporaryPath, JSON.stringify(this.data));
      await this.fs.rename(temporaryPath, this.filePath);
      await this.fs.syncDirectory(dirname(this.filePath));
      this.healthy = true;
    } catch (err) {
      await this.fs.removeFile(temporaryPath).catch(() => undefined);
      this.healthy = false;
      throw err;
    }
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    return this.mutations.run(async () => {
      if (!this.healthy) throw new Error("storage is unavailable");
      const result = operation();
      await this.persist();
      return result;
    });
  }

  async createToken(record: TokenRecord): Promise<void> {
    await this.mutate(() => {
      this.data.tokens.push(cloneToken(record));
    });
  }

  async listTokens(): Promise<TokenRecord[]> {
    return this.data.tokens.map(cloneToken);
  }

  async findTokenByHash(tokenHash: string): Promise<TokenRecord | undefined> {
    const record = this.data.tokens.find((t) => t.tokenHash === tokenHash);
    return record ? cloneToken(record) : undefined;
  }

  async getToken(id: string): Promise<TokenRecord | undefined> {
    const record = this.data.tokens.find((t) => t.id === id);
    return record ? cloneToken(record) : undefined;
  }

  async revokeToken(id: string): Promise<TokenRecord | undefined> {
    return this.mutate(() => {
      const record = this.data.tokens.find((t) => t.id === id);
      if (!record) return undefined;
      if (!record.revokedAt) record.revokedAt = new Date().toISOString();
      return cloneToken(record);
    });
  }

  async reserveUsage(params: ReserveUsageParams): Promise<ReserveUsageResult> {
    return this.mutations.run(async () => {
      if (!this.healthy) throw new Error("storage is unavailable");
      const pruned = pruneSettledUsageBeforeMonth(this.data, params.monthKey);
      const result = reserveUsage(this.data, params);
      // Persist compaction even when the new reservation is denied, otherwise
      // a busy account at its cap would never reclaim old historical rows.
      if (result.allowed || pruned) await this.persist();
      return result;
    });
  }

  async settleUsage(reservationId: string, actualUsd: number): Promise<void> {
    await this.mutate(() => settleUsage(this.data, reservationId, actualUsd));
  }

  async addUsage(tokenId: string, dateKey: string, usd: number): Promise<void> {
    if (!isFiniteNonNegative(usd) || !isDateKey(dateKey)) throw new Error("invalid usage cost or date");
    await this.mutate(() => {
      if (!this.data.tokens.some((token) => token.id === tokenId)) throw new Error("unknown token for usage");
      const perToken = usageFor(this.data, tokenId);
      perToken[dateKey] = checkedAddUsd(perToken[dateKey] ?? 0, usd);
    });
  }

  async getUsageForDate(tokenId: string, dateKey: string): Promise<number> {
    return this.data.usage[tokenId]?.[dateKey] ?? 0;
  }

  async getGlobalMonthlyUsage(monthKey: string): Promise<number> {
    return sumMonthlyUsage(this.data.usage, monthKey);
  }
}
