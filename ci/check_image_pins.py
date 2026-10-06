#!/usr/bin/env python3
"""Check image fields in tracked workflows, Compose files, and Dockerfiles."""

import re
import shlex
import subprocess
import sys
from pathlib import Path


# Non-semver tags are documented upstream distro/major channels; digest pins bytes.
TAG_EXCEPTIONS = {
    'node:22-bookworm-slim': 'Node 22 Bookworm distro channel.',
    'postgres:16': 'PostgreSQL 16 major channel.',
    'mysql:8.4': 'MySQL 8.4 LTS channel.',
    'mongo:7': 'MongoDB 7 major channel.',
    'postgres:18-alpine': 'PostgreSQL 18 Alpine channel.',
    'axllent/mailpit:v1.31': 'Mailpit two-part release tag.',
    'alpine:3': 'Alpine 3 major channel.',
    'postgres:17-alpine': 'PostgreSQL 17 Alpine channel.',
}

# These Compose values are deliberate runtime inputs; see docs/image-pin-check.md.
REQUIRED_VARIABLE = re.compile(r'^\$\{(FERRUM_EDGE_IMAGE|NEXUS_IMAGE):\?[^}]+\}$')
NEXUS_FALLBACK = re.compile(r'^\$\{NEXUS_IMAGE:-([^}]+)\}$')
LOCAL_IMAGES = {'ferrum-nexus:ci', 'ferrum-nexus:e2e'}
VERSION = re.compile(r'v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\Z')
PIN = re.compile(r'[^\s"\'@$]+(?::[^\s"\'@$]+)?@sha256:[0-9a-f]{64}\Z')
FIELD = re.compile(
    r'(?:^|[\s{,\-])\s*["\']?(image|container)["\']?\s*:\s*'
    r'((?:\$\{[^}]*\}|[^,}#])*?)\s*'
    r'(?=,|}|#|$)',
    re.IGNORECASE,
)


def error_for(image, local_ok=True):
    """Return why `image` is not acceptable, or None. Env files pass local_ok=False."""
    if local_ok and REQUIRED_VARIABLE.fullmatch(image):
        return None
    fallback = NEXUS_FALLBACK.fullmatch(image)
    if local_ok and fallback:
        return error_for(fallback.group(1), local_ok)
    if local_ok and image in LOCAL_IMAGES:
        return None
    if not PIN.fullmatch(image):
        return 'expected name[:tag]@sha256:<64 lowercase hex>'
    name_tag = image.split('@', 1)[0]
    last = name_tag.rsplit('/', 1)[-1]
    tag = last.rsplit(':', 1)[1] if ':' in last else None
    if tag and not VERSION.fullmatch(tag) and name_tag not in TAG_EXCEPTIONS:
        return 'tag must be an exact version or have a documented exception'
    return None


def image_fields(path, source):
    name = path.name.lower()
    if name == 'dockerfile' or name.startswith('dockerfile.') or name.endswith('.dockerfile'):
        for line_no, line in enumerate(source.splitlines(), 1):
            match = re.match(r'^\s*#\s*syntax\s*=\s*([^\s]+)', line, re.I)
            if match:
                yield line_no, match.group(1)
        # Docker ignores comment-only lines between continued instructions.
        source = '\n'.join(
            line for line in source.splitlines() if not line.lstrip().startswith('#')
        )
        logical = re.sub(r'\\\n\s*', ' ', source)
        stages = set()
        for line_no, line in enumerate(logical.splitlines(), 1):
            line = line.split('#', 1)[0].strip()
            match = re.match(r'FROM\s+(?:--\S+\s+)*([^\s]+)(?:\s+AS\s+(\S+))?', line, re.I)
            if match:
                ref, stage = match.groups()
                if ref.lower() != 'scratch' and ref.lower() not in stages:
                    yield line_no, ref
                if stage:
                    stages.add(stage.lower())
            for ref in re.findall(r'--from(?:=|\s+)([^\s]+)', line, re.I):
                if not ref.isdigit() and ref.lower() not in stages:
                    yield line_no, ref
            for mount in re.findall(r'--mount=([^\s]+)', line, re.I):
                match = re.search(r'(?:^|,)from=([^,]+)', mount, re.I)
                if match:
                    ref = match.group(1)
                    if not ref.isdigit() and ref.lower() not in stages:
                        yield line_no, ref
        return
    lines = list(enumerate(source.splitlines(), 1))
    if path.parts[:2] == ('.github', 'workflows'):
        lines = list(workflow_lines(lines))
    for line_no, line in lines:
        for match in FIELD.finditer(line):
            ref = match.group(2).strip().strip("'\"")
            if not ref:
                ref = '<empty image field>'
            yield line_no, ref
        if path.parts[:2] == ('.github', 'workflows'):
            match = re.search(r'\buses\s*:\s*["\']?docker://([^\s"\']+)', line)
            if match:
                yield line_no, match.group(1)
            for ref in workflow_docker_images(line):
                yield line_no, ref


DOCKER_GLOBAL_VALUES = {'--config', '-c', '--context', '--host', '-H', '--log-level'}
DOCKER_GLOBAL_SWITCHES = {'--debug', '--tls', '--tlsverify'}
DOCKER_VALUE_OPTIONS = {
    '--add-host', '--annotation', '--attach', '--blkio-weight', '--cap-add', '--cap-drop',
    '--cgroup-parent', '--device', '--device-cgroup-rule', '--dns', '--dns-option', '--dns-search',
    '--domainname', '--entrypoint', '--env', '-e', '--env-file', '--expose', '--gpus', '--group-add',
    '--health-cmd', '--health-interval', '--health-retries', '--health-start-period',
    '--health-timeout',
    '--hostname', '--ip', '--ip6', '--ipc', '--kernel-memory', '-l', '--label', '--link', '--log-driver',
    '--log-opt', '--mac-address', '--memory', '--memory-reservation', '--memory-swap', '--mount',
    '--name', '--network', '--network-alias', '--pid', '--pids-limit',
    '--platform', '-p', '--publish', '--restart', '--runtime', '--security-opt',
    '--shm-size', '--stop-signal', '--stop-timeout', '--storage-opt', '--sysctl', '--tmpfs', '-u',
    '--ulimit', '--user', '--userns', '--uts', '-v', '--volume', '--volumes-from', '-w', '--workdir',
}
DOCKER_SWITCH_OPTIONS = {
    '--all-tags', '-a', '--detach', '-d', '--help', '--interactive', '-i', '--oom-kill-disable',
    '--privileged',
    '--publish-all', '-P', '--quiet', '-q', '--rm', '--sig-proxy', '--tty', '-t', '--init',
    '--read-only', '--no-healthcheck',
}


def _skip_options(words, value_options, switch_options):
    while words and words[0].startswith('-') and words[0] != '-':
        option = words.pop(0)
        if option == '--':
            return
        if '=' in option:
            name = option.split('=', 1)[0]
            if name in value_options:
                continue
            words.insert(0, '<unsupported docker option>')
            return
        if option in value_options:
            if not words:
                words.append('<missing docker option value>')
                return
            words.pop(0)
        elif option not in switch_options:
            words.insert(0, '<unsupported docker option>')
            return


def workflow_lines(lines):
    pending = ''
    first_line = None
    for line_no, line in lines:
        if first_line is None:
            first_line = line_no
        stripped = line.rstrip()
        if stripped.endswith('\\'):
            pending += stripped[:-1] + ' '
            continue
        yield first_line, pending + line
        pending = ''
        first_line = None
    if first_line is not None:
        yield first_line, pending


def _workflow_run_text(line):
    match = re.match(r'^\s*-?\s*run\s*:\s*(.*)$', line)
    if not match:
        return line
    text = match.group(1).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


# A `docker ... run|create|pull` command inside one shell segment. Counting
# these gives a floor for the images the tokenizer must find on a line, so any
# form it cannot follow fails instead of being skipped.
DOCKER_COMMAND = re.compile(
    r'(?<![\w.-])(?:[\w.-]*/)?docker(?![\w.-])[^;&|()`\n]*?(?<![\w-])(?:run|create|pull)(?![\w-])'
)


def _shell_words(text):
    lexer = shlex.shlex(text, posix=True, punctuation_chars=';&|()`')
    lexer.whitespace_split = True
    return list(lexer)


def _docker_images_in_words(words, depth=0):
    images = []
    for index, word in enumerate(words):
        if depth < 2 and 'docker' in word and len(word.split()) > 1:
            # A quoted command string (`bash -c "docker run ..."`, `"$(docker ...)"`).
            try:
                images.extend(_docker_images_in_words(_shell_words(word), depth + 1))
            except ValueError:
                pass
            continue
        if word.rsplit('/', 1)[-1] != 'docker':
            continue
        command_words = words[index + 1:].copy()
        if not command_words:
            continue
        _skip_options(command_words, DOCKER_GLOBAL_VALUES, DOCKER_GLOBAL_SWITCHES)
        if command_words and command_words[0] == '<unsupported docker option>':
            images.append(command_words[0])
            continue
        if not command_words:
            continue
        command = command_words.pop(0)
        if command in {'container', 'image'} and command_words:
            command = command_words.pop(0)
        if command not in {'run', 'create', 'pull'}:
            continue
        _skip_options(command_words, DOCKER_VALUE_OPTIONS, DOCKER_SWITCH_OPTIONS)
        images.append(command_words[0] if command_words else '<missing docker image>')
    return images


def workflow_docker_images(line):
    line = _workflow_run_text(line)
    expected = len(DOCKER_COMMAND.findall(re.sub(r'(?:^|\s)#.*$', '', line)))
    try:
        images = _docker_images_in_words(_shell_words(line))
    except ValueError:
        images = []
    if len(images) < expected:
        images.append('<unparsed docker command>')
    return images

def files(root):
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')
    for name in filter(None, names):
        path = root / name
        basename = path.name.lower()
        yaml = basename.endswith(('.yml', '.yaml'))
        dockerfile = (
            basename == 'dockerfile' or basename.startswith('dockerfile.')
            or basename.endswith('.dockerfile')
        )
        workflow = path.parts[:2] == ('.github', 'workflows') and yaml
        compose = 'compose' in basename and yaml
        env_file = basename == '.env' or basename.startswith('.env.') or basename.endswith('.env')
        if path.is_file() and (dockerfile or workflow or compose or env_file):
            yield path


def env_image_fields(path, source):
    for line_no, line in enumerate(source.splitlines(), 1):
        match = re.match(
            r'^\s*(?:export\s+)?(FERRUM_EDGE_IMAGE|NEXUS_IMAGE)\s*=\s*(.*?)\s*$', line
        )
        if not match:
            continue
        image = match.group(2).strip().strip("'\"")
        if path.as_posix() == 'e2e/.env.example' and match.group(1) == 'NEXUS_IMAGE':
            if image == 'ferrum-nexus:e2e':
                continue
        yield line_no, image


def main(root):
    errors = []
    for path in files(root):
        source = path.read_text()
        relative_path = Path(path.relative_to(root).as_posix())
        refs = [(line, image, True) for line, image in image_fields(relative_path, source)]
        if path.name == '.env' or path.name.startswith('.env.') or path.name.endswith('.env'):
            # Env files may name a local image only through the explicit
            # e2e/.env.example exception in env_image_fields.
            refs.extend(
                (line, image, False) for line, image in env_image_fields(relative_path, source)
            )
        for line, image, local_ok in refs:
            reason = error_for(image, local_ok)
            if reason:
                errors.append(f'{path.relative_to(root)}:{line}: {image}: {reason}')
    if errors:
        print('Pin container images to a full sha256 digest:')
        print('\n'.join(errors))
        return 1
    print('Container image references are pinned.')
    return 0


if __name__ == '__main__':
    sys.exit(main(Path(sys.argv[1]).resolve()))
