#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Keep fixtures in the existing required CI entrypoint. --scan-root scans an
# isolated fixture checkout without recursively running the fixture suite.
if [[ $# == 0 ]]; then
  python3 "$ROOT/ci/test-image-pins.py"
  set -- "$ROOT"
elif [[ $# == 2 && $1 == --scan-root ]]; then
  set -- "$2"
else
  echo 'usage: check-image-pins.sh [--scan-root <checkout>]' >&2
  exit 2
fi

python3 - "$1" <<'PY'
"""Static image-reference checks; never evaluate shell or expand environment values.

Scope: Git-tracked Dockerfile / Dockerfile.* / *.Dockerfile files, *compose*.yml
and *compose*.yaml files, .github/workflows YAML, *.sh and executable shell-
shebang files, and .env / .env.* / *.env files, anywhere in the checkout.
Markdown, arbitrary YAML/source files, untracked/generated files, comments and
literal shell strings/heredocs are not operational image declarations.

Inspect Dockerfile FROM and external COPY --from, Compose/workflow image fields,
workflow container/docker:// fields and shell run blocks, docker [container]
run/create/pull (also docker image pull), and the two supported image overrides
in env files. This is a bounded static parser, not a shell/YAML interpreter;
computed commands, sourced values and arbitrary eval are outside its scope.
"""

import json
import re
import shlex
import subprocess
import sys
from pathlib import Path


root = Path(sys.argv[1]).resolve()
errors = []
digest = re.compile(r'''[^@\s="'\\]+@sha256:[0-9a-f]{64}''')
overrides = {'FERRUM_EDGE_IMAGE', 'NEXUS_IMAGE'}


def report(path, line, message):
    errors.append(f'{path}:{line}: {message}')


def check_image(path, line, image, local_image=None):
    # Runtime overrides are allowed, but every literal fallback is checked.
    variable = re.fullmatch(r'\$\{(\w+)(?::?\?[^}]*)?\}|\$(\w+)', image)
    if variable and (variable[1] or variable[2]) in overrides:
        return
    fallback = re.fullmatch(r'\$\{\w+:?-(.+)\}', image)
    if fallback:
        check_image(path, line, fallback[1], local_image)
        return
    # An option-valued default cannot establish Docker's image position, even
    # when an environment/label value in that option contains a full digest.
    if image.startswith('-'):
        report(path, line, f'ambiguous image argument: {image}')
        return
    if image == local_image:
        return
    if '${{' not in image and digest.fullmatch(image):
        return
    report(path, line, f'unpinned image reference: {image or "<empty>"}')


class ShellLexer:
    """Collect words, command boundaries and nested command substitutions.

    Parameter expansions stay single words. Single quotes and heredoc bodies
    are data; double quotes still permit substitutions. No token is executed.
    """

    def __init__(self, source, line=1):
        self.source = source
        self.pos = 0
        self.line = line
        self.nested = []
        self.delimiters = []

    def take(self):
        char = self.source[self.pos]
        self.pos += 1
        self.line += char == '\n'
        return char

    def substitution(self, end):
        start = self.pos
        tokens = self.tokens(end)
        self.nested.append(tokens)
        return self.source[start:self.pos]

    def word(self, end=None):
        value = ''
        quote = None
        quoted = False
        while self.pos < len(self.source):
            char = self.source[self.pos]
            if char == end and not quote:
                break
            if quote != "'" and self.source.startswith('$(', self.pos):
                self.pos += 2
                value += '$(' + self.substitution(')')
            elif quote != "'" and char == '`':
                self.pos += 1
                value += '`' + self.substitution('`')
            elif quote != "'" and self.source.startswith('${', self.pos):
                depth = 0
                parameter_quote = None
                while self.pos < len(self.source):
                    char = self.source[self.pos]
                    if parameter_quote != "'" and char == '\\':
                        value += self.take()
                        if self.pos < len(self.source):
                            value += self.take()
                        continue
                    if parameter_quote != "'" and self.source.startswith('$(', self.pos):
                        self.pos += 2
                        value += '$(' + self.substitution(')')
                        continue
                    if parameter_quote != "'" and char == '`':
                        self.pos += 1
                        value += '`' + self.substitution('`')
                        continue
                    char = self.take()
                    value += char
                    if parameter_quote:
                        if char == parameter_quote:
                            parameter_quote = None
                    elif char == '"' or (char == "'" and quote != '"'):
                        parameter_quote = char
                    else:
                        depth += char == '{'
                        depth -= char == '}'
                    if char == '}' and depth == 0:
                        break
            elif char == '\\' and quote != "'":
                self.take()
                if self.pos < len(self.source):
                    escaped = self.take()
                    if escaped != '\n':
                        value += escaped
                quoted = True
            elif quote:
                self.take()
                if char == quote:
                    quote = None
                else:
                    value += char
            elif char in "\"'":
                quote = self.take()
                quoted = True
            elif char.isspace() or char in ';|&()<>{}':
                break
            else:
                value += self.take()
        return value, quoted

    def tokens(self, end=None):
        tokens = []
        heredocs = []
        while self.pos < len(self.source):
            char = self.source[self.pos]
            if char == end:
                self.take()
                break
            if char in ' \t\r':
                self.take()
            elif self.source.startswith('\\\n', self.pos):
                self.take()
                self.take()
            elif char == '#':
                while self.pos < len(self.source) and self.source[self.pos] != '\n':
                    self.take()
            elif char == '\n':
                tokens.append(('\n', self.line, 'separator'))
                self.take()
                for delimiter, strip_tabs, quoted in heredocs:
                    body = ''
                    body_line = self.line
                    while self.pos < len(self.source):
                        start = self.pos
                        while self.pos < len(self.source) and self.take() != '\n':
                            pass
                        row = self.source[start:self.pos]
                        if (row.lstrip('\t') if strip_tabs else row).rstrip('\n') == delimiter:
                            break
                        body += row
                    # Unquoted heredocs expand substitutions, but their plain
                    # text (including docker prose) is never a shell command.
                    if not quoted:
                        expansion = ShellLexer(body, body_line)
                        while expansion.pos < len(body):
                            if body.startswith('$(', expansion.pos):
                                expansion.pos += 2
                                expansion.substitution(')')
                            elif body[expansion.pos] == '`':
                                expansion.pos += 1
                                expansion.substitution('`')
                            elif body[expansion.pos] == '\\':
                                expansion.take()
                                if expansion.pos < len(body):
                                    expansion.take()
                            else:
                                expansion.take()
                        self.nested.extend(expansion.nested)
                heredocs = []
            elif self.source.startswith('<<', self.pos) and not self.source.startswith('<<<', self.pos):
                self.pos += 2
                strip_tabs = self.source.startswith('-', self.pos)
                self.pos += strip_tabs
                while self.pos < len(self.source) and self.source[self.pos] in ' \t':
                    self.take()
                delimiter, quoted = self.word()
                heredocs.append((delimiter, strip_tabs, quoted))
                self.delimiters.append((delimiter, strip_tabs))
                tokens.append(('<', self.line, 'redirect'))
                tokens.append((delimiter, self.line, 'word'))
            elif char in '<>':
                if tokens and tokens[-1][0].isdigit() and self.source[self.pos - 1].isdigit():
                    tokens.pop()
                operator = next(
                    (op for op in ('<<<', '>>', '>&', '<&', '<>', '>|')
                     if self.source.startswith(op, self.pos)),
                    char,
                )
                self.pos += len(operator)
                tokens.append((operator, self.line, 'redirect'))
            elif char in ';|&(){}':
                # Parenthesized groups inside $(...) must not close it early.
                if char == '(':
                    self.take()
                    self.nested.append(self.tokens(')'))
                else:
                    tokens.append((self.take(), self.line, 'separator'))
            else:
                line = self.line
                word, _ = self.word(end)
                tokens.append((word, line, 'word'))
        return tokens


# Parse flags only before the image argument. Unknown Docker flags fail closed
# rather than guessing that an option's value is the image reference.
global_values = set('''
--config --context -c --host -H --log-level -l --tlscacert --tlscert --tlskey
'''.split())
global_switches = set('--debug -D --tls --tlsverify'.split())
run_values = set('''
--add-host --annotation --attach -a --blkio-weight --blkio-weight-device
--cap-add --cap-drop --cgroup-parent --cgroupns --cidfile --cpu-period --cpu-quota
--cpu-rt-period --cpu-rt-runtime --cpu-shares -c --cpus --cpuset-cpus --cpuset-mems
--device --device-cgroup-rule --device-read-bps --device-read-iops --device-write-bps
--device-write-iops --dns --dns-option --dns-search --domainname --entrypoint --env -e
--env-file --expose --gpus --group-add --health-cmd --health-interval --health-retries
--health-start-interval --health-start-period --health-timeout --hostname -h --ip --ip6
--ipc --isolation --label -l --label-file --link --link-local-ip --log-driver --log-opt
--mac-address --memory -m --memory-reservation --memory-swap --memory-swappiness
--mount --name --network --network-alias --oom-score-adj --pid --pids-limit --platform
--publish -p --pull --restart --runtime --security-opt --shm-size --stop-signal
--stop-timeout --storage-opt --sysctl --tmpfs --ulimit --user -u --userns --uts
--volume -v --volume-driver --volumes-from --workdir -w
'''.split())
run_switches = set('''
--detach -d --disable-content-trust --init --interactive -i --no-healthcheck
--oom-kill-disable --privileged --publish-all -P --read-only --rm --sig-proxy --tty -t
'''.split())
pull_values = {'--platform'}
pull_switches = {'--all-tags', '-a', '--disable-content-trust', '--quiet', '-q'}


def skip_options(words, pos, values, switches, command='Docker'):
    while pos < len(words) and words[pos].startswith('-'):
        option = words[pos]
        pos += 1
        if option == '--':
            break
        flag, equal, _ = option.partition('=')
        if flag in values:
            pos += not equal
        elif flag in switches:
            pass
        elif option.startswith('--'):
            raise ValueError(f'unsupported {command} option: {option}')
        else:
            for index, char in enumerate(option[1:], 1):
                flag = '-' + char
                if flag in values:
                    pos += index == len(option) - 1
                    break
                if flag not in switches:
                    raise ValueError(f'unsupported {command} option: {option}')
    return pos


def shell_command(path, command):
    words = [value for value, _, kind in command if kind == 'word']
    if not words:
        return
    pos = 0
    line = command[0][1]
    # A docker word passed to echo/printf/grep, etc. is data, not a command.
    prefixes = {
        'if', 'then', 'elif', 'else', 'while', 'until', 'do', '!',
    }
    while pos < len(words):
        if words[pos] in prefixes or re.match(r'\w+=', words[pos]):
            pos += 1
        elif words[pos] in {'exec', 'command', 'time', 'nohup'}:
            wrapper = words[pos]
            start = pos + 1
            if start < len(words) and words[start] in {'--help', '--version'}:
                return
            values = {
                'exec': {'-a'},
                'command': set(),
                'time': {'-f', '--format', '-o', '--output'},
                'nohup': set(),
            }[wrapper]
            switches = {
                'exec': {'-c', '-l'},
                'command': {'-p', '-v', '-V'},
                'time': {
                    '-p', '--portability', '-a', '--append', '-v', '--verbose', '-q', '--quiet',
                },
                'nohup': set(),
            }[wrapper]
            try:
                pos = skip_options(words, start, values, switches, wrapper)
            except ValueError as error:
                report(path, line, str(error))
                return
            # command -v/-V describes a command; it does not execute it.
            if wrapper == 'command' and any(
                set(option[1:]) & {'v', 'V'} for option in words[start:pos]
                if option != '--'
            ):
                return
        elif words[pos] == 'sudo':
            pos += 1
            while pos < len(words) and words[pos].startswith('-'):
                pos += 2 if words[pos] in {'-u', '-g', '--user', '--group'} else 1
        elif words[pos] == 'env':
            pos += 1
            while pos < len(words) and words[pos].startswith('-'):
                pos += 2 if words[pos] in {'-u', '--unset', '-C', '--chdir'} else 1
        else:
            break
    if pos >= len(words) or words[pos] != 'docker':
        return
    try:
        pos = skip_options(words, pos + 1, global_values, global_switches)
        if pos < len(words) and words[pos] in {'container', 'image'}:
            group = words[pos]
            pos += 1
        else:
            group = None
        if pos >= len(words) or words[pos] not in {'run', 'create', 'pull'}:
            return
        operation = words[pos]
        if group == 'image' and operation != 'pull':
            return
        values, switches = (
            (pull_values, pull_switches) if operation == 'pull' else (run_values, run_switches)
        )
        pos = skip_options(words, pos + 1, values, switches)
        image = words[pos] if pos < len(words) else ''
        local = (
            'ferrum-nexus:ci' if path == '.github/workflows/ci.yml' and operation == 'run'
            else None
        )
        check_image(path, line, image, local)
    except ValueError as error:
        report(path, line, str(error))


def scan_shell(path, source, line=1):
    lexer = ShellLexer(source, line)
    groups = [lexer.tokens(), *lexer.nested]
    for tokens in groups:
        command = []
        for token in [*tokens, ('\n', line, 'separator')]:
            if token[2] == 'separator':
                shell_command(path, command)
                command = []
            elif token[2] == 'redirect':
                command.append(token)
            elif command and command[-1][2] == 'redirect':
                command.pop()
            else:
                command.append(token)


def dockerfile_heredocs(row):
    # BuildKit permits heredocs only in non-JSON ADD/COPY/RUN instructions
    # (including ONBUILD), and only words beginning with [fd]<< are markers.
    instruction = re.match(r'^\s*(?:ONBUILD\s+)?(?:ADD|COPY|RUN)\s+(.*)', row, re.IGNORECASE)
    if not instruction:
        return []
    words = re.findall(r'''(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+''', instruction[1])
    pos = 0
    while pos < len(words) and words[pos].startswith('--'):
        pos += 1
    if pos < len(words) and words[pos].startswith('['):
        return []
    delimiters = []
    for word in words[pos:]:
        marker = re.fullmatch(r'\d*<<(-?)([^<]+)', word)
        if not marker:
            continue
        try:
            delimiter = shlex.split(marker[2])
        except ValueError:
            continue
        if len(delimiter) == 1:
            delimiters.append((delimiter[0], bool(marker[1])))
    return delimiters


def logical_lines(source):
    pending = ''
    start = 1
    heredocs = []
    for number, row in enumerate(source.splitlines(), 1):
        if heredocs:
            delimiter, strip_tabs = heredocs[0]
            if (row.lstrip('\t') if strip_tabs else row) == delimiter:
                heredocs.pop(0)
            continue
        if not pending:
            start = number
        if row.lstrip().startswith('#'):
            continue
        pending += row.rstrip('\\').strip() + ' ' if row.endswith('\\') else row
        if not row.endswith('\\'):
            heredocs = dockerfile_heredocs(pending)
            yield start, pending
            pending = ''
    if pending:
        yield start, pending


def scan_dockerfile(path, source):
    stages = set()
    for line, row in logical_lines(source):
        if not re.match(r'^\s*(FROM|COPY)\s', row, re.IGNORECASE):
            continue
        try:
            words = shlex.split(row)
        except ValueError:
            report(path, line, 'cannot parse Dockerfile instruction')
            continue
        if not words:
            continue
        instruction = words[0].lower()
        if instruction == 'from':
            pos = 1
            while pos < len(words) and words[pos].startswith('--'):
                pos += 1 if '=' in words[pos] else 2
            image = words[pos] if pos < len(words) else ''
            if image.lower() != 'scratch' and image.lower() not in stages:
                check_image(path, line, image)
            if len(words) > pos + 2 and words[pos + 1].lower() == 'as':
                stages.add(words[pos + 2].lower())
        elif instruction == 'copy':
            for pos, word in enumerate(words[1:], 1):
                if word.lower().startswith('--from='):
                    image = word.split('=', 1)[1]
                elif word.lower() == '--from' and pos + 1 < len(words):
                    image = words[pos + 1]
                else:
                    continue
                if not image.isdigit() and image.lower() not in stages:
                    check_image(path, line, image)


def yaml_scalar(value, flow=False):
    value = value.strip()
    if value.startswith("'"):
        match = re.match(r"'((?:[^']|'')*)'", value)
        return match[1].replace("''", "'") if match else value
    if value.startswith('"'):
        try:
            return json.JSONDecoder().raw_decode(value)[0]
        except ValueError:
            return value
    value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
    if flow:
        depth = 0
        for pos, char in enumerate(value):
            if char in ',}]' and depth == 0:
                return value[:pos].strip()
            depth += char == '{'
            depth -= char == '}'
    return value


def yaml_code(row):
    # Mask strings/comments while retaining offsets for finding flow-map keys.
    quote = None
    masked = list(row)
    pos = 0
    while pos < len(row):
        char = row[pos]
        if quote:
            masked[pos] = ' '
            if quote == '"' and char == '\\' and pos + 1 < len(row):
                pos += 1
                masked[pos] = ' '
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
            masked[pos] = ' '
        elif char == '#' and (pos == 0 or row[pos - 1].isspace()):
            masked[pos:] = ' ' * (len(row) - pos)
            break
        pos += 1
    return ''.join(masked)


def yaml_block(rows, pos, indent, folded):
    block = []
    while pos < len(rows):
        row = rows[pos]
        if row.strip() and len(row) - len(row.lstrip()) <= indent:
            break
        block.append(row)
        pos += 1
    width = min((len(row) - len(row.lstrip()) for row in block if row.strip()), default=0)
    block = [row[width:] for row in block]
    value = ''
    for index, row in enumerate(block):
        value += row
        following = block[index + 1] if index + 1 < len(block) else ''
        # YAML folds adjacent ordinary lines into spaces; blank and more-
        # indented lines retain command boundaries, including shell comments.
        ordinary = row and following and not row[0].isspace() and not following[0].isspace()
        value += ' ' if folded and ordinary else '\n'
    return value, pos


yaml_key = r'''(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[\w-]+)'''
yaml_mapping = re.compile(rf'^(\s*)(?:-\s+)?({yaml_key})\s*:\s*(.*)')


def check_yaml_field(path, line, kind, value, workflow, flow=False):
    value = value.strip()
    scalar = yaml_scalar(value, flow)
    if kind == 'run' and workflow:
        scan_shell(path, scalar, line)
    elif kind == 'image' or (kind == 'container' and value and not value.startswith('{')):
        local = 'ferrum-nexus:e2e' if path == 'e2e/docker-compose.yml' else None
        check_image(path, line, scalar, local)
    elif kind == 'uses' and scalar.startswith('docker://'):
        check_image(path, line, scalar[len('docker://'):])


def scan_yaml(path, source, workflow):
    rows = source.splitlines()
    pos = 0
    while pos < len(rows):
        row = rows[pos]
        line = pos + 1
        pos += 1
        if not row.strip() or row.lstrip().startswith('#'):
            continue
        field = yaml_mapping.match(row)
        kind = yaml_scalar(field[2]) if field else None
        indent = len(row) - len(row.lstrip()) + (2 if row.lstrip().startswith('- ') else 0)
        if kind == 'run' and workflow:
            value = field[3]
            if value.startswith(('|', '>')):
                source, pos = yaml_block(rows, pos, indent, value.startswith('>'))
                scan_shell(path, source, line + 1)
            else:
                scan_shell(path, yaml_scalar(value), line)
            continue
        # Other block scalars contain data, e.g. prose in workflow name: |.
        block = field and re.fullmatch(r'[|>][-+0-9]*\s*(?:#.*)?', field[3])
        if not field:
            block = re.match(r'^\s*(?:-\s+)?[^:]+:\s*[|>][-+0-9]*\s*(?:#.*)?$', row)
        if block:
            value, pos = yaml_block(rows, pos, indent, '>' in row)
            check_yaml_field(path, line, kind, value.strip(), workflow)
            continue
        if field and kind != 'run':
            check_yaml_field(path, line, kind, field[3], workflow)
        code = yaml_code(row)
        value = field[3].lstrip() if field else re.sub(r'^\s*(?:-\s+)?', '', row)
        if value.startswith(('{', '[')):
            for flow in re.finditer(rf'(?:\{{|\[|,)\s*({yaml_key})\s*:', row):
                # The delimiter and colon must be outside strings/comments;
                # quoted mapping keys themselves are decoded from the row.
                if code[flow.start()] not in '{[,' or code[flow.end() - 1] != ':':
                    continue
                check_yaml_field(
                    path, line, yaml_scalar(flow[1]), row[flow.end():], workflow, flow=True,
                )


files = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
for path in sorted(filter(None, files)):
    if path == 'ci/check-image-pins.sh':
        continue
    file = root / path
    if not file.is_file():
        continue
    name = file.name.lower()
    dockerfile = (
        name == 'dockerfile' or name.startswith('dockerfile.') or name.endswith('.dockerfile')
    )
    yaml = name.endswith(('.yml', '.yaml'))
    workflow = path.startswith('.github/workflows/') and yaml
    compose = 'compose' in name and yaml
    env = name == '.env' or name.startswith('.env.') or name.endswith('.env')
    shell = name.endswith('.sh')
    if not (dockerfile or workflow or compose or env or shell or file.stat().st_mode & 0o111):
        continue
    try:
        source = file.read_text()
    except UnicodeDecodeError:
        if dockerfile or workflow or compose or env or shell:
            report(path, 1, 'operational file must be UTF-8 text')
        continue
    if dockerfile:
        scan_dockerfile(path, source)
    elif workflow or compose:
        scan_yaml(path, source, workflow)
    elif env:
        for line, row in enumerate(source.splitlines(), 1):
            match = re.match(
                r'^\s*(?:export\s+)?(FERRUM_EDGE_IMAGE|NEXUS_IMAGE)\s*[=:]\s*(.*)', row,
            )
            if match and match[2].strip():
                local = 'ferrum-nexus:e2e' if path == 'e2e/.env.example' else None
                check_image(path, line, yaml_scalar(match[2]), local)
    elif shell or re.match(r'^#![^\n]*\b(?:bash|sh|dash|ksh|zsh)\b', source):
        scan_shell(path, source)

if errors:
    print('::error::Pin every container image reference to a full registry digest:')
    print('\n'.join(errors))
    sys.exit(1)
PY
