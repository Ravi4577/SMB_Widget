# SMB Transaction Tracker: Zoho CRM Widget

This is a spreadsheet-style transaction checklist (Phase → Item → Subitem) that runs inside Zoho CRM. Each task is stored as **its own record** in the existing **SMB Transaction Tracker** module. CRM is the only place data is stored.

## Project structure

```
SMB Widget/
├── app/                      ← widget source (this is what gets packaged)
│   ├── index.html            markup + SDK include
│   ├── style.css             sheet look (phase colours, sticky headers, responsive)
│   ├── config.js             module/field mapping, linking, picklists, TASK HIERARCHY
│   └── script.js             SDK integration, rendering, validation, save/update
├── plugin-manifest.json      Zoho widget manifest
├── pack.ps1                  builds dist/SMB_Transaction_Tracker.zip
├── dist/SMB_Transaction_Tracker.zip   ready-to-upload package
├── dev/mock-zoho-sdk.js      local preview only (fake CRM), not packaged
├── CONFIG-CHECKLIST.md       what must be verified before production
└── README.md
```

## How it works

| Topic | Behaviour |
|---|---|
| Record per task | Record `Name` = the Deal name (e.g. `ACRA MEDICAL AESTHETICS, LLC`) and `Task_Code` = the task code (e.g. `1.3.3`). **Each Deal has its own checklist**: the widget shows and updates only records whose Name is the opened Deal's name, so a new Deal opens empty and its saves are stored under its own name. |
| Phase / task fields | Every create writes `Phase_Items` (picklist: the main phase, validated against CRM's permitted values) and `Sub_Items` (the deepest selected task name, never truncated). The old per-phase fields `Letter_of_Intent`, `Under_Contract`, `Real_Estate` and `Closing` are no longer written. Records saved earlier still load (they are matched by `Name`), and editing one fills in `Phase_Items` / `Sub_Items` without clearing the old field. |
| Task fields | `Owner1`, `Status`, `Due_Date`, `Complete_Date` (YYYY-MM-DD), `At_Risk`, `Task_Details`. |
| Create vs update | Tasks that have no record are **created**. Tasks that have a record are **updated by record ID**, and only the fields that changed are sent. |
| Duplicate protection | Save is locked while a save is running. Before creating records, CRM is re-read, and a task whose record already exists is turned into an update. |
| Failures | Each task reports success or failure separately. Failed rows stay marked red and keep their edits; you can fix them and save again. |
| Completed date | When Status becomes *Complete* and the completed date is empty, the widget asks before setting it to today. An existing date is never overwritten. |
| Picklists | Values are sent only on create, and only when they match a permitted value. See the checklist. |
| Config check | On every load the widget verifies the module and fields through `getFields`. If anything is missing, a banner explains it and saving is turned off. |

SDK calls used: `ZOHO.embeddedApp.on("PageLoad")`, `ZOHO.embeddedApp.init()`, `ZOHO.CRM.META.getModules / getFields`, `ZOHO.CRM.API.getAllRecords / searchRecord / getRecord / insertRecord / updateRecord`. Each record is written with one call (`APIData` set to a single object, as in Zoho's documented examples), with up to 4 calls running in parallel.

## 1. Configure

Open [app/config.js](app/config.js) and work through [CONFIG-CHECKLIST.md](CONFIG-CHECKLIST.md). At minimum, set:

```js
module: { apiName: "SMB_Transaction_Tracker" /* verify */ },
transactionLink: { mode: "none" }   // Sandbox only. See checklist §3.
```

The task hierarchy is the `PHASES` array at the bottom of `config.js`. To change it, add, rename or remove nodes there. Don't renumber codes that already have records.

## 2. Preview locally (no CRM needed)

```bash
python -m http.server 5510 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5510/app/index.html?mock=1&reset=1`.

Mock URL options:

- `&fail=1` makes every save fail.
- `&reset=1` clears the fake data.
- `&link=lookup&entity=Deals&id=111` or `&link=name_prefix&entity=Deals&id=111` simulates opening the widget from a Deal.

The mock only runs with `?mock=1` and only outside an iframe, so it can never run inside CRM.

## 3. Package

```bash
powershell -ExecutionPolicy Bypass -File pack.ps1
```

This creates `dist/SMB_Transaction_Tracker.zip`, with the contents of `app/` and `plugin-manifest.json` at the ZIP root.

If you use the Zoho CLI instead (`npm i -g zoho-extension-toolkit`), this folder already uses the `app/` + `plugin-manifest.json` layout. Run `zet validate`, then `zet pack`.

## 4. Deploy to Zoho CRM Sandbox

1. Sign in to the **Sandbox** and go to Setup > Developer Hub > **Widgets** > **Create New Widget**.
2. Enter **Name** `SMB Transaction Tracker`, **Type** to match where you'll place it (see below), and **Hosting** `Zoho`.
3. Upload `dist/SMB_Transaction_Tracker.zip`. Set **Index Page** to `/index.html`.
4. Place the widget:
   - **Web Tab** (Setup > Customization > Modules > Web Tabs): suits mode `none` only, because there's no record context.
   - **Button** on the parent module's detail page (for example Deals > Links & Buttons > New Button > Action: *Open a Widget*): required for `lookup` and `name_prefix`.
   - **Related List** on the parent module: also works for `lookup` and `name_prefix`.
5. Open the widget and expand **Configuration & diagnostics**. Confirm the module API name, that all fields show ✓, and the link mode.
6. Once it's verified, set `module.apiName` explicitly, then run `pack.ps1` and upload again.

For development without re-uploading, run `zet run` (serves `https://127.0.0.1:5000`), accept the certificate in the browser, and create the widget with **Hosting: External** and base URL `https://127.0.0.1:5000/app/index.html`.

## 5. Test scenarios (Sandbox)

| # | Steps | Expected |
|---|---|---|
| 1 | Set 1.1 LOI Executed Date to Owner = Seller, Status = Not Started. Click Save. | 1 record `SMB-LOI-1.1`, with `Letter_of_Intent` = "LOI Executed Date". |
| 2 | Expand 1.3 Escrow Account. Fill in 1.3.3 and save. | `SMB-LOI-1.3.3`, with `Letter_of_Intent` = "Earnest Money Deposit (Initial)". |
| 3 | Fill in 1.1, 1.2, 1.3.3 and 1.5, then save. | 4 separate records. |
| 4 | Change 1.1 to In Progress and save. | Same record ID, banner shows "1 updated", no new record. |
| 5 | Set Status to Complete and choose **Yes** in the dialog. Save. | `Complete_Date` = today. A date that was already set is left unchanged. |
| 6 | Set At Risk to Yes and save. | `At_Risk` = "Yes". The phase header counts it as at risk. |
| 7 | Click Refresh, or reopen the widget. | Saved values are shown, and items with data open automatically. |
| 8 | Edit tasks in all 4 phases and save. | Each phase field gets only its own task's label. |
| 9 | Edit 1.1, save, then check 1.2. | 1.2 is unchanged, because updates send only the changed fields of that record. |
| 10 | Click Save Changes several times quickly. | No duplicates. The button is locked while saving, and existing records are checked first. |
| 11 | Set `debug.simulateFailureRate: 1` (or disconnect the network), edit a task and save. | Red error banner, row stays red, edits are kept, and the unsaved badge is still shown. Set the rate back to `0` afterwards. |

Scenarios 1–11 were run against the local mock (`dev/mock-zoho-sdk.js`) and behaved as expected. They still need to be repeated in the Sandbox against the real API.
