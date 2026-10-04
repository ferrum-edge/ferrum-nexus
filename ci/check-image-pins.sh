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
        if end == '`':
            # Bash removes one escape layer before parsing a backtick body.
            # In particular, \` inside it becomes an active nested backtick,
            # while an escaped backtick outside a substitution stays data.
            line = self.line
            body = ''
            while self.pos < len(self.source):
                char = self.take()
                if char == '`':
                    break
                if char == '\\' and self.pos < len(self.source):
                    following = self.source[self.pos]
                    if following in '$`\\':
                        char = self.take()
                body += char
            nested = ShellLexer(body, line)
            self.nested.append(nested.tokens())
            self.nested.extend(nested.nested)
            return self.source[start:self.pos]
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
    try:
        groups = [lexer.tokens(), *lexer.nested]
    except RecursionError:
        report(path, line, 'shell nesting exceeds scanner limit')
        return
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
        # Fold ordinary lines, preserving blank/more-indented boundaries.
        ordinary = row and following and not row[0].isspace() and not following[0].isspace()
        value += ' ' if folded and ordinary else '\n'
    return value, pos


class YamlError(ValueError):
    def __init__(self, line, message):
        super().__init__(message)
        self.line = line


class YamlNode:
    def __init__(self, kind, value, line):
        self.kind = kind
        self.value = value
        self.line = line


def yaml_fold(value):
    def fold(match):
        count = match[0].count('\n')
        return ' ' if count == 1 else '\n' * (count - 1)

    return re.sub(r'[ \t]*\n(?:[ \t]*\n)*[ \t]*', fold, value)


class YamlFlow:
    """Read whole flow collections, including continuations, without evaluation.

    Quoted strings use YAML 1.2.2 sections 5.7/7.3, not JSON escapes.
    Flow collections follow section 7.4, including compact sequence pairs.
    Maps retain all entries so duplicate keys cannot hide an earlier
    unpinned declaration.
    """

    escapes = {
        '0': '\0', 'a': '\a', 'b': '\b', 't': '\t', '\t': '\t', 'n': '\n',
        'v': '\v', 'f': '\f', 'r': '\r', 'e': '\x1b', ' ': ' ', '"': '"',
        '/': '/', '\\': '\\', 'N': '\x85', '_': '\xa0', 'L': '\u2028', 'P': '\u2029',
    }

    def __init__(self, source, line):
        self.source = source
        self.pos = 0
        self.line = line

    def take(self):
        char = self.source[self.pos]
        self.pos += 1
        self.line += char == '\n'
        return char

    def skip(self):
        while self.pos < len(self.source):
            if self.source[self.pos].isspace():
                self.take()
            elif self.source[self.pos] == '#':
                while self.pos < len(self.source) and self.source[self.pos] != '\n':
                    self.take()
            else:
                break

    def line_break(self, escaped=False):
        # The first newline has already been consumed. YAML folds one break
        # to a space, and N empty continuation lines to N newlines.
        count = 0
        while self.pos < len(self.source) and self.source[self.pos] in ' \t\r\n':
            count += self.take() == '\n'
        return '\n' * count if count or escaped else ' '

    def quoted(self):
        quote = self.take()
        value = ''
        while self.pos < len(self.source):
            char = self.take()
            if char == quote:
                if quote == "'" and self.source.startswith("'", self.pos):
                    self.take()
                    value += "'"
                    continue
                return value
            if quote == '"' and char == '\\':
                if self.pos == len(self.source):
                    break
                escape = self.take()
                if escape in self.escapes:
                    value += self.escapes[escape]
                elif escape in 'xuU':
                    width = {'x': 2, 'u': 4, 'U': 8}[escape]
                    digits = self.source[self.pos:self.pos + width]
                    if len(digits) != width or not re.fullmatch('[0-9a-fA-F]+', digits):
                        raise YamlError(self.line, 'invalid YAML hexadecimal escape')
                    number = int(digits, 16)
                    if number > 0x10ffff or 0xd800 <= number <= 0xdfff:
                        raise YamlError(self.line, 'invalid YAML Unicode escape')
                    self.pos += width
                    value += chr(number)
                elif escape == '\n':
                    value += self.line_break(escaped=True)
                else:
                    raise YamlError(self.line, f'unsupported YAML escape: \\{escape}')
            elif char == '\n':
                value = value.rstrip(' \t') + self.line_break()
            else:
                value += char
        raise YamlError(self.line, 'unterminated YAML quoted scalar')

    def key(self):
        quoted = self.pos < len(self.source) and self.source[self.pos] in "\"'"
        if quoted:
            key = self.quoted()
        else:
            start = self.pos
            while self.pos < len(self.source) and self.source[self.pos] not in ':,{}[]\n':
                self.take()
            key = self.source[start:self.pos].strip()
        self.skip()
        if not key or self.pos == len(self.source) or self.take() != ':':
            raise YamlError(self.line, 'unsupported YAML mapping key')
        if not quoted and key.startswith(('?', '&', '*', '!')):
            raise YamlError(self.line, 'unsupported YAML mapping key')
        return key

    def sequence_entry(self, depth):
        # YAML 7.4.2 permits a single mapping pair without braces inside a
        # flow sequence. Recognize only a real value indicator: colons in
        # plain image tags, URLs and port mappings remain scalar content.
        self.skip()
        start, line = self.pos, self.line
        key = self.node(depth, implicit_key=True)
        self.skip()
        if self.pos == len(self.source) or self.source[self.pos] != ':':
            return key
        if '\n' in self.source[start:self.pos] or self.pos - start > 1024:
            raise YamlError(line, 'unsupported YAML compact mapping key')
        self.take()
        self.skip()
        value = (
            YamlNode('scalar', '', self.line)
            if self.pos < len(self.source) and self.source[self.pos] in ',]'
            else self.node(depth + 1)
        )
        if key.kind != 'scalar':
            return YamlNode('unsupported', 'complex YAML compact mapping key', line)
        return YamlNode('mapping', [(key.value, value)], line)

    def node(self, depth=0, implicit_key=False):
        if depth > 64:
            raise YamlError(self.line, 'YAML nesting exceeds scanner limit')
        self.skip()
        line = self.line
        if self.pos == len(self.source):
            raise YamlError(line, 'incomplete YAML flow collection')
        char = self.source[self.pos]
        if char in '{[':
            self.take()
            mapping = char == '{'
            end = '}' if mapping else ']'
            entries = []
            self.skip()
            while self.pos < len(self.source) and self.source[self.pos] != end:
                if mapping:
                    key = self.key()
                    self.skip()
                    value = (
                        YamlNode('scalar', '', self.line)
                        if self.pos < len(self.source) and self.source[self.pos] in ',}'
                        else self.node(depth + 1)
                    )
                    entries.append((key, value))
                else:
                    entries.append(self.sequence_entry(depth + 1))
                self.skip()
                if self.pos < len(self.source) and self.source[self.pos] == ',':
                    self.take()
                    self.skip()
                elif self.pos == len(self.source) or self.source[self.pos] != end:
                    raise YamlError(self.line, 'expected YAML flow comma or closing delimiter')
            if self.pos == len(self.source):
                raise YamlError(self.line, 'unterminated YAML flow collection')
            self.take()
            return YamlNode('mapping' if mapping else 'sequence', entries, line)
        if char in "\"'":
            return YamlNode('scalar', self.quoted(), line)
        if char in '&!':
            # Consume a property and its node, even in inert metadata, so a
            # multiline collection cannot leak into a different context.
            start = self.pos
            while self.pos < len(self.source) and (
                not self.source[self.pos].isspace() and self.source[self.pos] not in ',{}[]'
            ):
                self.take()
            marker = self.source[start:self.pos]
            self.skip()
            if self.pos < len(self.source) and self.source[self.pos] not in ',}]':
                self.node(depth + 1)
            return YamlNode('unsupported', marker, line)
        start = self.pos
        while self.pos < len(self.source) and self.source[self.pos] not in ',{}[]':
            char = self.source[self.pos]
            if char == '#' and (self.pos == start or self.source[self.pos - 1].isspace()):
                break
            if implicit_key and char == ':' and (
                self.pos + 1 == len(self.source)
                or self.source[self.pos + 1].isspace()
                or self.source[self.pos + 1] in ',{}[]'
            ):
                break
            self.take()
        value = yaml_fold(self.source[start:self.pos].strip())
        if not value:
            raise YamlError(line, 'unsupported YAML flow scalar')
        kind = 'unsupported' if value.startswith(('*', '&', '!', '?')) else 'scalar'
        return YamlNode(kind, value, line)


# A leading quote commits to a quoted key. Never fall back to a plain key
# ending at a colon inside a quoted scalar (e.g. a block sequence port).
yaml_key = r'''(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|(?!["'])[^:{}\[\],#]+?)'''
yaml_mapping = re.compile(rf'^({yaml_key})\s*:(.*)')


def yaml_field(text):
    field = yaml_mapping.match(text)
    # Colons inside plain strings (e.g. port mappings) are not map entries.
    if field and (
        field[1].startswith(('"', "'")) or not field[2]
        or field[2][0].isspace() or field[2][0] in '{['
    ):
        return field
    return None


class YamlParser:
    """Bounded YAML grammar: block/flow maps and sequences, scalar keys,
    plain/single/double-quoted scalars and literal/folded block scalars.

    No aliases, anchors, tags, merge keys or explicit/complex mapping keys
    are resolved. Operational nodes using those forms fail closed. Metadata
    is parsed for structure but never visited as image or executable fields.
    Nesting is limited to 64 levels; unsupported syntax is diagnosed.
    """

    def __init__(self, source):
        self.rows = source.splitlines()
        self.pos = 0

    def peek(self):
        while self.pos < len(self.rows):
            row = self.rows[self.pos]
            if not row.strip() or row.lstrip().startswith('#'):
                self.pos += 1
            else:
                width = len(row) - len(row.lstrip())
                if '\t' in row[:width]:
                    raise YamlError(self.pos + 1, 'unsupported YAML tab indentation')
                return width, row.lstrip()
        return -1, ''

    def value(self, text, line, indent, depth):
        if not text or text.startswith('#'):
            width, row = self.peek()
            if width > indent or (width == indent and re.match(r'-(?:\s|$)', row)):
                return self.block(width, depth + 1)
            return YamlNode('scalar', '', line)
        if re.fullmatch(r'[|>][-+1-9]*\s*(?:#.*)?', text):
            value, self.pos = yaml_block(self.rows, self.pos, indent, text.startswith('>'))
            return YamlNode('scalar', value, line + 1)
        if text.startswith(('{', '[', '"', "'")):
            flow = YamlFlow('\n'.join([text, *self.rows[self.pos:]]), line)
            node = flow.node(depth)
            self.pos += flow.source[:flow.pos].count('\n')
            suffix = flow.source[flow.pos:].split('\n', 1)[0].strip()
            if suffix and not suffix.startswith('#'):
                raise YamlError(flow.line, 'unexpected content after YAML value')
            return node
        value = re.split(r'\s+#', text, maxsplit=1)[0].strip()
        if value.startswith(('*', '&', '!', '?')):
            # Consume any child collection so it cannot escape this node's
            # context; the visitor rejects the unresolved operational value.
            property_value = re.match(r'^[&!][^\s{}\[\],]*\s*(.*)', text)
            if property_value:
                self.value(property_value[1], line, indent, depth + 1)
            else:
                width, _ = self.peek()
                if width > indent:
                    self.block(width, depth + 1)
            return YamlNode('unsupported', value, line)
        continuation = []
        while self.pos < len(self.rows):
            row = self.rows[self.pos]
            if row.strip() and len(row) - len(row.lstrip()) <= indent:
                break
            if not row.lstrip().startswith('#'):
                continuation.append(re.split(r'\s+#', row, maxsplit=1)[0])
            self.pos += 1
        if continuation:
            value = yaml_fold(value + '\n' + '\n'.join(continuation)).strip()
        return YamlNode('scalar', value, line)

    def mapping_entry(self, text, line, indent, depth):
        field = yaml_field(text)
        if not field:
            raise YamlError(line, 'unsupported YAML block mapping')
        key = field[1].strip()
        if key.startswith(('"', "'")):
            key = YamlFlow(key, line).quoted()
        elif key.startswith(('?', '&', '*', '!')):
            raise YamlError(line, 'unsupported YAML mapping key')
        return key, self.value(field[2].lstrip(), line, indent, depth)

    def block(self, indent, depth=0, first=None):
        if depth > 64:
            raise YamlError(self.pos + 1, 'YAML nesting exceeds scanner limit')
        _, row = self.peek() if first is None else (indent, first[0])
        sequence = bool(re.match(r'-(?:\s|$)', row))
        if first is None and not sequence and not yaml_field(row):
            line = self.pos + 1
            self.pos += 1
            return self.value(row, line, indent, depth)
        entries = []
        line = first[1] if first else self.pos + 1
        while True:
            if first:
                text, number = first
                first = None
            else:
                width, text = self.peek()
                if width != indent or text in {'---', '...'}:
                    break
                number = self.pos + 1
                self.pos += 1
            if sequence:
                marker = re.match(r'-(?:\s+|$)', text)
                if not marker:
                    raise YamlError(number, 'mixed YAML mapping and sequence')
                item = text[marker.end():]
                if yaml_field(item):
                    node = self.block(
                        indent + marker.end(), depth + 1, first=(item, number),
                    )
                else:
                    node = self.value(item, number, indent, depth)
                entries.append(node)
            else:
                entries.append(self.mapping_entry(text, number, indent, depth))
        return YamlNode('sequence' if sequence else 'mapping', entries, line)

    def documents(self):
        while True:
            width, row = self.peek()
            if width < 0:
                return
            if row in {'---', '...'}:
                self.pos += 1
                continue
            if row.startswith(('{', '[')):
                line = self.pos + 1
                self.pos += 1
                yield self.value(row, line, width, 0)
            else:
                yield self.block(width)


def yaml_context(parent, key, workflow):
    if parent == 'root':
        return {
            'jobs': 'jobs' if workflow else None,
            'steps': 'steps' if workflow else None,
            'services': 'services',
            'container': 'container' if workflow else None,
            # Preserve isolated declarations/step fragments used by fixtures,
            # without extending that scope into metadata.
            'image': 'image',
            'run': 'run' if workflow else None,
            'uses': 'uses' if workflow else None,
        }.get(key)
    if parent == 'jobs':
        return 'job'
    if parent == 'services':
        return 'service'
    if parent == 'job':
        return {
            'steps': 'steps', 'services': 'services', 'container': 'container',
        }.get(key)
    if parent in {'service', 'container'}:
        return 'image' if key == 'image' else None
    if parent == 'step':
        return {'run': 'run', 'uses': 'uses', 'parallel': 'parallel'}.get(key)
    return None


def visit_yaml(path, node, context, workflow):
    if context is None:
        return
    if node.kind == 'unsupported':
        report(path, node.line, 'unsupported operational YAML value')
        return
    if context in {'steps', 'parallel'} and node.kind != 'sequence':
        report(path, node.line, f'expected YAML sequence for {context}')
        return
    if context == 'step' and node.kind != 'mapping':
        report(path, node.line, 'expected YAML mapping for step')
        return
    if node.kind == 'mapping':
        if context in {'image', 'run', 'uses'}:
            report(path, node.line, f'expected YAML scalar for {context}')
            return
        for key, child in node.value:
            if key == '<<':
                report(path, child.line, 'unsupported operational YAML merge key')
            else:
                visit_yaml(path, child, yaml_context(context, key, workflow), workflow)
    elif node.kind == 'sequence':
        child_context = 'step' if workflow and context in {'root', 'steps', 'parallel'} else None
        if child_context is None:
            report(path, node.line, f'unsupported operational YAML sequence for {context}')
        else:
            for child in node.value:
                visit_yaml(path, child, child_context, workflow)
    elif context == 'run':
        scan_shell(path, node.value, node.line)
    elif context in {'image', 'container'}:
        local = 'ferrum-nexus:e2e' if path == 'e2e/docker-compose.yml' else None
        check_image(path, node.line, node.value.strip(), local)
    elif context == 'uses' and node.value.startswith('docker://'):
        check_image(path, node.line, node.value[len('docker://'):])
    elif context not in {'root', 'uses'} and node.value:
        report(path, node.line, f'expected YAML collection for {context}')


def scan_yaml(path, source, workflow):
    try:
        for document in YamlParser(source).documents():
            visit_yaml(path, document, 'root', workflow)
    except YamlError as error:
        report(path, error.line, str(error))
    except RecursionError:
        report(path, 1, 'YAML nesting exceeds scanner limit')


def dotenv_unescape(value):
    # Compose's dotenv grammar uses shell escapes, not YAML/JSON escapes.
    escapes = {
        'a': '\a', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t',
        'v': '\v', '"': '"', '\\': '\\', '$': '$$',
    }

    def decode(match):
        escape = match[0][1:]
        if escape in escapes:
            return escapes[escape]
        if re.fullmatch(r'0[0-7]{3}', escape) and int(escape[1:], 8) <= 255:
            return chr(int(escape[1:], 8))
        return match[0]

    return re.sub(r'\\(?:[abfnrtv$"\\]|0\d{0,3})', decode, value)


def scan_env(path, source):
    """Read the entire Compose dotenv assignment stream, never shell commands.

    Like compose-go/dotenv/parser.go's locateKeyName/extractVarValue,
    both separators, optional export, horizontal whitespace and multiline
    quoted values are supported. Parsing resumes after a closing quote,
    including on the same line. Unknown suffix syntax is refused instead of
    dropping it; quoted prose in unrelated variables stays inert.
    """
    pos = 0
    line = 1
    local = 'ferrum-nexus:e2e' if path == 'e2e/.env.example' else None
    while pos < len(source):
        if source[pos].isspace():
            line += source[pos] == '\n'
            pos += 1
            continue
        if source[pos] == '#':
            end = source.find('\n', pos)
            pos = len(source) if end < 0 else end
            continue
        number = line
        export = re.match(r'export[^\S\n]+', source[pos:])
        if export:
            pos += export.end()
        key = re.match(r'[\w.\[\]-]+', source[pos:])
        if not key:
            report(path, line, 'unsupported dotenv assignment stream')
            return
        name = key[0]
        pos += key.end()
        while pos < len(source) and source[pos].isspace() and source[pos] != '\n':
            pos += 1
        # A bare key inherits the caller's value; it declares no literal pin.
        if pos == len(source) or source[pos] == '\n':
            continue
        if source[pos] not in '=:':
            report(path, line, 'unsupported dotenv assignment stream')
            return
        pos += 1
        while pos < len(source) and source[pos].isspace() and source[pos] != '\n':
            pos += 1
        if pos < len(source) and source[pos] in "\"'":
            quote = source[pos]
            pos += 1
            value = ''
            while pos < len(source):
                char = source[pos]
                pos += 1
                line += char == '\n'
                if char == quote:
                    break
                if char == '\\' and pos < len(source):
                    escaped = source[pos]
                    pos += 1
                    line += escaped == '\n'
                    value += escaped if escaped == quote else '\\' + escaped
                else:
                    value += char
            else:
                report(path, number, 'unterminated dotenv quoted value')
                return
            if quote == '"':
                value = dotenv_unescape(value)
        else:
            end = source.find('\n', pos)
            end = len(source) if end < 0 else end
            value = source[pos:end].split(' #', 1)[0].rstrip()
            pos = end
        if name in overrides and value.strip():
            check_image(path, number, value, local)


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
        scan_env(path, source)
    elif shell or re.match(r'^#![^\n]*\b(?:bash|sh|dash|ksh|zsh)\b', source):
        scan_shell(path, source)

if errors:
    print('::error::Pin every container image reference to a full registry digest:')
    print('\n'.join(errors))
    sys.exit(1)
PY
