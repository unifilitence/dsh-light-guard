/**
 * Reversible cold/hot session archiver for dsh-perf-guard.
 *
 * SAFETY CONTRACT:
 *  1. NEVER deletes session data — only moves directories between:
 *     `$DSH_HOME/sessions/<workspace>/<sessionId>`
 *     and
 *     `$DSH_HOME/sessions-archive/<workspace>/<sessionId>`
 *  2. Path traversal guard: workspace and sessionId must be single safe segments,
 *     and resolved paths must stay strictly inside sessions/ or sessions-archive/.
 *  3. Active-session guard: refuses to archive any session modified within
 *     `activeGuardMinutes` (default 10 min) or listed in `exemptSessions`.
 *  4. Refuses to overwrite if the destination directory already exists.
 */

import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readSessionTitle, scanSessions } from "./scanner.js";
import { STORAGE_SUBDIR } from "./config-store.js";

export const ARCHIVE_DIRNAME = "sessions-archive";
export const ARCHIVE_INDEX_FILENAME = "archive-index.json";
export const DEFAULT_ACTIVE_GUARD_MINUTES = 10;

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isSafeSegment(seg) {
  return (
    typeof seg === "string" &&
    seg.length > 0 &&
    seg.length <= 200 &&
    seg !== "." &&
    seg !== ".." &&
    SAFE_SEGMENT.test(seg)
  );
}

function isInsideRoot(rootDir, targetPath) {
  const normRoot = path.resolve(rootDir).toLowerCase() + path.sep;
  const normTarget = path.resolve(targetPath).toLowerCase();
  return normTarget.startsWith(normRoot);
}

export function archiveIndexPath(home) {
  return path.join(home, STORAGE_SUBDIR, ARCHIVE_INDEX_FILENAME);
}

export async function readArchiveIndex(home) {
  try {
    const text = await readFile(archiveIndexPath(home), "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {}
  return { version: 1, entries: [] };
}

async function writeArchiveIndex(home, indexDoc) {
  const file = archiveIndexPath(home);
  const dir = path.dirname(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(tmp, file, `${JSON.stringify(indexDoc, null, 2)}\n`);
}

import { writeFile } from "node:fs/promises";
async function writeFileAtomic(tmp, target, content) {
  await writeFile(tmp, content, "utf8");
  await rename(tmp, target);
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveDirectorySafe(src, dst) {
  await mkdir(path.dirname(dst), { recursive: true });
  try {
    await rename(src, dst);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await cp(src, dst, { recursive: true, errorOnExist: true, force: false });
      await rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

async function moveFileSafe(src, dst) {
  await mkdir(path.dirname(dst), { recursive: true });
  try {
    await rename(src, dst);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      await cp(src, dst, { errorOnExist: true, force: false });
      await rm(src, { force: true });
    } else {
      throw err;
    }
  }
}

function projCacheLivePath(home, sessionId) {
  return path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
}

function projCacheArchivePath(home, sessionId) {
  return path.join(home, ARCHIVE_DIRNAME, "_projcache", `${sessionId}.json`);
}

async function archiveProjCacheIfPresent(home, sessionId) {
  const src = projCacheLivePath(home, sessionId);
  const dst = projCacheArchivePath(home, sessionId);
  if (!(await pathExists(src))) return false;
  if (await pathExists(dst)) return false;
  try {
    await moveFileSafe(src, dst);
    return true;
  } catch {
    return false;
  }
}

async function restoreProjCacheIfPresent(home, sessionId) {
  const src = projCacheArchivePath(home, sessionId);
  const dst = projCacheLivePath(home, sessionId);
  if (!(await pathExists(src))) return false;
  if (await pathExists(dst)) return false;
  try {
    await moveFileSafe(src, dst);
    return true;
  } catch {
    return false;
  }
}

/**
 * Use DSH's official `workspaceRegistry` service (when running inside Host)
 * to cleanly detach a session from sidebar workspace lists & official archive list
 * so no ghost entries remain in `workspace.json` or live memory.
 */
async function detachFromWorkspaceRegistry(workspaceRegistry, sessionId) {
  const result = { originWorkspaceId: null, wasOfficialArchived: false, detachedFromSidebar: false, removedFromOfficialArchive: false };
  if (!workspaceRegistry) return result;
  try {
    const workspaces = typeof workspaceRegistry.list === "function" ? workspaceRegistry.list() : [];
    for (const ws of workspaces) {
      if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) {
        if (!result.originWorkspaceId) result.originWorkspaceId = String(ws.id);
        if (typeof ws.detachSession === "function") {
          await ws.detachSession(sessionId);
          result.detachedFromSidebar = true;
        }
      }
    }
    const archived = Array.isArray(workspaceRegistry.archivedSessionIds) ? workspaceRegistry.archivedSessionIds : [];
    if (archived.includes(sessionId)) {
      result.wasOfficialArchived = true;
      if (typeof workspaceRegistry.unarchiveSession === "function") {
        await workspaceRegistry.unarchiveSession(sessionId);
        result.removedFromOfficialArchive = true;
      }
    }
  } catch {}
  return result;
}

/**
 * Re-attach a restored session back into its original DSH workspace via official API.
 */
async function attachToWorkspaceRegistry(workspaceRegistry, entry) {
  if (!workspaceRegistry || !entry?.sessionId) return { attached: false, rearchived: false };
  let attached = false;
  let rearchived = false;
  try {
    if (entry.originWorkspaceId && typeof workspaceRegistry.get === "function") {
      const ws = workspaceRegistry.get(entry.originWorkspaceId);
      if (ws && typeof ws.attachSession === "function") {
        await ws.attachSession(entry.sessionId);
        attached = true;
      }
    }
    if (entry.wasOfficialArchived === true && typeof workspaceRegistry.archiveSession === "function") {
      await workspaceRegistry.archiveSession(entry.sessionId);
      rearchived = true;
    }
  } catch {}
  return { attached, rearchived };
}

/**
 * Dry-run preview of sessions matching archive rules.
 */
export async function previewArchive(home, options = {}, nowMs = Date.now()) {
  const minAgeDays = Math.max(0, Number(options.minAgeDays ?? 30) || 0);
  const minSizeMB = Math.max(0, Number(options.minSizeMB ?? 0) || 0);
  const workspaceFilter = typeof options.workspace === "string" ? options.workspace.trim() : "";
  const activeGuardMinutes = Math.max(1, Number(options.activeGuardMinutes ?? DEFAULT_ACTIVE_GUARD_MINUTES) || DEFAULT_ACTIVE_GUARD_MINUTES);
  const exemptSet = new Set(Array.isArray(options.exemptSessions) ? options.exemptSessions : []);
  const maxItems = Math.max(1, Math.min(5000, Number(options.limit ?? 2000) || 2000));

  const scan = await scanSessions(home, nowMs);
  const activeCutoffMs = nowMs - activeGuardMinutes * 60_000;

  const candidates = [];
  const skipped = { active: 0, exempt: 0 };

  for (const it of scan.items) {
    if (workspaceFilter && it.workspace !== workspaceFilter) continue;
    if (exemptSet.has(it.sessionId)) {
      skipped.exempt++;
      continue;
    }
    if (it.mtimeMs > activeCutoffMs) {
      skipped.active++;
      continue;
    }
    if (it.ageDays < minAgeDays) continue;
    if (it.mb < minSizeMB) continue;
    candidates.push(it);
  }

  candidates.sort((a, b) => b.ageDays - a.ageDays || b.bytes - a.bytes);
  const selected = candidates.slice(0, maxItems);
  const totalBytes = selected.reduce((s, x) => s + x.bytes, 0);

  // Enrich top 50 preview items with human-readable titles for UI review before archiving
  const previewSample = await Promise.all(
    selected.slice(0, 50).map(async (it) => ({
      ...it,
      title: await readSessionTitle(home, it.sessionId)
    }))
  );

  return {
    ok: true,
    matchedCount: candidates.length,
    selectedCount: selected.length,
    totalMB: +(totalBytes / 1_048_576).toFixed(1),
    skipped,
    items: selected,
    previewSample
  };
}

/**
 * Execute reversible move from `sessions/` -> `sessions-archive/`.
 */
export async function runArchive(home, items, options = {}, nowMs = Date.now()) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: "no-items", moved: 0, failed: [] };
  }
  const activeGuardMinutes = Math.max(1, Number(options.activeGuardMinutes ?? DEFAULT_ACTIVE_GUARD_MINUTES) || DEFAULT_ACTIVE_GUARD_MINUTES);
  const activeCutoffMs = nowMs - activeGuardMinutes * 60_000;
  const exemptSet = new Set(Array.isArray(options.exemptSessions) ? options.exemptSessions : []);

  const sessionsRoot = path.join(home, "sessions");
  const archiveRoot = path.join(home, ARCHIVE_DIRNAME);
  const index = await readArchiveIndex(home);
  const existingKeys = new Set(index.entries.map((e) => `${e.workspace}/${e.sessionId}`));

  const moved = [];
  const failed = [];

  for (const raw of items) {
    const workspace = raw?.workspace;
    const sessionId = raw?.sessionId;
    if (!isSafeSegment(workspace) || !isSafeSegment(sessionId)) {
      failed.push({ workspace, sessionId, reason: "invalid-segment" });
      continue;
    }
    if (exemptSet.has(sessionId)) {
      failed.push({ workspace, sessionId, reason: "exempt" });
      continue;
    }
    const src = path.join(sessionsRoot, workspace, sessionId);
    const dst = path.join(archiveRoot, workspace, sessionId);
    if (!isInsideRoot(sessionsRoot, src) || !isInsideRoot(archiveRoot, dst)) {
      failed.push({ workspace, sessionId, reason: "path-escape" });
      continue;
    }
    if (!(await pathExists(src))) {
      failed.push({ workspace, sessionId, reason: "not-found" });
      continue;
    }
    if (await pathExists(dst)) {
      failed.push({ workspace, sessionId, reason: "already-archived" });
      continue;
    }

    // Re-check mtime right before moving to guard against live writes
    const st = await stat(src).catch(() => null);
    if (st && st.mtimeMs > activeCutoffMs) {
      failed.push({ workspace, sessionId, reason: "active-session-guard" });
      continue;
    }

    try {
      const title = (typeof raw.title === "string" && raw.title.trim())
        ? raw.title.trim().slice(0, 80)
        : await readSessionTitle(home, sessionId);
      const wsMeta = await detachFromWorkspaceRegistry(options.workspaceRegistry, sessionId);
      await moveDirectorySafe(src, dst);
      const projCacheMoved = await archiveProjCacheIfPresent(home, sessionId);
      const key = `${workspace}/${sessionId}`;
      const entry = {
        workspace,
        sessionId,
        title,
        projCacheArchived: projCacheMoved,
        originWorkspaceId: wsMeta.originWorkspaceId,
        wasOfficialArchived: wsMeta.wasOfficialArchived,
        bytes: Number(raw.bytes) || 0,
        mb: Number(raw.mb) || 0,
        originalMtimeMs: Number(raw.mtimeMs) || Math.round(st?.mtimeMs || 0),
        archivedAt: new Date(nowMs).toISOString()
      };
      if (!existingKeys.has(key)) {
        index.entries.push(entry);
        existingKeys.add(key);
      }
      moved.push(entry);
    } catch (err) {
      failed.push({ workspace, sessionId, reason: err?.code || "move-failed" });
    }
  }

  if (moved.length > 0) {
    await writeArchiveIndex(home, index);
  }

  return {
    ok: true,
    movedCount: moved.length,
    failedCount: failed.length,
    moved,
    failed
  };
}

/**
 * List & search archived sessions offline (without touching DSH sidebar).
 * Enriches returned entries with readable titles from `session_projcache` when missing.
 */
export async function listArchive(home, query = "") {
  const index = await readArchiveIndex(home);
  const needle = String(query || "").trim().toLowerCase();

  // If searching, enrich titles on the fly for entries missing title (capped to keep fast)
  let pool = index.entries;
  if (needle) {
    const matched = [];
    for (const e of pool) {
      let title = e.title || "";
      if (!title) title = await readSessionTitle(home, e.sessionId);
      const hit =
        e.sessionId.toLowerCase().includes(needle) ||
        e.workspace.toLowerCase().includes(needle) ||
        title.toLowerCase().includes(needle) ||
        (e.archivedAt || "").toLowerCase().includes(needle);
      if (hit) matched.push(title && !e.title ? { ...e, title } : e);
    }
    pool = matched;
  }

  const totalBytes = pool.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
  const pageRaw = [...pool].reverse().slice(0, 100);
  const entries = await Promise.all(
    pageRaw.map(async (e) => {
      if (e.title) return e;
      const t = await readSessionTitle(home, e.sessionId);
      return t ? { ...e, title: t } : e;
    })
  );

  return {
    ok: true,
    totalCount: index.entries.length,
    matchedCount: pool.length,
    totalMB: +(totalBytes / 1_048_576).toFixed(1),
    entries
  };
}

/**
 * Restore archived sessions back to `$DSH_HOME/sessions/<workspace>/<sessionId>`,
 * restoring both `session_projcache` and official `workspaceRegistry` attachment.
 */
export async function restoreArchive(home, items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: "no-items", restoredCount: 0, failed: [] };
  }
  const sessionsRoot = path.join(home, "sessions");
  const archiveRoot = path.join(home, ARCHIVE_DIRNAME);
  const index = await readArchiveIndex(home);
  const indexMap = new Map(index.entries.map((e) => [`${e.workspace}/${e.sessionId}`, e]));

  const restored = [];
  const failed = [];
  const restoredKeys = new Set();

  for (const raw of items) {
    const workspace = raw?.workspace;
    const sessionId = raw?.sessionId;
    if (!isSafeSegment(workspace) || !isSafeSegment(sessionId)) {
      failed.push({ workspace, sessionId, reason: "invalid-segment" });
      continue;
    }
    const src = path.join(archiveRoot, workspace, sessionId);
    const dst = path.join(sessionsRoot, workspace, sessionId);
    if (!isInsideRoot(archiveRoot, src) || !isInsideRoot(sessionsRoot, dst)) {
      failed.push({ workspace, sessionId, reason: "path-escape" });
      continue;
    }
    if (!(await pathExists(src))) {
      failed.push({ workspace, sessionId, reason: "archive-not-found" });
      continue;
    }
    if (await pathExists(dst)) {
      failed.push({ workspace, sessionId, reason: "destination-exists" });
      continue;
    }
    try {
      await moveDirectorySafe(src, dst);
      await restoreProjCacheIfPresent(home, sessionId);
      const indexed = indexMap.get(`${workspace}/${sessionId}`) || { workspace, sessionId };
      await attachToWorkspaceRegistry(options.workspaceRegistry, indexed);
      restoredKeys.add(`${workspace}/${sessionId}`);
      restored.push({ workspace, sessionId });
    } catch (err) {
      failed.push({ workspace, sessionId, reason: err?.code || "restore-failed" });
    }
  }

  if (restoredKeys.size > 0) {
    index.entries = index.entries.filter((e) => !restoredKeys.has(`${e.workspace}/${e.sessionId}`));
    await writeArchiveIndex(home, index);
  }

  return {
    ok: true,
    restoredCount: restored.length,
    failedCount: failed.length,
    restored,
    failed
  };
}

/**
 * Reversibly clean up leftover ghost references for already-archived sessions:
 *  1. Moves leftover `storages/session_projcache/sessions/<id>.json` -> `sessions-archive/_projcache/`;
 *  2. Detaches ghost session IDs from DSH's live `workspaceRegistry` (sidebar & archivedSessionIds)
 *     via official API while recording original workspace metadata for 1-click restore.
 */
export async function syncArchiveCache(home, options = {}) {
  const index = await readArchiveIndex(home);
  let movedCount = 0;
  let titlesEnriched = 0;
  let detachedFromSidebar = 0;
  let removedFromOfficialArchive = 0;
  let dirty = false;

  for (const entry of index.entries) {
    if (!isSafeSegment(entry?.sessionId)) continue;
    if (!entry.title) {
      const t = await readSessionTitle(home, entry.sessionId);
      if (t) {
        entry.title = t;
        titlesEnriched++;
        dirty = true;
      }
    }
    const moved = await archiveProjCacheIfPresent(home, entry.sessionId);
    if (moved) {
      entry.projCacheArchived = true;
      movedCount++;
      dirty = true;
    }
    if (options.workspaceRegistry) {
      const wsMeta = await detachFromWorkspaceRegistry(options.workspaceRegistry, entry.sessionId);
      if (wsMeta.originWorkspaceId && !entry.originWorkspaceId) {
        entry.originWorkspaceId = wsMeta.originWorkspaceId;
        dirty = true;
      }
      if (wsMeta.wasOfficialArchived && !entry.wasOfficialArchived) {
        entry.wasOfficialArchived = true;
        dirty = true;
      }
      if (wsMeta.detachedFromSidebar) detachedFromSidebar++;
      if (wsMeta.removedFromOfficialArchive) removedFromOfficialArchive++;
    }
  }

  if (dirty) {
    await writeArchiveIndex(home, index);
  }

  return {
    ok: true,
    checkedCount: index.entries.length,
    movedCount,
    titlesEnriched,
    detachedFromSidebar,
    removedFromOfficialArchive,
    workspaceRegistryAvailable: !!options.workspaceRegistry
  };
}
