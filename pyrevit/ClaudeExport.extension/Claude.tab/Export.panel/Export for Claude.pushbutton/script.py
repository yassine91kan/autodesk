# -*- coding: utf-8 -*-
"""Exports the open Revit model to one .zip that Claude can query.

Drop the zip into a Claude chat (with code execution switched on) and ask
questions in plain words: Claude loads the CSV files into SQLite and runs SQL.

The zip holds:
  elements.csv    one row per model element (id, unique_id, category, family, type, level, name)
  properties.csv  one row per element parameter (instance and type), with numbers in display units
  model.csv       about the export (project, Revit version, date, counts)
  README.md       the table layout and example queries, for Claude

unique_id is Revit's UniqueId, which is also the externalId in the Autodesk Viewer (APS).
"""

__title__ = 'Export\nfor Claude'
__doc__ = 'Exports every model element and its parameters to a .zip of CSV files that Claude can query.'

import os
import zipfile
import datetime

from model_export import (
    CsvWriter, text, int_id, group_label, read_param, element_type, element_level, model_elements
)

try:
    from pyrevit import forms, script
    output = script.get_output()
except ImportError:  # run outside pyRevit (e.g. RevitPythonShell)
    forms = None
    output = None

doc = __revit__.ActiveUIDocument.Document  # noqa: F821 (provided by pyRevit)

README_PATH = os.path.join(os.path.dirname(__file__), 'README_for_claude.md')


def export(zip_path):
    folder = os.path.dirname(zip_path)
    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    parts = dict((name, os.path.join(folder, '_claude_%s_%s' % (stamp, name)))
                 for name in ('elements.csv', 'properties.csv', 'model.csv'))

    elements = CsvWriter(parts['elements.csv'],
                         [u'id', u'unique_id', u'category', u'family', u'type', u'level', u'name'])
    properties = CsvWriter(parts['properties.csv'],
                           [u'id', u'source', u'group', u'name', u'value', u'number', u'unit'])
    types_done = {}   # type id -> its rows, so each type's parameters are read once

    try:
        for element in model_elements(doc):
            eid = int_id(element.Id)
            type_element, family, type_name = element_type(doc, element)
            elements.write([eid, element.UniqueId, element.Category.Name, family,
                            type_name, element_level(doc, element), text(element.Name)])

            seen = set()
            for param in element.Parameters:
                definition = param.Definition
                key = (group_label(definition), definition.Name)
                value = read_param(doc, param)
                if value is None or key in seen:
                    continue
                seen.add(key)
                properties.write([eid, u'instance', key[0], key[1]] + list(value))

            # Type parameters, attached to each element (instance values win on name clashes).
            if type_element is not None:
                type_key = type_element.Id.ToString()
                if type_key not in types_done:
                    rows = []
                    for param in type_element.Parameters:
                        definition = param.Definition
                        value = read_param(doc, param)
                        if value is not None:
                            rows.append([group_label(definition), definition.Name] + list(value))
                    types_done[type_key] = rows
                for row in types_done[type_key]:
                    if (row[0], row[1]) not in seen:
                        properties.write([eid, u'type'] + row)
    finally:
        elements.close()
        properties.close()

    meta = CsvWriter(parts['model.csv'], [u'key', u'value'])
    meta.write([u'project', doc.Title])
    meta.write([u'path', doc.PathName])
    meta.write([u'revit_version', doc.Application.VersionNumber])
    meta.write([u'exported_at', datetime.datetime.now().isoformat()])
    meta.write([u'elements', elements.rows])
    meta.write([u'property_rows', properties.rows])
    meta.close()

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, path in parts.items():
            archive.write(path, name)
        if os.path.exists(README_PATH):
            archive.write(README_PATH, 'README.md')
    for path in parts.values():
        os.remove(path)

    return elements.rows, properties.rows


def choose_path():
    default_name = os.path.splitext(doc.Title)[0] + '_for_claude.zip'
    if forms is not None:
        return forms.save_file(file_ext='zip', default_name=default_name)
    return os.path.join(os.path.expanduser('~'), 'Desktop', default_name)


if __name__ == '__main__':
    target = choose_path()
    if target:
        started = datetime.datetime.now()
        element_count, property_count = export(target)
        seconds = (datetime.datetime.now() - started).total_seconds()
        size_mb = os.path.getsize(target) / 1048576.0
        message = 'Exported %d elements and %d property values in %.0f s to %s (%.1f MB).' % (
            element_count, property_count, seconds, target, size_mb)
        if output is not None:
            output.print_md('**Export for Claude**  \n' + message +
                            '  \nDrop the zip into a Claude chat with code execution on.')
        else:
            print(message)
