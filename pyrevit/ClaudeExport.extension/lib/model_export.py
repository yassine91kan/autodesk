# -*- coding: utf-8 -*-
"""Shared helpers for the export buttons: reading Revit elements and writing UTF-8 CSV.

pyRevit puts this extension's lib folder on the import path, so a button script can
`from model_export import ...`. Works with IronPython 2.7 and CPython 3, Revit 2021+.
"""

import io

from Autodesk.Revit.DB import (
    FilteredElementCollector, CategoryType, StorageType, ElementId,
    UnitUtils, LabelUtils
)

try:
    text_type = unicode   # IronPython 2.7
except NameError:
    text_type = str       # CPython 3


# ------------------------------------------------------------------- text + CSV

def text(value):
    """Any value as unicode text ('' for None)."""
    if value is None:
        return u''
    if isinstance(value, text_type):
        return value
    try:
        return text_type(value)
    except Exception:
        return text_type(str(value), 'utf-8', 'replace')


def csv_cell(value):
    """One CSV cell, quoted when needed (RFC 4180)."""
    if isinstance(value, float):
        value = repr(round(value, 6))
    value = text(value)
    if any(c in value for c in (u',', u'"', u'\n', u'\r')):
        value = u'"' + value.replace(u'"', u'""') + u'"'
    return value


class CsvWriter(object):
    """Minimal UTF-8 CSV writer: IronPython's csv module mishandles unicode.

    bom=True starts the file with a byte order mark, which Excel and the Power Apps
    importer need to read accents correctly.
    """

    def __init__(self, path, header, bom=False):
        self.file = io.open(path, 'w', encoding='utf-8-sig' if bom else 'utf-8', newline=u'')
        self.rows = 0
        self.write(header, count=False)

    def write(self, cells, count=True):
        self.file.write(u','.join(csv_cell(c) for c in cells) + u'\r\n')
        if count:
            self.rows += 1

    def close(self):
        self.file.close()


# ------------------------------------------------------------------ Revit reads

def int_id(element_id):
    """An ElementId as a number (IntegerValue before Revit 2024, Value after)."""
    return element_id.IntegerValue if hasattr(element_id, 'IntegerValue') else element_id.Value


def element_name(doc, element_id):
    if element_id is None or element_id == ElementId.InvalidElementId:
        return u''
    other = doc.GetElement(element_id)
    return text(getattr(other, 'Name', u'')) if other is not None else u''


def group_label(definition):
    """The parameter's group as shown in the Properties palette ('Dimensions', 'Constraints', ...)."""
    try:  # Revit 2022+
        return LabelUtils.GetLabelForGroup(definition.GetGroupTypeId())
    except Exception:
        pass
    try:  # Revit 2021 and earlier
        return LabelUtils.GetLabelFor(definition.ParameterGroup)
    except Exception:
        return u'Other'


def number_in_display_units(param):
    """(number, unit label) in the units the project shows."""
    raw = param.AsDouble()
    try:
        unit = param.GetUnitTypeId()          # Revit 2021+
        return UnitUtils.ConvertFromInternalUnits(raw, unit), LabelUtils.GetLabelForUnit(unit)
    except Exception:
        return raw, u''


def read_param(doc, param):
    """(display value, number or None, unit) for one parameter, or None when it is empty."""
    if param is None or not param.HasValue:
        return None
    storage = param.StorageType
    if storage == StorageType.String:
        value = param.AsString()
        return (value, None, u'') if value else None
    if storage == StorageType.Integer:
        shown = param.AsValueString()          # 'Yes'/'No' for Yes/No parameters
        number = param.AsInteger()
        return (shown if shown else text(number), float(number), u'')
    if storage == StorageType.Double:
        number, unit = number_in_display_units(param)
        shown = param.AsValueString()
        return (shown if shown else text(number), number, unit)
    if storage == StorageType.ElementId:
        shown = param.AsValueString() or element_name(doc, param.AsElementId())
        return (shown, None, u'') if shown else None
    return None


def element_type(doc, element):
    """(type element or None, family name, type name)."""
    type_element = doc.GetElement(element.GetTypeId())
    if type_element is None:
        return None, u'', u''
    return type_element, text(getattr(type_element, 'FamilyName', u'')), text(type_element.Name)


def element_level(doc, element):
    """The element's level name: LevelId first, then the usual level parameters."""
    try:
        name = element_name(doc, element.LevelId)
        if name:
            return name
    except Exception:
        pass
    for label in (u'Base Level', u'Reference Level', u'Level', u'Schedule Level'):
        value = read_param(doc, element.LookupParameter(label))
        if value:
            return value[0]
    return u''


def model_elements(doc):
    """Every non-type element in a model category (no views, annotations or view-only items)."""
    for element in FilteredElementCollector(doc).WhereElementIsNotElementType():
        category = element.Category
        if category is None or category.CategoryType != CategoryType.Model:
            continue
        if element.ViewSpecific:
            continue
        yield element
