# Revit export buttons (pyRevit)

A pyRevit extension that adds a **Claude** tab to Revit with two buttons:

| Button | Writes | For |
|---|---|---|
| **Export for Claude** | `<model>_for_claude.zip` (elements.csv, properties.csv, model.csv, README.md) | Dropping into a Claude chat with code execution on: Claude queries it with SQL |
| **Export for Dataverse** | `<model>_elements.csv` and `<model>_totals.csv` | Importing into Dataverse tables that a Copilot Studio agent uses as knowledge |

Both work with pyRevit's IronPython 2.7 and CPython 3 engines, in Revit 2021 and later.
Shared code is in `ClaudeExport.extension/lib/model_export.py`.

## Install

1. pyRevit → **Settings → Custom Extension Directories** → add this `pyrevit` folder.
2. Save and **Reload** pyRevit. The **Claude** tab appears in Revit.

## Export for Dataverse

### The two files

**`<model>_elements.csv`**: one row per model element (no annotations or view-only items).

| Column | Meaning |
|---|---|
| model | Revit file name without .rvt: several models can share one table |
| element_id | Revit ElementId |
| unique_id | Revit UniqueId (= externalId in the Autodesk Viewer) |
| category | Walls, Structural Columns, Structural Framing, ... |
| family, type | Family and type names |
| level | The element's level |
| base_level, top_level | Base / reference level and top level, when the element has them |
| material | Structural Material (or Material) |
| structural_usage | Girder, Joist, Bearing, ... |
| mark, comments | Instance Mark and Comments |
| length_mm, width_mm, height_mm, thickness_mm | In millimetres, whatever units the project shows |
| area_m2, volume_m3 | In square and cubic metres |

**`<model>_totals.csv`**: counts and totals already added up. The `scope` column says how:

| scope | One row per | Example question it answers |
|---|---|---|
| category | category | "How many structural columns are there?" |
| category per level | category + level | "How many columns on Level 2?" |
| type per level | category + family + type + level + material | "How many 200UB25.4 columns on Level 2?" |
| material | category + material | "Total concrete volume of the framing?" |

Each row has `element_count`, `total_length_m`, `total_area_m2` and `total_volume_m3`.
`(all)` in a column means "every value": the `category` row for Walls has family, type and level `(all)`.

Copilot Studio answers from Dataverse by searching for matching rows; it doesn't add up thousands
of rows reliably. The totals table turns "how many" and "how much" questions into finding one row.

### Import into Dataverse

The menu names below are those of make.powerapps.com at the time of writing; they may move.

1. Open **make.powerapps.com**, choose the environment the agent will use.
2. **Tables → New table → Import → Import data from Excel or .CSV** and pick `<model>_elements.csv`.
   Name the table e.g. *Revit Elements*. Check that the `_mm`, `_m2`, `_m3` columns are numbers
   (Decimal) and the rest text.
3. Do the same with `<model>_totals.csv` as *Revit Totals* (`element_count` whole number, totals decimal).
4. Give each column a **description** (the tables above). Copilot uses column names and descriptions
   to match questions to columns, so this matters more than it looks.
5. For more models later: import the new files into the same tables. To replace a model's data,
   first delete its rows (filter on `model`), then import. For automatic updates, set up a
   **dataflow** with `model` + `unique_id` as the key.

### Use it in Copilot Studio

1. Agent → **Knowledge → Add knowledge → Dataverse**, select *Revit Elements* and *Revit Totals*.
2. Requirements: the agent's authentication must be **Authenticate with Microsoft**, and
   **Dataverse search** must be on in the environment (Power Platform admin center).
3. Add to the agent's instructions:

   > You answer questions about Revit building models stored in two Dataverse tables.
   > For counts and totals (how many, total length, area, volume) always use *Revit Totals*:
   > find the row with the right scope (category, category per level, type per level, material)
   > and read element_count or the total columns. Never add up rows of *Revit Elements* yourself.
   > Use *Revit Elements* for questions about individual elements (which, list, the longest, the mark of).
   > Lengths in Revit Elements are in mm, areas in m², volumes in m³; totals give lengths in metres.
   > If several models are loaded, ask which model when the question doesn't say.

### Limits

- Questions outside the precomputed totals (e.g. "total volume by fire rating") can't be answered
  reliably: add a scope or a column to the export for them.
- "List all…" over hundreds of elements may be cut short by search: ask for counts or narrow it down.
- The data is as fresh as the last export.
