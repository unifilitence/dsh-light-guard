/**
 * dsh-perf-guard — Host half (Node).
 *
 * Registers authenticated Fetch routes under `/api/dsh-perf-guard/*` via
 * Cordis `connection.fetch.register`, strictly bound to Cordis disposers.
 *
 * Supports optional, manual hot-reload of this plugin's own business modules
 * (`config-store.js`, `scanner.js`, `archiver.js`) via `POST /api/dsh-perf-guard/reload`
 * without touching Cordis route tables, other plugins, or running any file watchers.
 *
 * ZERO background timers, ZERO polling, ZERO writes to `cordis.patch.yml` or credentials.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as initialConfigStore from "./config-store.js";
import * as initialScanner from "./scanner.js";
import * as initialArchiver from "./archiver.js";

export const name = "dsh-perf-guard";
export const ROUTE_PREFIX = "/api/dsh-perf-guard";

const MAX_BODY_BYTES = 1_000_000;
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(LIB_DIR, "..", "package.json");

async function readDiskVersion() {
  try {
    const raw = await readFile(PKG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function resolveSafeHomeSubdir(home, relPath) {
  if (typeof relPath !== "string" || relPath.trim().length === 0) return null;
  const cleaned = relPath.trim().replace(/\\/g, "/");
  if (cleaned.startsWith("/") || cleaned.includes("..") || cleaned.includes("\0")) return null;
  const root = path.resolve(home);
  const target = path.resolve(root, cleaned);
  if (target.toLowerCase() !== root.toLowerCase() && !target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
    return null;
  }
  return target;
}

function openDirectoryInOS(targetPath) {
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(cmd, [targetPath], { detached: true, stdio: "ignore" });
  child.unref();
}

async function readJsonBody(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, reason: "body-too-large" };
  }
  if (bytes.byteLength === 0) return { ok: true, body: {} };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, body: JSON.parse(text || "{}") };
  } catch {
    return { ok: false, status: 400, reason: "invalid-json" };
  }
}

export function registerRoutes(
  connection,
  getHome = () => initialConfigStore.resolveDshHome(),
  getWorkspaceRegistry = () => undefined
) {
  if (!connection?.fetch || typeof connection.fetch.register !== "function") {
    return () => {};
  }

  // Mutable delegate container for safe, manual hot-reload of our own modules only
  const mods = {
    configStore: initialConfigStore,
    scanner: initialScanner,
    archiver: initialArchiver
  };
  let hostVersion = "unknown";
  let reloadCount = 0;
  let lastReloadAt = null;
  readDiskVersion().then((v) => { hostVersion = v; }).catch(() => {});

  const disposers = [];
  const reg = (subpath, methods, handler) => {
    const d = connection.fetch.register({
      path: `${ROUTE_PREFIX}/${subpath}`,
      methods,
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const home = getHome();
          if (!home) {
            return Response.json({ ok: false, reason: "home-unavailable" }, { status: 503 });
          }
          return await handler(request, home);
        } catch (err) {
          return Response.json(
            { ok: false, reason: "handler-failed", detail: String(err?.message || err) },
            { status: 500 }
          );
        }
      }
    });
    if (typeof d === "function") disposers.push(d);
  };

  // 1. Config & Presets (also reports hostVersion vs diskVersion)
  reg("config", ["GET", "PUT", "POST"], async (request, home) => {
    const diskVersion = await readDiskVersion();
    if (hostVersion === "unknown") hostVersion = diskVersion;
    if (request.method === "GET") {
      const res = await mods.configStore.readConfig(home);
      return Response.json({
        ok: res.ok,
        value: res.value,
        presets: mods.configStore.PRESETS,
        hostUptimeSec: Math.round(process.uptime()),
        hostVersion,
        diskVersion,
        reloadCount,
        lastReloadAt
      });
    }
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const current = (await mods.configStore.readConfig(home)).value;
    let next = parsed.body?.value ?? parsed.body;
    if (parsed.body?.applyPreset && typeof parsed.body.applyPreset === "string") {
      next = mods.configStore.applyPreset(current, parsed.body.applyPreset);
    }
    const saved = await mods.configStore.writeConfig(home, next);
    return Response.json(
      saved.ok ? { ok: true, value: saved.value } : { ok: false, reason: saved.reason },
      { status: saved.ok ? 200 : 503 }
    );
  });

  // 2. On-demand read-only scan
  reg("scan", ["GET"], async (_request, home) => {
    const report = await mods.scanner.runFullScan(home);
    return Response.json({ ok: true, report });
  });

  // 3. Archive list / search
  reg("archive/list", ["GET"], async (request, home) => {
    let q = "";
    try {
      q = new URL(request.url, "http://127.0.0.1").searchParams.get("q") || "";
    } catch {}
    const res = await mods.archiver.listArchive(home, q);
    return Response.json(res);
  });

  // 4. Archive preview (dry-run)
  reg("archive/preview", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const cfg = (await mods.configStore.readConfig(home)).value;
    const res = await mods.archiver.previewArchive(home, {
      minAgeDays: parsed.body?.minAgeDays ?? cfg.archiveMinAgeDays,
      minSizeMB: parsed.body?.minSizeMB ?? cfg.archiveMinSizeMB,
      workspace: parsed.body?.workspace ?? "",
      exemptSessions: cfg.exemptSessions,
      limit: parsed.body?.limit ?? 2000
    });
    return Response.json(res);
  });

  // 5. Archive execute (reversible move + official workspaceRegistry detach)
  reg("archive/run", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const cfg = (await mods.configStore.readConfig(home)).value;
    const res = await mods.archiver.runArchive(home, parsed.body?.items, {
      exemptSessions: cfg.exemptSessions,
      workspaceRegistry: getWorkspaceRegistry()
    });
    return Response.json(res, { status: res.ok ? 200 : 400 });
  });

  // 6. Archive restore (move back to sessions/ + projcache + official workspaceRegistry attach)
  reg("archive/restore", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const res = await mods.archiver.restoreArchive(home, parsed.body?.items, {
      workspaceRegistry: getWorkspaceRegistry()
    });
    return Response.json(res, { status: res.ok ? 200 : 400 });
  });

  // 6b. Reversibly clean ghost projcache + detach ghost IDs from official workspaceRegistry
  reg("archive/sync-cache", ["POST"], async (_request, home) => {
    const res = await mods.archiver.syncArchiveCache(home, {
      workspaceRegistry: getWorkspaceRegistry()
    });
    return Response.json(res);
  });

  // 7. Open a directory strictly inside $DSH_HOME in OS file manager (read-only helper)
  reg("open-folder", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const target = resolveSafeHomeSubdir(home, parsed.body?.relPath);
    if (!target) return Response.json({ ok: false, reason: "invalid-path" }, { status: 400 });
    const st = await stat(target).catch(() => null);
    if (!st || !st.isDirectory()) {
      return Response.json({ ok: false, reason: "not-a-directory" }, { status: 404 });
    }
    if (parsed.body?.dryRun !== true) {
      openDirectoryInOS(target);
    }
    return Response.json({ ok: true, target });
  });

  // 8. Plugin before/after performance snapshot recorder
  reg("snapshot", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const current = (await mods.configStore.readConfig(home)).value;
    if (parsed.body?.clear === true) {
      const saved = await mods.configStore.writeConfig(home, { ...current, snapshots: [] });
      return Response.json(saved.ok ? { ok: true, snapshots: saved.value.snapshots } : { ok: false, reason: saved.reason });
    }
    const report = await mods.scanner.runFullScan(home);
    const label = typeof parsed.body?.label === "string" && parsed.body.label.trim()
      ? parsed.body.label.trim().slice(0, 60)
      : "性能快照";
    const snap = {
      at: new Date().toISOString(),
      label,
      domNodes: Number(parsed.body?.domNodes) || 0,
      longTasks: Number(parsed.body?.longTasks) || 0,
      maxLtMs: Number(parsed.body?.maxLtMs) || 0,
      sessionsCount: report.sessions.totalCount,
      sessionsMB: report.sessions.totalMB,
      storageFiles: report.storages.totalFiles,
      storageMB: report.storages.totalMB,
      hostUptimeMin: Math.round(process.uptime() / 60)
    };
    const nextSnaps = [...(current.snapshots || []), snap].slice(-20);
    const saved = await mods.configStore.writeConfig(home, { ...current, snapshots: nextSnaps });
    return Response.json(
      saved.ok ? { ok: true, snapshot: snap, snapshots: saved.value.snapshots } : { ok: false, reason: saved.reason },
      { status: saved.ok ? 200 : 503 }
    );
  });

  // 9. Experimental manual hot-reload of this plugin's own business modules (atomic swap, fail-safe)
  reg("reload", ["POST"], async () => {
    const bust = `?t=${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const [nextConfigStore, nextScanner, nextArchiver] = await Promise.all([
        import(pathToFileURL(path.join(LIB_DIR, "config-store.js")).href + bust),
        import(pathToFileURL(path.join(LIB_DIR, "scanner.js")).href + bust),
        import(pathToFileURL(path.join(LIB_DIR, "archiver.js")).href + bust)
      ]);
      if (
        typeof nextConfigStore?.readConfig !== "function" ||
        typeof nextScanner?.runFullScan !== "function" ||
        typeof nextArchiver?.previewArchive !== "function"
      ) {
        return Response.json({ ok: false, reason: "invalid-module-exports" }, { status: 500 });
      }
      mods.configStore = nextConfigStore;
      mods.scanner = nextScanner;
      mods.archiver = nextArchiver;
      hostVersion = await readDiskVersion();
      reloadCount += 1;
      lastReloadAt = new Date().toISOString();
      return Response.json({ ok: true, hostVersion, diskVersion: hostVersion, reloadCount, lastReloadAt });
    } catch (err) {
      return Response.json(
        { ok: false, reason: "reload-failed", detail: String(err?.message || err) },
        { status: 500 }
      );
    }
  });

  return () => {
    for (const d of disposers.splice(0)) {
      try { d(); } catch {}
    }
  };
}

export function apply(ctx) {
  if (!ctx || typeof ctx.inject !== "function") return;
  let disposeRoutes = null;
  const resolveWorkspaceRegistry = () => {
    try {
      if (typeof ctx.get === "function") {
        const reg = ctx.get("workspaceRegistry", false);
        if (reg) return reg;
      }
      return ctx.workspaceRegistry;
    } catch {
      return undefined;
    }
  };
  ctx.inject(["connection"], (scope) => {
    try {
      disposeRoutes = registerRoutes(
        scope.connection,
        () => initialConfigStore.resolveDshHome(),
        resolveWorkspaceRegistry
      );
    } catch {}
    return () => {
      if (typeof disposeRoutes === "function") {
        try { disposeRoutes(); } catch {}
        disposeRoutes = null;
      }
    };
  });
}
