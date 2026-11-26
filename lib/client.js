/**
 * dsh-perf-guard — Browser half (self-contained client bundle, v0.3.0).
 *
 * ZERO background polling, ZERO rAF loops, ZERO unsolicited network beacons.
 * Provides:
 *   1. Pure CSS offscreen rendering optimization (`content-visibility: auto`) + optional Hang Mode;
 *   2. Configurable SessionEventStream slimming (auto-yields if `dsh-lag-guard` is already active);
 *   3. "Performance Cockpit" settings section ("性能护航") with SVG health gauge, 2x2 preset cards,
 *      3 segmented tabs, visual storage bars, before/after delta snapshots, and reversible cold archiver.
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
    var VERSION = "0.3.0";
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
      exemptSessions: [],
      snapshots: []
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
        if (r.status === 404) return { ok: false, reason: "后端尚未加载新版接口，请正常重启一次 DSH 生效" };
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
        if (r.status === 404) return { ok: false, reason: "后端尚未加载新版接口，请正常重启一次 DSH 生效" };
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

    applyCssOptimization(runtimeConfig);
    installStreamGuard();

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

    // ── 3) Performance Cockpit Settings UI ───────────────────────────────────
    var PRESET_CARDS = [
      {
        key: "light",
        icon: "🍃",
        title: "轻量无感",
        badge: "零流干预",
        desc: "仅启用纯 CSS 离屏跳过与手动冷归档，完全不介入消息流，最稳妥。"
      },
      {
        key: "heavy",
        icon: "🚀",
        title: "重度长会话",
        badge: "推荐",
        desc: "流窗口裁剪 + 挂机减负 + CSS 离屏，适合多轮工具调用与长上下文拍档。"
      },
      {
        key: "archive",
        icon: "📦",
        title: "海量历史档",
        badge: "治侧边栏",
        desc: "针对上千条历史对话堆积，侧重 30 天+ 冷归档与标题离线检索还原。"
      },
      {
        key: "debug",
        icon: "🔬",
        title: "插件排查档",
        badge: "揪元凶",
        desc: "侧重存储小文件膨胀体检、长驻提醒与插件增删前后 Δ 对比快照。"
      }
    ];

    function computeHealthScore(domNodes, scan) {
      var score = 100;
      if (domNodes > 12000) score -= 28;
      else if (domNodes > 6000) score -= 14;
      else if (domNodes > 3000) score -= 5;
      if (scan) {
        if (scan.sessions.totalCount >= 1500) score -= 30;
        else if (scan.sessions.totalCount >= 500) score -= 15;
        else if (scan.sessions.totalCount >= 200) score -= 6;
        var crit = scan.warnings.filter(function (w) { return w.level === "critical"; }).length;
        var warn = scan.warnings.filter(function (w) { return w.level === "warn"; }).length;
        score -= Math.min(30, crit * 14 + warn * 6);
      }
      return Math.max(12, Math.min(100, score));
    }

    function HealthGauge(props) {
      var score = props.score;
      var color = score >= 80 ? "#10b981" : score >= 55 ? "#f59e0b" : "#ef4444";
      var label = score >= 80 ? "状态流畅" : score >= 55 ? "略显偏重" : "建议减负";
      var arcLen = 125.6; // semicircle r=40 -> pi*40
      var filled = (score / 100) * arcLen;
      return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minWidth: "112px" } },
        h("svg", { width: 108, height: 64, viewBox: "0 0 108 64", style: { overflow: "visible" } },
          h("path", { d: "M 14 54 A 40 40 0 0 1 94 54", fill: "none", stroke: "rgba(128,128,128,0.22)", strokeWidth: 9, strokeLinecap: "round" }),
          h("path", { d: "M 14 54 A 40 40 0 0 1 94 54", fill: "none", stroke: color, strokeWidth: 9, strokeLinecap: "round", strokeDasharray: filled.toFixed(1) + " " + arcLen }),
          h("text", { x: 54, y: 44, textAnchor: "middle", fill: "currentColor", fontSize: "21", fontWeight: "700" }, String(score)),
          h("text", { x: 54, y: 58, textAnchor: "middle", fill: color, fontSize: "10", fontWeight: "600" }, label)
        )
      );
    }

    function Pill(props) {
      var bg = props.bg || "rgba(128,128,128,0.14)";
      var color = props.color || "inherit";
      return h("span", {
        style: {
          display: "inline-block",
          padding: "2px 8px",
          borderRadius: "999px",
          fontSize: "11px",
          fontWeight: 600,
          background: bg,
          color: color,
          lineHeight: 1.4,
          whiteSpace: "nowrap"
        }
      }, props.children);
    }

    function DeltaPill(props) {
      var cur = props.cur, prev = props.prev, prefix = props.prefix;
      if (typeof prev !== "number") {
        return h(Pill, null, prefix + " " + cur);
      }
      var d = cur - prev;
      if (d === 0) return h(Pill, null, prefix + " " + cur + " (±0)");
      var worse = d > 0;
      return h(Pill, {
        bg: worse ? "rgba(239,68,68,0.14)" : "rgba(16,185,129,0.14)",
        color: worse ? "#ef4444" : "#10b981"
      }, prefix + " " + cur + " (" + (d > 0 ? "+" + d : String(d)) + ")");
    }

    var surfaceCard = {
      border: "1px solid var(--dsh-border, rgba(128,128,128,0.22))",
      borderRadius: "10px",
      padding: "14px 16px",
      marginBottom: "12px",
      background: "var(--dsh-surface-2, rgba(128,128,128,0.04))"
    };
    var btnBase = {
      padding: "6px 12px",
      borderRadius: "7px",
      border: "1px solid var(--dsh-border, rgba(128,128,128,0.3))",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: 500
    };
    var btnPrimary = Object.assign({}, btnBase, {
      background: "var(--dsh-accent, #2563eb)",
      color: "#ffffff",
      borderColor: "transparent"
    });
    var kpiTile = {
      border: "1px solid var(--dsh-border, rgba(128,128,128,0.18))",
      borderRadius: "8px",
      padding: "8px 10px",
      background: "var(--dsh-surface-1, rgba(128,128,128,0.03))"
    };

    function SettingsPanel() {
      var _tab = React.useState("overview"); // "overview" | "doctor" | "archive"
      var activeTab = _tab[0], setActiveTab = _tab[1];
      var _adv = React.useState(false);
      var showAdv = _adv[0], setShowAdv = _adv[1];

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

        apiGet("archive/list?q=").then(function (res) {
          if (alive && res && res.ok) setArchList(res);
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
            setMsg("配置已保存（独立写入本插件目录，未触碰 cordis.patch.yml）");
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
            setMsg("已切换至预设：" + presetKey);
          }
        }).catch(function (e) { setMsg("切换预设失败：" + e.message); });
      }

      function doScan(switchTab) {
        setScanning(true);
        setMsg("正在只读体检 $DSH_HOME …");
        apiGet("scan").then(function (res) {
          setScanning(false);
          if (res && res.ok) {
            setScan(res.report);
            setLiveDom(function (p) {
              return Object.assign({}, p, { domNodes: document.querySelectorAll("*").length });
            });
            if (switchTab) setActiveTab("doctor");
            setMsg("体检完成（耗时 " + res.report.durationMs + " ms，发现 " + res.report.warnings.length + " 项提醒）");
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
            setMsg("已安全归档 " + res.movedCount + " 个会话到 sessions-archive/（随时可一键还原）");
            setPreview(null);
            doScan(false);
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
            setMsg("已还原会话「" + (entry.title || entry.sessionId) + "」到 sessions/");
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

      var healthScore = computeHealthScore(liveDom.domNodes, scan);
      var streamBadge = !cfg.streamGuardEnabled
        ? { text: "流瘦身已关", bg: "rgba(128,128,128,0.16)", color: "inherit" }
        : streamState.status === "yielded-to-lag-guard"
          ? { text: "避让 dsh-lag-guard 共存", bg: "rgba(59,130,246,0.16)", color: "#3b82f6" }
          : streamState.status === "installed"
            ? { text: "流守卫已生效", bg: "rgba(16,185,129,0.16)", color: "#10b981" }
            : { text: "流守卫待命", bg: "rgba(245,158,11,0.16)", color: "#f59e0b" };

      var maxStorageFiles = 1;
      if (scan && scan.storages && scan.storages.dirs && scan.storages.dirs.length > 0) {
        maxStorageFiles = Math.max(1, scan.storages.dirs[0].files);
      }

      var tabs = [
        { id: "overview", label: "概览与预设" },
        { id: "doctor", label: "体检与快照" + (scan && scan.warnings.length > 0 ? " (" + scan.warnings.length + ")" : "") },
        { id: "archive", label: "冷归档库" + (archList ? " (" + archList.totalCount + ")" : "") }
      ];

      return h("div", { style: { fontSize: "13px", lineHeight: 1.5, maxWidth: "820px" } },

        // ── Hero Performance Cockpit ──
        h("div", {
          style: Object.assign({}, surfaceCard, {
            background: "linear-gradient(135deg, rgba(37,99,235,0.08) 0%, rgba(16,185,129,0.05) 100%)",
            padding: "16px 18px"
          })
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" } },
            h(HealthGauge, { score: healthScore }),
            h("div", { style: { flex: 1, minWidth: "240px" } },
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px" } },
                h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                  h("span", { style: { fontSize: "16px", fontWeight: 700 } }, "性能护航"),
                  h(Pill, null, "v" + VERSION),
                  h(Pill, { bg: streamBadge.bg, color: streamBadge.color }, streamBadge.text)
                ),
                h("button", {
                  style: Object.assign({}, btnPrimary, { padding: "6px 14px", fontWeight: 600 }),
                  disabled: scanning,
                  onClick: function () { doScan(true); }
                }, scanning ? "扫描中…" : "立即体检")
              ),
              h("div", { style: { fontSize: "12px", opacity: 0.78, marginBottom: "10px" } },
                "零后台轮询 · 可逆会话冷归档 · 按需存储体检 · UI 可调参流瘦身"
              ),
              h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "8px" } },
                h("div", { style: kpiTile },
                  h("div", { style: { fontSize: "11px", opacity: 0.68 } }, "页面 DOM 节点"),
                  h("div", { style: { fontSize: "15px", fontWeight: 700 } }, liveDom.domNodes.toLocaleString())
                ),
                h("div", { style: kpiTile },
                  h("div", { style: { fontSize: "11px", opacity: 0.68 } }, "活跃会话数"),
                  h("div", { style: { fontSize: "15px", fontWeight: 700 } }, scan ? (scan.sessions.totalCount + " 个") : "待体检")
                ),
                h("div", { style: kpiTile },
                  h("div", { style: { fontSize: "11px", opacity: 0.68 } }, "冷归档库"),
                  h("div", { style: { fontSize: "15px", fontWeight: 700 } }, archList ? (archList.totalCount + " 个") : "—")
                ),
                h("div", { style: kpiTile },
                  h("div", { style: { fontSize: "11px", opacity: 0.68 } }, "宿主已运行"),
                  h("div", { style: { fontSize: "15px", fontWeight: 700 } }, (hostUptimeSec / 3600).toFixed(1) + " h")
                )
              )
            )
          )
        ),

        // Long uptime gentle reminder
        cfg.longUptimeWarnEnabled && hostUptimeSec >= 43200
          ? h("div", { style: Object.assign({}, surfaceCard, { borderColor: "#f59e0b", background: "rgba(245,158,11,0.08)", padding: "10px 14px", fontSize: "12px" }) },
              "⏱ 宿主已连续运行 " + (hostUptimeSec / 3600).toFixed(1) + " 小时。若感觉界面发涩，建议在无活跃任务时正常重启一次以释放累积内存。"
            )
          : null,

        // Status toast banner
        msg ? h("div", { style: { padding: "7px 12px", marginBottom: "10px", borderRadius: "7px", background: "rgba(37,99,235,0.12)", fontSize: "12px" } }, msg) : null,

        // ── 3 Segmented Tabs ──
        h("div", {
          style: {
            display: "flex",
            gap: "6px",
            padding: "4px",
            borderRadius: "9px",
            background: "var(--dsh-surface-2, rgba(128,128,128,0.08))",
            marginBottom: "12px"
          }
        },
          tabs.map(function (t) {
            var active = activeTab === t.id;
            return h("button", {
              key: t.id,
              onClick: function () { setActiveTab(t.id); },
              style: {
                flex: 1,
                padding: "7px 10px",
                borderRadius: "7px",
                border: "none",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: active ? 600 : 500,
                background: active ? "var(--dsh-accent, #2563eb)" : "transparent",
                color: active ? "#ffffff" : "inherit",
                opacity: active ? 1 : 0.8
              }
            }, t.label);
          })
        ),

        // ── TAB 1: Overview & 2x2 Preset Cards ──
        activeTab === "overview" ? h("div", null,
          h("div", { style: surfaceCard },
            h("div", { style: { fontWeight: 600, marginBottom: "10px" } }, "选择一套适合你的预设（点选即生效）"),
            h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "10px", marginBottom: "12px" } },
              PRESET_CARDS.map(function (card) {
                var active = cfg.preset === card.key;
                return h("div", {
                  key: card.key,
                  onClick: function () { choosePreset(card.key); },
                  style: {
                    border: active ? "1.5px solid var(--dsh-accent, #2563eb)" : "1px solid var(--dsh-border, rgba(128,128,128,0.24))",
                    borderRadius: "9px",
                    padding: "11px 13px",
                    cursor: "pointer",
                    background: active ? "rgba(37,99,235,0.09)" : "var(--dsh-surface-1, rgba(128,128,128,0.02))"
                  }
                },
                  h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" } },
                    h("span", { style: { fontWeight: 600, fontSize: "13px" } }, card.icon + " " + card.title),
                    active
                      ? h(Pill, { bg: "var(--dsh-accent, #2563eb)", color: "#fff" }, "当前生效 ✓")
                      : h(Pill, null, card.badge)
                  ),
                  h("div", { style: { fontSize: "12px", opacity: 0.78 } }, card.desc)
                );
              })
            ),
            // Quick toggles
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "14px", paddingTop: "8px", borderTop: "1px solid rgba(128,128,128,0.16)", fontSize: "12px" } },
              h("label", { style: { cursor: "pointer" } },
                h("input", {
                  type: "checkbox",
                  checked: !!cfg.cssOffscreenEnabled,
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", cssOffscreenEnabled: e.target.checked })); }
                }), " CSS 离屏跳过渲染"
              ),
              h("label", { style: { cursor: "pointer" } },
                h("input", {
                  type: "checkbox",
                  checked: !!cfg.hangModeEnabled,
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", hangModeEnabled: e.target.checked })); }
                }), " 挂机减负模式（暂停动画）"
              ),
              h("label", { style: { cursor: "pointer" } },
                h("input", {
                  type: "checkbox",
                  checked: !!cfg.streamGuardEnabled,
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", streamGuardEnabled: e.target.checked })); }
                }), " 会话流瘦身"
              )
            )
          ),

          // Collapsible Advanced Tuning Drawer
          h("div", { style: surfaceCard },
            h("div", {
              onClick: function () { setShowAdv(!showAdv); },
              style: { display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontWeight: 600 }
            },
              h("span", null, "高级参数微调" + (cfg.preset === "custom" ? "（自定义）" : "")),
              h("span", { style: { opacity: 0.7, fontSize: "12px" } }, showAdv ? "收起 ▴" : "展开 ▾")
            ),
            showAdv ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "10px", marginTop: "12px", fontSize: "12px" } },
              h("label", null, "首页消息上限 (10-500): ",
                h("input", {
                  type: "number", min: 10, max: 500, value: cfg.maxMessages, style: { width: "70px", marginLeft: "4px" },
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", maxMessages: Number(e.target.value) || 120 })); }
                })
              ),
              h("label", null, "工具输出截断 (字符, 0=不截): ",
                h("input", {
                  type: "number", min: 0, max: 500000, step: 4096, value: cfg.maxToolResultChars, style: { width: "86px", marginLeft: "4px" },
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", maxToolResultChars: Number(e.target.value) || 0 })); }
                })
              ),
              h("label", null, "工具 Schema 上限 (字符): ",
                h("input", {
                  type: "number", min: 0, max: 1000000, step: 10000, value: cfg.maxHeaderToolsChars, style: { width: "86px", marginLeft: "4px" },
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", maxHeaderToolsChars: Number(e.target.value) || 0 })); }
                })
              ),
              h("label", null, "默认归档早于 (天): ",
                h("input", {
                  type: "number", min: 0, max: 3650, value: cfg.archiveMinAgeDays, style: { width: "70px", marginLeft: "4px" },
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { preset: "custom", archiveMinAgeDays: Number(e.target.value) || 0 })); }
                })
              )
            ) : null
          )
        ) : null,

        // ── TAB 2: Doctor & Snapshots ──
        activeTab === "doctor" ? h("div", null,
          h("div", { style: surfaceCard },
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" } },
              h("span", { style: { fontWeight: 600 } }, "存储与会话按需体检（只读）"),
              h("button", { style: btnPrimary, disabled: scanning, onClick: function () { doScan(false); } }, scanning ? "扫描中…" : "重新体检")
            ),
            scan ? h("div", { style: { fontSize: "12px" } },
              h("div", { style: { marginBottom: "8px" } },
                "活跃会话：", h("b", null, scan.sessions.totalCount), " 个（", scan.sessions.totalMB, " MB）｜30天前：",
                h("b", null, scan.sessions.buckets.olderThan30d.count), " 个（", scan.sessions.buckets.olderThan30d.mb, " MB）｜近7天：",
                h("b", null, scan.sessions.buckets.recent7d.count), " 个"
              ),
              scan.warnings.length > 0
                ? h("div", { style: { padding: "8px 10px", borderRadius: "7px", background: "rgba(245,158,11,0.1)", marginBottom: "10px" } },
                    scan.warnings.map(function (w, idx) {
                      return h("div", { key: idx, style: { color: w.level === "critical" ? "#ef4444" : "#d97706", marginBottom: "2px" } }, "• " + w.message);
                    })
                  )
                : h("div", { style: { padding: "8px 10px", borderRadius: "7px", background: "rgba(16,185,129,0.1)", color: "#10b981", marginBottom: "10px" } }, "✓ 未发现严重会话或存储膨胀告警。"),

              h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "插件存储占用 Top 目录："),
              h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" } },
                scan.storages.dirs.slice(0, 8).map(function (d) {
                  var pct = Math.max(4, Math.round((d.files / maxStorageFiles) * 100));
                  var barColor = d.severity === "critical" ? "#ef4444" : d.severity === "warn" ? "#f59e0b" : "#3b82f6";
                  return h("div", { key: d.name, style: { padding: "6px 8px", borderRadius: "6px", background: "rgba(128,128,128,0.05)" } },
                    h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", marginBottom: "4px" } },
                      h("span", { style: { fontFamily: "monospace", fontWeight: 600 } }, d.name),
                      h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } },
                        h("span", { style: { fontSize: "11px", opacity: 0.8 } }, d.files.toLocaleString() + " 文件 · " + d.mb + " MB"),
                        h(Pill, {
                          bg: d.severity === "critical" ? "rgba(239,68,68,0.15)" : d.severity === "warn" ? "rgba(245,158,11,0.15)" : "rgba(16,185,129,0.14)",
                          color: d.severity === "critical" ? "#ef4444" : d.severity === "warn" ? "#d97706" : "#10b981"
                        }, d.severity === "critical" ? "膨胀" : d.severity === "warn" ? "偏高" : "正常"),
                        h("button", { style: Object.assign({}, btnBase, { padding: "2px 8px", fontSize: "11px" }), onClick: function () { doOpenFolder(d.relPath || ("storages/" + d.name)); } }, "打开目录")
                      )
                    ),
                    h("div", { style: { height: "5px", borderRadius: "3px", background: "rgba(128,128,128,0.15)", overflow: "hidden" } },
                      h("div", { style: { width: pct + "%", height: "100%", background: barColor } })
                    )
                  );
                })
              ),

              scan.heavyAssets && scan.heavyAssets.length > 0 ? h("div", null,
                h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "大体积附件 / 历史备份目录（只读）："),
                scan.heavyAssets.map(function (a) {
                  return h("div", { key: a.name, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 6px", borderBottom: "1px solid rgba(128,128,128,0.12)" } },
                    h("span", { style: { fontFamily: "monospace" } }, a.name + " · " + a.files.toLocaleString() + " 文件 · " + a.mb + " MB"),
                    h("button", { style: Object.assign({}, btnBase, { padding: "2px 8px", fontSize: "11px" }), onClick: function () { doOpenFolder(a.relPath || a.name); } }, "打开目录")
                  );
                })
              ) : null
            ) : h("div", { style: { opacity: 0.72, fontSize: "12px" } }, "点击右上角「立即体检」扫描 sessions/、storages/ 与大体积附件（平时零后台占用）。")
          ),

          // Before/After Plugin Snapshots with Delta Pills
          h("div", { style: surfaceCard },
            h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "插件前后性能对比快照"),
            h("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "10px" } },
              h("input", {
                type: "text",
                placeholder: "快照备注（如：安装 XX 插件前 / 冷归档后）",
                value: snapLabel,
                style: { flex: 1, padding: "5px 9px", fontSize: "12px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.3)", background: "transparent", color: "inherit" },
                onChange: function (e) { setSnapLabel(e.target.value); }
              }),
              h("button", { style: btnPrimary, onClick: doTakeSnapshot }, "拍快照"),
              cfg.snapshots && cfg.snapshots.length > 0
                ? h("button", { style: btnBase, onClick: doClearSnapshots }, "清空")
                : null
            ),
            cfg.snapshots && cfg.snapshots.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              cfg.snapshots.map(function (s, idx) {
                var prev = idx > 0 ? cfg.snapshots[idx - 1] : null;
                return h("div", { key: s.at + idx, style: { padding: "7px 10px", borderRadius: "7px", background: "rgba(128,128,128,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" } },
                  h("div", null,
                    h("b", null, s.label),
                    h("span", { style: { marginLeft: "8px", fontSize: "11px", opacity: 0.65 } }, String(s.at || "").slice(5, 16).replace("T", " "))
                  ),
                  h("div", { style: { display: "flex", gap: "5px", flexWrap: "wrap" } },
                    h(DeltaPill, { prefix: "DOM", cur: s.domNodes, prev: prev && prev.domNodes }),
                    h(DeltaPill, { prefix: "会话", cur: s.sessionsCount, prev: prev && prev.sessionsCount }),
                    h(DeltaPill, { prefix: "存储文件", cur: s.storageFiles, prev: prev && prev.storageFiles })
                  )
                );
              })
            ) : h("div", { style: { opacity: 0.72, fontSize: "12px" } }, "在增删第三方插件前后各拍一张快照，自动用红/绿徽章标出 DOM 与存储增量。")
          )
        ) : null,

        // ── TAB 3: Reversible Cold Archive ──
        activeTab === "archive" ? h("div", null,
          h("div", { style: surfaceCard },
            h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "批量安全冷归档（只移不删，自动保护近期活跃会话）"),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", fontSize: "12px" } },
              h("label", null, "早于(天): ",
                h("input", {
                  type: "number", min: 0, max: 3650, value: cfg.archiveMinAgeDays, style: { width: "64px" },
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { archiveMinAgeDays: Number(e.target.value) || 0 })); }
                })
              ),
              h("label", null, "最小体积(MB): ",
                h("input", {
                  type: "number", min: 0, max: 500, value: cfg.archiveMinSizeMB, style: { width: "64px" },
                  onChange: function (e) { persistConfig(Object.assign({}, cfg, { archiveMinSizeMB: Number(e.target.value) || 0 })); }
                })
              ),
              h("button", { style: btnBase, onClick: doPreviewArchive }, "预览归档清单"),
              preview && preview.selectedCount > 0
                ? h("button", { style: btnPrimary, onClick: doRunArchive }, "确认归档 " + preview.selectedCount + " 个会话 (" + preview.totalMB + " MB)")
                : null
            )
          ),
          h("div", { style: surfaceCard },
            h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "已归档会话离线检索与一键还原"),
            h("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "10px" } },
              h("input", {
                type: "text",
                placeholder: "搜索已归档会话标题 / ID / 工作区…",
                value: archQ,
                style: { flex: 1, padding: "5px 9px", fontSize: "12px", borderRadius: "6px", border: "1px solid rgba(128,128,128,0.3)", background: "transparent", color: "inherit" },
                onChange: function (e) { setArchQ(e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter") loadArchiveList(archQ); }
              }),
              h("button", { style: btnPrimary, onClick: function () { loadArchiveList(archQ); } }, "搜索 / 刷新")
            ),
            archList ? h("div", null,
              h("div", { style: { fontSize: "12px", opacity: 0.72, marginBottom: "6px" } },
                "归档库共 " + archList.totalCount + " 个，当前匹配 " + archList.matchedCount + " 个（" + archList.totalMB + " MB）"
              ),
              h("div", { style: { maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px" } },
                archList.entries.slice(0, 50).map(function (ent) {
                  return h("div", {
                    key: ent.workspace + "/" + ent.sessionId,
                    style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", borderRadius: "6px", background: "rgba(128,128,128,0.04)" }
                  },
                    h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: "10px" } },
                      ent.title ? h("div", { style: { fontWeight: 600, fontSize: "12px" } }, ent.title) : null,
                      h("div", { style: { fontFamily: "monospace", fontSize: "11px", opacity: 0.7 } }, ent.sessionId + " · " + ent.mb + " MB")
                    ),
                    h("button", { style: Object.assign({}, btnBase, { padding: "3px 10px", fontSize: "11px", flexShrink: 0 }), onClick: function () { doRestoreOne(ent); } }, "还原")
                  );
                })
              )
            ) : h("div", { style: { opacity: 0.7, fontSize: "12px" } }, "点击「搜索 / 刷新」查看冷归档库。")
          )
        ) : null
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
