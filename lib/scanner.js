/**
 * On-demand read-only scanner for DSH_HOME sessions, storages, and heavy assets.
 *
 * Strictly READ-ONLY: never creates, modifies, renames, or deletes any file.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 86_400_000;
const MB = 1_048_576;

/**
 * Best-effort read of a session's human-readable title from DSH's projection caches
 * (`storages/session_projcache/sessions/` then `storages/session_projcache_archive_manager/sessions/`).
 * Strictly read-only.
 */
export async function readSessionTitle(home, sessionId) {
  if (!home || !sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return "";
  const candidates = [
    path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`),
    path.join(home, "storages", "session_projcache_archive_manager", "sessions", `${sessionId}.json`)
  ];
  for (const cacheFile of candidates) {
    try {
      const raw = await readFile(cacheFile, "utf8");
      const doc = JSON.parse(raw);
      const rows = doc?.record?.rows;
      const t = rows?.title?.val || rows?.titleInput?.val?.first?.text || "";
      if (typeof t === "string" && t.trim().length > 0) {
        return t.trim().replace(/\s+/g, " ").slice(0, 80);
      }
    } catch {}
  }
  return "";
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function measureTree(rootDir, maxEntries = 200_000) {
  let files = 0;
  let bytes = 0;
  let latestMtimeMs = 0;
  let truncated = false;
  const stack = [rootDir];

  while (stack.length > 0) {
    const cur = stack.pop();
    const entries = await safeReaddir(cur);
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        files++;
        if (files > maxEntries) {
          truncated = true;
          return { files, bytes, latestMtimeMs, truncated };
        }
        const st = await safeStat(full);
        if (st) {
          bytes += st.size;
          if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs;
        }
      }
    }
  }
  return { files, bytes, latestMtimeMs, truncated };
}

/**
 * Scan `$DSH_HOME/sessions/<workspace>/<sessionId>` (read-only).
 */
export async function scanSessions(home, nowMs = Date.now()) {
  const sessionsRoot = path.join(home, "sessions");
  const workspaces = await safeReaddir(sessionsRoot);
  const items = [];

  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(sessionsRoot, ws.name);
    const sessions = await safeReaddir(wsPath);
    for (const sess of sessions) {
      if (!sess.isDirectory()) continue;
      const sessPath = path.join(wsPath, sess.name);
      const children = await safeReaddir(sessPath);
      let bytes = 0;
      let mtimeMs = 0;
      let fileCount = 0;
      for (const ch of children) {
        if (!ch.isFile()) continue;
        const st = await safeStat(path.join(sessPath, ch.name));
        if (st) {
          fileCount++;
          bytes += st.size;
          if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
        }
      }
      if (fileCount === 0) {
        const stDir = await safeStat(sessPath);
        mtimeMs = stDir ? stDir.mtimeMs : 0;
      }
      const ageDays = mtimeMs > 0 ? Math.max(0, (nowMs - mtimeMs) / DAY_MS) : 0;
      items.push({
        workspace: ws.name,
        sessionId: sess.name,
        bytes,
        mb: +(bytes / MB).toFixed(2),
        fileCount,
        mtimeMs: Math.round(mtimeMs),
        ageDays: +ageDays.toFixed(1)
      });
    }
  }

  let totalBytes = 0;
  const buckets = {
    olderThan30d: { count: 0, bytes: 0 },
    olderThan14d: { count: 0, bytes: 0 },
    olderThan7d: { count: 0, bytes: 0 },
    recent7d: { count: 0, bytes: 0 },
    sizeGe10MB: { count: 0, bytes: 0 },
    sizeGe5MB: { count: 0, bytes: 0 },
    sizeGe1MB: { count: 0, bytes: 0 }
  };

  for (const it of items) {
    totalBytes += it.bytes;
    if (it.ageDays > 30) { buckets.olderThan30d.count++; buckets.olderThan30d.bytes += it.bytes; }
    if (it.ageDays > 14) { buckets.olderThan14d.count++; buckets.olderThan14d.bytes += it.bytes; }
    if (it.ageDays > 7)  { buckets.olderThan7d.count++;  buckets.olderThan7d.bytes += it.bytes; }
    else                 { buckets.recent7d.count++;     buckets.recent7d.bytes += it.bytes; }
    if (it.bytes >= 10 * MB) { buckets.sizeGe10MB.count++; buckets.sizeGe10MB.bytes += it.bytes; }
    if (it.bytes >= 5 * MB)  { buckets.sizeGe5MB.count++;  buckets.sizeGe5MB.bytes += it.bytes; }
    if (it.bytes >= 1 * MB)  { buckets.sizeGe1MB.count++;  buckets.sizeGe1MB.bytes += it.bytes; }
  }

  const formatBucket = (b) => ({ count: b.count, mb: +(b.bytes / MB).toFixed(1) });
  const topLargest = await Promise.all(
    [...items]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15)
      .map(async (it) => ({ ...it, title: await readSessionTitle(home, it.sessionId) }))
  );

  return {
    totalCount: items.length,
    totalMB: +(totalBytes / MB).toFixed(1),
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, formatBucket(v)])),
    topLargest,
    items
  };
}

/**
 * Scan `$DSH_HOME/storages/*` (read-only) to surface plugin storage bloat.
 */
export async function scanStorages(home) {
  const root = path.join(home, "storages");
  const entries = await safeReaddir(root);
  const dirs = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const stats = await measureTree(path.join(root, ent.name));
    const mb = +(stats.bytes / MB).toFixed(2);
    let severity = "ok";
    if (stats.files >= 20_000 || mb >= 100) severity = "critical";
    else if (stats.files >= 5_000 || mb >= 30) severity = "warn";
    dirs.push({
      name: ent.name,
      relPath: `storages/${ent.name}`,
      files: stats.files,
      mb,
      latestMtimeMs: Math.round(stats.latestMtimeMs),
      truncated: stats.truncated,
      severity
    });
  }

  dirs.sort((a, b) => b.files - a.files || b.mb - a.mb);
  return {
    totalDirs: dirs.length,
    totalFiles: dirs.reduce((s, d) => s + d.files, 0),
    totalMB: +(dirs.reduce((s, d) => s + d.mb, 0)).toFixed(1),
    dirs: dirs.slice(0, 20)
  };
}

/**
 * Scan heavy top-level folders (attachments, backups, legacy .runtime.bak-*) read-only.
 */
export async function scanHeavyAssets(home) {
  const entries = await safeReaddir(home);
  const targets = entries.filter(
    (e) => e.isDirectory() && /^(attachments|backups|cache|\.runtime\.bak-|\.runtime\.failed-|\.runtime\.canary-)/i.test(e.name)
  );
  const list = [];
  for (const ent of targets) {
    const full = path.join(home, ent.name);
    const stats = await measureTree(full, 50_000);
    const mb = +(stats.bytes / MB).toFixed(1);
    if (mb >= 10 || stats.files >= 1000) {
      list.push({ name: ent.name, relPath: ent.name, fullPath: full, files: stats.files, mb, truncated: stats.truncated });
    }
  }
  list.sort((a, b) => b.mb - a.mb);
  return list;
}

/**
 * Run a full on-demand read-only health check.
 */
export async function runFullScan(home, nowMs = Date.now()) {
  const t0 = Date.now();
  const [sessionsRaw, storages, heavyAssets] = await Promise.all([
    scanSessions(home, nowMs),
    scanStorages(home),
    scanHeavyAssets(home)
  ]);

  const warnings = [];
  if (sessionsRaw.totalCount >= 500) {
    warnings.push({
      level: sessionsRaw.totalCount >= 1500 ? "critical" : "warn",
      code: "TOO_MANY_SESSIONS",
      message: `sessions/ 中已有 ${sessionsRaw.totalCount} 个会话（其中 30 天前 ${sessionsRaw.buckets.olderThan30d.count} 个），建议冷归档历史会话以减轻侧边栏渲染压力。`
    });
  }
  for (const d of storages.dirs) {
    if (d.severity !== "ok") {
      warnings.push({
        level: d.severity,
        code: "STORAGE_BLOAT",
        target: d.name,
        message: `storages/${d.name} 堆积了 ${d.files.toLocaleString()} 个文件（${d.mb} MB），可能拖慢磁盘与插件同步。`
      });
    }
  }

  return {
    scannedAt: new Date(nowMs).toISOString(),
    durationMs: Date.now() - t0,
    home,
    sessions: {
      totalCount: sessionsRaw.totalCount,
      totalMB: sessionsRaw.totalMB,
      buckets: sessionsRaw.buckets,
      topLargest: sessionsRaw.topLargest
    },
    storages,
    heavyAssets,
    warnings
  };
}
