"""Read-only, value-free AST comparison. Never imports either input module."""
import ast
import difflib
import hashlib
import json
from pathlib import Path
import sys

RAW_PIN = '47bacb1651dc3a826822c79736968c4e9a8d917b4e1f9adc8d1e37d1370f5d18'
REFERENCE_PIN = '5e2ec27106724efdb16e69cfa0442f594339681abbf862451b76e9b69f5501da'


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


DOC_OWNERS = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def leading_docstring(node):
    if isinstance(node, DOC_OWNERS) and node.body:
        first = node.body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            return first
    return None


def aligned_differences(reference, actual):
    """Alignment is explanatory only: no changes to either tree or admission."""
    records = []

    def visit(left, right, lp, rp, lines=(None, None)):
        lines = (getattr(left, 'lineno', lines[0]), getattr(right, 'lineno', lines[1]))

        def report(kind, category='structure'):
            records.append({'category': category, 'kind': kind,
                            'reference_path': lp, 'host_path': rp,
                            'reference_line': lines[0], 'host_line': lines[1]})

        if type(left) is not type(right):
            report('node_or_value_type_differs')
        elif isinstance(left, ast.AST):
            ld, rd = leading_docstring(left), leading_docstring(right)
            if ld is not None or rd is not None:
                if ld is None or rd is None or ld.value.value != rd.value.value:
                    records.append({'category': 'leading_docstring',
                                    'kind': 'added' if ld is None else 'removed' if rd is None else 'value_differs',
                                    'reference_path': lp + '.body[0]' if ld is not None else None,
                                    'host_path': rp + '.body[0]' if rd is not None else None,
                                    'reference_line': getattr(ld, 'lineno', None),
                                    'host_line': getattr(rd, 'lineno', None)})
            for field in left._fields:
                a, b = getattr(left, field, None), getattr(right, field, None)
                if field == 'body' and isinstance(left, DOC_OWNERS):
                    sequence(a, b, lp + '.body', rp + '.body', lines,
                             int(ld is not None), int(rd is not None))
                else:
                    visit(a, b, lp + '.' + field, rp + '.' + field, lines)
        elif isinstance(left, list):
            if all(isinstance(n, ast.stmt) for n in left + right):
                sequence(left, right, lp, rp, lines)
            else:
                if len(left) != len(right):
                    report('list_length_differs')
                for i in range(max(len(left), len(right))):
                    if i >= len(left) or i >= len(right):
                        records.append({'category': 'structure', 'kind': 'list_item_added' if i >= len(left) else 'list_item_removed',
                                        'reference_path': lp + '[' + str(i) + ']' if i < len(left) else None,
                                        'host_path': rp + '[' + str(i) + ']' if i < len(right) else None,
                                        'reference_line': lines[0], 'host_line': lines[1]})
                    else:
                        visit(left[i], right[i], lp + '[' + str(i) + ']', rp + '[' + str(i) + ']', lines)
        elif left != right:
            report('value_differs')

    def sequence(left, right, lp, rp, lines, lo=0, ro=0):
        # Exact statements anchor insertions, even among repeated statement types.
        # Within changed spans, named definitions anchor corresponding bodies.
        def key(n):
            return (type(n).__name__, getattr(n, 'name', None))

        def span(ai, aj, bi, bj, exact):
            encode = (lambda n: ast.dump(n, include_attributes=False)) if exact else key
            matcher = difflib.SequenceMatcher(None, [encode(n) for n in left[ai:aj]],
                                              [encode(n) for n in right[bi:bj]], autojunk=False)
            for tag, i, j, k, l in matcher.get_opcodes():
                i, j, k, l = ai+i, ai+j, bi+k, bi+l
                if tag == 'replace' and exact:
                    span(i, j, k, l, False)
                    continue
                paired = min(j-i, l-k)
                for offset in range(paired):
                    visit(left[i+offset], right[k+offset], lp+'['+str(i+offset)+']', rp+'['+str(k+offset)+']', lines)
                for index in range(i+paired, j):
                    records.append({'category': 'structure', 'kind': 'statement_removed',
                                    'reference_path': lp+'['+str(index)+']', 'host_path': None,
                                    'reference_line': left[index].lineno, 'host_line': None})
                for index in range(k+paired, l):
                    records.append({'category': 'structure', 'kind': 'statement_added',
                                    'reference_path': None, 'host_path': rp+'['+str(index)+']',
                                    'reference_line': None, 'host_line': right[index].lineno})
        span(lo, len(left), ro, len(right), True)

    visit(reference, actual, 'Module', 'Module')
    return records


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
    found = aligned_differences(left, right)
    digest = lambda t: hashlib.sha256(ast.dump(t, include_attributes=False).encode()).hexdigest()
    print(json.dumps({**pins, 'python': list(sys.version_info[:3]),
                      'reference_shape_on_host': digest(left), 'host_shape': digest(right),
                      'differences': found, 'truncated': False,
                      'admission_decision': 'none; diagnostic only'}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
