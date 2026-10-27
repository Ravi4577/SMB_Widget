/*
 * LOCAL PREVIEW ONLY – not part of the deployed widget.
 *
 * In-memory stand-in for the Zoho CRM Embedded App SDK so the UI can be
 * exercised outside CRM:  app/index.html?mock=1
 *
 * Mock CRM data is kept in sessionStorage so the "Refresh" scenario can be
 * tested; this is the fake CRM's storage, not the widget's.
 *
 * URL options:
 *   &fail=1        every insert/update fails (Scenario 11)
 *   &fail=0.5      50% of writes fail
 *   &reset=1       clear mock CRM data
 *   &entity=Deals&id=111   simulate opening from a parent record
 */
(function () {
  "use strict";
  var qs = new URLSearchParams(location.search);
  var KEY = "smb-mock-crm";
  var MODULE = "SMB_Transaction_Tracker";
  if (qs.get("reset") === "1") sessionStorage.removeItem(KEY);
  var failRate = Number(qs.get("fail") || 0);

  function load() { try { return JSON.parse(sessionStorage.getItem(KEY)) || { seq: 1000, records: [] }; } catch (e) { return { seq: 1000, records: [] }; } }
  function save(db) { sessionStorage.setItem(KEY, JSON.stringify(db)); }
  function delay(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 250); }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function now() { return new Date().toISOString(); }

  var FIELDS = [
    ["Name", "text"], ["Letter_of_Intent", "text"], ["Under_Contract", "text"], ["Real_Estate", "text"],
    ["Closing", "text"], ["Owner1", "text"], ["Status", "text"], ["At_Risk", "text"], ["Due_Date", "date"],
    ["Complete_Date", "date"], ["Task_Details", "textarea"], ["LOI_Executed_Date", "text"],
    ["Introduction_to_Client_s_CPA", "text"], ["Introduce_Client_to_M_A_Attorney", "text"], ["Data_Room_Access_Updated", "text"],
    ["Phase_Items", "picklist", ["-None-", "Letter of Intent", "Under Contract", "Real Estate", "Closing"]],
    ["Sub_Items", "text"],
    ["Task_Code", "text"],
    ["Escrow_Account", "picklist", ["-None-", "Escrow Account"]],
    ["Escrow_Account_Sub_Item", "picklist", ["-None-", "Escrow Initiated / Contact Information Shared", "Escrow Instructions Shared / Signed / Fee Paid", "Earnest Money Deposit (Initial)", "Earnest Money Deposit (Subsequent)"]],
    ["Letter_of_intent_Subitem", "picklist", ["-None-", "LOI Executed Date", "Introduction to Client's CPA", "Escrow Account", "Introduce Client to M&A Attorney", "Data Room Access Updated"]],
    ["Under_Contract_Sub_Item", "picklist", ["-None-", "Due Diligence", "Financing Application"]]
  ].map(function (f) {
    var m = { api_name: f[0], data_type: f[1] };
    if (f[1] === "text") m.length = 255;
    if (f[2]) m.pick_list_values = f[2].map(function (v) { return { display_value: v, actual_value: v }; });
    return m;
  });

  // Parent Deal: Seller + Buyer (Contacts lookups), Closing Date (date), Location (text)
  var DEAL_FIELDS = [
    { api_name: "Seller", field_label: "Seller", data_type: "lookup", lookup: { module: { api_name: "Contacts" } } },
    { api_name: "Buyer", field_label: "Buyer", data_type: "lookup", lookup: { module: { api_name: "Contacts" } } },
    { api_name: "Closing_Date", field_label: "Closing Date", data_type: "date" },
    { api_name: "Location", field_label: "Location", data_type: "text", length: 255 }
  ];

  if (qs.get("noloc") === "1") DEAL_FIELDS = DEAL_FIELDS.filter(function (f) { return f.api_name !== "Location"; });

  var CONTACTS = [
    { id: "c1", Full_Name: "James McCarthy" }, { id: "c2", Full_Name: "Sarah Cherry" },
    { id: "c3", Full_Name: "Sarah Connor" }, { id: "c4", Full_Name: "David Lee" }
  ];

  function write(isNew, cfg) {
    var data = cfg.APIData;
    if (cfg.Entity === "Deals") {
      if (Math.random() < failRate) return delay({ data: [{ code: "INTERNAL_ERROR", status: "error", message: "Mock API failure", details: {} }] });
      var d = load();
      d.deals = d.deals || {}; d.deals[data.id] = d.deals[data.id] || {};
      Object.keys(data).forEach(function (k) { if (k !== "id") d.deals[data.id][k] = data[k]; });
      save(d);
      return delay({ data: [{ code: "SUCCESS", status: "success", message: "record updated", details: { id: data.id } }] });
    }
    if (Math.random() < failRate) return delay({ data: [{ code: "INTERNAL_ERROR", status: "error", message: "Mock API failure", details: {} }] });
    var db = load();
    if (isNew) {
      var rec = clone(data);
      rec.id = String(++db.seq) + "000000";
      rec.Modified_Time = now();
      db.records.push(rec);
      save(db);
      return delay({ data: [{ code: "SUCCESS", status: "success", message: "record added", details: { id: rec.id } }] });
    }
    var r = db.records.filter(function (x) { return x.id === data.id; })[0];
    if (!r) return delay({ data: [{ code: "INVALID_DATA", status: "error", message: "the id given seems to be invalid", details: { api_name: "id" } }] });
    Object.keys(data).forEach(function (k) { r[k] = data[k]; });
    r.Modified_Time = now();
    save(db);
    return delay({ data: [{ code: "SUCCESS", status: "success", message: "record updated", details: { id: r.id } }] });
  }

  function page(rows, cfg) {
    var per = cfg.per_page || 200, p = cfg.page || 1;
    var slice = rows.slice((p - 1) * per, p * per);
    if (!slice.length) return delay({}); // CRM returns 204 / empty body for no data
    return delay({ data: clone(slice), info: { more_records: p * per < rows.length, page: p, per_page: per } });
  }

  var handlers = {};
  window.ZOHO = {
    embeddedApp: {
      on: function (evt, fn) { handlers[evt] = fn; },
      init: function () {
        var pd = { Entity: qs.get("entity") || MODULE };
        if (qs.get("id")) pd.EntityId = [qs.get("id")];
        setTimeout(function () { handlers.PageLoad && handlers.PageLoad(pd); }, 150);
        return Promise.resolve();
      }
    },
    CRM: {
      UI: {
        Resize: function (size) { window.__lastResize = size; console.info("[mock] Resize", size); return Promise.resolve(true); }
      },
      META: {
        getModules: function () { return delay({ modules: [{ api_name: MODULE, plural_label: "SMB Transaction Tracker", singular_label: "SMB Transaction Tracker", module_name: "SMB_Transaction_Tracker" }, { api_name: "Deals", plural_label: "Deals", singular_label: "Deal" }] }); },
        getFields: function (cfg) {
          if (cfg && cfg.Entity === "Deals") return delay({ fields: clone(DEAL_FIELDS) });
          return delay({ fields: clone(FIELDS) });
        }
      },
      API: {
        getAllRecords: function (cfg) { return page(load().records, cfg); },
        searchRecord: function (cfg) {
          if (cfg.Type === "word") {
            var q = String(cfg.Query || "").toLowerCase();
            return delay({ data: CONTACTS.filter(function (c) { return c.Full_Name.toLowerCase().indexOf(q) !== -1; }), info: { more_records: false } });
          }
          var m = /^\((\w+):(equals|starts_with):(.*)\)$/.exec(cfg.Query || "");
          var rows = load().records.filter(function (r) {
            if (!m) return false;
            var v = r[m[1]]; if (v && typeof v === "object") v = v.id;
            v = String(v || "");
            return m[2] === "equals" ? v === m[3] : v.indexOf(m[3]) === 0;
          });
          return page(rows, cfg);
        },
        getRecord: function (cfg) {
          if (cfg.Entity === "Deals") {
            var db = load();
            db.deals = db.deals || {};
            db.deals[cfg.RecordID] = db.deals[cfg.RecordID] || { Deal_Name: cfg.RecordID === "7344" ? "ACRA MEDICAL AESTHETICS, LLC" : "Deal " + cfg.RecordID, Seller: { id: "c1", name: "James McCarthy" }, Buyer: { id: "c2", name: "Sarah Cherry" }, Closing_Date: "2026-12-15", Location: null };
            save(db);
            return delay({ data: [Object.assign({ id: cfg.RecordID }, clone(db.deals[cfg.RecordID]))] });
          }
          var r = load().records.filter(function (x) { return x.id === String(cfg.RecordID); })[0];
          return delay(r ? { data: [clone(r)] } : {});
        },
        insertRecord: function (cfg) { return write(true, cfg); },
        updateRecord: function (cfg) { return write(false, cfg); }
      }
    }
  };
  // &link=name_prefix|lookup  – try the linking modes without editing config.js
  if (qs.get("link") && window.SMB_CONFIG) {
    window.SMB_CONFIG.transactionLink = { mode: qs.get("link"), parentModule: "Deals", lookupField: "Deal" };
    FIELDS.push({ api_name: "Deal", data_type: "lookup" });
  }
  console.info("[mock] Zoho SDK mock active", { failRate: failRate });
})();
