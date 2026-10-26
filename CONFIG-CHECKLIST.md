# Configuration checklist (verify before production)

All of these live in [app/config.js](app/config.js). The widget's **Configuration & diagnostics** panel (bottom of the widget) shows what it detected at runtime: use it to check each item.

## 1. Module API name — REQUIRED
- [ ] Setup > Developer Hub > APIs & SDKs > API Names > **SMB Transaction Tracker**: copy the module API name.
- [ ] Set `CONFIG.module.apiName` (for example `"SMB_Transaction_Tracker"`). Until you do, the widget finds the module by its label and shows "auto-detected" in the diagnostics panel.

## 2. Field API names: already supplied and checked at runtime
`Name, Owner1, Status, At_Risk, Due_Date, Complete_Date, Task_Details, Letter_of_Intent, Under_Contract, Real_Estate, Closing`

- [ ] On every load the widget calls `ZOHO.CRM.META.getFields`. If any field is missing, it shows a red banner and turns off saving.
- [ ] `Owner1` is the task-owner text field. The standard record owner (`Owner`) is never written.

## 3. Transaction linking — CONFIGURATION DEPENDENCY (blocks production)
The module has **no lookup or identifier that ties a task record to a transaction**. The API Names screen has only `Connected_To__s` (MultiModuleLookup), and it hasn't been confirmed as a transaction link. Without a link, the widget can't tell transactions apart.

Choose one and set `CONFIG.transactionLink`:

| mode | What it needs | Notes |
|---|---|---|
| `"none"` (current default) | nothing | **Sandbox / single transaction only.** Every record in the module is treated as one transaction, and a yellow warning banner is always shown. |
| `"lookup"` (recommended) | A **lookup field** on SMB Transaction Tracker pointing to the parent (for example a Deal). An admin must create it; the widget will not create fields. Set `parentModule` and `lookupField`. | Place the widget on the parent module (detail-page button or related list). Records are searched with `(lookupField:equals:parentId)`. |
| `"name_prefix"` | No new field. Set `parentModule`. | The parent record ID is put into the record Name: `SMB-<parentId>-LOI-1.3.3`. Works with existing fields, but the grouping depends on the Name format. |

- [ ] Decide which parent module identifies a transaction (Deals? a custom module?).
- [ ] Decide on a mode and create the lookup field if you choose `lookup`.
- [ ] Note: `Connected_To__s` could be evaluated as the link. Its read/search format for a MultiModuleLookup was not verified, so it isn't used.

> Changing the mode after records exist changes how records are found. For example, `none` records named `SMB-LOI-1.1` are not found by `name_prefix`. Decide before entering real data.

## 4. Header fields (Seller, Buyer, Closing Date, Location)
These are read from the **parent record** (`transactionLink.parentModule`, or the record the widget was opened from). Until they're mapped, they show "Not mapped".

- [ ] `CONFIG.header.sellerName` = API name of the seller/practice field on the parent module
- [ ] `CONFIG.header.buyerName`
- [ ] `CONFIG.header.closingDate`
- [ ] `CONFIG.header.location`

## 5. Existing picklists
`Phase_Item, Escrow_Account, Escrow_Account_Sub_Item, Letter_of_intent_Subitem, Under_Contract_Sub_Item`

- [ ] Their permitted values were not provided. The widget sends a picklist value **only when a record is created**, and **only if it exactly matches a permitted value** returned by `getFields`. Anything else is skipped and listed under "Picklist values skipped" in the diagnostics panel. Nothing invalid is ever sent.
- [ ] Review the rules in `CONFIG.picklists.rules`, or set `CONFIG.picklists.enabled = false`.

## 6. Unused existing fields
`LOI_Executed_Date, Introduction_to_Client_s_CPA, Introduce_Client_to_M_A_Attorney, Data_Room_Access_Updated` (Single Line) are not written. Per the spec, the task name goes only into its phase field (`Letter_of_Intent`, …). Confirm this is the intended behavior.

## 7. Task hierarchy
- [ ] **Definitive Purchase Agreement (Stock/Asset)** subitems come from the reference sheet (Draft …, Negotiations, Executed). Confirm them.
- [ ] Spelling was corrected from the sheet: "Commerical" → "Commercial", "Buidling" → "Building". Labels are written to CRM, so confirm the spelling before going live.
- [ ] Task codes (for example `1.3.3`) are part of the record Name. **Don't renumber existing codes** after go-live; add new codes instead.

## 8. Other
- [ ] SDK URL `https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js`: confirm the version your org uses.
- [ ] `CONFIG.api.triggers = ["workflow"]` means workflow rules fire on create and update. Set it to `[]` if they shouldn't.
- [ ] `CONFIG.validation.requiredFields` is Owner + Status by default.
- [ ] `CONFIG.debug.simulateFailureRate` must be `0` in production.
- [ ] Check the user profiles: users need Create/Edit permission on the module and field-level access to all of the fields above.
