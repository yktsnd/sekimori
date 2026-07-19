// Design doc 8-6: fail-closed - inject a FileStore write failure -> 503 from then on

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, type FileStoreFS, MemoryStore, validateStoreFileText } from "../src/store.js";
import { startMockUpstream, jsonMessagesHandler } from "./helpers/mock-upstream.js";
import { buildTestConfig, buildApp, issueToken, messagesRequest } from "./helpers/test-app.js";

/** FileStoreFS that avoids the real disk and can inject failures. DI so tests don't depend on root/permissions. */
function makeControllableFs(): {
  fs: FileStoreFS;
  setShouldFail(v: boolean): void;
  setShouldFailPermissions(v: boolean): void;
} {
  const files = new Map<string, string>();
  let shouldFail = false;
  let shouldFailPermissions = false;
  let lockHeld = false;
  const fs: FileStoreFS = {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    },
    async restrictFilePermissions() {
      if (shouldFailPermissions) {
        const err = new Error("simulated permission hardening failure") as NodeJS.ErrnoException;
        // ENOENT is significant: only a missing initial read is a new store.
        // A later chmod ENOENT must fail closed instead of resetting usage.
        err.code = "ENOENT";
        throw err;
      }
    },
    async writeFile(path, data) {
      if (shouldFail) throw new Error("simulated disk write failure");
      files.set(path, data);
    },
    async rename(from, to) {
      const content = files.get(from);
      if (content === undefined) throw new Error(`missing temporary file: ${from}`);
      files.set(to, content);
      files.delete(from);
    },
    async mkdir() {
      // no-op: virtual filesystem, no directories to create
    },
    async removeFile(path) {
      files.delete(path);
    },
    async syncDirectory() {
      // no-op: virtual filesystem has no durability boundary
    },
    async acquireLock() {
      if (lockHeld) throw new Error("simulated file store lock is already held");
      lockHeld = true;
      return async () => {
        lockHeld = false;
      };
    },
  };
  return {
    fs,
    setShouldFail: (v: boolean) => (shouldFail = v),
    setShouldFailPermissions: (v: boolean) => (shouldFailPermissions = v),
  };
}

test("FileStore: a second process cannot open the same accounting state", async () => {
  const { fs } = makeControllableFs();
  const first = new FileStore("/virtual/state.json", fs);
  const second = new FileStore("/virtual/state.json", fs);
  await first.init();
  await assert.rejects(() => second.init(), /lock is already held/);
  await first.close();

  await second.init();
  await second.close();
});

test("FileStore: the real filesystem lock is exclusive and state files are owner-only on POSIX", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sekimori-store-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const first = new FileStore(path);
  const second = new FileStore(path);

  await first.init();
  await assert.rejects(() => second.init(), /already locked/);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${path}.lock`)).mode & 0o777, 0o600);
  }
  await first.close();

  await second.init();
  await second.close();
});

test(
  "FileStore: init migrates an existing valid state file from 0644 to owner-only on POSIX",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "sekimori-store-mode-migration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "state.json");
    await writeFile(path, JSON.stringify({ tokens: [], usage: {}, reservations: {} }), "utf8");
    await chmod(path, 0o644);
    assert.equal((await stat(path)).mode & 0o777, 0o644);

    const store = new FileStore(path);
    await store.init();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await store.close();
  },
);

test("FileStore: permission migration failure fails initialization closed and releases the lock", async () => {
  const { fs, setShouldFailPermissions } = makeControllableFs();
  const initial = new FileStore("/virtual/state.json", fs);
  await initial.init();
  await initial.close();

  setShouldFailPermissions(true);
  const failed = new FileStore("/virtual/state.json", fs);
  await assert.rejects(() => failed.init(), /simulated permission hardening failure/);
  assert.equal(failed.isHealthy(), false);

  setShouldFailPermissions(false);
  const recovered = new FileStore("/virtual/state.json", fs);
  await recovered.init();
  await recovered.close();
});

test("fail-closed: once FileStore write fails, all subsequent requests are 503 (process keeps running)", async (t) => {
  const upstream = await startMockUpstream(jsonMessagesHandler({ inputTokens: 10, outputTokens: 10 }));
  t.after(() => upstream.close());

  const { fs, setShouldFail } = makeControllableFs();
  const store = new FileStore("/virtual/state.json", fs);
  await store.init();
  assert.equal(store.isHealthy(), true);

  const config = buildTestConfig(upstream.baseUrl, { store: { type: "file", path: "/virtual/state.json" } });
  const { app, adminKey } = buildApp(config, store);
  const issued = await issueToken(app, adminKey, { dailyUsd: 100 });

  const body = { model: "test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  // works fine while the disk is healthy
  const res1 = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(res1.status, 200);
  assert.equal(store.isHealthy(), true);

  // Inject a write failure. Requests reserve their worst-case budget before
  // they are forwarded, so this fails closed before this call can reach the
  // upstream at all.
  setShouldFail(true);
  const res2 = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(res2.status, 503);
  assert.equal(store.isHealthy(), false);

  // subsequent requests are blocked with 503, without even reaching the upstream/budget logic
  const res3 = await app.fetch(messagesRequest(issued.token, body));
  assert.equal(res3.status, 503);
  const json3 = (await res3.json()) as { error: { type: string; message: string } };
  assert.equal(json3.error.type, "storage_unavailable_error");

  const usageRes = await app.fetch(new Request("http://localhost/v1/usage", { headers: { Authorization: `Bearer ${issued.token}` } }));
  assert.equal(usageRes.status, 503);

  const adminRes = await app.fetch(
    new Request("http://localhost/admin/usage", { headers: { Authorization: `Bearer ${adminKey}` } }),
  );
  assert.equal(adminRes.status, 503);

  // /healthz keeps responding even in the degraded state, since it doesn't depend on the store.
  const healthRes = await app.fetch(new Request("http://localhost/healthz"));
  assert.equal(healthRes.status, 200);
});

test("fail-closed: an admin persist failure returns the documented structured 503", async () => {
  const { fs, setShouldFail } = makeControllableFs();
  const store = new FileStore("/virtual/state.json", fs);
  await store.init();
  const config = buildTestConfig("http://127.0.0.1:1", { store: { type: "file", path: "/virtual/state.json" } });
  const { app, adminKey } = buildApp(config, store);

  // The health middleware observes a healthy store before this request; the
  // write itself then fails. onError must still normalize that race to 503.
  setShouldFail(true);
  const res = await app.fetch(
    new Request("http://localhost/admin/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "will-not-persist", dailyUsd: 1 }),
    }),
  );
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { type: string } };
  assert.equal(body.error.type, "storage_unavailable_error");
  assert.equal(store.isHealthy(), false);
});

test("FileStore: a restart finalizes an orphan reservation at its conservative debit", async () => {
  const { fs } = makeControllableFs();
  const first = new FileStore("/virtual/state.json", fs);
  await first.init();
  await first.createToken({
    id: "token-1",
    tokenHash: "a".repeat(64),
    dailyUsd: 5,
    createdAt: "2026-07-14T00:00:00.000Z",
  });

  const reserved = await first.reserveUsage({
    tokenId: "token-1",
    dateKey: "2026-07-14",
    monthKey: "2026-07",
    worstCostUsd: 1,
    tokenDailyUsd: 5,
    globalMonthlyUsd: 10,
  });
  assert.ok(reserved.allowed);
  if (!reserved.allowed) return;

  // A process exit between forwarding and settlement must not erase the
  // conservative debit. A new FileStore instance reads the same snapshot.
  await first.close();
  const restarted = new FileStore("/virtual/state.json", fs);
  await restarted.init();
  assert.equal(await restarted.getUsageForDate("token-1", "2026-07-14"), 1);
  assert.equal(await restarted.getGlobalMonthlyUsage("2026-07"), 1);
  await restarted.close();

  await assert.rejects(() => restarted.settleUsage(reserved.reservationId, 0.25), /unknown usage reservation/);
  assert.equal(await restarted.getUsageForDate("token-1", "2026-07-14"), 1);
  assert.equal(await restarted.getGlobalMonthlyUsage("2026-07"), 1);
});

test("FileStore: a new month compacts settled history without losing an unresolved reservation", async () => {
  const { fs } = makeControllableFs();
  const first = new FileStore("/virtual/state.json", fs);
  await first.init();
  await first.createToken({
    id: "token-1",
    tokenHash: "b".repeat(64),
    dailyUsd: 10,
    createdAt: "2026-05-01T00:00:00.000Z",
  });

  // Fully settled history from an earlier month should disappear once the
  // gateway processes a request in a later month.
  await first.addUsage("token-1", "2026-05-31", 3);
  const unresolved = await first.reserveUsage({
    tokenId: "token-1",
    dateKey: "2026-06-30",
    monthKey: "2026-06",
    worstCostUsd: 1,
    tokenDailyUsd: 10,
    globalMonthlyUsd: 20,
  });
  assert.ok(unresolved.allowed);
  if (!unresolved.allowed) return;

  // Move into July. The June reservation is deliberately still unsettled,
  // while May has no reservation and can be pruned.
  const july = await first.reserveUsage({
    tokenId: "token-1",
    dateKey: "2026-07-01",
    monthKey: "2026-07",
    worstCostUsd: 1,
    tokenDailyUsd: 10,
    globalMonthlyUsd: 20,
  });
  assert.ok(july.allowed);
  assert.equal(await first.getUsageForDate("token-1", "2026-05-31"), 0);
  assert.equal(await first.getUsageForDate("token-1", "2026-06-30"), 1);

  // A live request can still settle across the month boundary. The later July
  // request is deliberately left orphaned so restart finalizes it at worst.
  await first.settleUsage(unresolved.reservationId, 0.25);
  await first.close();
  const restarted = new FileStore("/virtual/state.json", fs);
  await restarted.init();
  assert.equal(await restarted.getUsageForDate("token-1", "2026-06-30"), 0.25);
  assert.equal(await restarted.getUsageForDate("token-1", "2026-07-01"), 1);
  await restarted.close();
});

test("FileStore: structurally valid JSON cannot hide usage outside the accounting model", () => {
  const valid = {
    tokens: [
      {
        id: "token-1",
        tokenHash: "d".repeat(64),
        dailyUsd: 5,
        createdAt: "2026-07-14T00:00:00.000Z",
      },
    ],
    usage: { "token-1": { "2026-07-14": 1 } },
    reservations: {
      "reservation-1": { tokenId: "token-1", dateKey: "2026-07-14", reservedUsd: 0.5 },
    },
  };
  assert.doesNotThrow(() => validateStoreFileText(JSON.stringify(valid)));

  const cases: unknown[] = [];
  const invalidDate = structuredClone(valid) as typeof valid & { usage: Record<string, Record<string, number>> };
  (invalidDate.usage as Record<string, Record<string, number>>)["token-1"] = { "2026-13-99": 1 };
  cases.push(invalidDate);
  const unknownToken = structuredClone(valid) as typeof valid & { usage: Record<string, Record<string, number>> };
  unknownToken.usage["missing-token"] = { "2026-07-14": 1 };
  cases.push(unknownToken);
  const duplicateHash = structuredClone(valid);
  duplicateHash.tokens.push({ ...duplicateHash.tokens[0]!, id: "token-2" });
  cases.push(duplicateHash);
  const badTimestamp = structuredClone(valid);
  badTimestamp.tokens[0]!.createdAt = "yesterday";
  cases.push(badTimestamp);
  const missingDebit = structuredClone(valid);
  missingDebit.reservations["reservation-1"]!.reservedUsd = 2;
  cases.push(missingDebit);

  for (const candidate of cases) {
    assert.throws(() => validateStoreFileText(JSON.stringify(candidate)));
  }
});

test("Store: reservation date and month keys must describe the same real UTC date", async () => {
  const store = new MemoryStore();
  await store.init();
  await store.createToken({
    id: "token-1",
    tokenHash: "e".repeat(64),
    dailyUsd: 5,
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  await assert.rejects(
    () =>
      store.reserveUsage({
        tokenId: "token-1",
        dateKey: "2026-07-14",
        monthKey: "2026-08",
        worstCostUsd: 1,
        tokenDailyUsd: 5,
        globalMonthlyUsd: 10,
      }),
    /same real UTC date/,
  );
});

test("Store: an unrepresentable positive USD increment fails closed", async () => {
  const store = new MemoryStore();
  await store.init();
  await store.createToken({
    id: "token-1",
    tokenHash: "f".repeat(64),
    dailyUsd: 1_000_000_000,
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  await store.addUsage("token-1", "2026-07-14", 1_000_000_000);
  await assert.rejects(
    () =>
      store.reserveUsage({
        tokenId: "token-1",
        dateKey: "2026-07-14",
        monthKey: "2026-07",
        worstCostUsd: 1e-9,
        tokenDailyUsd: 1_000_000_000,
        globalMonthlyUsd: 1_000_000_000,
      }),
    /not representable safely/,
  );
});
