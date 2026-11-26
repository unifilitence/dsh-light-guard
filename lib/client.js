/**
 * dsh-perf-guard — Browser half (self-contained client bundle).
 *
 * ZERO background polling, ZERO rAF loops, ZERO unsolicited network beacons.
 * Provides:
 *   1. Pure CSS offscreen rendering optimization (`content-visibility: auto`) + optional Hang Mode;
 *   2. Configurable SessionEventStream slimming (auto-yields if `dsh-lag-guard` is already active);
 *   3. Settings section ("性能护航") with 4 presets, on-demand doctor, and reversible cold archive UI.
 */
window.__ModuleLoader__.load({
  id: "dsh-perf-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    var PLUGIN_NAME = "dsh-perf-guard";
    var VERSION = "0.2.0";
    var API_PREFIX = "dsh-perf-guard";
    var LOCAL_CACHE_KEY = "dsh.perfGuard.config.v1";
    var STYLE_ELEMENT_ID = "dsh-perf-guard-style";
    var PATCHED_SELF = Symbol.for("dsh-perf-guard.stream-patched.v1");
    var PATCHED_LAG_GUARD = Symbol.for("dsh-lag-guard.patched.v1");

    var DEFAULT_CFG = {
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
      archiveMinAgeDays: 30,
      archiveMinSizeMB: 0,
      exemptSessions: []
    };

    var runtimeConfig = loadCachedConfig();
    var streamState = {
      status: "idle", // "installed" | "yielded-to-lag-guard" | "unavailable" | "idle"
      opens: 0,
      records: 0,
      toolsCharsDropped: 0,
      resultsTrimmed: 0,
      argsTrimmed: 0,
      lastOpenMs: 0
    };

    function loadCachedConfig() {
      try {
        if (typeof localStorage !== "undefined") {
          var raw = localStorage.getItem(LOCAL_CACHE_KEY);
          if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
              return Object.assign({}, DEFAULT_CFG, parsed);
            }
          }
        }
      } catch {}
      return Object.assign({}, DEFAULT_CFG);
    }

    function saveCachedConfig(cfg) {
      runtimeConfig = Object.assign({}, DEFAULT_CFG, cfg || {});
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(runtimeConfig));
        }
      } catch {}
      applyCssOptimization(runtimeConfig);
    }

    function apiUrl(subpath) {
      try {
        return new URL("api/" + API_PREFIX + "/" + subpath, document.baseURI).toString();
      } catch {
        return "/api/" + API_PREFIX + "/" + subpath;
      }
    }

    function apiGet(subpath) {
      return fetch(apiUrl(subpath), {
        method: "GET",
        headers: { "cache-control": "no-store" },
        credentials: "same-origin"
      }).then(function (r) {
        return r.json();
      });
    }

    function apiPost(subpath, body, method) {
      return fetch(apiUrl(subpath), {
        method: method || "POST",
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        credentials: "same-origin",
        body: JSON.stringify(body || {})
      }).then(function (r) {
        return r.json();
      });
    }

    // ── 1) Pure CSS Offscreen Optimization & Hang Mode ────────────────────────
    function applyCssOptimization(cfg) {
      if (typeof document === "undefined" || !document.head) return;
      var existing = document.getElementById(STYLE_ELEMENT_ID);
      if (!cfg.cssOffscreenEnabled && !cfg.hangModeEnabled) {
        if (existing) existing.remove();
        return;
      }
      var rules = [];
      if (cfg.cssOffscreenEnabled) {
        rules.push(
          "[role='treeitem'][class*='sessionRow'] { content-visibility: auto; contain-intrinsic-size: auto 34px; }",
          "[data-testid*='turn'], [class*='turnContainer'], [class*='messageItem'] { content-visibility: auto; contain-intrinsic-size: auto 120px; }"
        );
      }
      if (cfg.hangModeEnabled) {
        rules.push(
          "*, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }"
        );
      }
      var cssText = rules.join("\n");
      if (!existing) {
        existing = document.createElement("style");
        existing.id = STYLE_ELEMENT_ID;
        document.head.appendChild(existing);
      }
      if (existing.textContent !== cssText) {
        existing.textContent = cssText;
      }
    }

    // ── 2) Configurable Stream Slimming (coexists peacefully with dsh-lag-guard) ─
    function clampRequest(request) {
      if (!runtimeConfig.streamGuardEnabled) return request;
      if (request === null || typeof request !== "object") return request;
      var max = Math.max(10, Math.min(500, Math.floor(Number(runtimeConfig.maxMessages) || 120)));
      var wanted = typeof request.maxMessages === "number" ? request.maxMessages : max;
      var next = Object.assign({}, request, { maxMessages: Math.min(wanted, max) });
      if (request.turnWindow && typeof request.turnWindow === "object") {
        var minMessages = Math.min(
          Math.max(0, Math.floor(Number(runtimeConfig.minMessages) || 20)),
          next.maxMessages
        );
        var minTurns = Math.max(1, Math.floor(Number(runtimeConfig.minTurns) || 1));
        next.turnWindow = Object.assign({}, request.turnWindow, { minMessages: minMessages, minTurns: minTurns });
      }
      return next;
    }

    function elideText(text, limit) {
      return text.slice(0, limit) + "\n… [dsh-perf-guard] 已折叠 " + (text.length - limit) + " 字符（仅影响前端显示，原始日志与模型上下文未改动）";
    }

    function measureChars(val) {
      try {
        var s = JSON.stringify(val);
        return s ? s.length : 0;
      } catch {
        return 0;
      }
    }

    function slimEvent(entry) {
      if (!runtimeConfig.streamGuardEnabled || !entry || typeof entry !== "object") return;
      var ev = entry.event || entry;
      if (!ev || typeof ev !== "object") return;

      // Trim oversized request/header.tools schema blob
      var maxTools = Number(runtimeConfig.maxHeaderToolsChars) || 0;
      if (maxTools > 0 && ev.type === "request/header" && ev.header && Array.isArray(ev.header.tools) && ev.header.tools.length > 0) {
        var chars = measureChars(ev.header.tools);
        if (chars > maxTools) {
          ev.header.toolsDropped = ev.header.tools.length;
          ev.header.toolsChars = chars;
          ev.header.tools = [];
          streamState.toolsCharsDropped += chars;
        }
      }

      // Trim oversized tool result bodies
      var maxRes = Number(runtimeConfig.maxToolResultChars) || 0;
      if (maxRes > 0 && typeof ev.type === "string" && ev.type.indexOf("tool") !== -1) {
        if (typeof ev.output === "string" && ev.output.length > maxRes) {
          ev.output = elideText(ev.output, maxRes);
          streamState.resultsTrimmed++;
        }
        if (typeof ev.content === "string" && ev.content.length > maxRes) {
          ev.content = elideText(ev.content, maxRes);
          streamState.resultsTrimmed++;
        }
      }

      // Trim oversized tool call arguments
      var maxArgs = Number(runtimeConfig.maxToolCallArgsChars) || 0;
      if (maxArgs > 0 && typeof ev.arguments === "string" && ev.arguments.length > maxArgs) {
        ev.arguments = elideText(ev.arguments, maxArgs);
        streamState.argsTrimmed++;
      }
    }

    function slimRecords(records) {
      if (!Array.isArray(records)) return;
      streamState.records += records.length;
      for (var i = 0; i < records.length; i++) {
        slimEvent(records[i]);
      }
    }

    function installStreamGuard() {
      var controller;
      try {
        controller = require("@deepseek-ai/dsh-api-session-controller");
      } catch {
        streamState.status = "unavailable";
        return false;
      }
      var Stream = controller && controller.SessionEventStream;
      if (typeof Stream !== "function" || !Stream.prototype) {
        streamState.status = "unavailable";
        return false;
      }
      var proto = Stream.prototype;
      if (proto[PATCHED_LAG_GUARD] === true) {
        streamState.status = "yielded-to-lag-guard";
        return false;
      }
      if (proto[PATCHED_SELF] === true) {
        streamState.status = "installed";
        return true;
      }

      var origFollow = proto.follow;
      var origReadPage = proto.readPage;

      if (typeof origFollow === "function") {
        proto.follow = function perfGuardFollow(request, signal) {
          var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
          var source = origFollow.call(this, clampRequest(request), signal);
          return (async function* () {
            for await (var frame of source) {
              if (frame && typeof frame === "object") {
                if (frame.type === "opened" && frame.page && typeof frame.page === "object") {
                  slimRecords(frame.page.records);
                  streamState.opens++;
                  var t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
                  streamState.lastOpenMs = +(t1 - t0).toFixed(1);
                } else if (frame.type === "entry" && frame.entry !== undefined) {
                  slimRecords([frame.entry]);
                }
              }
              yield frame;
            }
          })();
        };
      }

      if (typeof origReadPage === "function") {
        proto.readPage = async function perfGuardReadPage(request, throughSeq, signal) {
          var page = await origReadPage.call(this, clampRequest(request), throughSeq, signal);
          if (page && typeof page === "object") slimRecords(page.records);
          return page;
        };
      }

      Object.defineProperty(proto, PATCHED_SELF, { value: true, enumerable: false, configurable: false });
      streamState.status = "installed";
      return true;
    }

    // Boot-time lightweight setup (no timers, no network calls)
    applyCssOptimization(runtimeConfig);
    installStreamGuard();

    // Sync persisted config from host once asynchronously (non-blocking)
    try {
      if (typeof fetch === "function") {
        apiGet("config").then(function (res) {
          if (res && res.ok && res.value) saveCachedConfig(res.value);
        }).catch(function () {});
      }
    } catch {}

    globalThis.__DSH_PERF_GUARD_SNAPSHOT__ = function () {
      return {
        version: VERSION,
        config: Object.assign({}, runtimeConfig),
        streamState: Object.assign({}, streamState),
        cssActive: typeof document !== "undefined" && !!document.getElementById(STYLE_ELEMENT_ID)
      };
    };

    // ── 3) Settings UI Panel ("性能护航") ────────────────────────────────────
    var boxStyle = {
      border: "1px solid var(--dsh-border, rgba(128,128,128,0.25))",
      borderRadius: "8px",
      padding: "12px 14px",
      marginBottom: "12px",
      background: "var(--dsh-surface-2, rgba(128,128,128,0.05))"
    };
    var btnStyle = {
      padding: "5px 11px",
      borderRadius: "6px",
      border: "1px solid var(--dsh-border, rgba(128,128,128,0.35))",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      fontSize: "12px",
      marginRight: "6px",
      marginBottom: "6px"
    };
    var primaryBtnStyle = Object.assign({}, btnStyle, {
      background: "var(--dsh-accent, #2563eb)",
      color: "#fff",
      borderColor: "transparent"
    });

    function SettingsPanel() {
      var _cfg = React.useState(runtimeConfig);
      var cfg = _cfg[0], setCfg = _cfg[1];
      var _hostUp = React.useState(0);
      var hostUptimeSec = _hostUp[0], setHostUptimeSec = _hostUp[1];
      var _msg = React.useState("");
      var msg = _msg[0], setMsg = _msg[1];
      var _scan = React.useState(null);
      var scan = _scan[0], setScan = _scan[1];
      var _scanning = React.useState(false);
      var scanning = _scanning[0], setScanning = _scanning[1];
      var _preview = React.useState(null);
      var preview = _preview[0], setPreview = _preview[1];
      var _archList = React.useState(null);
      var archList = _archList[0], setArchList = _archList[1];
      var _archQ = React.useState("");
      var archQ = _archQ[0], setArchQ = _archQ[1];
      var _snapLabel = React.useState("");
      var snapLabel = _snapLabel[0], setSnapLabel = _snapLabel[1];
      var _liveDom = React.useState({ domNodes: 0, longTasks: 0, maxLtMs: 0 });
      var liveDom = _liveDom[0], setLiveDom = _liveDom[1];

      // Load host config & attach temporary LongTask observer ONLY while panel is mounted
      React.useEffect(function () {
        var alive = true;
        apiGet("config").then(function (res) {
          if (!alive || !res || !res.ok) return;
          if (res.value) {
            saveCachedConfig(res.value);
            setCfg(res.value);
          }
          if (typeof res.hostUptimeSec === "number") setHostUptimeSec(res.hostUptimeSec);
        }).catch(function () {});

        var nodes = typeof document !== "undefined" ? document.querySelectorAll("*").length : 0;
        setLiveDom({ domNodes: nodes, longTasks: 0, maxLtMs: 0 });

        var obs = null;
        try {
          if (typeof PerformanceObserver === "function") {
            obs = new PerformanceObserver(function (list) {
              var entries = list.getEntries();
              if (!alive || !entries.length) return;
              setLiveDom(function (prev) {
                var maxD = prev.maxLtMs;
                for (var i = 0; i < entries.length; i++) {
                  if (entries[i].duration > maxD) maxD = Math.round(entries[i].duration);
                }
                return {
                  domNodes: document.querySelectorAll("*").length,
                  longTasks: prev.longTasks + entries.length,
                  maxLtMs: maxD
                };
              });
            });
            obs.observe({ entryTypes: ["longtask"] });
          }
        } catch {}

        return function () {
          alive = false;
          if (obs) try { obs.disconnect(); } catch {}
        };
      }, []);

      function persistConfig(next) {
        saveCachedConfig(next);
        setCfg(next);
        apiPost("config", { value: next }, "PUT").then(function (res) {
          if (res && res.ok && res.value) {
            saveCachedConfig(res.value);
            setCfg(res.value);
            setMsg("配置已保存（仅写入本插件独立目录，未触碰 cordis.patch.yml）");
          } else {
            setMsg("保存失败：" + ((res && res.reason) || "未知错误"));
          }
        }).catch(function (e) { setMsg("保存异常：" + e.message); });
      }

      function choosePreset(presetKey) {
        apiPost("config", { applyPreset: presetKey }, "POST").then(function (res) {
          if (res && res.ok && res.value) {
            saveCachedConfig(res.value);
            setCfg(res.value);
            setMsg("已切换预设：" + presetKey);
          }
        }).catch(function (e) { setMsg("切换预设失败：" + e.message); });
      }

      function doScan() {
        setScanning(true);
        setMsg("正在只读体检 $DSH_HOME …");
        apiGet("scan").then(function (res) {
          setScanning(false);
          if (res && res.ok) {
            setScan(res.report);
            setLiveDom(function (p) {
              return Object.assign({}, p, { domNodes: document.querySelectorAll("*").length });
            });
            setMsg("体检完成（耗时 " + res.report.durationMs + " ms）");
          } else {
            setMsg("体检失败：" + ((res && res.reason) || "未知错误"));
          }
        }).catch(function (e) {
          setScanning(false);
          setMsg("体检异常：" + e.message);
        });
      }

      function doPreviewArchive() {
        setMsg("正在预览可归档历史会话…");
        apiPost("archive/preview", {
          minAgeDays: cfg.archiveMinAgeDays,
          minSizeMB: cfg.archiveMinSizeMB
        }).then(function (res) {
          if (res && res.ok) {
            setPreview(res);
            setMsg("预览完成：命中 " + res.selectedCount + " 个会话（" + res.totalMB + " MB），已自动跳过活跃/豁免会话");
          }
        }).catch(function (e) { setMsg("预览失败：" + e.message); });
      }

      function doRunArchive() {
        if (!preview || !preview.items || preview.items.length === 0) return;
        setMsg("正在安全冷归档（只移不删）…");
        apiPost("archive/run", { items: preview.items }).then(function (res) {
          if (res && res.ok) {
            setMsg("已归档 " + res.movedCount + " 个会话到 sessions-archive/（失败 " + res.failedCount + " 个），随时可一键还原");
            setPreview(null);
            doScan();
            loadArchiveList(archQ);
          } else {
            setMsg("归档失败：" + ((res && res.reason) || "未知错误"));
          }
        }).catch(function (e) { setMsg("归档异常：" + e.message); });
      }

      function loadArchiveList(q) {
        apiGet("archive/list?q=" + encodeURIComponent(q || "")).then(function (res) {
          if (res && res.ok) setArchList(res);
        }).catch(function () {});
      }

      function doRestoreOne(entry) {
        apiPost("archive/restore", { items: [{ workspace: entry.workspace, sessionId: entry.sessionId }] }).then(function (res) {
          if (res && res.ok && res.restoredCount > 0) {
            setMsg("已还原会话 " + (entry.title || entry.sessionId) + " 到 sessions/");
            loadArchiveList(archQ);
          } else {
            setMsg("还原失败：" + JSON.stringify(res && res.failed));
          }
        }).catch(function (e) { setMsg("还原异常：" + e.message); });
      }

      function doOpenFolder(relPath) {
        apiPost("open-folder", { relPath: relPath }).then(function (res) {
          if (res && res.ok) setMsg("已在系统文件管理器中打开：" + relPath);
          else setMsg("打开目录失败：" + ((res && res.reason) || "未知错误"));
        }).catch(function (e) { setMsg("打开目录异常：" + e.message); });
      }

      function doTakeSnapshot() {
        var curNodes = typeof document !== "undefined" ? document.querySelectorAll("*").length : liveDom.domNodes;
        setMsg("正在记录性能快照…");
        apiPost("snapshot", {
          label: snapLabel || "手动快照",
          domNodes: curNodes,
          longTasks: liveDom.longTasks,
          maxLtMs: liveDom.maxLtMs
        }).then(function (res) {
          if (res && res.ok) {
            var next = Object.assign({}, cfg, { snapshots: res.snapshots || [] });
            saveCachedConfig(next);
            setCfg(next);
            setSnapLabel("");
            setMsg("已记录快照：" + res.snapshot.label);
          } else {
            setMsg("记录快照失败：" + ((res && res.reason) || "未知错误"));
          }
        }).catch(function (e) { setMsg("记录快照异常：" + e.message); });
      }

      function doClearSnapshots() {
        apiPost("snapshot", { clear: true }).then(function (res) {
          if (res && res.ok) {
            var next = Object.assign({}, cfg, { snapshots: [] });
            saveCachedConfig(next);
            setCfg(next);
            setMsg("已清空对比快照");
          }
        }).catch(function () {});
      }

      function fmtDelta(cur, prev) {
        if (typeof prev !== "number") return "";
        var d = cur - prev;
        if (d === 0) return " (±0)";
        return d > 0 ? " (+" + d + ")" : " (" + d + ")";
      }

      var presetLabels = [
        ["light", "轻量无感"],
        ["heavy", "重度长会话"],
        ["archive", "海量历史档"],
        ["debug", "插件排查档"]
      ];

      return h("div", { style: { fontSize: "13px", lineHeight: 1.55, maxWidth: "780px" } },
        h("h3", { style: { marginTop: 0, marginBottom: "6px" } }, "性能护航 (dsh-perf-guard v" + VERSION + ")"),
        h("p", { style: { opacity: 0.75, marginTop: 0, marginBottom: "12px", fontSize: "12px" } },
          "零后台轮询 · 可逆会话冷归档 · 按需存储体检 · UI 可调参流瘦身与 CSS 离屏优化。当前状态：流守卫=" + streamState.status +
          "｜页面 DOM=" + liveDom.domNodes + "｜宿主已运行=" + (hostUptimeSec / 3600).toFixed(1) + "h"
        ),
        cfg.longUptimeWarnEnabled && hostUptimeSec >= 43200
          ? h("div", { style: Object.assign({}, boxStyle, { borderColor: "#f59e0b" }) },
              "提示：当前宿主已连续运行 " + (hostUptimeSec / 3600).toFixed(1) + " 小时，若感觉界面变涩，建议在无活跃任务时正常重启一次以释放内存。"
            )
          : null,
        msg ? h("div", { style: { padding: "6px 10px", marginBottom: "10px", borderRadius: "6px", background: "rgba(37,99,235,0.12)", fontSize: "12px" } }, msg) : null,

        // Presets & Switches
        h("div", { style: boxStyle },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "1. 一键预设与渲染减负开关"),
          h("div", { style: { marginBottom: "8px" } },
            presetLabels.map(function (pair) {
              var active = cfg.preset === pair[0];
              return h("button", {
                key: pair[0],
                style: active ? primaryBtnStyle : btnStyle,
                onClick: function () { choosePreset(pair[0]); }
              }, pair[1] + (active ? " ✓" : ""));
            })
          ),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "8px" } },
            h("label", null,
              h("input", {
                type: "checkbox",
                checked: !!cfg.cssOffscreenEnabled,
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", cssOffscreenEnabled: e.target.checked })); }
              }), " CSS 离屏跳过渲染"
            ),
            h("label", null,
              h("input", {
                type: "checkbox",
                checked: !!cfg.hangModeEnabled,
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", hangModeEnabled: e.target.checked })); }
              }), " 挂机减负模式（暂停动画）"
            ),
            h("label", null,
              h("input", {
                type: "checkbox",
                checked: !!cfg.streamGuardEnabled,
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", streamGuardEnabled: e.target.checked })); }
              }), " 会话流瘦身"
            )
          ),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "12px", fontSize: "12px" } },
            h("label", null, "首页消息上限: ",
              h("input", {
                type: "number", min: 20, max: 500, value: cfg.maxMessages, style: { width: "64px" },
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", maxMessages: Number(e.target.value) || 120 })); }
              })
            ),
            h("label", null, "工具输出截断(字符): ",
              h("input", {
                type: "number", min: 0, max: 500000, step: 4096, value: cfg.maxToolResultChars, style: { width: "84px" },
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", maxToolResultChars: Number(e.target.value) || 0 })); }
              })
            )
          )
        ),

        // On-demand Doctor
        h("div", { style: boxStyle },
          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
            h("span", { style: { fontWeight: 600 } }, "2. 按需性能体检（只读扫描）"),
            h("button", { style: primaryBtnStyle, disabled: scanning, onClick: doScan }, scanning ? "扫描中…" : "立即体检")
          ),
          scan ? h("div", { style: { fontSize: "12px" } },
            h("div", { style: { marginBottom: "6px" } },
              "会话总计：", h("b", null, scan.sessions.totalCount), " 个（", scan.sessions.totalMB, " MB）｜30天前：",
              h("b", null, scan.sessions.buckets.olderThan30d.count), " 个（", scan.sessions.buckets.olderThan30d.mb, " MB）｜近7天活跃：",
              h("b", null, scan.sessions.buckets.recent7d.count), " 个"
            ),
            scan.warnings.length > 0 ? h("ul", { style: { margin: "4px 0 8px 18px", color: "#d97706" } },
              scan.warnings.map(function (w, idx) { return h("li", { key: idx }, w.message); })
            ) : h("div", { style: { color: "#16a34a" } }, "未发现严重存储或会话膨胀告警。"),
            h("div", { style: { fontWeight: 600, marginTop: "6px" } }, "插件存储 Top 目录："),
            h("div", { style: { maxHeight: "150px", overflowY: "auto", fontFamily: "monospace", fontSize: "11px" } },
              scan.storages.dirs.slice(0, 8).map(function (d) {
                return h("div", { key: d.name, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", color: d.severity === "critical" ? "#dc2626" : d.severity === "warn" ? "#d97706" : "inherit" } },
                  h("span", null, d.name + " : " + d.files + " 文件 / " + d.mb + " MB [" + d.severity + "]"),
                  h("button", { style: Object.assign({}, btnStyle, { padding: "1px 6px", margin: 0, fontSize: "11px" }), onClick: function () { doOpenFolder(d.relPath || ("storages/" + d.name)); } }, "打开目录")
                );
              })
            ),
            scan.heavyAssets && scan.heavyAssets.length > 0 ? h("div", { style: { marginTop: "8px" } },
              h("div", { style: { fontWeight: 600 } }, "大体积附件 / 历史备份目录（只读）："),
              h("div", { style: { maxHeight: "110px", overflowY: "auto", fontFamily: "monospace", fontSize: "11px" } },
                scan.heavyAssets.map(function (a) {
                  return h("div", { key: a.name, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0" } },
                    h("span", null, a.name + " : " + a.files + " 文件 / " + a.mb + " MB"),
                    h("button", { style: Object.assign({}, btnStyle, { padding: "1px 6px", margin: 0, fontSize: "11px" }), onClick: function () { doOpenFolder(a.relPath || a.name); } }, "打开目录")
                  );
                })
              )
            ) : null
          ) : h("div", { style: { opacity: 0.7, fontSize: "12px" } }, "点击「立即体检」扫描 sessions/、storages/ 与大体积附件（平时零后台占用）。")
        ),

        // Reversible Cold Archiver
        h("div", { style: boxStyle },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "3. 会话冷热归档与一键还原（只移不删）"),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "8px", fontSize: "12px" } },
            h("label", null, "早于(天): ",
              h("input", {
                type: "number", min: 0, max: 3650, value: cfg.archiveMinAgeDays, style: { width: "60px" },
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { archiveMinAgeDays: Number(e.target.value) || 0 })); }
              })
            ),
            h("label", null, "最小体积(MB): ",
              h("input", {
                type: "number", min: 0, max: 500, value: cfg.archiveMinSizeMB, style: { width: "60px" },
                onChange: function (e) { persistConfig(Object.assign({}, cfg, { archiveMinSizeMB: Number(e.target.value) || 0 })); }
              })
            ),
            h("button", { style: btnStyle, onClick: doPreviewArchive }, "预览归档清单"),
            preview && preview.selectedCount > 0
              ? h("button", { style: primaryBtnStyle, onClick: doRunArchive }, "确认归档 " + preview.selectedCount + " 个会话 (" + preview.totalMB + " MB)")
              : null
          ),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "8px" } },
            h("input", {
              type: "text",
              placeholder: "离线搜索已归档会话标题 / ID / 工作区…",
              value: archQ,
              style: { flex: 1, padding: "4px 8px", fontSize: "12px" },
              onChange: function (e) { setArchQ(e.target.value); }
            }),
            h("button", { style: btnStyle, onClick: function () { loadArchiveList(archQ); } }, "查看已归档")
          ),
          archList ? h("div", { style: { marginTop: "8px", maxHeight: "180px", overflowY: "auto", fontSize: "11px" } },
            h("div", { style: { opacity: 0.75, marginBottom: "4px" } },
              "归档库共 " + archList.totalCount + " 个，当前匹配 " + archList.matchedCount + " 个（" + archList.totalMB + " MB）"
            ),
            archList.entries.slice(0, 40).map(function (ent) {
              return h("div", { key: ent.workspace + "/" + ent.sessionId, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", borderBottom: "1px solid rgba(128,128,128,0.12)" } },
                h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: "8px" } },
                  ent.title ? h("b", { style: { marginRight: "6px" } }, ent.title) : null,
                  h("span", { style: { fontFamily: "monospace", opacity: 0.75 } }, ent.sessionId + " · " + ent.mb + " MB")
                ),
                h("button", { style: Object.assign({}, btnStyle, { padding: "1px 6px", margin: 0, flexShrink: 0 }), onClick: function () { doRestoreOne(ent); } }, "还原")
              );
            })
          ) : null
        ),

        // Before/After Plugin Snapshots
        h("div", { style: boxStyle },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "4. 插件前后性能对比快照"),
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "8px" } },
            h("input", {
              type: "text",
              placeholder: "快照备注（如：安装 XX 插件前 / 归档后）",
              value: snapLabel,
              style: { flex: 1, padding: "4px 8px", fontSize: "12px" },
              onChange: function (e) { setSnapLabel(e.target.value); }
            }),
            h("button", { style: primaryBtnStyle, onClick: doTakeSnapshot }, "拍快照"),
            cfg.snapshots && cfg.snapshots.length > 0
              ? h("button", { style: btnStyle, onClick: doClearSnapshots }, "清空")
              : null
          ),
          cfg.snapshots && cfg.snapshots.length > 0 ? h("div", { style: { maxHeight: "140px", overflowY: "auto", fontFamily: "monospace", fontSize: "11px" } },
            cfg.snapshots.map(function (s, idx) {
              var prev = idx > 0 ? cfg.snapshots[idx - 1] : null;
              return h("div", { key: s.at + idx, style: { padding: "3px 0", borderBottom: "1px solid rgba(128,128,128,0.12)" } },
                h("b", null, "[" + s.label + "] "),
                "DOM=" + s.domNodes + fmtDelta(s.domNodes, prev && prev.domNodes) +
                " | 会话=" + s.sessionsCount + fmtDelta(s.sessionsCount, prev && prev.sessionsCount) +
                " (" + s.sessionsMB + "MB)" +
                " | 存储文件=" + s.storageFiles + fmtDelta(s.storageFiles, prev && prev.storageFiles) +
                " | " + String(s.at || "").slice(5, 16).replace("T", " ")
              );
            })
          ) : h("div", { style: { opacity: 0.7, fontSize: "12px" } }, "在增删第三方插件前后各拍一张快照，自动计算 DOM 与存储文件数增量。")
        )
      );
    }

    function registerSettingsSection(ctx) {
      try {
        var slots = ctx.get("slots", false);
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
          return null;
        }
        var dispose = null;
        slots.inject("settings.section", function () {
          try {
            var d = slots.register({
              name: "settings.section",
              id: PLUGIN_NAME,
              order: 65,
              label: "性能护航"
            }, SettingsPanel);
            if (typeof d === "function") dispose = d;
          } catch {}
        });
        return function () {
          try { if (typeof dispose === "function") dispose(); } catch {}
        };
      } catch {
        return null;
      }
    }

    function apply(ctx) {
      installStreamGuard();
      applyCssOptimization(runtimeConfig);
      var disposeSection = registerSettingsSection(ctx);
      return function () {
        try { if (typeof disposeSection === "function") disposeSection(); } catch {}
      };
    }

    exports.name = PLUGIN_NAME;
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  }
});
