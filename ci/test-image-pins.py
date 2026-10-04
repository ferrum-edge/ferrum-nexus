"""Regression fixtures for check-image-pins.sh, run by its required CI entrypoint.

Each fixture is a separate tracked checkout. Only the scanner is invoked, never
the fixture's shell commands or Docker. No project dependencies are required.
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCANNER = Path(__file__).with_name('check-image-pins.sh').resolve()
PIN = 'example/app:1@sha256:' + 'a' * 64
OTHER_DIGEST = 'unrelated@sha256:' + 'b' * 64


class ImagePinFixtures(unittest.TestCase):
    def scan(self, files, untracked=None, executable=None):
        with tempfile.TemporaryDirectory(prefix='image-pins-') as directory:
            root = Path(directory)
            subprocess.run(
                ['git', '-c', 'core.hooksPath=/dev/null', 'init', '--quiet', directory],
                check=True,
                capture_output=True,
            )
            for path, source in files.items():
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(source)
                if path in (executable or set()):
                    file.chmod(0o755)
            subprocess.run(['git', '-C', directory, 'add', '--all'], check=True)
            for path, source in (untracked or {}).items():
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(source)
            result = subprocess.run(
                ['bash', str(SCANNER), '--scan-root', directory],
                cwd=directory,
                env={**os.environ, 'SCAN_SENTINEL': str(root / 'sentinel')},
                text=True,
                capture_output=True,
                timeout=15,
            )
            self.assertFalse((root / 'sentinel').exists(), 'scanner executed fixture code')
            self.assertNotIn('Traceback', result.stderr, result.stderr)
            return result.returncode, result.stdout + result.stderr

    def assert_scan(self, files, bad=None, **kwargs):
        status, output = self.scan(files, **kwargs)
        self.assertEqual(status, 1 if bad else 0, output)
        for expected in bad or []:
            self.assertIn(expected, output)

    def test_command_substitutions_and_backticks(self):
        cases = [
            'id=$(docker run alpine:3)',
            'id="$(docker container create --name app alpine:3)"',
            'id=`docker pull alpine:3`',
            'printf "%s" "`docker run -d alpine:3`"',
            'echo "$(printf "%s" "$(docker pull alpine:3)")"',
            'echo "${VALUE:-$(docker pull alpine:3)}"',
            'id=$(echo ok; (docker pull alpine:3))',
            'docker \\\n  container \\\n  run --rm \\\n  alpine:3',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source}, ['alpine:3'])
        for source in [f'id=$(docker run {PIN})', f'id=`docker pull {PIN}`']:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source})

    def test_command_positions_and_options(self):
        cases = [
            'docker run --rm -it --name app -p8080:80 alpine:3',
            'docker --context build container create --name=app alpine:3',
            'sudo -u root env -u UNUSED SET=1 docker -H unix:///socket pull alpine:3',
            'if docker pull alpine:3; then echo ok; fi',
            'false || docker run alpine:3',
            'docker image pull --platform linux/amd64 alpine:3',
            'docker run >output 2>&1 --rm alpine:3',
            'docker run -- alpine:3',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source}, ['alpine:3'])
        self.assert_scan(
            {'tools/start.sh': f'docker run -it -p8080:80 --name=app {PIN} docker pull alpine:3'}
        )
        self.assert_scan(
            {'tools/start.sh': f'docker run --new-unknown-flag {PIN}'},
            ['unsupported Docker option: --new-unknown-flag'],
        )

    def test_digest_belongs_to_image_argument(self):
        cases = [
            f'docker run -e HASH={OTHER_DIGEST} alpine:3',
            f'docker run --env=HASH={OTHER_DIGEST} alpine:3',
            f'docker run -eHASH={OTHER_DIGEST} alpine:3',
            f'docker create --label digest={OTHER_DIGEST} alpine:3',
            f'docker run alpine:3 echo {OTHER_DIGEST}',
            f'docker pull alpine:3 # {OTHER_DIGEST}',
            'docker run example/app@sha256:abc',
            f'docker run {PIN}suffix',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source}, ['tools/start.sh:1:'])
        self.assert_scan({'tools/start.sh': f'docker run --env HASH={OTHER_DIGEST} "{PIN}"'})

    def test_shell_data_comments_and_other_subcommands(self):
        source = r'''#!/usr/bin/env bash
# docker run alpine:3
docker network create sandbox
docker compose run web
docker --context build compose run web
docker volume create storage
docker build -t app:local .
printf '%s\n' 'docker run alpine:3'
echo docker pull alpine:3
echo '$(docker pull alpine:3)'
echo '`docker run alpine:3`'
echo "\$(docker pull alpine:3)"
cat <<'EOF'
docker pull alpine:3
$(docker run alpine:3)
EOF
cat <<EOF
Use docker run alpine:3 here.
EOF
'''
        self.assert_scan({'tools/start.sh': source})
        self.assert_scan(
            {'tools/start.sh': 'cat <<EOF\n$(docker pull alpine:3)\nEOF\n'},
            ['tools/start.sh:2:', 'alpine:3'],
        )

    def test_scanner_never_executes_candidate_commands(self):
        source = f'''touch "$SCAN_SENTINEL"
id=$(touch "$SCAN_SENTINEL"; docker run {PIN})
id=`touch "$SCAN_SENTINEL"; docker pull {PIN}`
'''
        self.assert_scan({'tools/start.sh': source})

    def test_dockerfile_case_external_copy_and_stages(self):
        bad = {
            'packaging/Dockerfile': 'from alpine:3 AS build\n',
            'packaging/Dockerfile.dev': 'FrOm --platform=$BUILDPLATFORM alpine:3\n',
            'packaging/test.Dockerfile': 'FROM scratch\ncOpY --from=alpine:3 /bin/sh /sh\n',
            'other/Dockerfile': 'FROM scratch\nCOPY --from alpine:3 /bin/sh /sh\n',
        }
        self.assert_scan(bad, [f'{path}:' for path in bad])
        self.assert_scan({
            'packaging/Dockerfile': f'''# FROM alpine:3
from --platform=$BUILDPLATFORM {PIN} as build
FROM build AS final
COPY --from=BUILD /bin/sh /sh
COPY --from=0 /bin/sh /sh2
COPY --from={PIN} /bin/sh /external
FROM scratch
''',
        })
        self.assert_scan(
            {'Dockerfile': f'FROM alpine:3 AS build # {OTHER_DIGEST}\n'},
            ['Dockerfile:1:', 'alpine:3'],
        )
        self.assert_scan({'Dockerfile': f'''FROM scratch
COPY <<'EOF' /notice
FROM alpine:3
COPY --from=alpine:3 /x /y
EOF
COPY --from={PIN} /x /y
''', 'other/Dockerfile': f'FROM \\\n  {PIN}\n'})

    def test_variable_defaults_are_checked(self):
        for variable in ['FERRUM_EDGE_IMAGE', 'NEXUS_IMAGE']:
            for operator in [':-', '-']:
                value = '${' + variable + operator + 'alpine:3}'
                for path, source in [
                    ('deploy/compose.yaml', f'services:\n  app:\n    image: {value}\n'),
                    ('tools/start.sh', f'docker run "{value}"\n'),
                ]:
                    with self.subTest(variable=variable, path=path, operator=operator):
                        self.assert_scan({path: source}, ['alpine:3'])
            self.assert_scan({
                'deploy/compose.yaml': 'image: ${' + variable + ':-' + PIN + '}\n',
                'tools/start.sh': 'docker run "${' + variable + ':-' + PIN + '}"\n',
            })
            self.assert_scan({
                'deploy/compose.yaml': 'image: ${' + variable + ':?set the image}\n',
                'tools/start.sh': 'docker run "$' + variable + '"\n',
            })
        self.assert_scan({'deploy/compose.yaml': 'image: ${UNKNOWN_IMAGE}\n'}, ['UNKNOWN_IMAGE'])
        self.assert_scan(
            {'deploy/compose.yaml': 'image: ${{ matrix.image }}\n'}, ['matrix.image']
        )

    def test_yaml_reference_specific_digests_and_quotes(self):
        cases = [
            'image: alpine:3',
            "image: 'alpine:3'",
            'image: "alpine:3"',
            f'image: alpine:3 # {OTHER_DIGEST}',
            'container: alpine:3',
            f'container: {{ image: alpine:3, env: {{ HASH: {OTHER_DIGEST} }} }}',
            f'container: {{ env: {{ HASH: {OTHER_DIGEST} }}, image: alpine:3 }}',
            'uses: docker://alpine:3',
            'services: { app: { image: alpine:3 } }',
            'image: >-\n  alpine:3\n',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'.github/workflows/test.yml': source}, ['alpine:3'])
        self.assert_scan({'.github/workflows/test.yml': f'''
container: {{ image: "{PIN}", env: {{ HASH: anything }} }}
services: {{ app: {{ image: '{PIN}' }} }}
uses: docker://{PIN}
''', 'deploy/compose.yaml': f'image: "{PIN}" # a readable tag\n'})

    def test_workflow_run_blocks_inline_and_folded(self):
        cases = [
            '      - run: docker pull alpine:3\n',
            '      - run: "docker pull alpine:3"\n',
            "      - run: 'id=$(docker run alpine:3)'\n",
            '      - run: |\n          id=$(docker run alpine:3)\n',
            '      - run: >-\n          docker run --rm\n          alpine:3\n',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'.github/workflows/test.yaml': source}, ['alpine:3'])
        self.assert_scan({'.github/workflows/test.yaml': f'''
name: |
  Use docker run alpine:3.
  image: alpine:3
jobs:
  check:
    steps:
      - name: 'Use docker pull alpine:3 {{ image: alpine:3 }}'
        run: |
          # docker run alpine:3
          echo 'docker run alpine:3'
          docker run --rm {PIN}
''', 'deploy/compose.yml': f'image: {PIN}\n# {{ image: alpine:3 }}\n'})
        self.assert_scan({'.github/workflows/test.yaml': f'''run: >-
  docker pull {PIN}

  docker pull alpine:3
'''}, ['alpine:3'])

    def test_operational_scope_anywhere_in_checkout(self):
        cases = {
            'Dockerfile': 'FROM alpine:3\n',
            'packaging/Dockerfile.debug': 'FROM alpine:3\n',
            'infra/app.Dockerfile': 'FROM alpine:3\n',
            'compose.yaml': 'image: alpine:3\n',
            'deploy/docker-compose.production.yml': 'image: alpine:3\n',
            'tools/maintenance.sh': 'docker pull alpine:3\n',
            'tools/deploy': '#!/usr/bin/env bash\ndocker run alpine:3\n',
            'release/compatibility.env': 'FERRUM_EDGE_IMAGE=alpine:3\n',
            '.env.production': 'NEXUS_IMAGE=alpine:3\n',
        }
        self.assert_scan(cases, [f'{path}:' for path in cases], executable={'tools/deploy'})
        self.assert_scan({
            'docs/example.md': 'docker run alpine:3\nimage: alpine:3\nFROM alpine:3\n',
            'tools/fixture.txt': 'docker run alpine:3\n',
            'app/config.yaml': 'image: alpine:3\n',
            'web/example.ts': 'const text = "docker run alpine:3";\n',
            'tools/nonexecutable': '#!/bin/sh\ndocker pull alpine:3\n',
            'release/compatibility.env': f'FERRUM_EDGE_IMAGE={PIN}\n',
        }, untracked={'tools/generated.sh': 'docker pull alpine:3\n'})

    def test_local_build_exceptions_are_path_and_operation_specific(self):
        self.assert_scan({
            '.github/workflows/ci.yml': 'run: docker run --rm ferrum-nexus:ci node --version\n',
            'e2e/docker-compose.yml': 'image: ${NEXUS_IMAGE:-ferrum-nexus:e2e}\n',
            'e2e/.env.example': 'NEXUS_IMAGE=ferrum-nexus:e2e\n',
        })
        self.assert_scan({
            '.github/workflows/other.yml': 'run: docker run --rm ferrum-nexus:ci\n',
            'deploy/compose.yml': 'image: ${NEXUS_IMAGE:-ferrum-nexus:e2e}\n',
            '.github/workflows/ci.yml': 'run: docker pull ferrum-nexus:ci\n',
        }, ['other.yml:1:', 'deploy/compose.yml:1:', 'ci.yml:1:'])


if __name__ == '__main__':
    unittest.main()
