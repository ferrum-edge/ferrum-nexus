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


def error_for(image):
    if REQUIRED_VARIABLE.fullmatch(image):
        return None
    fallback = NEXUS_FALLBACK.fullmatch(image)
    if fallback:
        return error_for(fallback.group(1))
    if image in LOCAL_IMAGES:
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
        return
    for line_no, line in enumerate(source.splitlines(), 1):
        for match in FIELD.finditer(line):
            ref = match.group(2).strip().strip("'\"")
            if not ref:
                ref = '<empty image field>'
            yield line_no, ref
        if path.parts[:2] == ('.github', 'workflows'):
            match = re.search(r'\buses\s*:\s*["\']?docker://([^\s"\']+)', line)
            if match:
                yield line_no, match.group(1)
            ref = workflow_docker_image(line)
            if ref is not None:
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
            continue
        if option in value_options:
            if not words:
                words.append('<missing docker option value>')
                return
            words.pop(0)
        elif option not in switch_options:
            words.insert(0, '<unsupported docker option>')
            return


def workflow_docker_image(line):
    try:
        words = shlex.split(line, comments=False)
    except ValueError:
        return None
    try:
        index = words.index('docker')
    except ValueError:
        return None
    words = words[index + 1:]
    _skip_options(words, DOCKER_GLOBAL_VALUES, DOCKER_GLOBAL_SWITCHES)
    if not words:
        return None
    command = words.pop(0)
    if command == 'container' and words:
        command = words.pop(0)
    elif command == 'image' and words:
        command = words.pop(0)
    if command not in {'run', 'create', 'pull'}:
        return None
    _skip_options(words, DOCKER_VALUE_OPTIONS, DOCKER_SWITCH_OPTIONS)
    return words[0] if words else '<missing docker image>'


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
        match = re.match(r'^\s*(FERRUM_EDGE_IMAGE|NEXUS_IMAGE)\s*=\s*(.*?)\s*$', line)
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
        refs = list(image_fields(relative_path, source))
        if path.name == '.env' or path.name.startswith('.env.') or path.name.endswith('.env'):
            refs.extend(env_image_fields(relative_path, source))
        for line, image in refs:
            reason = error_for(image)
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
