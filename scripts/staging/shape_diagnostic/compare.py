"""Read-only, value-free AST comparison. Never imports either input module."""
import ast
import hashlib
import json
from pathlib import Path
import sys

RAW_PIN = '47bacb1651dc3a826822c79736968c4e9a8d917b4e1f9adc8d1e37d1370f5d18'
REFERENCE_PIN = '9823654c22a01a24c76f3755545f52cf9d34707cf10f44131405fc98e2065de9'


def normalized(data):
    tree = ast.parse(data)
    tree.body = [n for n in tree.body if not isinstance(n, ast.Assign) or not any(
        isinstance(v, ast.Name) and v.id in {'WS', 'KEY', 'REPORT_DIRS'}
        for v in n.targets)]
    return tree


def differences(reference, actual, path='Module', lines=(None, None)):
    if isinstance(reference, ast.AST) and isinstance(actual, ast.AST):
        lines = (getattr(reference, 'lineno', lines[0]), getattr(actual, 'lineno', lines[1]))
    def report(kind):
        return {'path': path, 'kind': kind, 'reference_line': lines[0], 'host_line': lines[1]}
    if type(reference) is not type(actual):
        yield report('node_or_value_type_differs')
    elif isinstance(reference, ast.AST):
        for field in reference._fields:
            yield from differences(getattr(reference, field, None), getattr(actual, field, None), path + '.' + field, lines)
    elif isinstance(reference, list):
        if len(reference) != len(actual):
            yield report('list_length_differs')
        for i, (left, right) in enumerate(zip(reference, actual)):
            yield from differences(left, right, path + '[' + str(i) + ']', lines)
    elif reference != actual:
        yield report('value_differs')


def main():
    # Path names, source text, identifiers and literal values never enter output.
    try:
        actual = Path(sys.argv[1]).read_bytes()
        reference = Path(__file__).with_name('queue-runner.redacted.txt').read_bytes()
    except (OSError, IndexError):
        print(json.dumps({'error': 'input_unavailable'}))
        return 2
    pins = {'host_pin_matches': hashlib.sha256(actual).hexdigest() == RAW_PIN,
            'reference_pin_matches': hashlib.sha256(reference).hexdigest() == REFERENCE_PIN}
    if not all(pins.values()):
        print(json.dumps(pins))
        return 2
    try:
        left, right = normalized(reference), normalized(actual)
    except (SyntaxError, ValueError, UnicodeError):
        print(json.dumps({'error': 'parse_failed', 'python': list(sys.version_info[:3])}))
        return 2
    found = []
    for item in differences(left, right):
        found.append(item)
        if len(found) == 21:
            break
    digest = lambda t: hashlib.sha256(ast.dump(t, include_attributes=False).encode()).hexdigest()
    print(json.dumps({**pins, 'python': list(sys.version_info[:3]),
                      'reference_shape_on_host': digest(left), 'host_shape': digest(right),
                      'differences': found[:20], 'truncated': len(found) > 20}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
