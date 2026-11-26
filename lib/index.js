/**
 * dsh-perf-guard — Host half (Node).
 *
 * Registers authenticated Fetch routes under `/api/dsh-perf-guard/*` via
 * Cordis `connection.fetch.register`, strictly bound to Cordis disposers.
 *
 * ZERO background timers, ZERO polling, ZERO writes to `cordis.patch.yml` or credentials.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  PRESETS,
  applyPreset,
  readConfig,
  resolveDshHome,
  writeConfig
} from "./config-store.js";
import { runFullScan } from "./scanner.js";
import {
  listArchive,
  previewArchive,
  restoreArchive,
  runArchive
} from "./archiver.js";

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

export const name = "dsh-perf-guard";
export const ROUTE_PREFIX = "/api/dsh-perf-guard";

const MAX_BODY_BYTES = 1_000_000;

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

export function registerRoutes(connection, getHome = () => resolveDshHome()) {
  if (!connection?.fetch || typeof connection.fetch.register !== "function") {
    return () => {};
  }

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

  // 1. Config & Presets
  reg("config", ["GET", "PUT", "POST"], async (request, home) => {
    if (request.method === "GET") {
      const res = await readConfig(home);
      return Response.json({ ok: res.ok, value: res.value, presets: PRESETS, hostUptimeSec: Math.round(process.uptime()) });
    }
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const current = (await readConfig(home)).value;
    let next = parsed.body?.value ?? parsed.body;
    if (parsed.body?.applyPreset && typeof parsed.body.applyPreset === "string") {
      next = applyPreset(current, parsed.body.applyPreset);
    }
    const saved = await writeConfig(home, next);
    return Response.json(
      saved.ok ? { ok: true, value: saved.value } : { ok: false, reason: saved.reason },
      { status: saved.ok ? 200 : 503 }
    );
  });

  // 2. On-demand read-only scan
  reg("scan", ["GET"], async (_request, home) => {
    const report = await runFullScan(home);
    return Response.json({ ok: true, report });
  });

  // 3. Archive list / search
  reg("archive/list", ["GET"], async (request, home) => {
    let q = "";
    try {
      q = new URL(request.url, "http://127.0.0.1").searchParams.get("q") || "";
    } catch {}
    const res = await listArchive(home, q);
    return Response.json(res);
  });

  // 4. Archive preview (dry-run)
  reg("archive/preview", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const cfg = (await readConfig(home)).value;
    const res = await previewArchive(home, {
      minAgeDays: parsed.body?.minAgeDays ?? cfg.archiveMinAgeDays,
      minSizeMB: parsed.body?.minSizeMB ?? cfg.archiveMinSizeMB,
      workspace: parsed.body?.workspace ?? "",
      exemptSessions: cfg.exemptSessions,
      limit: parsed.body?.limit ?? 2000
    });
    return Response.json(res);
  });

  // 5. Archive execute (reversible move)
  reg("archive/run", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const cfg = (await readConfig(home)).value;
    const res = await runArchive(home, parsed.body?.items, {
      exemptSessions: cfg.exemptSessions
    });
    return Response.json(res, { status: res.ok ? 200 : 400 });
  });

  // 6. Archive restore (move back to sessions/)
  reg("archive/restore", ["POST"], async (request, home) => {
    const parsed = await readJsonBody(request);
    if (!parsed.ok) return Response.json({ ok: false, reason: parsed.reason }, { status: parsed.status });
    const res = await restoreArchive(home, parsed.body?.items);
    return Response.json(res, { status: res.ok ? 200 : 400 });
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
    const current = (await readConfig(home)).value;
    if (parsed.body?.clear === true) {
      const saved = await writeConfig(home, { ...current, snapshots: [] });
      return Response.json(saved.ok ? { ok: true, snapshots: saved.value.snapshots } : { ok: false, reason: saved.reason });
    }
    const report = await runFullScan(home);
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
    const saved = await writeConfig(home, { ...current, snapshots: nextSnaps });
    return Response.json(
      saved.ok ? { ok: true, snapshot: snap, snapshots: saved.value.snapshots } : { ok: false, reason: saved.reason },
      { status: saved.ok ? 200 : 503 }
    );
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
  ctx.inject(["connection"], (scope) => {
    try {
      disposeRoutes = registerRoutes(scope.connection);
    } catch {}
    return () => {
      if (typeof disposeRoutes === "function") {
        try { disposeRoutes(); } catch {}
        disposeRoutes = null;
      }
    };
  });
}
