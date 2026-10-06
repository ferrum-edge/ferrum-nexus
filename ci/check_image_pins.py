#!/usr/bin/env python3
"""Check image fields in tracked workflows, Compose files, and Dockerfiles."""

import re
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
VARIABLE_EXCEPTIONS = {
    '${FERRUM_EDGE_IMAGE:?set FERRUM_EDGE_IMAGE}',
    '${FERRUM_EDGE_IMAGE:?set FERRUM_EDGE_IMAGE to a published version or digest}',
    '${NEXUS_IMAGE:-ferrum-nexus:e2e}',
}
LOCAL_IMAGES = {'ferrum-nexus:ci', 'ferrum-nexus:e2e'}
VERSION = re.compile(r'v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\Z')
PIN = re.compile(r'[^\s"\'@$]+(?::[^\s"\'@$]+)?@sha256:[0-9a-f]{64}\Z')
FIELD = re.compile(r'^\s*image\s*:\s*(.*?)\s*(?:#.*)?$', re.IGNORECASE)


def error_for(image):
    if image in VARIABLE_EXCEPTIONS | LOCAL_IMAGES:
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
        match = FIELD.match(line)
        if match:
            ref = match.group(1).strip().strip("'\"")
            yield line_no, ref
        elif path.parts[:2] == ('.github', 'workflows'):
            match = re.search(r'\buses\s*:\s*["\']?docker://([^\s"\']+)', line)
            if match:
                yield line_no, match.group(1)
            command = re.search(r'\bdocker\s+(?:container\s+)?(?:run|create|pull)\s+(.+)', line)
            if command:
                words = command.group(1).split()
                values = {'--name', '-p', '--publish', '-e', '--env', '--platform'}
                while words and words[0].startswith('-'):
                    option = words.pop(0)
                    if '=' not in option and option in values and words:
                        words.pop(0)
                if words:
                    yield line_no, words[0].strip("'\"")


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
        if path.is_file() and (dockerfile or workflow or compose):
            yield path


def main(root):
    errors = []
    for path in files(root):
        for line, image in image_fields(path, path.read_text()):
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
