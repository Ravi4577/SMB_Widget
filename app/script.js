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
  var TF = CONFIG.taskFields; // Phase_Items / Sub_Items
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
    phaseValues: {},    // phase key -> exact Phase_Items picklist value
    subItemMaxLength: 255,
    nameMaxLength: 120,
    txnName: "",        // name of the record the widget was opened from (e.g. the Deal)
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

  // Stable task key, e.g. "SMB-LOI-1.3.3". This is what identifies a record's
  // task; labels are not unique (e.g. "Lease Finalized" exists twice).
  function taskKey(task) {
    var parts = [CONFIG.naming.prefix];
    if (state.txn.mode === "name_prefix") parts.push(state.txn.parentId);
    parts.push(task.phaseKey, task.code);
    return parts.join("-");
  }

  // Record Name is just the name of the record the widget was opened from
  // (the Deal), shortened with "…" only if it exceeds the Name field length.
  // Without such a record (or in name_prefix mode) the task key is used.
  function dealName() {
    if (!state.txnName || state.txn.mode === "name_prefix") return "";
    var max = state.nameMaxLength;
    return state.txnName.length > max ? state.txnName.slice(0, max - 1).trim() + "…" : state.txnName;
  }
  function recordName(task) { return dealName() || taskKey(task); }

  // Names used before Task_Code existed: "SMB-LOI-1.3.3" or
  // "<Deal name> - SMB-LOI-1.3.3". Group 1 = task code.
  var LEGACY_NAME = /(?:^|\s-\s)SMB-(?:\d+-)?(?:LOI|UC|RE|CL)-(\d+(?:\.\d+)*)$/;

  function isDirty(task) {
    return VALUE_KEYS.some(function (k) { return (task.current[k] || "") !== (task.original[k] || ""); });
  }

  function changedKeys(task) {
    return VALUE_KEYS.filter(function (k) { return (task.current[k] || "") !== (task.original[k] || ""); });
  }

  function dirtyTasks() {
    return state.taskOrder.map(function (c) { return state.tasks[c]; })
      .filter(function (t) { return !t.childCodes.length && isDirty(t); });
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
    // Asked once on PageLoad and again after the first render, since CRM may
    // still be laying out the popup on the first call. Result is logged
    // (true/false) so a CRM-side size cap can be seen in the console.
    [0, 1500].forEach(function (delay) {
      setTimeout(function () {
        try {
          Promise.resolve(ZOHO.CRM.UI.Resize({ width: w, height: h }))
            .then(function (ok) { log("resize", w + "x" + h, "->", ok, "viewport now", window.innerWidth + "x" + window.innerHeight); },
                  function (e) { log("resize failed", e); });
        } catch (e) { log("resize failed", e); }
      }, delay);
    });
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
        // Opened from a Deal but its name could not be read: never fall back
        // to showing or saving other Deals' tasks.
        var pd = state.pageData || {};
        if (pd.Entity && pd.Entity !== state.moduleApi && first(pd.EntityId) && !state.txnName) {
          state.configErrors.push("Could not read the name of this " + pd.Entity + " record, so its tasks cannot be loaded.");
        }
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
      required.push(TF.phase, TF.subItem, TF.code);
      if (state.txn.mode === "lookup" && CONFIG.transactionLink.lookupField) required.push(CONFIG.transactionLink.lookupField);

      var missing = required.filter(function (api) { return !state.fieldsMeta[api]; });
      if (missing.length) state.configErrors.push("These fields were not found in module " + state.moduleApi + ": " + missing.join(", "));

      // Map each phase to the exact Phase_Items picklist value CRM permits.
      state.phaseValues = {};
      var phaseMeta = state.fieldsMeta[TF.phase];
      if (phaseMeta) {
        var allowed = (phaseMeta.pick_list_values || [])
          .map(function (v) { return v.actual_value != null ? v.actual_value : v.display_value; })
          .filter(function (v) { return v && v !== "-None-"; });
        PHASES.forEach(function (p) {
          var hit = allowed.filter(function (a) { return norm(a) === norm(p.label); })[0];
          if (hit) state.phaseValues[p.key] = hit;
          else state.configWarnings.push(TF.phase + " picklist has no value \"" + p.label + "\" – " + p.label + " tasks cannot be saved.");
        });
      }
      var nameMeta = state.fieldsMeta[F.name];
      state.nameMaxLength = (nameMeta && nameMeta.length) || 120;
      var subMeta = state.fieldsMeta[TF.subItem];
      state.subItemMaxLength = (subMeta && subMeta.length) || 255;

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
    var prev = (state.header && state.header.keys) || {};
    function localValue(key) { return prev[key] && !prev[key].meta ? prev[key].current || "" : ""; }
    var h = { entity: null, id: null, keys: {} };
    state.header = h;
    state.txnName = "";
    HEADER_KEYS.forEach(function (k) { h.keys[k[0]] = { meta: null, current: localValue(k[0]), reason: "Widget not opened from a record" }; });

    if (state.txn.parentId && state.txn.parentModule) {
      h.entity = state.txn.parentModule; h.id = state.txn.parentId;
    } else if (state.pageData && state.pageData.Entity && state.pageData.Entity !== state.moduleApi && first(state.pageData.EntityId)) {
      h.entity = state.pageData.Entity; h.id = String(first(state.pageData.EntityId));
    }
    if (!h.entity) return Promise.resolve();

    return Promise.all([CRM.getRecord(h.entity, h.id), CRM.getFields(h.entity)]).then(function (res) {
      var rec = res[0];
      state.txnName = String(recordDisplayName(rec) || "").trim();
      var byApi = {};
      res[1].forEach(function (f) { byApi[f.api_name] = f; });
      HEADER_KEYS.forEach(function (pair) {
        var key = pair[0];
        var cfg = CONFIG.header[key] || {};
        // Configured API name first (exact, then case-insensitive), then labels.
        var meta = cfg.field ? (byApi[cfg.field] ||
          res[1].filter(function (f) { return norm(f.api_name) === norm(cfg.field); })[0] || null) : null;
        var wanted = (cfg.labels || []).map(norm);
        for (var i = 0; i < wanted.length && !meta; i++) {
          meta = res[1].filter(function (f) { return norm(f.field_label) === wanted[i]; })[0] || null;
        }
        if (meta && cfg.field && meta.api_name !== cfg.field) log("header", key, "field", cfg.field, "not found; using", meta.api_name);
        if (!meta) {
          h.keys[key] = { meta: null, current: localValue(key), reason: "Field \"" + (cfg.field || cfg.labels[0]) + "\" not found in " + h.entity };
          state.configWarnings.push("Header \"" + key + "\": no field found in " + h.entity + (cfg.field ? " (" + cfg.field + ")" : " by label") + ".");
          return;
        }
        var kind = headerKind(meta);
        var raw = rec[meta.api_name];
        var val = toHeaderValue(raw, kind);
        h.keys[key] = { meta: meta, kind: kind, original: val, current: val, display: displayValue(raw),
                        lookupModule: kind === "lookup" ? lookupModuleOf(meta) : null,
                        lookupFilter: kind === "lookup" ? (cfg.lookupFilter || null) : null };
        log("header field", key, meta.api_name, meta.data_type, "->", kind);
      });
    }).catch(function (e) {
      state.configWarnings.push("Could not load header record: " + errMsg(e));
    });
  }

  // Input kind for a CRM field: text | date | picklist | number | boolean | lookup | readonly
  function headerKind(meta) {
    if (meta.read_only || meta.field_read_only) return "readonly";
    switch (meta.data_type) {
      case "text": case "textarea": case "email": case "phone": case "website": return "text";
      case "date": return "date";
      case "picklist": return "picklist";
      case "integer": case "bigint": case "double": case "currency": case "decimal": case "percent": return "number";
      case "boolean": return "boolean";
      case "lookup": return lookupModuleOf(meta) ? "lookup" : "readonly";
      default: return "readonly"; // ownerlookup, datetime, multiselect, autonumber, formula…
    }
  }

  function lookupModuleOf(meta) {
    var m = meta.lookup && meta.lookup.module;
    return m ? (m.api_name || (typeof m === "string" ? m : "")) : "";
  }

  // Display name of a record (Deal, Contact, Account, …). Only plain strings
  // count, so a Deal's Account_Name lookup object is never taken as its name.
  function recordDisplayName(r) {
    var names = [r.Deal_Name, r.Full_Name, r.Account_Name, r.Vendor_Name, r.Product_Name, r.Name,
      [r.First_Name, r.Last_Name].filter(Boolean).join(" ")];
    for (var i = 0; i < names.length; i++) if (typeof names[i] === "string" && names[i].trim()) return names[i].trim();
    return r.id;
  }

  // Lookup values are kept as the related record id; the name is shown in the input.
  function toHeaderValue(v, kind) {
    if (kind === "boolean") return v === true ? "true" : "false";
    if (v == null) return "";
    if (kind === "lookup") return v.id ? String(v.id) : "";
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
    if (f.kind === "lookup") return { id: f.current };
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

  // Map CRM records to task codes for the Deal the widget was opened from.
  // Every Deal has its OWN checklist: only records whose Name is this Deal's
  // name are used, so a Deal with no saved tasks opens empty and saves create
  // records under its own name.
  //   - current format: Name = Deal name, code in Task_Code
  //   - earlier format: Name = "<Deal name> - SMB-LOI-1.3.3" (renamed on edit)
  //   - first format "SMB-LOI-1.3.3" has no Deal, so it is only used when the
  //     widget is not opened from a Deal.
  // If one Deal has several records for a code, the most recently modified is
  // shown and updated. Returns { byCode, dupes, others }.
  function indexRecords(rows) {
    var deal = dealName();
    var byCode = {}, dupes = [], others = [];
    rows.forEach(function (r) {
      var name = String(r[F.name] || "").trim();
      var tc = r[TF.code] == null ? "" : String(r[TF.code]).trim();
      var m = LEGACY_NAME.exec(name);
      var code = "";
      if (tc && (!deal || name === deal)) {
        code = tc;
      } else if (m && m[0] !== name) {
        if (!deal || name.slice(0, name.length - m[0].length).trim() === deal) code = m[1];
      } else if (m && !deal) {
        code = m[1];
      }
      if (!code || !state.tasks[code]) { others.push(r); return; } // another Deal's record
      if (byCode[code]) {
        if (dupes.indexOf(code) === -1) dupes.push(code);
        if (String(r.Modified_Time || "") > String(byCode[code].Modified_Time || "")) byCode[code] = r;
      } else {
        byCode[code] = r;
      }
    });
    return { byCode: byCode, dupes: dupes, others: others };
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

  // What the CRM record holds for the task's place in the hierarchy.
  // Phase_Items / Sub_Items first; records saved before those fields existed
  // fall back to the legacy per-phase field. The task itself is still
  // identified by the record Name (phase key + code), never by these labels,
  // because several tasks share a label.
  function readTaskFields(t, rec) {
    var legacy = rec[CONFIG.legacyPhaseFields[t.phaseKey]];
    t.crm = {
      phase: rec[TF.phase] == null ? "" : String(rec[TF.phase]),
      subItem: rec[TF.subItem] == null ? "" : String(rec[TF.subItem]),
      legacySubItem: legacy == null ? "" : String(legacy),
      taskCode: rec[TF.code] == null ? "" : String(rec[TF.code])
    };
    if (t.crm.phase && t.crm.phase !== state.phaseValues[t.phaseKey]) {
      log("record", rec[F.name], "has", TF.phase, "=", t.crm.phase, "but its task belongs to", t.phaseLabel);
    }
  }

  // keepEdits: preserve unsaved current values on tasks that are still dirty.
  function applyRecords(rows, keepEdits) {
    var idx = indexRecords(rows);
    var known = {};
    state.duplicates = [];
    state.taskOrder.forEach(function (code) {
      var t = state.tasks[code];
      var rec = idx.byCode[t.code];
      if (rec) known[rec.id] = true;
      var stillDirty = keepEdits && isDirty(t);
      if (rec) {
        t.recordId = rec.id;
        t.original = recordToValues(rec);
        readTaskFields(t, rec);
        t.crmName = rec[F.name];
        if (!stillDirty) t.current = recordToValues(rec);
      } else {
        t.recordId = null;
        t.crm = null;
        t.crmName = null;
        t.original = emptyValues();
        if (!stillDirty) t.current = emptyValues();
      }
      if (idx.dupes.indexOf(t.code) !== -1) state.duplicates.push(code);
    });
    state.unrecognized = rows.filter(function (r) { return !known[r.id] && idx.others.indexOf(r) === -1; });

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

  // Presentation helpers ---------------------------------------------------
  function svg(body, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  }
  var PHASE_ICONS = {
    LOI: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>', 22),
    UC:  svg('<path d="M11 17l-1.5 1.5a2 2 0 0 1-2.8-2.8L10 12.4"/><path d="M3 11l4-4 3 1 3-2 5 5-4 4"/><path d="M21 11l-4-4"/><path d="M14 14l2 2M12 16l2 2"/>', 22),
    RE:  svg('<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16"/><path d="M14 10h5a1 1 0 0 1 1 1v10"/><path d="M3 21h18"/><path d="M7.5 8h3M7.5 12h3M7.5 16h3M16.5 14h1M16.5 17.5h1"/>', 22),
    CL:  svg('<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3"/><path d="M17 6l2 2M15 8l2 2"/>', 22)
  };
  var KEBAB = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
  var CAL_ICON = svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v4M16 3v4"/>', 15);
  var AVATAR_COLORS = {
    "Buyer": "#8b7ff0", "Seller": "#ef7f9c", "Buyer / Seller": "#f29e4c", "SMB": "#2bb3a3",
    "Buyer Attorney": "#6f86f2", "Seller Attorney": "#5a8ff0", "Title Company": "#4aa3df"
  };
  function avatarHtml(owner) {
    if (!owner) return '<span class="avatar"></span>';
    return '<span class="avatar" style="background:' + (AVATAR_COLORS[owner] || "#94a3b8") + '">' + esc(owner.charAt(0).toUpperCase()) + "</span>";
  }
  function statusClass(v) {
    if (!v) return "";
    if (v === CONFIG.options.completeStatus) return "status-complete";
    if (v === "In Progress") return "status-progress";
    return "status-none";
  }

  function renderSheet() {
    var html = [];
    PHASES.forEach(function (phase) {
      var open = !!state.expanded["P:" + phase.key];
      var codes = state.taskOrder.filter(function (c) { return state.tasks[c].phaseKey === phase.key; });
      var saved = 0, complete = 0, risk = 0, leaves = 0;
      codes.forEach(function (c) {
        var t = state.tasks[c];
        if (!isLeaf(t)) return; // parent items are headings, not tasks
        leaves++;
        if (t.recordId) saved++;
        if (t.original.status === CONFIG.options.completeStatus) complete++;
        if (t.original.atRisk === "Yes") risk++;
      });
      var pct = leaves ? Math.round(complete / leaves * 100) : 0;
      html.push(
        '<tr class="row-phase ' + phase.color + '" data-phase="' + phase.key + '">' +
          '<td class="cell-code">' + esc(phase.code) + '</td>' +
          '<td colspan="6"><div class="cell-item">' +
            '<button type="button" class="toggle" data-toggle="P:' + phase.key + '" aria-expanded="' + open + '" aria-label="Toggle ' + esc(phase.label) + '">' + CHEVRON + '</button>' +
            '<span class="phase-icon">' + (PHASE_ICONS[phase.key] || "") + '</span>' +
            '<span>' + esc(phase.label) + '</span>' +
            '<span class="phase-meta">' + saved + ' of ' + leaves + ' tracked · ' + complete + ' complete' + (risk ? ' · <span class="err-text">' + risk + ' at risk</span>' : '') + '</span>' +
          '</div></td>' +
          '<td><div class="phase-progress"><div class="bar"><span style="width:' + pct + '%"></span></div><span class="pct">' + pct + '%</span></div></td>' +
          '<td class="cell-actions"><button type="button" class="menu-btn" data-menu="P:' + phase.key + '" aria-label="Phase actions">' + KEBAB + '</button></td>' +
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

  // Items that have subitems are headings: only their subitems hold data.
  function isLeaf(t) { return !t.childCodes.length; }

  function parentRowHtml(t) {
    var open = !!state.expanded[t.code];
    return '<tr class="row-task row-parent depth-' + t.depth + '" data-code="' + esc(t.code) + '" title="' + esc(t.phaseLabel + " › " + t.label) + '">' +
      '<td class="cell-code">' + esc(t.code) + '</td>' +
      '<td colspan="8"><div class="cell-item">' +
        '<button type="button" class="toggle" data-toggle="' + esc(t.code) + '" aria-expanded="' + open + '" aria-label="Toggle ' + esc(t.label) + '">' + CHEVRON + '</button>' +
        '<span class="item-label">' + esc(t.label) + '</span></div></td>' +
    '</tr>';
  }

  function taskRowHtml(t) {
    if (!isLeaf(t)) return parentRowHtml(t);
    var v = t.current;
    var open = !!state.expanded[t.code];
    var toggle = t.childCodes.length
      ? '<button type="button" class="toggle" data-toggle="' + esc(t.code) + '" aria-expanded="' + open + '" aria-label="Toggle ' + esc(t.label) + '">' + CHEVRON + '</button>'
      : '<span class="toggle-spacer"></span>';
    var ownerPh = "Select…";
    var statusCls = " " + statusClass(v.status);

    return '<tr class="' + rowClass(t) + '" data-code="' + esc(t.code) + '" title="' + esc(t.phaseLabel + " › " + t.label) + '">' +
      '<td class="cell-code">' + esc(t.code) + '</td>' +
      '<td><div class="cell-item">' + toggle +
        '<span class="item-label">' + esc(t.label) + '</span><span class="dot-slot">' + dotHtml(t) + '</span></div>' +
        '<div class="row-msg"' + (t.error ? "" : " hidden") + '>' + esc(t.error || "") + '</div></td>' +
      '<td><div class="owner-wrap">' + avatarHtml(v.owner) +
        '<select data-key="owner" aria-label="Owner" class="' + (v.owner ? "" : "placeholder") + inv(t, "owner") + '">' + optionsHtml(CONFIG.options.owner, v.owner, ownerPh) + '</select></div></td>' +
      '<td><select data-key="status" aria-label="Status" class="' + (v.status ? "" : "placeholder") + statusCls + inv(t, "status") + '">' + optionsHtml(CONFIG.options.status, v.status, "Select…") + '</select></td>' +
      '<td><div class="date-wrap">' + CAL_ICON + '<input type="date" data-key="dueDate" aria-label="Due date" value="' + esc(v.dueDate) + '" class="' + inv(t, "dueDate") + '"></div></td>' +
      '<td><div class="date-wrap">' + CAL_ICON + '<input type="date" data-key="completeDate" aria-label="Completed date" value="' + esc(v.completeDate) + '" class="' + inv(t, "completeDate") + '"></div></td>' +
      '<td><select data-key="atRisk" aria-label="At risk" class="' + (v.atRisk ? "" : "placeholder") + (v.atRisk === "Yes" ? " risk-yes" : "") + inv(t, "atRisk") + '">' + optionsHtml(CONFIG.options.atRisk, v.atRisk, "—") + '</select></td>' +
      '<td><textarea data-key="taskDetails" aria-label="Task details" rows="1" maxlength="' + CONFIG.validation.taskDetailsMaxLength + '" class="' + inv(t, "taskDetails") + '">' + esc(v.taskDetails) + '</textarea></td>' +
      '<td class="cell-actions"><button type="button" class="menu-btn" data-menu="' + esc(t.code) + '" aria-label="Task actions">' + KEBAB + '</button></td>' +
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
    ["status-complete", "status-progress", "status-none"].forEach(function (c) { st.classList.remove(c); });
    var sc = statusClass(st.value);
    if (sc) st.classList.add(sc);
    tr.querySelector('[data-key="atRisk"]').classList.toggle("risk-yes", t.current.atRisk === "Yes");
    var av = tr.querySelector(".owner-wrap .avatar");
    if (av) av.outerHTML = avatarHtml(t.current.owner);
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
        // No CRM field: still typeable, but the value stays in the widget only (never saved).
        html = '<input type="text"' + attrs + ' value="' + esc(f.current || "") + '" title="' + esc((f.reason || "") + " – not saved to CRM") + '">';
      } else if (f.kind === "readonly") {
        var why = (f.meta.read_only || f.meta.field_read_only) ? "read-only for your profile" : "field type \"" + f.meta.data_type + "\" can't be edited here";
        html = '<span class="hdr-readonly">' + esc(f.display) + '</span><span class="hdr-note">' + esc(f.meta.api_name + ": " + why) + "</span>";
      } else if (f.kind === "lookup") {
        // Type to search the related module, then pick a record from the list.
        html = '<div class="lk"><input type="text" autocomplete="off"' + attrs.replace('class="hdr-input"', 'class="hdr-input lk-input"') +
          ' value="' + esc(f.display) + '" placeholder="" aria-autocomplete="list">' +
          '<div class="lk-menu" hidden></div></div>';
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
    if (!f) return;
    if (!f.meta) { f.current = e.target.value; return; } // widget-only value, nothing to save
    if (f.kind === "lookup") { if (e.type === "input") lookupSearch(e.target, f); return; }
    f.current = e.target.type === "checkbox" ? String(e.target.checked) : e.target.value;
    e.target.closest(".txn-value").classList.toggle("is-dirty", f.current !== f.original);
    updateToolbar();
  }

  /* ---------- Lookup picker (header) ---------- */
  var lookupTimer = null;
  var lookupSeq = 0;

  // Resolves a lookup filter ({ fieldLabel, value }) to the field's API name
  // in the lookup module. Cached per module + label.
  var lookupFilterCache = {};
  function resolveLookupFilter(f) {
    var lf = f.lookupFilter;
    if (!lf) return Promise.resolve(null);
    var key = f.lookupModule + "|" + lf.fieldLabel;
    if (!lookupFilterCache[key]) {
      // Only the field's API name is cached; each box applies its own value.
      lookupFilterCache[key] = CRM.getFields(f.lookupModule).then(function (fields) {
        var hit = fields.filter(function (x) { return norm(x.field_label) === norm(lf.fieldLabel) || norm(x.api_name) === norm(lf.fieldLabel); })[0];
        if (!hit) log("lookup filter field", lf.fieldLabel, "not found in", f.lookupModule, "- results are not filtered");
        return hit ? hit.api_name : null;
      }, function (e) { log("lookup filter fields failed", e); return null; });
    }
    return lookupFilterCache[key].then(function (api) { return api ? { api: api, value: lf.value } : null; });
  }

  // True when the record's filter field holds the wanted value (picklist,
  // multi-select array or text).
  function passesLookupFilter(rec, flt) {
    if (!flt) return true;
    var v = rec[flt.api];
    var list = Array.isArray(v) ? v : (v == null ? [] : String(v).split(";"));
    return list.some(function (x) { return norm(x && typeof x === "object" ? (x.name || x.display_value) : x) === norm(flt.value); });
  }

  function lookupSearch(input, f) {
    var menu = input.parentNode.querySelector(".lk-menu");
    var text = input.value.trim();
    clearTimeout(lookupTimer);
    if (!text) { // cleared: the field will be emptied on save
      setLookup(input, f, "", "");
      menu.hidden = true;
      return;
    }
    if (text.length < 2) { menu.hidden = true; return; }
    lookupTimer = setTimeout(function () {
      var seq = ++lookupSeq;
      menu.hidden = false;
      menu.innerHTML = '<div class="lk-empty">Searching…</div>';
      var flt = null;
      resolveLookupFilter(f)
        .then(function (resolved) {
          flt = resolved;
          // Fetch more than shown, since the filter is applied to the results.
          return ZOHO.CRM.API.searchRecord({ Entity: f.lookupModule, Type: "word", Query: text, page: 1, per_page: flt ? 100 : 10 });
        })
        .then(function (r) {
          if (seq !== lookupSeq) return;
          var rows = ((r && Array.isArray(r.data)) ? r.data : [])
            .filter(function (rec) { return passesLookupFilter(rec, flt); })
            .slice(0, 10);
          menu.innerHTML = rows.length
            ? rows.map(function (rec) {
                return '<div class="lk-item" data-id="' + esc(rec.id) + '">' + esc(recordDisplayName(rec)) + "</div>";
              }).join("")
            : '<div class="lk-empty">No results found</div>';
        }, function (e) {
          if (seq === lookupSeq) menu.innerHTML = '<div class="lk-empty">Search failed: ' + esc(errMsg(e)) + "</div>";
        });
    }, 300);
  }

  function setLookup(input, f, id, name) {
    f.current = id;
    f.display = name;
    input.value = name;
    input.closest(".txn-value").classList.toggle("is-dirty", f.current !== f.original);
    updateToolbar();
  }

  function bindLookupPicker(container) {
    // mousedown fires before the input's blur, so the pick is not lost.
    container.addEventListener("mousedown", function (e) {
      var item = e.target.closest(".lk-item");
      if (!item) return;
      e.preventDefault();
      var input = item.closest(".lk").querySelector(".lk-input");
      var f = state.header.keys[input.getAttribute("data-hkey")];
      setLookup(input, f, item.getAttribute("data-id"), item.textContent);
      item.parentNode.hidden = true;
    });
    // Leaving the box without picking restores the selected record's name.
    container.addEventListener("focusout", function (e) {
      if (!e.target.classList.contains("lk-input")) return;
      var input = e.target;
      var f = state.header.keys[input.getAttribute("data-hkey")];
      setTimeout(function () {
        input.parentNode.querySelector(".lk-menu").hidden = true;
        if (input.value.trim() && input.value !== f.display) input.value = f.display;
      }, 150);
    });
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
    fieldList.push(TF.phase, TF.subItem, TF.code);
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
      var menuBtn = e.target.closest(".menu-btn");
      if (menuBtn) { e.stopPropagation(); openRowMenu(menuBtn); return; }
      var btn = e.target.closest("[data-toggle]");
      var phaseRow = e.target.closest(".row-phase");
      var parentRow = e.target.closest(".row-parent");
      var key = btn ? btn.getAttribute("data-toggle")
        : phaseRow ? "P:" + phaseRow.getAttribute("data-phase")
        : parentRow ? parentRow.getAttribute("data-code") : null;
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
    $("btnClose").onclick = closeWidget;

    // Row actions menu
    $("rowMenu").addEventListener("click", function (e) {
      var item = e.target.closest("button[data-act]");
      if (!item || item.disabled) return;
      runRowAction(item.getAttribute("data-act"), $("rowMenu").getAttribute("data-for"));
      closeRowMenu();
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest("#rowMenu") && !e.target.closest(".menu-btn")) closeRowMenu();
    });
    $("sheetWrap").addEventListener("scroll", closeRowMenu);
    window.addEventListener("resize", closeRowMenu);

    var hdr = document.querySelector(".txn-header");
    hdr.addEventListener("input", onHeaderEdit);
    hdr.addEventListener("change", onHeaderEdit);
    bindLookupPicker(hdr);

    window.addEventListener("beforeunload", function (e) {
      if (totalDirty() && !state.closing) { e.preventDefault(); e.returnValue = ""; }
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

  /* ---------- Row actions menu (⋮) ---------- */
  function openRowMenu(btn) {
    var key = btn.getAttribute("data-menu");
    var menu = $("rowMenu");
    var items;
    if (key.indexOf("P:") === 0) {
      items = [["expandPhase", "Expand all items", true], ["collapsePhase", "Collapse phase", true]];
    } else {
      var t = state.tasks[key];
      items = [
        ["undo", "Undo unsaved changes", isDirty(t)],
        ["complete", "Mark as " + CONFIG.options.completeStatus, t.current.status !== CONFIG.options.completeStatus]
      ];
    }
    menu.innerHTML = items.map(function (i) {
      return '<button type="button" role="menuitem" data-act="' + i[0] + '"' + (i[2] ? "" : " disabled") + ">" + esc(i[1]) + "</button>";
    }).join("");
    menu.setAttribute("data-for", key);
    menu.hidden = false;
    var r = btn.getBoundingClientRect();
    var left = Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8);
    var top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 4;
    menu.style.left = Math.max(8, left) + "px";
    menu.style.top = Math.max(8, top) + "px";
  }

  function closeRowMenu() { $("rowMenu").hidden = true; }

  function runRowAction(act, key) {
    if (act === "expandPhase" || act === "collapsePhase") {
      var pk = key.slice(2);
      var open = act === "expandPhase";
      state.expanded[key] = open;
      state.taskOrder.forEach(function (c) {
        var t = state.tasks[c];
        if (t.phaseKey === pk && t.childCodes.length) state.expanded[c] = open;
      });
      renderSheet();
      return;
    }
    var t = state.tasks[key];
    if (!t) return;
    if (act === "undo") {
      t.current = JSON.parse(JSON.stringify(t.original));
      t.error = null;
      t.invalidKeys = {};
      refreshRow(t);
      updateToolbar();
    } else if (act === "complete") {
      // Goes through the normal edit path, so the completed-date prompt still applies.
      var sel = document.querySelector('tr[data-code="' + CSS.escape(t.code) + '"] [data-key="status"]');
      if (!sel) return;
      sel.value = CONFIG.options.completeStatus;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Close the CRM popup (asks first when there are unsaved changes).
  function closeWidget() {
    var n = totalDirty();
    var go = n ? confirmDialog("Close without saving " + n + " unsaved change(s)?") : Promise.resolve(true);
    go.then(function (yes) {
      if (!yes) return;
      try {
        if (ZOHO.CRM.UI.Popup && ZOHO.CRM.UI.Popup.close) {
          state.closing = true; // skip the browser's leave-page prompt
          ZOHO.CRM.UI.Popup.close();
        }
      } catch (e) { log("close failed", e); }
    });
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
    // Phase_Items must be an exact permitted picklist value; Sub_Items is never truncated.
    if (!state.phaseValues[t.phaseKey]) {
      errs.push(TF.phase + " picklist has no value \"" + t.phaseLabel + "\" – add it in CRM");
    }
    if (t.label.length > state.subItemMaxLength) {
      errs.push("Task name is longer than " + TF.subItem + " allows (" + state.subItemMaxLength + " characters)");
    }
    return errs;
  }

  // Phase_Items / Sub_Items the record should hold for this task.
  function taskFieldValues(t) {
    var out = {};
    out[TF.phase] = state.phaseValues[t.phaseKey];
    out[TF.subItem] = t.label; // deepest selected task / subitem name
    out[TF.code] = t.code;     // identifies the record's task
    return out;
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
    var tf = taskFieldValues(t); // Phase_Items + Sub_Items (legacy phase fields are not written)
    Object.keys(tf).forEach(function (k) { p[k] = tf[k]; });
    VALUE_KEYS.forEach(function (k) { if (t.current[k]) p[F[k]] = t.current[k]; });
    if (state.txn.mode === "lookup") p[CONFIG.transactionLink.lookupField] = { id: state.txn.parentId };
    var pl = picklistPayload(t);
    Object.keys(pl).forEach(function (k) { p[k] = pl[k]; });
    return p;
  }

  // Only changed fields are sent, so concurrent edits to other fields are not
  // overwritten. Phase_Items / Sub_Items are added only when the record does
  // not already hold the right values (e.g. records saved before they existed);
  // legacy phase fields are left as they are.
  function updatePayload(t) {
    var p = { id: t.recordId };
    changedKeys(t).forEach(function (k) { p[F[k]] = crmValue(k, t.current[k]); });
    // Records still carrying the old "<Deal> - SMB-LOI-1.2" Name get the plain Deal name.
    if (t.crmName && LEGACY_NAME.test(t.crmName)) p[F.name] = recordName(t);
    var tf = taskFieldValues(t);
    var crm = t.crm || {};
    if (crm.phase !== tf[TF.phase]) p[TF.phase] = tf[TF.phase];
    if (crm.subItem !== tf[TF.subItem]) p[TF.subItem] = tf[TF.subItem];
    if (crm.taskCode !== tf[TF.code]) p[TF.code] = tf[TF.code];
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
            var rec = !t.recordId && idx.byCode[t.code];
            if (rec) { t.recordId = rec.id; t.original = recordToValues(rec); readTaskFields(t, rec); t.crmName = rec[F.name]; }
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
              t.crmName = recordName(t);
              var tf = taskFieldValues(t);
              t.crm = { phase: tf[TF.phase], subItem: tf[TF.subItem], taskCode: tf[TF.code], legacySubItem: (t.crm || {}).legacySubItem || "" };
            } else if (/Phase_Items/.test(r.message || "")) {
              r.message = "CRM rejected " + TF.phase + " \"" + taskFieldValues(t)[TF.phase] + "\": " + r.message;
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
    // Successful saves show no banner: rows simply lose their unsaved marker.
    log("saved", { tasks: okN, header: !!hdrOk });
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
    s.src = "../dev/mock-zoho-sdk.js?t=" + Date.now();
    s.onload = start;
    s.onerror = function () { start(); };
    document.body.appendChild(s);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
