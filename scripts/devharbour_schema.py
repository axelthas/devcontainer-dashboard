"""Dependency-free validation of the shared DevHarbour configuration schema.

The browser receives this same schema through the Settings bridge. Operational
validation remains in the existing launcher; this module only validates data.
"""
import json
from pathlib import Path
import re

SCHEMA = json.loads((Path(__file__).with_name('devharbour.schema.json')).read_text())
PROPERTIES = SCHEMA['properties']['settings']['properties']


def validate(value, rule=SCHEMA, location='config'):
    """Validate the subset of JSON Schema used in the checked-in contract."""
    kind = rule.get('type')
    correct = {'object': isinstance(value, dict), 'array': isinstance(value, list),
               'string': isinstance(value, str), 'integer': type(value) is int,
               'boolean': type(value) is bool}
    if kind and not correct[kind]:
        raise ValueError('Invalid type: ' + location)
    if 'const' in rule and value != rule['const']:
        raise ValueError('Unsupported version: ' + location)
    if 'enum' in rule and value not in rule['enum']:
        raise ValueError('Invalid choice: ' + location)
    if kind == 'object':
        props = rule.get('properties', {})
        if set(rule.get('required', [])) - value.keys():
            raise ValueError('Missing required fields: ' + location)
        if rule.get('additionalProperties') is False and value.keys() - props.keys():
            raise ValueError('Unknown fields: ' + location)
        for key, item in value.items():
            if key in props:
                validate(item, props[key], location + '.' + key)
    elif kind == 'array':
        if len(value) > rule.get('maxItems', 1024):
            raise ValueError('Too many entries: ' + location)
        for item in value:
            validate(item, rule['items'], location)
    elif kind == 'string':
        if not rule.get('minLength', 0) <= len(value) <= rule.get('maxLength', 8192):
            raise ValueError('Invalid length: ' + location)
        if 'pattern' in rule and not re.search(rule['pattern'], value):
            raise ValueError('Invalid format: ' + location)
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Control characters: ' + location)
    elif kind == 'integer':
        if not rule.get('minimum', value) <= value <= rule.get('maximum', value):
            raise ValueError('Out of range: ' + location)
