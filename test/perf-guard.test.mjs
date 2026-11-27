import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PRESETS, applyPreset, readConfig, sanitizeConfig, writeConfig } from "../lib/config-store.js";
import { runFullScan, scanSessions, scanStorages } from "../lib/scanner.js";
import { isSafeSegment, listArchive, previewArchive, restoreArchive, runArchive, syncArchiveCache } from "../lib/archiver.js";
import { registerRoutes } from "../lib/index.js";

async function makeTempHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-light-guard-test-"));
  await mkdir(path.join(dir, "sessions", "--WS--", "session-old-1"), { recursive: true });
  await mkdir(path.join(dir, "sessions", "--WS--", "session-active-1"), { recursive: true });
  await mkdir(path.join(dir, "storages", "heavy-plugin"), { recursive: true });

  const oldFile = path.join(dir, "sessions", "--WS--", "session-old-1", "session.v4.jsonl.zstd");
  await writeFile(oldFile, "x".repeat(4096));
  const past = new Date(Date.now() - 45 * 86_400_000);
  await utimes(oldFile, past, past);
  await utimes(path.join(dir, "sessions", "--WS--", "session-old-1"), past, past);

  const activeFile = path.join(dir, "sessions", "--WS--", "session-active-1", "session.v4.jsonl.zstd");
  await writeFile(activeFile, "y".repeat(2048));

  await writeFile(path.join(dir, "storages", "heavy-plugin", "a.json"), "{}");
  await mkdir(path.join(dir, "storages", "session_projcache", "sessions"), { recursive: true });
  await writeFile(
    path.join(dir, "storages", "session_projcache", "sessions", "session-old-1.json"),
    JSON.stringify({ version: 7, record: { rows: { title: { val: "旧项目排查对话" } } } })
  );
  return dir;
}

test("config-store: sanitizeConfig clamps invariants and persists atomically", async () => {
  const home = await makeTempHome();
  try {
    const clean = sanitizeConfig({ preset: "heavy", maxMessages: 30, minMessages: 100, expGpuLiteEnabled: true, expStreamCoalesceMs: 9999 });
    assert.equal(clean.maxMessages, 30);
    assert.equal(clean.minMessages, 30, "minMessages must never exceed maxMessages");
    assert.equal(clean.expGpuLiteEnabled, true);
    assert.equal(clean.expUltraLeanEnabled, false);
    assert.equal(clean.expStreamCoalesceMs, 500, "expStreamCoalesceMs must clamp to <= 500");

    const light = applyPreset(clean, "light");
    assert.equal(light.preset, "light");
    assert.equal(light.streamGuardEnabled, false);
    assert.equal(light.expGpuLiteEnabled, true, "switching presets must preserve user experimental flags");

    const saved = await writeConfig(home, light);
    assert.equal(saved.ok, true);
    // Partial write must preserve existing flags
    await writeConfig(home, { maxMessages: 80 });
    const loaded = await readConfig(home);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.exists, true);
    assert.equal(loaded.value.preset, "light");
    assert.equal(loaded.value.maxMessages, 80);
    assert.equal(loaded.value.expGpuLiteEnabled, true, "partial config write must not wipe existing user settings");
    assert.equal(PRESETS.heavy.streamGuardEnabled, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("scanner: read-only scan classifies sessions and storages accurately", async () => {
  const home = await makeTempHome();
  try {
    const sess = await scanSessions(home);
    assert.equal(sess.totalCount, 2);
    assert.equal(sess.buckets.olderThan30d.count, 1);
    assert.equal(sess.buckets.recent7d.count, 1);

    const stor = await scanStorages(home);
    assert.equal(stor.totalDirs, 2);
    assert.ok(stor.dirs.some((d) => d.name === "heavy-plugin"));

    const full = await runFullScan(home);
    assert.equal(full.sessions.totalCount, 2);
    assert.ok(full.durationMs >= 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("archiver: path guard, active-session guard, reversible archive and restore", async () => {
  const home = await makeTempHome();
  try {
    // Negative path: traversal rejected
    assert.equal(isSafeSegment("../evil"), false);
    assert.equal(isSafeSegment("a/b"), false);
    assert.equal(isSafeSegment("session-old-1"), true);

    const badMove = await runArchive(home, [{ workspace: "..", sessionId: "session-old-1" }]);
    assert.equal(badMove.movedCount, 0);
    assert.equal(badMove.failed[0].reason, "invalid-segment");

    // Negative path: active session refused even if explicitly requested
    const activeMove = await runArchive(home, [{ workspace: "--WS--", sessionId: "session-active-1" }]);
    assert.equal(activeMove.movedCount, 0);
    assert.equal(activeMove.failed[0].reason, "active-session-guard");

    // Preview matches only old session
    const preview = await previewArchive(home, { minAgeDays: 30 });
    assert.equal(preview.ok, true);
    assert.equal(preview.selectedCount, 1);
    assert.equal(preview.items[0].sessionId, "session-old-1");
    assert.equal(preview.skipped.active, 1);

    // Execute archive with fake official workspaceRegistry (detach on archive, re-attach on restore)
    const wsSessions = ["session-old-1", "session-active-1"];
    const officialArchived = [];
    const fakeWs = {
      id: "ws-main",
      get sessionIds() { return wsSessions; },
      async detachSession(id) { const i = wsSessions.indexOf(id); if (i >= 0) wsSessions.splice(i, 1); },
      async attachSession(id) { if (!wsSessions.includes(id)) wsSessions.push(id); }
    };
    const fakeWsReg = {
      list: () => [fakeWs],
      get: (id) => (id === "ws-main" ? fakeWs : undefined),
      get archivedSessionIds() { return officialArchived; },
      async archiveSession(id) { if (!officialArchived.includes(id)) officialArchived.push(id); },
      async unarchiveSession(id) { const i = officialArchived.indexOf(id); if (i >= 0) officialArchived.splice(i, 1); }
    };

    const archived = await runArchive(home, preview.items, { workspaceRegistry: fakeWsReg });
    assert.equal(archived.ok, true);
    assert.equal(archived.movedCount, 1);
    assert.equal(wsSessions.includes("session-old-1"), false, "session must be detached from sidebar workspace on archive");
    await assert.rejects(() => stat(path.join(home, "sessions", "--WS--", "session-old-1")));
    await assert.rejects(() => stat(path.join(home, "storages", "session_projcache", "sessions", "session-old-1.json")));
    const stArch = await stat(path.join(home, "sessions-archive", "--WS--", "session-old-1"));
    assert.equal(stArch.isDirectory(), true);
    const stProjArch = await stat(path.join(home, "sessions-archive", "_projcache", "session-old-1.json"));
    assert.equal(stProjArch.isFile(), true);

    // Search archive offline by human-readable title
    const listed = await listArchive(home, "旧项目排查");
    assert.equal(listed.matchedCount, 1);
    assert.equal(listed.entries[0].sessionId, "session-old-1");
    assert.equal(listed.entries[0].title, "旧项目排查对话");

    // Restore back to sessions/ + projcache + original workspace
    const restored = await restoreArchive(home, [{ workspace: "--WS--", sessionId: "session-old-1" }], { workspaceRegistry: fakeWsReg });
    assert.equal(restored.ok, true);
    assert.equal(restored.restoredCount, 1);
    assert.equal(wsSessions.includes("session-old-1"), true, "session must be re-attached to original workspace on restore");
    const stBack = await stat(path.join(home, "sessions", "--WS--", "session-old-1"));
    assert.equal(stBack.isDirectory(), true);
    const stProjBack = await stat(path.join(home, "storages", "session_projcache", "sessions", "session-old-1.json"));
    assert.equal(stProjBack.isFile(), true);
    const listedAfter = await listArchive(home, "");
    assert.equal(listedAfter.totalCount, 0);

    // syncArchiveCache should cleanly handle already-synced index
    const syncRes = await syncArchiveCache(home);
    assert.equal(syncRes.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("host routes: registerRoutes binds and disposes all 10 endpoints cleanly", async () => {
  const home = await makeTempHome();
  try {
    const routes = new Map();
    const fakeConn = {
      fetch: {
        register(def) {
          routes.set(def.path, def);
          return () => routes.delete(def.path);
        }
      }
    };
    const dispose = registerRoutes(fakeConn, () => home);
    assert.equal(routes.size, 10);

    const cfgRoute = routes.get("/api/dsh-light-guard/config");
    const r1 = await cfgRoute.fetch(new Request("http://127.0.0.1/api/dsh-light-guard/config", { method: "GET" }));
    const j1 = await r1.json();
    assert.equal(j1.ok, true);
    assert.equal(j1.value.preset, "heavy");

    const scanRoute = routes.get("/api/dsh-light-guard/scan");
    const r2 = await scanRoute.fetch(new Request("http://127.0.0.1/api/dsh-light-guard/scan", { method: "GET" }));
    const j2 = await r2.json();
    assert.equal(j2.ok, true);
    assert.equal(j2.report.sessions.totalCount, 2);
    assert.equal(typeof j2.report.hostMemory.rssMB, "number");
    assert.ok(j2.report.hostMemory.rssMB > 0);
    assert.equal(typeof j2.report.hostMemory.heapUsedMB, "number");
    assert.equal(typeof j2.report.hostMemory.uptimeHours, "number");

    // Negative path: open-folder rejects path traversal outside $DSH_HOME
    const openRoute = routes.get("/api/dsh-light-guard/open-folder");
    const badOpen = await openRoute.fetch(new Request("http://127.0.0.1/api/dsh-light-guard/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPath: "../../Windows", dryRun: true })
    }));
    assert.equal(badOpen.status, 400);
    const okOpen = await openRoute.fetch(new Request("http://127.0.0.1/api/dsh-light-guard/open-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPath: "storages/heavy-plugin", dryRun: true })
    }));
    assert.equal(okOpen.status, 200);

    // Snapshot recorder
    const snapRoute = routes.get("/api/dsh-light-guard/snapshot");
    const rSnap = await snapRoute.fetch(new Request("http://127.0.0.1/api/dsh-light-guard/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "基线快照", domNodes: 1200, longTasks: 2, maxLtMs: 120 })
    }));
    const jSnap = await rSnap.json();
    assert.equal(jSnap.ok, true);
    assert.equal(jSnap.snapshots.length, 1);
    assert.equal(jSnap.snapshots[0].label, "基线快照");

    // Experimental hot-reload endpoint
    const reloadRoute = routes.get("/api/dsh-light-guard/reload");
    const rReload = await reloadRoute.fetch(new Request("http://127.0.0.1/api/dsh-light-guard/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }));
    const jReload = await rReload.json();
    assert.equal(jReload.ok, true);
    assert.equal(jReload.reloadCount, 1);
    assert.ok(typeof jReload.hostVersion === "string" && jReload.hostVersion.length > 0);

    dispose();
    assert.equal(routes.size, 0, "all registered routes must be cleaned up on dispose");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("client bundle: parses as classic script and guards duplicate registration", async () => {
  const clientSrc = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  // 1. Must parse cleanly as a classic browser script (catches stray TS annotations / syntax bugs)
  const fn = new Function("window", clientSrc);

  // 2. Calling twice against a loader that throws on duplicate registration must NOT throw
  const seen = new Set();
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        if (seen.has(entry.id)) {
          throw new Error(`client-modules: duplicate factory registration for "${entry.id}" (bundle executed twice without invalidate?)`);
        }
        seen.add(entry.id);
      }
    }
  };
  fn(fakeWindow);
  assert.equal(seen.has("dsh-light-guard"), true);
  assert.doesNotThrow(() => fn(fakeWindow));
});
