# Revit model export: how to query it

This zip was made by the pyRevit button "Export for Claude". It holds one Revit model's
elements and parameters. Load the CSV files into SQLite and answer questions with SQL:

```python
import sqlite3, zipfile, pandas as pd
z = zipfile.ZipFile('model_for_claude.zip')
db = sqlite3.connect(':memory:')
for name in ('elements', 'properties', 'model'):
    pd.read_csv(z.open(name + '.csv'), dtype={'unique_id': str}).to_sql(name, db, index=False)
db.execute('CREATE INDEX p_name ON properties(name, value)')
db.execute('CREATE INDEX p_id ON properties(id)')
```

## Tables

**elements**: one row per model element.

| column | meaning |
|---|---|
| id | Revit ElementId (also shown in brackets in the Viewer: "Wall [123456]") |
| unique_id | Revit UniqueId = the externalId in the Autodesk Viewer (APS) |
| category | e.g. Walls, Structural Columns, Structural Framing |
| family | e.g. "UB-Universal Beams-Column (AS 3679_1)" |
| type | e.g. "200UB25.4" |
| level | the element's level (LevelId, else Base / Reference Level) |
| name | the element's name (often the type name) |

**properties**: one row per element parameter (long format).

| column | meaning |
|---|---|
| id | the element (elements.id) |
| source | `instance`, or `type` when the value comes from the element's type |
| group | the Properties palette group: Constraints, Dimensions, Structural, Identity Data, ... |
| name | parameter name, e.g. "Base Level", "Length", "Volume", "Structural Material" |
| value | the value as Revit shows it, with units ("4500 mm", "Level 2", "Yes") |
| number | numeric value in the project's display units, empty for text |
| unit | the unit of `number`, e.g. "Millimeters", "Cubic meters" |

**model**: about the export (project, path, revit_version, exported_at, counts).

## Tips

- The same parameter name can exist in two groups; filter on `name` alone unless that matters.
- Use `number` for maths (sums, ranges, sorting) and `value` for display and text matches.
- Levels: elements.level is filled for most elements. For a specific parameter use
  properties `name IN ('Base Level', 'Top Level', 'Reference Level')`.
- Lengths and volumes are already in display units (usually mm and m³).

## Example queries

Columns by base level and family:

```sql
SELECT p.value AS base_level, e.family, COUNT(*) AS columns
FROM elements e JOIN properties p ON p.id = e.id AND p.name = 'Base Level'
WHERE e.category = 'Structural Columns'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

The five longest beams:

```sql
SELECT e.id, e.type, p.number AS length
FROM elements e JOIN properties p ON p.id = e.id AND p.name = 'Length'
WHERE e.category = 'Structural Framing'
ORDER BY p.number DESC LIMIT 5;
```

Total concrete volume per level:

```sql
SELECT e.level, ROUND(SUM(v.number), 2) AS volume
FROM elements e
JOIN properties v ON v.id = e.id AND v.name = 'Volume'
JOIN properties m ON m.id = e.id AND m.name = 'Structural Material' AND m.value LIKE '%concrete%'
GROUP BY e.level;
```
