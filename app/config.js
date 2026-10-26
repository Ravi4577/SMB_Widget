/*
 * SMB Transaction Tracker – widget configuration.
 *
 * Everything that depends on the CRM org (module API name, field API names,
 * transaction linking, header mapping) lives here so it can be verified and
 * changed without touching the widget logic in script.js.
 *
 * Items marked "VERIFY" must be checked in Setup > Developer Hub > APIs & SDKs
 * > API Names before production use. See CONFIG-CHECKLIST.md.
 */
(function (global) {
  "use strict";

  var CONFIG = {
    /* ------------------------------------------------------------------
     * Module
     * ------------------------------------------------------------------ */
    module: {
      // VERIFY: exact module API name. Leave empty to auto-detect by label
      // (the detected name is shown in the "Configuration" panel). Once
      // verified, hardcode it here, e.g. "SMB_Transaction_Tracker".
      apiName: "",
      // Labels used for auto-detection when apiName is empty.
      labels: ["SMB Transaction Tracker", "SMB Transaction Trackers"]
    },

    /* ------------------------------------------------------------------
     * Field API names (taken from the API Names screen – do not rename)
     * ------------------------------------------------------------------ */
    fields: {
      name: "Name",
      owner: "Owner1", // custom task-owner text field (NOT the record owner lookup "Owner")
      status: "Status",
      atRisk: "At_Risk",
      dueDate: "Due_Date",
      completeDate: "Complete_Date",
      taskDetails: "Task_Details"
    },

    // Phase -> Single Line field that receives the deepest selected task name.
    phaseFields: {
      LOI: "Letter_of_Intent",
      UC: "Under_Contract",
      RE: "Real_Estate",
      CL: "Closing"
    },

    /* ------------------------------------------------------------------
     * Existing picklists.
     *
     * Picklist values are only sent on record CREATE, and only when the
     * candidate value exactly matches (case/space-insensitive) one of the
     * permitted values returned by ZOHO.CRM.META.getFields. Non-matching
     * values are skipped and reported in the Configuration panel, so an
     * invalid value is never sent to CRM.
     *
     * Each rule: { field, appliesTo(task) -> bool, candidates(task) -> [values] }
     * ------------------------------------------------------------------ */
    picklists: {
      enabled: true,
      rules: [
        {
          field: "Phase_Item",
          appliesTo: function () { return true; },
          candidates: function (t) { return [t.label, t.rootItemLabel, t.phaseLabel]; }
        },
        {
          field: "Letter_of_intent_Subitem",
          appliesTo: function (t) { return t.phaseKey === "LOI"; },
          candidates: function (t) { return [t.label]; }
        },
        {
          field: "Escrow_Account",
          appliesTo: function (t) { return t.code.indexOf("1.3") === 0; },
          candidates: function (t) { return [t.label, t.rootItemLabel]; }
        },
        {
          field: "Escrow_Account_Sub_Item",
          appliesTo: function (t) { return t.code.indexOf("1.3.") === 0; },
          candidates: function (t) { return [t.label]; }
        },
        {
          field: "Under_Contract_Sub_Item",
          appliesTo: function (t) { return t.phaseKey === "UC"; },
          candidates: function (t) { return [t.label]; }
        }
      ]
    },

    /* ------------------------------------------------------------------
     * Transaction linking  (VERIFY – configuration dependency)
     *
     * The module has no transaction lookup/identifier field today, so the
     * widget cannot know on its own which records belong to which deal.
     *
     * mode:
     *   "none"        – sandbox / single-transaction mode. Every record in the
     *                   module is treated as ONE transaction and a warning
     *                   banner is shown. Not for production with >1 deal.
     *   "lookup"      – records carry a lookup field (lookupField) pointing to
     *                   a parent record in parentModule (e.g. a Deal). The
     *                   widget must be opened from that parent record (detail
     *                   page button / related list). The lookup field must
     *                   already exist in the module.
     *   "name_prefix" – no new field: the parent record ID is embedded in the
     *                   record Name ("SMB-<parentId>-LOI-1.3.3") and records
     *                   are searched with Name starts_with. Must be opened
     *                   from the parent record.
     * ------------------------------------------------------------------ */
    transactionLink: {
      mode: "none",
      parentModule: "", // VERIFY, e.g. "Deals"
      lookupField: ""   // VERIFY, only for mode "lookup"
    },

    /* ------------------------------------------------------------------
     * Transaction header. Values are read from the parent record (the
     * record the widget was opened from). Leave a field empty when no CRM
     * field has been confirmed – it is then shown as "Not mapped".
     * ------------------------------------------------------------------ */
    header: {
      sellerName: "",  // VERIFY: parent-record field API name
      buyerName: "",   // VERIFY
      closingDate: "", // VERIFY
      location: ""     // VERIFY
    },

    /* ------------------------------------------------------------------
     * Record naming. {TXN} is only used in "name_prefix" mode.
     * ------------------------------------------------------------------ */
    naming: {
      prefix: "SMB",
      // Resulting Name examples: "SMB-LOI-1.3.3"  /  "SMB-4876876000001234-LOI-1.3.3"
    },

    /* ------------------------------------------------------------------
     * Validation
     * ------------------------------------------------------------------ */
    validation: {
      requiredFields: ["owner", "status"], // keys of `fields`
      taskDetailsMaxLength: 2000            // Multi Line (Small)
    },

    /* ------------------------------------------------------------------
     * Dropdown options
     * ------------------------------------------------------------------ */
    options: {
      owner: ["Buyer", "Seller", "Buyer / Seller", "SMB", "Buyer Attorney", "Seller Attorney", "Title Company"],
      status: ["Not Started", "In Progress", "Complete"],
      atRisk: ["Yes", "No"],
      completeStatus: "Complete"
    },

    api: {
      batchSize: 100, // Zoho CRM insert/update limit per call
      pageSize: 200,
      triggers: ["workflow"] // workflow rules fire on create/update; set [] to disable
    },

    debug: {
      // Sandbox testing aid (Scenario 11): when > 0, that fraction of records
      // in each save is failed on purpose BEFORE reaching CRM. Keep 0 in production.
      simulateFailureRate: 0,
      log: true
    }
  };

  /* ====================================================================
   * Task hierarchy:  Phase -> Item -> Subitem (-> nested subitem)
   * `owner` / `hint` come from the reference sheet and are only shown as
   * suggestions; they are never saved unless the user selects/enters them.
   * ==================================================================== */
  var PHASES = [
    {
      key: "LOI", code: "1.0", label: "Letter of Intent", color: "loi",
      items: [
        { code: "1.1", label: "LOI Executed Date", owner: "Seller" },
        { code: "1.2", label: "Introduction to Client's CPA" },
        {
          code: "1.3", label: "Escrow Account",
          children: [
            { code: "1.3.1", label: "Escrow Initiated / Contact Information Shared", hint: "Arizona Escrow if no real estate; if real estate involved, use Stewart Title" },
            { code: "1.3.2", label: "Escrow Instructions Shared / Signed / Fee Paid" },
            { code: "1.3.3", label: "Earnest Money Deposit (Initial)" },
            { code: "1.3.4", label: "Earnest Money Deposit (Subsequent)" }
          ]
        },
        { code: "1.4", label: "Introduce Client to M&A Attorney", owner: "SMB" },
        { code: "1.5", label: "Data Room Access Updated", hint: "Access to Attorney, etc." }
      ]
    },
    {
      key: "UC", code: "2.0", label: "Under Contract", color: "uc",
      items: [
        {
          code: "2.1", label: "Due Diligence",
          children: [
            { code: "2.1.1", label: "Due Diligence Begins" },
            { code: "2.1.2", label: "Due Diligence List Provided" },
            { code: "2.1.3", label: "Due Diligence Ends" },
            { code: "2.1.4", label: "Due Diligence Expiration" }
          ]
        },
        {
          code: "2.2", label: "Financing Application",
          children: [
            { code: "2.2.1", label: "Introduction to Lender" },
            { code: "2.2.2", label: "Introduction of Lender to Escrow Company", owner: "SMB" },
            { code: "2.2.3", label: "Initial Financing Application Submission" },
            { code: "2.2.4", label: "Schedule Check-ins with Lender", hint: "Status updates from Lender; underwriter provide Conditional Loan Approval" },
            { code: "2.2.5", label: "Request Conditional Loan Approval Document", hint: "i.e. lease assignment" },
            { code: "2.2.6", label: "Monitor Conditional Loan Approval Conditions" },
            { code: "2.2.7", label: "Request Appraisal Status / Outcome" },
            { code: "2.2.8", label: "Proof of Financing Approval" }
          ]
        },
        {
          // Subitems taken from the reference sheet – confirm with the business.
          code: "2.3", label: "Definitive Purchase Agreement (Stock)",
          children: [
            { code: "2.3.1", label: "Draft Stock Purchase Agreement", owner: "Buyer Attorney" },
            { code: "2.3.2", label: "Definitive Purchase Agreement Negotiations" },
            { code: "2.3.3", label: "Definitive Purchase Agreement Executed" }
          ]
        },
        {
          // Subitems taken from the reference sheet – confirm with the business.
          code: "2.4", label: "Definitive Purchase Agreement (Asset)",
          children: [
            { code: "2.4.1", label: "Draft Asset Purchase Agreement", owner: "Buyer Attorney" },
            { code: "2.4.2", label: "Definitive Purchase Agreement Negotiations" },
            { code: "2.4.3", label: "Definitive Purchase Agreement Executed" }
          ]
        },
        {
          code: "2.5", label: "Employment Agreement(s)",
          children: [
            { code: "2.5.1", label: "Initial Draft of Employment Agreement(s)", owner: "Buyer Attorney" },
            { code: "2.5.2", label: "Redline to Employment Agreement(s)" },
            { code: "2.5.3", label: "Executed Employment Agreement(s)" }
          ]
        },
        {
          code: "2.6", label: "Promissory Note",
          children: [
            { code: "2.6.1", label: "Initial Draft of Promissory Note", owner: "Seller Attorney" },
            { code: "2.6.2", label: "Redline to Promissory Note" },
            { code: "2.6.3", label: "Executed Promissory Note" }
          ]
        },
        {
          code: "2.7", label: "Earnout Agreement",
          children: [
            { code: "2.7.1", label: "Initial Draft of Earnout Agreement" },
            { code: "2.7.2", label: "Redline to Earnout Agreement" },
            { code: "2.7.3", label: "Executed Earnout Agreement" }
          ]
        },
        {
          code: "2.8", label: "Buyer Credentialing",
          children: [
            { code: "2.8.1", label: "Introduction to Credentialing Firm" },
            { code: "2.8.2", label: "Provide Necessary Information to Buyer's Credentialing Firm", hint: "Once preliminary loan approval is in, provide Buyer's credentialing form with needed information (CAQH and PECOS logins)" },
            { code: "2.8.3", label: "Request Status Updates from Credentialing Firm", hint: "Due: On-going" }
          ]
        }
      ]
    },
    {
      key: "RE", code: "3.0", label: "Real Estate", color: "re",
      items: [
        {
          code: "3.1", label: "Lease (Assignment)",
          children: [
            { code: "3.1.1", label: "Landlord Notification" },
            { code: "3.1.2", label: "Initial Lease Assignment Agreement Draft", hint: "If landlord is third party (not seller); honor existing contract" },
            { code: "3.1.3", label: "Lease Terms Negotiation", hint: "i.e. extension, termination agreement w/ new lease" },
            { code: "3.1.4", label: "Lease Finalized" }
          ]
        },
        {
          code: "3.2", label: "Lease (New)",
          children: [
            { code: "3.2.1", label: "Initial Lease Agreement Draft" },
            { code: "3.2.2", label: "Lease Terms Negotiation" },
            { code: "3.2.3", label: "Lease Finalized" }
          ]
        },
        {
          code: "3.3", label: "Purchase",
          children: [
            {
              code: "3.3.1", label: "Commercial Real Estate (CRE) Purchase Agreement",
              children: [
                { code: "3.3.1.1", label: "CRE Purchase Agreement Drafted" },
                { code: "3.3.1.2", label: "CRE Purchase Agreement Negotiation" },
                { code: "3.3.1.3", label: "CRE Purchase Agreement Signed" }
              ]
            },
            { code: "3.3.2", label: "Real Estate Lender Introduction", hint: "Often same lender providing financing for the practice" },
            { code: "3.3.3", label: "Real Estate Loan Application Submission" },
            { code: "3.3.4", label: "Real Estate Loan Monitoring", hint: "Status, conditions, etc. (Due: On-going)" },
            { code: "3.3.5", label: "Real Estate Earnest Deposit" },
            { code: "3.3.6", label: "Real Estate Property Appraisal" },
            { code: "3.3.7", label: "Real Estate Loan Proof of Financing", hint: "Often same due date as practice financing" },
            { code: "3.3.8", label: "Real Estate Due Diligence Begins" },
            { code: "3.3.9", label: "Building Inspection" },
            { code: "3.3.10", label: "Environment Assessment (Phase 1)", hint: "Requested by Lender; records review" },
            { code: "3.3.11", label: "Real Estate Due Diligence Ends" }
          ]
        }
      ]
    },
    {
      key: "CL", code: "4.0", label: "Closing", color: "cl",
      items: [
        {
          code: "4.1", label: "UCC-1",
          children: [
            { code: "4.1.1", label: "UCC-1 Search Performed", owner: "Title Company", hint: "Shows any debt on the business; buyer responsibility" },
            { code: "4.1.2", label: "UCC-1 Findings (Debt Pay-off)", hint: "Proof of pay-off" }
          ]
        },
        { code: "4.2", label: "Payoff Credit Line", owner: "Seller" },
        { code: "4.3", label: "Staff Meeting to Announce Sale" },
        { code: "4.4", label: "Sign Promissory Note" },
        { code: "4.5", label: "Vaccine Inventory Count / Invoice to Buyer" },
        {
          code: "4.6", label: "Document Signatures (Stock Sale)",
          children: [
            { code: "4.6.1", label: "Resignation of Officers", owner: "Seller" },
            { code: "4.6.2", label: "Bill of Sale (optional)", owner: "Seller" },
            { code: "4.6.3", label: "Assignment of Shares", owner: "Seller" },
            { code: "4.6.4", label: "Corporate Resolution Documents", owner: "Seller", hint: "Approving the sale" }
          ]
        },
        {
          code: "4.7", label: "Document Signatures (Asset Sale)",
          children: [
            { code: "4.7.1", label: "Bill of Sale (required)", owner: "Seller" },
            { code: "4.7.2", label: "Resignation of Officers (required)", owner: "Seller" },
            { code: "4.7.3", label: "Corporate Resolution Documents", owner: "Seller" }
          ]
        },
        { code: "4.8", label: "Meeting at Bank (regarding Signature Cards/Buyer add cash)", owner: "Buyer / Seller", hint: "Stock sale only" },
        { code: "4.9", label: "Update of Corporation Commission Officers", owner: "Buyer", hint: "Stock sale only; state level" }
      ]
    }
  ];

  global.SMB_CONFIG = CONFIG;
  global.SMB_PHASES = PHASES;
})(window);
