# -*- coding: utf-8 -*-
"""Exports the open Revit model as two CSV files to import into Dataverse tables,
for a Copilot Studio agent that uses them as knowledge.

  <model>_elements.csv  one row per model element, with fixed columns in fixed units
  <model>_totals.csv    counts and totals already added up, so "how many" and
                        "how much" questions are answered by finding one row

Copilot finds rows by searching the tables; it doesn't add up thousands of rows
reliably. That's why the totals are computed here, in Revit.

Each row has a `model` column, so several models can share the same two tables.
Units are fixed whatever the project shows: lengths in mm, areas in m², volumes in m³.
"""

__title__ = 'Export for\nDataverse'
__doc__ = 'Exports the model as two CSV files (elements and totals) to import into Dataverse for Copilot Studio.'

import os
import datetime

from Autodesk.Revit.DB import UnitUtils, StorageType
from model_export import CsvWriter, text, int_id, read_param, element_type, element_level, model_elements

try:
    from Autodesk.Revit.DB import UnitTypeId   # Revit 2021+
    UNITS = {'mm': UnitTypeId.Millimeters, 'm2': UnitTypeId.SquareMeters, 'm3': UnitTypeId.CubicMeters}
except ImportError:
    UNITS = None

try:
    from pyrevit import forms, script
    output = script.get_output()
except ImportError:
    forms = None
    output = None

doc = __revit__.ActiveUIDocument.Document  # noqa: F821 (provided by pyRevit)

# Text columns: column name -> parameter names to try, in order (instance first, then type).
TEXT_COLUMNS = [
    ('base_level', ['Base Level', 'Reference Level', 'Level']),
    ('top_level', ['Top Level', 'Top Constraint']),
    ('material', ['Structural Material', 'Material']),
    ('structural_usage', ['Structural Usage']),
    ('mark', ['Mark']),
    ('comments', ['Comments']),
]
# Number columns: column name -> (unit, parameter names to try).
NUMBER_COLUMNS = [
    ('length_mm', 'mm', ['Length', 'Cut Length', 'Unconnected Height']),
    ('width_mm', 'mm', ['Width', 'b', 'Width (b)']),
    ('height_mm', 'mm', ['Height', 'd', 'Depth', 'Height (h)']),
    ('thickness_mm', 'mm', ['Thickness', 'Default Thickness']),
    ('area_m2', 'm2', ['Area']),
    ('volume_m3', 'm3', ['Volume']),
]
ELEMENT_HEADER = ([u'model', u'element_id', u'unique_id', u'category', u'family', u'type', u'level'] +
                  [c[0] for c in TEXT_COLUMNS] + [c[0] for c in NUMBER_COLUMNS])
TOTALS_HEADER = [u'model', u'scope', u'category', u'family', u'type', u'level', u'material',
                 u'element_count', u'total_length_m', u'total_area_m2', u'total_volume_m3']


def lookup(element, type_element, names):
    """The first of these parameters that has a value, on the element then on its type."""
    for owner in (element, type_element):
        if owner is None:
            continue
        for name in names:
            param = owner.LookupParameter(name)
            if param is not None and param.HasValue:
                return param
    return None


def number_in(param, unit_key):
    """A length/area/volume parameter in fixed units (mm, m², m³), or None."""
    if param is None or param.StorageType != StorageType.Double:
        return None
    raw = param.AsDouble()
    if UNITS is None:
        return raw
    return round(UnitUtils.ConvertFromInternalUnits(raw, UNITS[unit_key]), 3)


def add_total(totals, key, length_mm, area_m2, volume_m3):
    entry = totals.setdefault(key, [0, 0.0, 0.0, 0.0])
    entry[0] += 1
    entry[1] += (length_mm or 0) / 1000.0
    entry[2] += area_m2 or 0
    entry[3] += volume_m3 or 0


def export(folder):
    model = os.path.splitext(doc.Title)[0]
    elements_path = os.path.join(folder, model + '_elements.csv')
    totals_path = os.path.join(folder, model + '_totals.csv')

    elements = CsvWriter(elements_path, ELEMENT_HEADER, bom=True)
    totals = {}   # (scope, category, family, type, level, material) -> [count, length m, area, volume]
    try:
        for element in model_elements(doc):
            type_element, family, type_name = element_type(doc, element)
            category = element.Category.Name
            level = element_level(doc, element)

            texts = []
            for _, names in TEXT_COLUMNS:
                value = read_param(doc, lookup(element, type_element, names))
                texts.append(value[0] if value else u'')
            numbers = [number_in(lookup(element, type_element, names), unit)
                       for _, unit, names in NUMBER_COLUMNS]

            elements.write([model, int_id(element.Id), element.UniqueId, category, family,
                            type_name, level] + texts + numbers)

            material = texts[2]
            length_mm, area_m2, volume_m3 = numbers[0], numbers[4], numbers[5]
            all_ = u'(all)'
            for key in (
                (u'type per level', category, family, type_name, level, material),
                (u'category per level', category, all_, all_, level, all_),
                (u'category', category, all_, all_, all_, all_),
                (u'material', category, all_, all_, all_, material or u'(none)'),
            ):
                add_total(totals, key, length_mm, area_m2, volume_m3)
    finally:
        elements.close()

    sheet = CsvWriter(totals_path, TOTALS_HEADER, bom=True)
    for key in sorted(totals):
        count, length_m, area, volume = totals[key]
        sheet.write([model] + list(key) + [count, round(length_m, 3), round(area, 3), round(volume, 3)])
    sheet.close()
    return elements_path, totals_path, elements.rows, sheet.rows


def choose_folder():
    if forms is not None:
        return forms.pick_folder(title='Folder for the Dataverse CSV files')
    return os.path.join(os.path.expanduser('~'), 'Desktop')


if __name__ == '__main__':
    target = choose_folder()
    if target:
        started = datetime.datetime.now()
        elements_path, totals_path, element_rows, total_rows = export(target)
        seconds = (datetime.datetime.now() - started).total_seconds()
        message = ('Exported %d elements and %d total rows in %.0f s:  \n%s  \n%s' %
                   (element_rows, total_rows, seconds, elements_path, totals_path))
        if output is not None:
            output.print_md('**Export for Dataverse**  \n' + message +
                            '  \nImport both files into Dataverse (see pyrevit/README.md).')
        else:
            print(message.replace('  \n', '\n'))
