/**
 * Persistent configuration & preset definitions for dsh-perf-guard.
 *
 * OWNERSHIP: writes ONLY to `$DSH_HOME/storages/dsh-perf-guard/config.json`.
 * Never touches `cordis.patch.yml`, `.credentials.yaml`, or any other plugin's storage.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_VERSION = 1;
export const STORAGE_SUBDIR = "storages/dsh-perf-guard";
export const CONFIG_FILENAME = "config.json";

export const PRESETS = Object.freeze({
  light: Object.freeze({
    preset: "light",
    cssOffscreenEnabled: true,
    streamGuardEnabled: false,
    hangModeEnabled: false,
    sessionWarnEnabled: false,
    longUptimeWarnEnabled: false,
    maxMessages: 120,
    minMessages: 20,
    minTurns: 1,
    maxHeaderToolsChars: 150000,
    maxToolResultChars: 65536,
    maxToolCallArgsChars: 24576,
    sessionWarnMB: 5,
    archiveMinAgeDays: 30,
    archiveMinSizeMB: 0
  }),
  heavy: Object.freeze({
    preset: "heavy",
    cssOffscreenEnabled: true,
    streamGuardEnabled: true,
    hangModeEnabled: false,
    sessionWarnEnabled: true,
    longUptimeWarnEnabled: true,
    maxMessages: 100,
    minMessages: 20,
    minTurns: 1,
    maxHeaderToolsChars: 120000,
    maxToolResultChars: 49152,
    maxToolCallArgsChars: 16384,
    sessionWarnMB: 5,
    archiveMinAgeDays: 14,
    archiveMinSizeMB: 0
  }),
  archive: Object.freeze({
    preset: "archive",
    cssOffscreenEnabled: true,
    streamGuardEnabled: true,
    hangModeEnabled: false,
    sessionWarnEnabled: true,
    longUptimeWarnEnabled: false,
    maxMessages: 120,
    minMessages: 20,
    minTurns: 1,
    maxHeaderToolsChars: 150000,
    maxToolResultChars: 65536,
    maxToolCallArgsChars: 24576,
    sessionWarnMB: 5,
    archiveMinAgeDays: 30,
    archiveMinSizeMB: 0
  }),
  debug: Object.freeze({
    preset: "debug",
    cssOffscreenEnabled: true,
    streamGuardEnabled: true,
    hangModeEnabled: false,
    sessionWarnEnabled: true,
    longUptimeWarnEnabled: true,
    maxMessages: 120,
    minMessages: 20,
    minTurns: 1,
    maxHeaderToolsChars: 150000,
    maxToolResultChars: 65536,
    maxToolCallArgsChars: 24576,
    sessionWarnMB: 3,
    archiveMinAgeDays: 30,
    archiveMinSizeMB: 0
  })
});

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  ...PRESETS.heavy,
  expGpuLiteEnabled: false,
  expUltraLeanEnabled: false,
  expStreamCoalesceMs: 0,
  exemptSessions: [],
  snapshots: []
});

export function resolveDshHome(env = process.env) {
  const raw = env?.DSH_HOME;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.resolve(raw.trim());
  }
  return "";
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function boolOr(val, fallback) {
  return typeof val === "boolean" ? val : fallback;
}

export function sanitizeConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const presetKey = typeof src.preset === "string" && (src.preset in PRESETS || src.preset === "custom")
    ? src.preset
    : DEFAULT_CONFIG.preset;
  const base = presetKey in PRESETS ? PRESETS[presetKey] : PRESETS.heavy;

  const maxMessages = clampInt(src.maxMessages, 10, 500, base.maxMessages);
  const minMessages = Math.min(clampInt(src.minMessages, 0, 500, base.minMessages), maxMessages);
  const minTurns = clampInt(src.minTurns, 1, 20, base.minTurns);

  const exemptSessions = Array.isArray(src.exemptSessions)
    ? [...new Set(src.exemptSessions.filter((s) => typeof s === "string" && s.length > 0 && s.length < 200))].slice(0, 500)
    : [];

  const snapshots = Array.isArray(src.snapshots)
    ? src.snapshots
        .filter((s) => s && typeof s === "object" && typeof s.at === "string")
        .slice(-20)
    : [];

  return {
    version: CONFIG_VERSION,
    preset: presetKey,
    cssOffscreenEnabled: boolOr(src.cssOffscreenEnabled, base.cssOffscreenEnabled),
    streamGuardEnabled: boolOr(src.streamGuardEnabled, base.streamGuardEnabled),
    hangModeEnabled: boolOr(src.hangModeEnabled, base.hangModeEnabled),
    sessionWarnEnabled: boolOr(src.sessionWarnEnabled, base.sessionWarnEnabled),
    longUptimeWarnEnabled: boolOr(src.longUptimeWarnEnabled, base.longUptimeWarnEnabled),
    maxMessages,
    minMessages,
    minTurns,
    maxHeaderToolsChars: clampInt(src.maxHeaderToolsChars, 0, 2_000_000, base.maxHeaderToolsChars),
    maxToolResultChars: clampInt(src.maxToolResultChars, 0, 2_000_000, base.maxToolResultChars),
    maxToolCallArgsChars: clampInt(src.maxToolCallArgsChars, 0, 1_000_000, base.maxToolCallArgsChars),
    sessionWarnMB: clampInt(src.sessionWarnMB, 1, 100, base.sessionWarnMB),
    archiveMinAgeDays: clampInt(src.archiveMinAgeDays, 0, 3650, base.archiveMinAgeDays),
    archiveMinSizeMB: clampInt(src.archiveMinSizeMB, 0, 500, base.archiveMinSizeMB),
    expGpuLiteEnabled: boolOr(src.expGpuLiteEnabled, false),
    expUltraLeanEnabled: boolOr(src.expUltraLeanEnabled, false),
    expStreamCoalesceMs: clampInt(src.expStreamCoalesceMs, 0, 500, 0),
    exemptSessions,
    snapshots
  };
}

export function applyPreset(current, presetName) {
  if (!(presetName in PRESETS)) return sanitizeConfig(current);
  return sanitizeConfig({
    ...current,
    ...PRESETS[presetName],
    preset: presetName
  });
}

export function configFilePath(home) {
  return path.join(home, STORAGE_SUBDIR, CONFIG_FILENAME);
}

export async function readConfig(home) {
  if (!home) return { ok: false, reason: "home-unavailable", value: sanitizeConfig(DEFAULT_CONFIG) };
  const file = configFilePath(home);
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text);
    return { ok: true, value: sanitizeConfig(parsed), exists: true };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { ok: true, value: sanitizeConfig(DEFAULT_CONFIG), exists: false };
    }
    return { ok: false, reason: "read-failed", value: sanitizeConfig(DEFAULT_CONFIG) };
  }
}

export async function writeConfig(home, nextConfig) {
  if (!home) return { ok: false, reason: "home-unavailable" };
  // Merge with existing on-disk config so partial updates or version skew never wipe user settings
  const existing = await readConfig(home);
  const merged = existing.exists && nextConfig && typeof nextConfig === "object"
    ? { ...existing.value, ...nextConfig }
    : nextConfig;
  const clean = sanitizeConfig(merged);
  const file = configFilePath(home);
  const dir = path.dirname(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return { ok: true, value: clean };
  } catch (err) {
    return { ok: false, reason: err?.code || "write-failed" };
  }
}
