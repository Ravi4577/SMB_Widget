/*
 * SMB Transaction Tracker – Zoho CRM widget
 *
 * Data model: one CRM record per task. A task is identified by its record
 * Name, which is generated from the task hierarchy code, e.g. "SMB-LOI-1.3.3"
 * (or "SMB-<parentId>-LOI-1.3.3" in name_prefix linking mode). The CRM is
 * the only persistent store; nothing is written to browser storage.
 *
 * SDK methods used (Zoho CRM Embedded App SDK 1.2):
 *   ZOHO.embeddedApp.on("PageLoad", fn) / ZOHO.embeddedApp.init()
 *   ZOHO.CRM.META.getModules()            ZOHO.CRM.META.getFields({Entity})
 *   ZOHO.CRM.API.getAllRecords({...})     ZOHO.CRM.API.searchRecord({...})
 *   ZOHO.CRM.API.getRecord({...})         ZOHO.CRM.API.insertRecord({...})
 *   ZOHO.CRM.API.updateRecord({...})
 */
(function () {
  "use strict";

  var CONFIG = window.SMB_CONFIG;
  var PHASES = window.SMB_PHASES;
  var F = CONFIG.fields;
  var VALUE_KEYS = ["owner", "status", "dueDate", "completeDate", "atRisk", "taskDetails"];
  var KEY_LABELS = {
    owner: "Owner", status: "Status", dueDate: "Due Date",
    completeDate: "Completed Date", atRisk: "At Risk?", taskDetails: "Task Details"
  };
  var WRITE_CONCURRENCY = 4;
  // [config key, element id] for the transaction header.
  var HEADER_KEYS = [["sellerName", "hdrSeller"], ["closingDate", "hdrClosing"], ["buyerName", "hdrBuyer"], ["location", "hdrLocation"]];

  /* ==================================================================
   * State
   * ================================================================== */
  var state = {
    tasks: {},          // code -> task
    taskOrder: [],      // codes in display order
    phaseOf: {},        // phaseKey -> phase config
    expanded: {},       // "P:LOI" or task code -> true
    pageData: null,
    moduleApi: "",
    moduleSource: "",
    fieldsMeta: {},     // api_name -> field meta
    picklistValues: {}, // api_name -> [actual values]
    picklistSkips: {},  // "field|value" -> true (diagnostics)
    configErrors: [],   // blocking problems: saving disabled
    configWarnings: [],
    txn: { mode: CONFIG.transactionLink.mode, parentId: null, parentModule: CONFIG.transactionLink.parentModule },
    header: { entity: null, id: null, keys: {} }, // transaction header (parent record)
    unrecognized: [],
    duplicates: [],
    loaded: false,
    saving: false
  };

  /* ==================================================================
   * Utilities
   * ================================================================== */
  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function log() {
    if (CONFIG.debug.log && window.console) console.log.apply(console, ["[SMB Tracker]"].concat([].slice.call(arguments)));
  }

  function first(v) { return Array.isArray(v) ? v[0] : v; }

  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim(); }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function isIsoDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }

  function formatDate(s) {
    if (!s || !isIsoDate(String(s).slice(0, 10))) return s;
    var p = String(s).slice(0, 10).split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function errMsg(e) {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    if (e.data && e.data[0]) return errMsg(e.data[0]);
    var m = e.message || e.code || e.statusText;
    if (e.details && e.details.api_name) m += " (" + e.details.api_name + ")";
    if (m) return String(m);
    try { return JSON.stringify(e).slice(0, 300); } catch (x) { return String(e); }
  }

  // Runs fn over items with a concurrency limit; never rejects.
  function runPool(items, limit, fn) {
    var results = new Array(items.length);
    var next = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve()
        .then(function () { return fn(items[i], i); })
        .then(function (r) { results[i] = r; }, function (e) { results[i] = { ok: false, message: errMsg(e) }; })
        .then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  /* ==================================================================
   * Task hierarchy
   * ================================================================== */
  function buildTasks() {
    PHASES.forEach(function (phase) {
      state.phaseOf[phase.key] = phase;
      state.expanded["P:" + phase.key] = true;
      (function walk(nodes, depth, parent, rootItem) {
        nodes.forEach(function (n) {
          var root = rootItem || n;
          var task = {
            code: n.code,
            label: n.label,
            phaseKey: phase.key,
            phaseLabel: phase.label,
            rootItemLabel: root.label,
            depth: depth,
            parentCode: parent ? parent.code : null,
            childCodes: (n.children || []).map(function (c) { return c.code; }),
            suggestedOwner: n.owner || "",
            hint: n.hint || "",
            recordId: null,
            original: emptyValues(),
            current: emptyValues(),
            error: null,
            invalidKeys: {},
            justSaved: false
          };
          if (state.tasks[task.code]) throw new Error("Duplicate task code in config: " + task.code);
          state.tasks[task.code] = task;
          state.taskOrder.push(task.code);
          if (n.children) walk(n.children, depth + 1, n, root);
        });
      })(phase.items, 1, null, null);
    });
  }

  function emptyValues() {
    return { owner: "", status: "", dueDate: "", completeDate: "", atRisk: "", taskDetails: "" };
  }

  function recordName(task) {
    var parts = [CONFIG.naming.prefix];
    if (state.txn.mode === "name_prefix") parts.push(state.txn.parentId);
    parts.push(task.phaseKey, task.code);
    return parts.join("-");
  }

  function isDirty(task) {
    return VALUE_KEYS.some(function (k) { return (task.current[k] || "") !== (task.original[k] || ""); });
  }

  function changedKeys(task) {
    return VALUE_KEYS.filter(function (k) { return (task.current[k] || "") !== (task.original[k] || ""); });
  }

  function dirtyTasks() {
    return state.taskOrder.map(function (c) { return state.tasks[c]; }).filter(isDirty);
  }

  /* ==================================================================
   * SDK wrappers
   * ================================================================== */
  var CRM = {
    getModules: function () {
      return ZOHO.CRM.META.getModules().then(function (r) { return (r && r.modules) || []; });
    },
    getFields: function (entity) {
      return ZOHO.CRM.META.getFields({ Entity: entity }).then(function (r) { return (r && r.fields) || []; });
    },
    getRecord: function (entity, id) {
      return ZOHO.CRM.API.getRecord({ Entity: entity, RecordID: id }).then(function (r) {
        if (r && r.data && r.data[0]) return r.data[0];
        throw new Error("Record " + id + " not found in " + entity);
      });
    },
    // Fetch every page of a list/search call.
    paged: function (call) {
      var all = [];
      function page(n) {
        return call(n).then(function (r) {
          var rows = (r && Array.isArray(r.data)) ? r.data : [];
          all = all.concat(rows);
          if (r && r.info && r.info.more_records && rows.length) return page(n + 1);
          return all;
        });
      }
      return page(1);
    },
    insert: function (entity, data) {
      return ZOHO.CRM.API.insertRecord({ Entity: entity, APIData: data, Trigger: CONFIG.api.triggers }).then(parseWrite);
    },
    update: function (entity, data) {
      return ZOHO.CRM.API.updateRecord({ Entity: entity, APIData: data, Trigger: CONFIG.api.triggers }).then(parseWrite);
    }
  };

  function parseWrite(resp) {
    var row = resp && resp.data && resp.data[0];
    if (row && (row.code === "SUCCESS" || row.status === "success")) {
      return { ok: true, id: row.details && row.details.id };
    }
    return { ok: false, message: errMsg(row || resp) };
  }

  /* ==================================================================
   * Initialisation
   * ================================================================== */
  function start() {
    buildTasks();
    bindUI();
    renderSheet();

    if (typeof ZOHO === "undefined" || !ZOHO.embeddedApp) {
      addBanner("error", "Zoho CRM Embedded App SDK could not be loaded. Open this widget from inside Zoho CRM.", { id: "sdk" });
      return;
    }
    showLoader("Connecting to Zoho CRM…");
    ZOHO.embeddedApp.on("PageLoad", function (data) {
      state.pageData = data || {};
      log("PageLoad", state.pageData);
      resizePopup();
      loadEverything();
    });
    ZOHO.embeddedApp.init();
  }

  // Enlarge the CRM popup. Only applies to popup placements; ignored elsewhere.
  function resizePopup() {
    var ui = CONFIG.ui || {};
    if (!ui.resize || !ZOHO.CRM || !ZOHO.CRM.UI || typeof ZOHO.CRM.UI.Resize !== "function") return;
    var w = Math.round(Math.min(ui.width, (window.screen.availWidth || 1400) - (ui.marginX || 0)));
    var h = Math.round(Math.min(ui.height, (window.screen.availHeight || 900) - (ui.marginY || 0)));
    try {
      Promise.resolve(ZOHO.CRM.UI.Resize({ width: String(w), height: String(h) }))
        .catch(function (e) { log("resize failed", e); });
    } catch (e) { log("resize failed", e); }
  }

  function loadEverything() {
    showLoader("Loading transaction tasks…");
    state.configErrors = [];
    state.configWarnings = [];
    return resolveModule()
      .then(verifyFields)
      .then(resolveTransaction)
      .then(loadHeader)
      .then(function () {
        if (state.configErrors.length) return null;
        return fetchTaskRecords().then(applyRecords);
      })
      .catch(function (e) {
        state.configErrors.push("Initialisation failed: " + errMsg(e));
        log("init error", e);
      })
      .then(function () {
        state.loaded = true;
        renderConfigBanners();
        renderSheet();
        renderDiagnostics();
        updateToolbar();
        hideLoader();
      });
  }

  function resolveModule() {
    if (CONFIG.module.apiName) {
      state.moduleApi = CONFIG.module.apiName;
      state.moduleSource = "config.js";
      return Promise.resolve();
    }
    return CRM.getModules().then(function (mods) {
      var wanted = CONFIG.module.labels.map(norm);
      var hit = mods.filter(function (m) {
        return [m.plural_label, m.singular_label, m.module_name, m.api_name].some(function (l) { return wanted.indexOf(norm(l)) !== -1; });
      });
      if (!hit.length) throw new Error("Module \"" + CONFIG.module.labels[0] + "\" not found. Set CONFIG.module.apiName in config.js.");
      if (hit.length > 1) state.configWarnings.push("More than one module matches \"" + CONFIG.module.labels[0] + "\"; using " + hit[0].api_name + ". Set CONFIG.module.apiName.");
      state.moduleApi = hit[0].api_name;
      state.moduleSource = "auto-detected from label – hardcode in config.js after verifying";
    });
  }

  function verifyFields() {
    return CRM.getFields(state.moduleApi).then(function (fields) {
      state.fieldsMeta = {};
      fields.forEach(function (f) { state.fieldsMeta[f.api_name] = f; });

      var required = [];
      Object.keys(F).forEach(function (k) { required.push(F[k]); });
      Object.keys(CONFIG.phaseFields).forEach(function (k) { required.push(CONFIG.phaseFields[k]); });
      if (state.txn.mode === "lookup" && CONFIG.transactionLink.lookupField) required.push(CONFIG.transactionLink.lookupField);

      var missing = required.filter(function (api) { return !state.fieldsMeta[api]; });
      if (missing.length) state.configErrors.push("These fields were not found in module " + state.moduleApi + ": " + missing.join(", "));

      state.picklistValues = {};
      if (CONFIG.picklists.enabled) {
        CONFIG.picklists.rules.forEach(function (rule) {
          var meta = state.fieldsMeta[rule.field];
          if (!meta) { state.configWarnings.push("Picklist " + rule.field + " not found – rule skipped."); return; }
          state.picklistValues[rule.field] = (meta.pick_list_values || [])
            .map(function (v) { return v.actual_value != null ? v.actual_value : v.display_value; })
            .filter(function (v) { return v && v !== "-None-"; });
        });
      }
    });
  }

  function resolveTransaction() {
    var link = CONFIG.transactionLink;
    var pd = state.pageData || {};
    var entity = pd.Entity;
    var entityId = first(pd.EntityId);
    state.txn = { mode: link.mode, parentId: null, parentModule: link.parentModule };

    if (link.mode === "none") {
      state.configWarnings.push(
        "Transaction linking is not configured (mode \"none\"). All records in " + state.moduleApi +
        " are treated as ONE transaction. Use this only in Sandbox / single-transaction testing. " +
        "Configure transactionLink in config.js before production (see CONFIG-CHECKLIST.md).");
      return Promise.resolve();
    }
    if (link.mode !== "lookup" && link.mode !== "name_prefix") {
      state.configErrors.push("Unknown transactionLink.mode \"" + link.mode + "\".");
      return Promise.resolve();
    }
    if (!link.parentModule) { state.configErrors.push("transactionLink.parentModule is not set in config.js."); return Promise.resolve(); }
    if (link.mode === "lookup" && !link.lookupField) { state.configErrors.push("transactionLink.lookupField is not set in config.js."); return Promise.resolve(); }

    if (entity === link.parentModule && entityId) {
      state.txn.parentId = String(entityId);
      return Promise.resolve();
    }
    if (entity === state.moduleApi && entityId) {
      // Opened from a tracker record: derive the transaction from that record.
      return CRM.getRecord(state.moduleApi, entityId).then(function (rec) {
        if (link.mode === "lookup") {
          var lk = rec[link.lookupField];
          if (lk && lk.id) state.txn.parentId = String(lk.id);
        } else {
          var m = new RegExp("^" + CONFIG.naming.prefix + "-(\\d+)-").exec(rec[F.name] || "");
          if (m) state.txn.parentId = m[1];
        }
        if (!state.txn.parentId) state.configErrors.push("This tracker record is not linked to a " + link.parentModule + " record, so its transaction cannot be determined.");
      });
    }
    state.configErrors.push("Open this widget from a " + link.parentModule + " record so the transaction can be identified.");
    return Promise.resolve();
  }

  function loadHeader() {
    var h = { entity: null, id: null, keys: {} };
    state.header = h;
    HEADER_KEYS.forEach(function (k) { h.keys[k[0]] = { meta: null, reason: "Open the widget from a record to edit this field" }; });

    if (state.txn.parentId && state.txn.parentModule) {
      h.entity = state.txn.parentModule; h.id = state.txn.parentId;
    } else if (state.pageData && state.pageData.Entity && state.pageData.Entity !== state.moduleApi && first(state.pageData.EntityId)) {
      h.entity = state.pageData.Entity; h.id = String(first(state.pageData.EntityId));
    }
    if (!h.entity) return Promise.resolve();

    return Promise.all([CRM.getRecord(h.entity, h.id), CRM.getFields(h.entity)]).then(function (res) {
      var rec = res[0];
      var byApi = {};
      res[1].forEach(function (f) { byApi[f.api_name] = f; });
      HEADER_KEYS.forEach(function (pair) {
        var key = pair[0];
        var cfg = CONFIG.header[key] || {};
        var meta = null;
        if (cfg.field) {
          meta = byApi[cfg.field] || null;
        } else {
          var wanted = (cfg.labels || []).map(norm);
          for (var i = 0; i < wanted.length && !meta; i++) {
            meta = res[1].filter(function (f) { return norm(f.field_label) === wanted[i]; })[0] || null;
          }
        }
        if (!meta) {
          h.keys[key] = { meta: null, reason: "No matching field in " + h.entity + " – set CONFIG.header." + key + ".field in config.js" };
          state.configWarnings.push("Header \"" + key + "\": no field found in " + h.entity + (cfg.field ? " (" + cfg.field + ")" : " by label") + ".");
          return;
        }
        var kind = headerKind(meta);
        var val = toHeaderValue(rec[meta.api_name], kind);
        h.keys[key] = { meta: meta, kind: kind, original: val, current: val, display: displayValue(rec[meta.api_name]) };
      });
    }).catch(function (e) {
      state.configWarnings.push("Could not load header record: " + errMsg(e));
    });
  }

  // Input kind for a CRM field: text | date | picklist | number | boolean | readonly
  function headerKind(meta) {
    if (meta.read_only || meta.field_read_only) return "readonly";
    switch (meta.data_type) {
      case "text": case "textarea": case "email": case "phone": case "website": return "text";
      case "date": return "date";
      case "picklist": return "picklist";
      case "integer": case "bigint": case "double": case "currency": case "decimal": case "percent": return "number";
      case "boolean": return "boolean";
      default: return "readonly"; // lookup, ownerlookup, datetime, multiselect, autonumber, formula…
    }
  }

  function toHeaderValue(v, kind) {
    if (kind === "boolean") return v === true ? "true" : "false";
    if (v == null) return "";
    if (kind === "date") return String(v).slice(0, 10);
    return String(v);
  }

  function displayValue(v) {
    if (v == null || v === "") return "";
    if (typeof v === "object") return v.name || v.display_value || v.id || "";
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return formatDate(v);
    return String(v);
  }

  function headerDirtyKeys() {
    return HEADER_KEYS.map(function (p) { return p[0]; }).filter(function (k) {
      var f = state.header.keys[k];
      return f && f.meta && f.kind !== "readonly" && f.current !== f.original;
    });
  }

  function toCrmHeaderValue(f) {
    if (f.kind === "boolean") return f.current === "true";
    if (f.current === "") return null;
    if (f.kind === "number") return Number(f.current);
    return f.current;
  }

  function validateHeader() {
    var errs = [];
    headerDirtyKeys().forEach(function (k) {
      var f = state.header.keys[k];
      if (f.kind === "date" && f.current && !isIsoDate(f.current)) errs.push(f.meta.field_label + " must be a valid date");
      if (f.kind === "number" && f.current !== "" && !isFinite(Number(f.current))) errs.push(f.meta.field_label + " must be a number");
      if (f.meta.length && f.kind === "text" && f.current.length > f.meta.length) errs.push(f.meta.field_label + " is longer than " + f.meta.length + " characters");
    });
    return errs;
  }

  function saveHeader() {
    var keys = headerDirtyKeys();
    if (!keys.length) return Promise.resolve(null);
    var errs = validateHeader();
    if (errs.length) return Promise.resolve({ ok: false, message: errs.join("; ") });
    var data = { id: state.header.id };
    keys.forEach(function (k) { var f = state.header.keys[k]; data[f.meta.api_name] = toCrmHeaderValue(f); });
    log("update header", state.header.entity, data);
    return CRM.update(state.header.entity, data).then(function (r) {
      if (r.ok) keys.forEach(function (k) { var f = state.header.keys[k]; f.original = f.current; });
      return r;
    }, function (e) { return { ok: false, message: errMsg(e) }; });
  }

  function totalDirty() { return dirtyTasks().length + headerDirtyKeys().length; }

  function fetchTaskRecords() {
    var link = CONFIG.transactionLink;
    var per = CONFIG.api.pageSize;
    var entity = state.moduleApi;
    if (state.txn.mode === "lookup") {
      return CRM.paged(function (p) {
        return ZOHO.CRM.API.searchRecord({ Entity: entity, Type: "criteria", Query: "(" + link.lookupField + ":equals:" + state.txn.parentId + ")", page: p, per_page: per });
      });
    }
    if (state.txn.mode === "name_prefix") {
      var prefix = CONFIG.naming.prefix + "-" + state.txn.parentId + "-";
      return CRM.paged(function (p) {
        return ZOHO.CRM.API.searchRecord({ Entity: entity, Type: "criteria", Query: "(" + F.name + ":starts_with:" + prefix + ")", page: p, per_page: per });
      }).then(function (rows) {
        return rows.filter(function (r) { return String(r[F.name] || "").indexOf(prefix) === 0; });
      });
    }
    return CRM.paged(function (p) {
      return ZOHO.CRM.API.getAllRecords({ Entity: entity, sort_order: "asc", per_page: per, page: p });
    });
  }

  // Map CRM records to tasks by exact record Name. Returns map name -> record.
  function indexRecords(rows) {
    var byName = {};
    var dupes = [];
    rows.forEach(function (r) {
      var name = r[F.name];
      if (!name) return;
      if (byName[name]) {
        dupes.push(name);
        if (String(r.Modified_Time || "") > String(byName[name].Modified_Time || "")) byName[name] = r;
      } else {
        byName[name] = r;
      }
    });
    return { byName: byName, dupes: dupes };
  }

  function recordToValues(r) {
    var v = {};
    VALUE_KEYS.forEach(function (k) {
      var x = r[F[k]];
      v[k] = x == null ? "" : String(x);
    });
    v.dueDate = v.dueDate.slice(0, 10);
    v.completeDate = v.completeDate.slice(0, 10);
    return v;
  }

  // keepEdits: preserve unsaved current values on tasks that are still dirty.
  function applyRecords(rows, keepEdits) {
    var idx = indexRecords(rows);
    var known = {};
    state.duplicates = [];
    state.taskOrder.forEach(function (code) {
      var t = state.tasks[code];
      var name = recordName(t);
      known[name] = true;
      var rec = idx.byName[name];
      var stillDirty = keepEdits && isDirty(t);
      if (rec) {
        t.recordId = rec.id;
        t.original = recordToValues(rec);
        if (!stillDirty) t.current = recordToValues(rec);
      } else {
        t.recordId = null;
        t.original = emptyValues();
        if (!stillDirty) t.current = emptyValues();
      }
      if (idx.dupes.indexOf(name) !== -1) state.duplicates.push(code);
    });
    state.unrecognized = rows.filter(function (r) { return !known[r[F.name]]; });

    // Expand items that hold saved data so it is visible on load.
    state.taskOrder.forEach(function (code) {
      var t = state.tasks[code];
      if (!t.recordId) return;
      var p = t.parentCode;
      while (p) { state.expanded[p] = true; p = state.tasks[p].parentCode; }
    });
    log("records loaded", rows.length, "unrecognized", state.unrecognized.length);
  }

  /* ==================================================================
   * Rendering
   * ================================================================== */
  var CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function isVisible(task) {
    if (!state.expanded["P:" + task.phaseKey]) return false;
    var p = task.parentCode;
    while (p) {
      if (!state.expanded[p]) return false;
      p = state.tasks[p].parentCode;
    }
    return true;
  }

  function renderSheet() {
    var html = [];
    PHASES.forEach(function (phase) {
      var open = !!state.expanded["P:" + phase.key];
      var codes = state.taskOrder.filter(function (c) { return state.tasks[c].phaseKey === phase.key; });
      var saved = 0, complete = 0, risk = 0;
      codes.forEach(function (c) {
        var t = state.tasks[c];
        if (t.recordId) saved++;
        if (t.original.status === CONFIG.options.completeStatus) complete++;
        if (t.original.atRisk === "Yes") risk++;
      });
      html.push(
        '<tr class="row-phase ' + phase.color + '" data-phase="' + phase.key + '">' +
          '<td class="cell-code">' + esc(phase.code) + '</td>' +
          '<td colspan="7"><div class="cell-item">' +
            '<button type="button" class="toggle" data-toggle="P:' + phase.key + '" aria-expanded="' + open + '" aria-label="Toggle ' + esc(phase.label) + '">' + CHEVRON + '</button>' +
            '<span>' + esc(phase.label) + '</span>' +
            '<span class="phase-meta">' + saved + ' of ' + codes.length + ' tracked · ' + complete + ' complete' + (risk ? ' · <span class="err-text">' + risk + ' at risk</span>' : '') + '</span>' +
          '</div></td>' +
        '</tr>'
      );
      codes.forEach(function (c) {
        var t = state.tasks[c];
        if (isVisible(t)) html.push(taskRowHtml(t));
      });
    });
    $("sheetBody").innerHTML = html.join("");
  }

  function optionsHtml(options, value, placeholder) {
    var list = options.slice();
    if (value && list.indexOf(value) === -1) list.push(value); // keep unexpected CRM values visible
    var out = ['<option value="">' + esc(placeholder) + '</option>'];
    list.forEach(function (o) {
      out.push('<option value="' + esc(o) + '"' + (o === value ? " selected" : "") + ">" + esc(o) + "</option>");
    });
    return out.join("");
  }

  function rowClass(t) {
    var cls = ["row-task", "depth-" + t.depth];
    if (t.error) cls.push("is-error");
    else if (isDirty(t)) cls.push("is-dirty");
    else if (t.recordId) cls.push("is-saved");
    return cls.join(" ");
  }

  function dotHtml(t) {
    if (t.error) return '<span class="status-dot error" title="Save failed"></span>';
    if (isDirty(t)) return '<span class="status-dot dirty" title="Unsaved changes"></span>';
    if (t.recordId) return '<span class="status-dot saved" title="Saved in CRM (record ' + esc(t.recordId) + ')"></span>';
    return "";
  }

  function inv(t, k) { return t.invalidKeys[k] ? " invalid" : ""; }

  function taskRowHtml(t) {
    var v = t.current;
    var open = !!state.expanded[t.code];
    var toggle = t.childCodes.length
      ? '<button type="button" class="toggle" data-toggle="' + esc(t.code) + '" aria-expanded="' + open + '" aria-label="Toggle ' + esc(t.label) + '">' + CHEVRON + '</button>'
      : '<span class="toggle-spacer"></span>';
    var ownerPh = t.suggestedOwner ? "Select (suggested: " + t.suggestedOwner + ")" : "Select…";
    var statusCls = v.status === CONFIG.options.completeStatus ? " status-complete" : (v.status === "In Progress" ? " status-progress" : "");

    return '<tr class="' + rowClass(t) + '" data-code="' + esc(t.code) + '" title="' + esc(t.phaseLabel + " › " + t.label) + '">' +
      '<td class="cell-code">' + esc(t.code) + '</td>' +
      '<td><div class="cell-item">' + toggle +
        '<span class="item-label">' + esc(t.label) + '</span><span class="dot-slot">' + dotHtml(t) + '</span></div>' +
        '<div class="row-msg"' + (t.error ? "" : " hidden") + '>' + esc(t.error || "") + '</div></td>' +
      '<td><select data-key="owner" aria-label="Owner" class="' + (v.owner ? "" : "placeholder") + inv(t, "owner") + '">' + optionsHtml(CONFIG.options.owner, v.owner, ownerPh) + '</select></td>' +
      '<td><select data-key="status" aria-label="Status" class="' + (v.status ? "" : "placeholder") + statusCls + inv(t, "status") + '">' + optionsHtml(CONFIG.options.status, v.status, "Select…") + '</select></td>' +
      '<td><input type="date" data-key="dueDate" aria-label="Due date" value="' + esc(v.dueDate) + '" class="' + inv(t, "dueDate") + '"></td>' +
      '<td><input type="date" data-key="completeDate" aria-label="Completed date" value="' + esc(v.completeDate) + '" class="' + inv(t, "completeDate") + '"></td>' +
      '<td><select data-key="atRisk" aria-label="At risk" class="' + (v.atRisk ? "" : "placeholder") + (v.atRisk === "Yes" ? " risk-yes" : "") + inv(t, "atRisk") + '">' + optionsHtml(CONFIG.options.atRisk, v.atRisk, "—") + '</select></td>' +
      '<td><textarea data-key="taskDetails" aria-label="Task details" rows="1" maxlength="' + CONFIG.validation.taskDetailsMaxLength + '" class="' + inv(t, "taskDetails") + '">' + esc(v.taskDetails) + '</textarea></td>' +
    '</tr>';
  }

  // Update one rendered row in place (keeps focus while typing).
  function refreshRow(t) {
    var tr = document.querySelector('tr[data-code="' + CSS.escape(t.code) + '"]');
    if (!tr) return;
    tr.className = rowClass(t);
    tr.querySelector(".dot-slot").innerHTML = dotHtml(t);
    var msg = tr.querySelector(".row-msg");
    msg.textContent = t.error || "";
    msg.hidden = !t.error;
    tr.querySelectorAll("[data-key]").forEach(function (el) {
      var k = el.getAttribute("data-key");
      if (el.value !== t.current[k]) el.value = t.current[k];
      el.classList.toggle("invalid", !!t.invalidKeys[k]);
      if (el.tagName === "SELECT") el.classList.toggle("placeholder", !el.value);
    });
    var st = tr.querySelector('[data-key="status"]');
    st.classList.toggle("status-complete", st.value === CONFIG.options.completeStatus);
    st.classList.toggle("status-progress", st.value === "In Progress");
    tr.querySelector('[data-key="atRisk"]').classList.toggle("risk-yes", t.current.atRisk === "Yes");
  }

  function updateToolbar() {
    var n = totalDirty();
    var badge = $("dirtyBadge");
    badge.hidden = n === 0;
    badge.textContent = n + " unsaved change" + (n === 1 ? "" : "s");
    $("btnSave").disabled = state.saving || n === 0 || !state.loaded || state.configErrors.length > 0;
    $("btnRefresh").disabled = state.saving;
  }

  // Renders an input matching the CRM field type of each header field.
  function renderHeader() {
    HEADER_KEYS.forEach(function (pair) {
      var key = pair[0];
      var el = $(pair[1]);
      var f = state.header.keys[key] || {};
      var attrs = ' data-hkey="' + key + '" class="hdr-input"';
      var html;
      if (!f.meta) {
        html = '<input type="text" disabled' + attrs + ' title="' + esc(f.reason || "") + '">';
      } else if (f.kind === "readonly") {
        html = '<span class="hdr-readonly" title="' + esc(f.meta.field_label + " (" + f.meta.api_name + ") – read-only here") + '">' + esc(f.display) + "</span>";
      } else if (f.kind === "date") {
        html = '<input type="date"' + attrs + ' value="' + esc(f.current) + '">';
      } else if (f.kind === "number") {
        html = '<input type="number" step="any"' + attrs + ' value="' + esc(f.current) + '">';
      } else if (f.kind === "boolean") {
        html = '<input type="checkbox"' + attrs + (f.current === "true" ? " checked" : "") + '>';
      } else if (f.kind === "picklist") {
        var vals = (f.meta.pick_list_values || []).map(function (v) { return v.actual_value != null ? v.actual_value : v.display_value; })
          .filter(function (v) { return v && v !== "-None-"; });
        html = '<select' + attrs + '>' + optionsHtml(vals, f.current, "") + "</select>";
      } else {
        html = '<input type="text"' + attrs + ' value="' + esc(f.current) + '"' + (f.meta.length ? ' maxlength="' + f.meta.length + '"' : "") + ">";
      }
      el.innerHTML = html;
      el.classList.toggle("is-dirty", !!(f.meta && f.current !== f.original));
      if (f.meta) el.title = f.meta.field_label + " (" + state.header.entity + "." + f.meta.api_name + ")";
    });
  }

  function onHeaderEdit(e) {
    var key = e.target.getAttribute("data-hkey");
    var f = key && state.header.keys[key];
    if (!f || !f.meta) return;
    f.current = e.target.type === "checkbox" ? String(e.target.checked) : e.target.value;
    e.target.closest(".txn-value").classList.toggle("is-dirty", f.current !== f.original);
    updateToolbar();
  }

  function renderConfigBanners() {
    removeBanner("cfg-errors");
    removeBanner("cfg-warnings");
    removeBanner("cfg-dupes");
    if (state.configErrors.length) {
      addBanner("error", "<strong>Configuration required – saving is disabled.</strong><ul><li>" + state.configErrors.map(esc).join("</li><li>") + "</li></ul>", { id: "cfg-errors", html: true });
    }
    // Non-blocking warnings and duplicates are listed in the diagnostics panel only.
    renderHeader();
  }

  function renderDiagnostics() {
    var rows = [];
    function row(k, v) { rows.push("<tr><td><strong>" + esc(k) + "</strong></td><td>" + v + "</td></tr>"); }
    var pd = state.pageData || {};
    row("Module API name", state.moduleApi ? "<code>" + esc(state.moduleApi) + "</code> <span class='warn-text'>(" + esc(state.moduleSource) + ")</span>" : "<span class='err-text'>not resolved</span>");
    row("Opened from", pd.Entity ? "<code>" + esc(pd.Entity) + "</code> / <code>" + esc(first(pd.EntityId) || "—") + "</code>" : "Web tab / no record context");
    row("Transaction link", "<code>" + esc(state.txn.mode) + "</code>" + (state.txn.parentId ? " → " + esc(state.txn.parentModule) + " <code>" + esc(state.txn.parentId) + "</code>" : ""));
    if (state.configWarnings.length) row("Warnings", "<span class='warn-text'>" + state.configWarnings.map(esc).join("<br>") + "</span>");
    if (state.duplicates.length) row("Duplicate records", "<span class='warn-text'>Task(s) " + esc(state.duplicates.join(", ")) + " have more than one CRM record; the most recently modified one is shown and updated.</span>");

    var fieldList = [];
    Object.keys(F).forEach(function (k) { fieldList.push(F[k]); });
    Object.keys(CONFIG.phaseFields).forEach(function (k) { fieldList.push(CONFIG.phaseFields[k]); });
    row("Fields", fieldList.map(function (api) {
      var m = state.fieldsMeta[api];
      return m ? "<span class='ok-text'>✓</span> <code>" + esc(api) + "</code> " + esc(m.data_type || "")
               : "<span class='err-text'>✗ <code>" + esc(api) + "</code> missing</span>";
    }).join("<br>"));

    if (CONFIG.picklists.enabled) {
      row("Picklists (create only)", Object.keys(state.picklistValues).map(function (api) {
        return "<code>" + esc(api) + "</code>: " + state.picklistValues[api].length + " permitted values";
      }).join("<br>") || "—");
      var skips = Object.keys(state.picklistSkips);
      if (skips.length) row("Picklist values skipped", "<span class='warn-text'>" + skips.map(esc).join("<br>") + "</span>");
    }
    row("Unrecognized records", state.unrecognized.length
      ? "<span class='warn-text'>" + state.unrecognized.length + " record(s) whose Name does not match a configured task (ignored): " +
        state.unrecognized.slice(0, 10).map(function (r) { return esc(r[F.name] || r.id); }).join(", ") + (state.unrecognized.length > 10 ? "…" : "") + "</span>"
      : "0");
    row("Record naming", "<code>" + esc(state.moduleApi ? recordName(state.tasks["1.3.3"]) : "") + "</code> (example for 1.3.3)");
    if (CONFIG.debug.simulateFailureRate > 0) row("Debug", "<span class='err-text'>simulateFailureRate = " + CONFIG.debug.simulateFailureRate + "</span>");
    // The panel is not shown in the widget; diagnostics go to the browser console.
    var box = $("diagBody");
    if (box) { box.innerHTML = "<table>" + rows.join("") + "</table>"; return; }
    var tmp = document.createElement("div");
    tmp.innerHTML = "<table>" + rows.join("") + "</table>";
    log("diagnostics\n" + Array.prototype.map.call(tmp.querySelectorAll("tr"), function (tr) {
      return tr.cells[0].textContent + ": " + tr.cells[1].innerText.replace(/\n/g, " | ");
    }).join("\n"));
  }

  /* ==================================================================
   * Banners, loader, dialog
   * ================================================================== */
  function addBanner(type, content, opts) {
    opts = opts || {};
    if (opts.id) removeBanner(opts.id);
    var div = document.createElement("div");
    div.className = "banner banner-" + type;
    if (opts.id) div.setAttribute("data-banner", opts.id);
    var body = document.createElement("div");
    body.className = "banner-body";
    if (opts.html) body.innerHTML = content; else body.textContent = content;
    div.appendChild(body);
    if (opts.dismissible !== false && type !== "error" || opts.dismissible) {
      var x = document.createElement("button");
      x.type = "button"; x.className = "banner-close"; x.setAttribute("aria-label", "Dismiss"); x.innerHTML = "&times;";
      x.onclick = function () { div.remove(); };
      div.appendChild(x);
    }
    $("banners").appendChild(div);
    return div;
  }

  function removeBanner(id) {
    var el = document.querySelector('[data-banner="' + id + '"]');
    if (el) el.remove();
  }

  function showLoader(text) { $("loaderText").textContent = text || "Loading…"; $("loader").hidden = false; }
  function hideLoader() { $("loader").hidden = true; }

  function confirmDialog(message) {
    return new Promise(function (resolve) {
      $("dialogMsg").textContent = message;
      $("dialog").hidden = false;
      $("dialogYes").focus();
      function done(v) {
        $("dialog").hidden = true;
        $("dialogYes").onclick = $("dialogNo").onclick = null;
        resolve(v);
      }
      $("dialogYes").onclick = function () { done(true); };
      $("dialogNo").onclick = function () { done(false); };
    });
  }

  /* ==================================================================
   * UI events
   * ================================================================== */
  function bindUI() {
    var body = $("sheetBody");

    body.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-toggle]");
      var phaseRow = e.target.closest(".row-phase");
      var key = btn ? btn.getAttribute("data-toggle") : (phaseRow ? "P:" + phaseRow.getAttribute("data-phase") : null);
      if (!key) return;
      state.expanded[key] = !state.expanded[key];
      renderSheet();
    });

    body.addEventListener("change", onFieldEdit);
    body.addEventListener("input", function (e) { if (e.target.tagName === "TEXTAREA") onFieldEdit(e); });

    $("btnExpandAll").onclick = function () {
      PHASES.forEach(function (p) { state.expanded["P:" + p.key] = true; });
      state.taskOrder.forEach(function (c) { if (state.tasks[c].childCodes.length) state.expanded[c] = true; });
      renderSheet();
    };
    $("btnCollapseAll").onclick = function () {
      PHASES.forEach(function (p) { state.expanded["P:" + p.key] = false; });
      state.taskOrder.forEach(function (c) { state.expanded[c] = false; });
      renderSheet();
    };
    $("btnRefresh").onclick = onRefresh;
    $("btnSave").onclick = saveChanges;

    var hdr = document.querySelector(".txn-header");
    hdr.addEventListener("input", onHeaderEdit);
    hdr.addEventListener("change", onHeaderEdit);

    window.addEventListener("beforeunload", function (e) {
      if (totalDirty()) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function onFieldEdit(e) {
    var el = e.target;
    var key = el.getAttribute("data-key");
    var tr = el.closest("tr[data-code]");
    if (!key || !tr) return;
    var t = state.tasks[tr.getAttribute("data-code")];
    var prevStatus = t.current.status;
    t.current[key] = el.value;
    t.error = null;
    delete t.invalidKeys[key];
    t.justSaved = false;
    refreshRow(t);
    updateToolbar();

    if (key === "status" && e.type === "change" && el.value === CONFIG.options.completeStatus &&
        prevStatus !== CONFIG.options.completeStatus && !t.current.completeDate) {
      var d = today();
      confirmDialog("Mark \"" + t.label + "\" complete. Set Completed Date to today (" + d + ")?").then(function (yes) {
        if (yes && !t.current.completeDate) { // never overwrite an existing date
          t.current.completeDate = d;
          refreshRow(t);
          updateToolbar();
        }
      });
    }
  }

  function onRefresh() {
    var n = totalDirty();
    var go = n ? confirmDialog("Discard " + n + " unsaved change(s) and reload from CRM?") : Promise.resolve(true);
    go.then(function (yes) {
      if (!yes) return;
      state.taskOrder.forEach(function (c) { var t = state.tasks[c]; t.error = null; t.invalidKeys = {}; });
      removeBanner("save-result");
      loadEverything();
    });
  }

  /* ==================================================================
   * Validation & payloads
   * ================================================================== */
  function validateTask(t) {
    var v = t.current;
    var errs = [];
    t.invalidKeys = {};
    CONFIG.validation.requiredFields.forEach(function (k) {
      if (!v[k]) { errs.push(KEY_LABELS[k] + " is required"); t.invalidKeys[k] = true; }
    });
    [["owner", CONFIG.options.owner], ["status", CONFIG.options.status], ["atRisk", CONFIG.options.atRisk]].forEach(function (p) {
      var k = p[0];
      if (v[k] && p[1].indexOf(v[k]) === -1 && v[k] !== t.original[k]) { errs.push(KEY_LABELS[k] + " has an invalid value"); t.invalidKeys[k] = true; }
    });
    ["dueDate", "completeDate"].forEach(function (k) {
      if (v[k] && !isIsoDate(v[k])) { errs.push(KEY_LABELS[k] + " must be a valid date"); t.invalidKeys[k] = true; }
    });
    if (v.taskDetails.length > CONFIG.validation.taskDetailsMaxLength) {
      errs.push("Task Details exceeds " + CONFIG.validation.taskDetailsMaxLength + " characters"); t.invalidKeys.taskDetails = true;
    }
    return errs;
  }

  function crmValue(k, v) { return v === "" ? null : v; }

  function picklistPayload(t) {
    var out = {};
    if (!CONFIG.picklists.enabled) return out;
    CONFIG.picklists.rules.forEach(function (rule) {
      var allowed = state.picklistValues[rule.field];
      if (!allowed || !rule.appliesTo(t)) return;
      var cands = rule.candidates(t).filter(Boolean);
      for (var i = 0; i < cands.length; i++) {
        var hit = allowed.filter(function (a) { return norm(a) === norm(cands[i]); })[0];
        if (hit) { out[rule.field] = hit; return; }
      }
      state.picklistSkips[rule.field + " | " + t.code + " " + t.label] = true;
    });
    return out;
  }

  function createPayload(t) {
    var p = {};
    p[F.name] = recordName(t);
    p[CONFIG.phaseFields[t.phaseKey]] = t.label; // deepest task name -> its phase field only
    VALUE_KEYS.forEach(function (k) { if (t.current[k]) p[F[k]] = t.current[k]; });
    if (state.txn.mode === "lookup") p[CONFIG.transactionLink.lookupField] = { id: state.txn.parentId };
    var pl = picklistPayload(t);
    Object.keys(pl).forEach(function (k) { p[k] = pl[k]; });
    return p;
  }

  // Only changed fields are sent, so concurrent edits to other fields are not overwritten.
  function updatePayload(t) {
    var p = { id: t.recordId };
    changedKeys(t).forEach(function (k) { p[F[k]] = crmValue(k, t.current[k]); });
    return p;
  }

  /* ==================================================================
   * Save
   * ================================================================== */
  function saveChanges() {
    if (state.saving) return; // guards against repeated clicks
    var dirty = dirtyTasks();
    if (!dirty.length && !headerDirtyKeys().length) return;

    state.saving = true;
    updateToolbar();
    showLoader("Validating changes…");
    removeBanner("save-result");

    var invalid = [];
    var valid = [];
    dirty.forEach(function (t) {
      var errs = validateTask(t);
      if (errs.length) { t.error = errs.join("; "); invalid.push(t); } else { t.error = null; valid.push(t); }
    });

    // Duplicate guard: re-read CRM and attach any record that already exists
    // for a "new" task (e.g. created by an earlier save in another tab).
    var needsCheck = valid.some(function (t) { return !t.recordId; });
    var precheck = needsCheck
      ? fetchTaskRecords().then(function (rows) {
          var idx = indexRecords(rows);
          valid.forEach(function (t) {
            var rec = !t.recordId && idx.byName[recordName(t)];
            if (rec) { t.recordId = rec.id; t.original = recordToValues(rec); }
          });
        })
      : Promise.resolve();

    var outcome = { created: [], updated: [], header: null, failed: invalid.map(function (t) { return { task: t, message: t.error }; }) };

    saveHeader()
      .then(function (r) { outcome.header = r; return precheck; })
      .then(function () {
        showLoader("Saving " + valid.length + " task(s) to CRM…");
        return runPool(valid, WRITE_CONCURRENCY, function (t) {
          var isNew = !t.recordId;
          if (!isNew && !isDirty(t)) return { ok: true, skipped: true }; // precheck found identical data
          var payload = isNew ? createPayload(t) : updatePayload(t);
          var sent = JSON.parse(JSON.stringify(t.current));
          if (CONFIG.debug.simulateFailureRate > 0 && Math.random() < CONFIG.debug.simulateFailureRate) {
            return { ok: false, message: "Simulated API failure (debug.simulateFailureRate)" };
          }
          log(isNew ? "insert" : "update", payload);
          var call = isNew ? CRM.insert(state.moduleApi, payload) : CRM.update(state.moduleApi, payload);
          return call.then(function (r) {
            if (r.ok) {
              if (isNew) t.recordId = r.id || t.recordId;
              t.original = sent; // what CRM now holds for the fields we sent
            }
            r.isNew = isNew;
            return r;
          });
        }).then(function (results) {
          results.forEach(function (r, i) {
            var t = valid[i];
            if (r && r.ok) {
              t.error = null;
              t.justSaved = true;
              if (!r.skipped) (r.isNew ? outcome.created : outcome.updated).push(t);
            } else {
              t.error = "Save failed: " + ((r && r.message) || "unknown error");
              outcome.failed.push({ task: t, message: t.error });
            }
          });
        });
      })
      .catch(function (e) {
        // Pre-check failed: nothing was written.
        valid.forEach(function (t) {
          t.error = "Save failed: " + errMsg(e);
          outcome.failed.push({ task: t, message: t.error });
        });
      })
      .then(function () {
        // Refresh saved records from CRM while keeping failed edits.
        if (!outcome.created.length && !outcome.updated.length) return null;
        showLoader("Refreshing saved records…");
        return fetchTaskRecords().then(function (rows) { applyRecords(rows, true); })
          .catch(function (e) { addBanner("warn", "Saved, but reloading from CRM failed: " + errMsg(e), { id: "reload-warn" }); });
      })
      .then(function () {
        state.saving = false;
        reportSave(outcome);
        renderHeader();
        renderSheet();
        renderDiagnostics();
        updateToolbar();
        hideLoader();
      });
  }

  function reportSave(o) {
    var okN = o.created.length + o.updated.length;
    var hdrOk = o.header && o.header.ok;
    var hdrFail = o.header && !o.header.ok;
    var html = [];
    if (okN) {
      html.push("<strong>Saved " + okN + " task(s)</strong> – " + o.created.length + " created, " + o.updated.length + " updated." +
        "<ul><li>" + o.created.concat(o.updated).map(function (t) { return esc(t.code + " " + t.label); }).join("</li><li>") + "</li></ul>");
    }
    if (hdrOk) html.push("<strong>Transaction details saved</strong> to the " + esc(state.header.entity) + " record.");
    if (okN || hdrOk) addBanner("ok", html.join(""), { id: "save-result", html: true, dismissible: true });
    removeBanner("save-failed");
    if (o.failed.length || hdrFail) {
      var items = o.failed.map(function (f) { return esc(f.task.code + " " + f.task.label + ": " + f.message); });
      if (hdrFail) items.unshift(esc("Transaction details: " + o.header.message));
      addBanner("error",
        "<strong>" + items.length + " item(s) not saved</strong> – your changes are kept; fix and click Save Changes again." +
        "<ul><li>" + items.join("</li><li>") + "</li></ul>",
        { id: "save-failed", html: true, dismissible: true });
      // Make sure failed rows are visible.
      o.failed.forEach(function (f) {
        state.expanded["P:" + f.task.phaseKey] = true;
        var p = f.task.parentCode;
        while (p) { state.expanded[p] = true; p = state.tasks[p].parentCode; }
      });
    }
    if (!okN && !o.header && !o.failed.length) addBanner("info", "No changes needed saving.", { id: "save-result" });
  }

  /* ==================================================================
   * Boot
   * ================================================================== */
  function boot() {
    // Local preview only: index.html?mock=1 opened directly in a browser
    // (never inside CRM) swaps in an in-memory CRM for UI testing.
    var wantsMock = window.top === window.self && /[?&]mock=1\b/.test(location.search);
    if (!wantsMock) return start();
    var s = document.createElement("script");
    s.src = "../dev/mock-zoho-sdk.js";
    s.onload = start;
    s.onerror = function () { start(); };
    document.body.appendChild(s);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
