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

    def test_backticks_in_parameter_defaults(self):
        cases = [
            'id=${RESULT:-`docker pull alpine:3`}',
            'id="${RESULT:-`docker run alpine:3`}"',
            'id=${OUTER:-${RESULT:-`docker container create alpine:3`}}',
            'id="${RESULT:-\'`docker pull alpine:3`\'}"',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source}, ['alpine:3'])
                self.assert_scan({'tools/start.sh': source.replace('alpine:3', PIN)})
        self.assert_scan({'tools/start.sh': r'''
id='${RESULT:-`docker pull alpine:3`}'
id=${RESULT:-'`docker pull alpine:3`'}
id=${RESULT:-\`docker pull alpine:3\`}
id="${RESULT:-\`docker pull alpine:3\`}"
'''})
        self.assert_scan({
            'tools/start.sh': 'id=${RESULT:-\n`docker pull alpine:3`}\n',
        }, ['tools/start.sh:2:', 'alpine:3'])

    def test_nested_backticks_unwrap_each_escape_layer(self):
        cases = [
            r'id=${RESULT:-`printf "%s" \`docker pull alpine:3\``}',
            r'id="${RESULT:-`printf "%s" \`docker pull alpine:3\``}"',
            r'id=`printf "%s" \`docker container create alpine:3\``',
            r'id=$(printf "%s" "${RESULT:-`printf "%s" \`docker run alpine:3\``}")',
            r'id=${RESULT:-`printf "%s" \`printf "%s" \\\`docker pull alpine:3\\\`\``}',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source}, ['alpine:3'])
                self.assert_scan({'tools/start.sh': source.replace('alpine:3', PIN)})
                # The review's single-quoted counterpart is literal data.
                self.assert_scan({'tools/start.sh': "id='" + source.split('=', 1)[1] + "'"})
        self.assert_scan({'tools/start.sh': r'''
id='${RESULT:-`printf "%s" \`docker pull alpine:3\``}'
id=${RESULT:-\`docker pull alpine:3\`}
id="${RESULT:-\`docker pull alpine:3\`}"
id=`printf '%s' '\`docker pull alpine:3\`'`
'''})
        self.assert_scan({'tools/start.sh': r'''
id=${RESULT:-`printf "%s" \`touch "$SCAN_SENTINEL"; docker pull TARGET\``}
'''.replace('TARGET', PIN)})

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

    def test_command_wrapper_options(self):
        cases = [
            'command -p docker pull alpine:3',
            'command -- docker container create alpine:3',
            'exec -- docker run alpine:3',
            'exec -cl -a nexus docker run alpine:3',
            'env SET=1 command -p exec -- docker image pull alpine:3',
            'time -p docker pull alpine:3',
            'nohup -- docker run alpine:3',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assert_scan({'tools/start.sh': source}, ['alpine:3'])
                self.assert_scan({'tools/start.sh': source.replace('alpine:3', PIN)})
        self.assert_scan({'tools/start.sh': '''
command -v docker
command -pV docker pull alpine:3
command -pv docker run alpine:3
command -p echo docker pull alpine:3
command -p docker network create sandbox
exec -- docker compose run web
exec -a docker echo docker pull alpine:3
time -f '%e' docker volume create storage
nohup -- echo docker pull alpine:3
'''})
        for wrapper in ['command', 'exec', 'time', 'nohup']:
            with self.subTest(wrapper=wrapper):
                self.assert_scan(
                    {'tools/start.sh': f'{wrapper} --unknown-option docker pull {PIN}'},
                    [f'unsupported {wrapper} option: --unknown-option'],
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

    def test_option_valued_fallback_is_not_an_image_pin(self):
        for option in ['--env=HASH=', '-eHASH=', '--label=hash=']:
            for target in ['alpine:3', PIN]:
                source = 'docker run ${FLAGS:-' + option + OTHER_DIGEST + '} ' + target
                with self.subTest(source=source):
                    self.assert_scan({'tools/start.sh': source}, ['ambiguous image argument:'])
        self.assert_scan({
            'tools/start.sh': f'docker run --env=HASH={OTHER_DIGEST} '
            + '${NEXUS_IMAGE:-' + PIN + '}\n',
        })
        self.assert_scan({
            'tools/start.sh': 'docker run ${FLAGS:-\'--env=HASH=\'' + OTHER_DIGEST + '} alpine:3',
        }, ['tools/start.sh:1:'])

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
id=${{RESULT:-`touch "$SCAN_SENTINEL"; docker pull {PIN}`}}
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

    def test_dockerfile_heredocs_follow_buildkit_instruction_grammar(self):
        for instruction in [
            'LABEL note=<<EOF',
            'ENV note=<<EOF',
            'ARG note=<<EOF',
            'RUN echo note=<<EOF',
            'RUN echo "<<EOF"',
            'RUN ["echo", "<<EOF"]',
            'COPY ["<<EOF", "/notice"]',
        ]:
            with self.subTest(instruction=instruction):
                self.assert_scan({
                    'Dockerfile': f'FROM {PIN}\n{instruction}\nFROM alpine:3\n',
                }, ['Dockerfile:3:', 'alpine:3'])
                self.assert_scan({
                    'Dockerfile': f'FROM {PIN}\n{instruction}\nFROM {PIN}\n',
                })
        for instruction in [
            "COPY <<'EOF' /notice",
            'ADD <<EOF /notice',
            'RUN cat 3<<EOF',
            'ONBUILD COPY <<EOF /notice',
            "run --mount=type=tmpfs,target=/tmp <<-'EOF'",
        ]:
            with self.subTest(instruction=instruction):
                self.assert_scan({'Dockerfile': f'''FROM scratch
{instruction}
FROM alpine:3
COPY --from=alpine:3 /x /y
EOF
COPY --from={PIN} /x /y
'''})
                self.assert_scan({'Dockerfile': f'''FROM scratch
{instruction}
FROM alpine:3
EOF
FROM alpine:3
'''}, ['Dockerfile:5:', 'alpine:3'])

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

    def test_yaml_flow_operations_and_quoted_mapping_keys(self):
        workflow_cases = [
            '- {run: docker pull alpine:3}',
            '- {name: pull, run: docker pull alpine:3}',
            '- {"run": "docker pull alpine:3"}',
            "- {'run': 'id=`docker run alpine:3`'}",
            'steps: [{run: docker pull alpine:3}]',
            '- {uses: docker://alpine:3}',
            'jobs: {check: {container: alpine:3}}',
            'container: {"image": alpine:3}',
            '"run": |\n  docker pull alpine:3\n',
        ]
        compose_cases = [
            'services:\n  app:\n    "image": alpine:3\n',
            "services:\n  app:\n    'image': alpine:3\n",
            'services: {app: {"image": alpine:3}}',
            "services: {app: {'image': alpine:3}}",
        ]
        for path, cases in [
            ('.github/workflows/test.yml', workflow_cases),
            ('deploy/compose.yml', compose_cases),
        ]:
            for source in cases:
                with self.subTest(path=path, source=source):
                    self.assert_scan({path: source}, ['alpine:3'])
                    self.assert_scan({path: source.replace('alpine:3', PIN)})
        self.assert_scan({'.github/workflows/test.yml': f'''
"name": |
  - {{run: docker pull alpine:3}}
  "image": alpine:3
steps:
  - {{name: '{{run: docker pull alpine:3}}', run: docker pull {PIN}}}
  - {{run: "echo '{{image: alpine:3}}'"}}
  - {{run: docker network create sandbox}}
  - {{run: docker compose run web}}
# {{"run": "docker pull alpine:3"}}
''', 'deploy/compose.yml': f'''
services: {{app: {{"image": {PIN}, command: "docker pull alpine:3"}}}}
x-note: {{run: docker pull alpine:3}}
'''})

    def test_repository_compose_files_accept_quoted_ports(self):
        for path in ['docker/docker-compose.example.yml', 'e2e/docker-compose.yml']:
            source = (SCANNER.parent.parent / path).read_text()
            with self.subTest(path=path):
                self.assert_scan({path: source})
            pinned_images = [
                row for row in source.splitlines()
                if row.startswith('    image: ') and '@sha256:' in row
            ]
            self.assertTrue(pinned_images, path)
            # Check the first and last declarations so a parser failure or
            # a skipped document suffix cannot mask an operational image.
            for image in [pinned_images[0], pinned_images[-1]]:
                with self.subTest(path=path, image=image):
                    self.assert_scan(
                        {path: source.replace(image, '    image: alpine:3', 1)},
                        ['unpinned image reference: alpine:3'],
                    )

    def test_block_quoted_scalar_sequences_remain_metadata(self):
        source = r'''
x-notes:
  - 'image: alpine:3'
  - "run: docker pull alpine:3"
  - 'can''t parse: uses: docker://alpine:3'
  - "note: \"image\": alpine:3"
services:
  app:
    ports:
      - '127.0.0.1:8787:8787'
      - '127.0.0.1:${MAILPIT_HTTP_PORT:-8025}:8025'
      - "127.0.0.1:8787:8787"
      - "127.0.0.1:${MAILPIT_HTTP_PORT:-8025}:8025"
    labels:
      - 'note=image: alpine:3'
      - "note=run: docker pull alpine:3"
    environment:
      NOTE: 'uses: docker://alpine:3'
    "image": TARGET
'''
        self.assert_scan({'deploy/compose.yml': source.replace('TARGET', PIN)})
        self.assert_scan(
            {'deploy/compose.yml': source.replace('TARGET', 'alpine:3')},
            ['unpinned image reference: alpine:3'],
        )

    def test_quoted_workflow_metadata_preserves_operational_steps(self):
        prefix = '''
name: 'image: alpine:3'
on:
  push:
    paths:
      - 'run: docker pull alpine:3'
      - "uses: docker://alpine:3"
jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        note:
          - 'can''t parse: image: alpine:3'
          - "parallel: [run: docker pull alpine:3]"
'''
        cases = [
            '    steps:\n      - name: "run: docker pull alpine:3"\n'
            '        run: "docker pull TARGET"\n',
            '    steps:\n      - name: "uses: docker://alpine:3"\n'
            "        'uses': docker://TARGET\n",
            '    steps: ["run":"docker pull TARGET"]\n',
            '    steps:\n      - parallel:\n          - parallel:\n'
            '              - name: "run: docker pull alpine:3"\n'
            '                "run": docker pull TARGET\n',
            "    steps: [parallel: [parallel: ['uses':docker://TARGET]]]\n",
        ]
        for steps in cases:
            source = prefix + steps
            with self.subTest(steps=steps):
                self.assert_scan({'.github/workflows/test.yml': source.replace('TARGET', PIN)})
                self.assert_scan(
                    {'.github/workflows/test.yml': source.replace('TARGET', 'alpine:3')},
                    ['unpinned image reference: alpine:3'],
                )

    def test_invalid_quoted_block_scalars_fail_closed(self):
        cases = [
            ("'unterminated: metadata", 'unterminated YAML quoted scalar'),
            ('"unterminated: metadata', 'unterminated YAML quoted scalar'),
            (r'"invalid: \q"', 'unsupported YAML escape:'),
            ("'complete: scalar' suffix", 'unexpected content after YAML value'),
        ]
        for scalar, message in cases:
            with self.subTest(scalar=scalar):
                self.assert_scan({
                    'deploy/compose.yml': 'x-notes:\n  - ' + scalar
                    + f'\nservices:\n  app:\n    image: {PIN}\n',
                }, [message])

    def test_workflow_compact_flow_pairs_retain_step_context(self):
        prefix = 'name: pins\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n'
        cases = [
            '    steps: [run: docker pull alpine:3]\n',
            '    steps: [uses: docker://alpine:3]\n',
            '    steps: ["run":"docker pull alpine:3"]\n',
            "    steps: ['uses':docker://alpine:3]\n",
            '    steps: [run : "docker pull alpine:3",]\n',
            r'    steps: ["\x72un": "docker pull alpine:3"]' + '\n',
            r'    steps: ["\u0075ses": docker://alpine:3]' + '\n',
            '    steps: [\n      run: docker pull\n        alpine:3,\n    ]\n',
            '    steps: [\n      "uses":\n        docker://alpine:3\n    ]\n',
            f'    steps: [{{run: docker pull {PIN}}}, uses: docker://alpine:3]\n',
            f'    steps: [run: docker pull {PIN}, {{uses: docker://alpine:3}}]\n',
        ]
        for steps in cases:
            source = prefix + steps
            with self.subTest(source=source):
                self.assert_scan(
                    {'.github/workflows/test.yml': source},
                    ['unpinned image reference: alpine:3'],
                )
                self.assert_scan({'.github/workflows/test.yml': source.replace('alpine:3', PIN)})
        self.assert_scan({'deploy/compose.yml': f'''
services:
  app:
    image: {PIN}
    ports: [8080:80, "9090:90"]
    environment: [NOTE=docker://alpine:3]
'''})

    def test_workflow_parallel_groups_visit_every_child(self):
        prefix = 'name: pins\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n'
        cases = [
            '    steps:\n      - parallel:\n          - run: docker pull alpine:3\n',
            '    steps:\n      - parallel:\n          - uses: docker://alpine:3\n',
            '    steps:\n      - id: pull\n        background: true\n'
            '        run: docker pull alpine:3\n      - wait: pull\n',
            '    steps:\n      - parallel:\n          - name: nested\n'
            '            parallel:\n              - background: true\n'
            '                run: |\n                  docker pull alpine:3\n',
            '    steps:\n      - parallel:\n          - parallel:\n'
            '              - uses: docker://alpine:3\n',
            '    steps: [{parallel: [{run: docker pull alpine:3}]}]\n',
            '    steps: [parallel: [run: docker pull alpine:3]]\n',
            '    steps: [parallel: [parallel: [uses: docker://alpine:3]]]\n',
            r'    steps: [{"\u0070arallel": ["uses":docker://alpine:3]}]' + '\n',
            '    steps: [\n      parallel: [\n        {background: true,\n'
            '         run: docker pull alpine:3},\n      ],\n    ]\n',
            f'    steps:\n      - parallel:\n          - run: docker pull {PIN}\n'
            '          - run: docker pull alpine:3\n',
            f'    steps: [parallel: [run: docker pull {PIN}], uses: docker://alpine:3]\n',
        ]
        for steps in cases:
            source = prefix + steps
            with self.subTest(source=source):
                self.assert_scan(
                    {'.github/workflows/test.yml': source},
                    ['unpinned image reference: alpine:3'],
                )
                self.assert_scan({'.github/workflows/test.yml': source.replace('alpine:3', PIN)})

    def test_parallel_step_metadata_and_quoted_command_prose_are_inert(self):
        source = '''
name: pins
on: push
env:
  run: docker pull alpine:3
  parallel: '[run: docker pull alpine:3]'
jobs:
  check:
    runs-on: ubuntu-latest
    env: {run: 'docker pull alpine:3', parallel: '[uses: docker://alpine:3]'}
    steps:
      - parallel:
          - name: '[parallel: [run: docker pull alpine:3]]'
            env: {run: 'docker pull alpine:3', parallel: '[run: docker pull alpine:3]'}
            run: docker pull TARGET
          - parallel: [run: "echo 'docker pull alpine:3'"]
          - uses: actions/example@anything
            with: {run: 'docker pull alpine:3', parallel: '[run: docker pull alpine:3]'}
'''
        self.assert_scan({'.github/workflows/test.yml': source.replace('TARGET', PIN)})
        self.assert_scan(
            {'.github/workflows/test.yml': source.replace('TARGET', 'alpine:3')},
            ['unpinned image reference: alpine:3'],
        )
        self.assert_scan({'.github/workflows/test.yml': f'''
env: {{run: 'docker pull alpine:3', parallel: '[uses: docker://alpine:3]'}}
jobs: {{check: {{runs-on: ubuntu-latest, steps: [parallel: [
  {{env: {{run: 'docker pull alpine:3'}}, run: docker pull {PIN}}},
  parallel: [uses: docker://{PIN}]
]]}}}}
'''})

    def test_unsupported_compact_and_parallel_steps_fail_closed(self):
        cases = [
            ('["run: docker pull TARGET"]', 'expected YAML mapping for step'),
            ('{run: docker pull TARGET}', 'expected YAML sequence for steps'),
            ('[parallel: "run: docker pull TARGET"]', 'expected YAML sequence for parallel'),
            ('[parallel: {run: docker pull TARGET}]', 'expected YAML sequence for parallel'),
            ('[parallel: ["run: docker pull TARGET"]]', 'expected YAML mapping for step'),
            ('[run: *external]', 'unsupported operational YAML'),
            ('[run: !!str "docker pull TARGET"]', 'unsupported operational YAML'),
            ('[parallel: *external]', 'unsupported operational YAML'),
            ('[parallel: [run: *external]]', 'unsupported operational YAML'),
            ('[parallel: [{<<: *external}]]', 'unsupported operational YAML'),
            ('[? run: docker pull TARGET]', 'unsupported operational YAML'),
            ('[[run]: docker pull TARGET]', 'unsupported operational YAML'),
        ]
        prefix = 'jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps: '
        for steps, message in cases:
            with self.subTest(steps=steps):
                self.assert_scan(
                    {'.github/workflows/test.yml': prefix + steps.replace('TARGET', PIN)},
                    [message],
                )
        self.assert_scan({
            '.github/workflows/test.yml': prefix + '[parallel: [' * 40
            + f'run: docker pull {PIN}' + ']]' * 40,
        }, ['YAML nesting exceeds scanner limit'])

    def test_compose_env_override_assignment_forms(self):
        for variable in ['NEXUS_IMAGE', 'FERRUM_EDGE_IMAGE']:
            for separator in [' = ', ': ', ' : ', ':']:
                for prefix in ['', 'export ']:
                    with self.subTest(variable=variable, separator=separator, prefix=prefix):
                        files = {
                            'deploy/compose.yml': 'services:\n  app:\n    image: ${'
                            + variable + '}\n',
                            'deploy/.env': prefix + variable + separator + 'alpine:3\n',
                        }
                        self.assert_scan(files, ['deploy/.env:1:', 'alpine:3'])
                        files['deploy/.env'] = (
                            prefix + variable + separator + '"' + PIN + '" # pin\n'
                        )
                        self.assert_scan(files)
        self.assert_scan({'deploy/.env': '''
# NEXUS_IMAGE = alpine:3
OTHER_IMAGE: alpine:3
NEXUS_IMAGE =
FERRUM_EDGE_IMAGE:
'''})

    def test_multiline_flow_collections_keep_operational_context(self):
        compose_cases = [
            'services:\n  app: {restart: "no",\n'
            '        hostname: app, image: alpine:3}\n',
            'services: {\n  app: {\n    restart: "no",\n'
            '    image: alpine:3,\n  },\n}\n',
            'services:\n  app:\n    {hostname: app,\n     image: alpine:3}\n',
        ]
        workflow_cases = [
            '      - {name: pull,\n'
            '         shell: bash, run: docker pull alpine:3}\n',
            '      - {env: {run: "docker pull alpine:3"},\n'
            '         name: pull,\n         run: docker pull TARGET}\n',
            '      - {name: pull,\n'
            '         uses: docker://alpine:3}\n',
        ]
        for source in compose_cases:
            with self.subTest(source=source):
                self.assert_scan({'deploy/compose.yml': source}, ['alpine:3'])
                self.assert_scan({'deploy/compose.yml': source.replace('alpine:3', PIN)})
        prefix = 'jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n'
        for step in workflow_cases:
            source = prefix + step
            image = 'TARGET' if 'TARGET' in source else 'alpine:3'
            with self.subTest(source=source):
                self.assert_scan(
                    {'.github/workflows/test.yml': source.replace(image, 'alpine:3')},
                    ['alpine:3'],
                )
                self.assert_scan({'.github/workflows/test.yml': source.replace(image, PIN)})
        for source in [
            'jobs: {check: {runs-on: ubuntu-latest,\n'
            '  steps: [\n    {name: pull,\n     run: docker pull alpine:3}\n  ]}}\n',
            'jobs: {check: {container: {env: {image: alpine:3},\n'
            '  image: TARGET}}}\n',
            'jobs: {check: {services: {app: {env: {run: docker pull alpine:3},\n'
            '  image: TARGET}}}}\n',
        ]:
            image = 'TARGET' if 'TARGET' in source else 'alpine:3'
            with self.subTest(source=source):
                self.assert_scan(
                    {'.github/workflows/test.yml': source.replace(image, 'alpine:3')},
                    ['alpine:3'],
                )
                self.assert_scan({'.github/workflows/test.yml': source.replace(image, PIN)})
        self.assert_scan({'deploy/compose.yml': f'''
x-note: {{restart: "no",
         hostname: app, image: alpine:3}}
services:
  app: {{environment: {{image: alpine:3, run: docker pull alpine:3}},
        image: {PIN}, command: 'docker pull alpine:3'}}
'''})
        self.assert_scan({
            'deploy/compose.yml': f'services:\n  app: {{image: {PIN}}}\n'
            '  other:\n    image: alpine:3\n',
        }, ['deploy/compose.yml:4:', 'alpine:3'])

    def test_yaml_quoted_keys_and_values_decode_yaml_escapes(self):
        cases = [
            ('deploy/compose.yml', r'services: {app: {"\x69mage": alpine:3}}'),
            ('deploy/compose.yml', 'services:\n  app:\n    "\\x69mage": alpine:3\n'),
            ('deploy/compose.yml', r'services: {app: {"\u0069mage": alpine:3}}'),
            ('deploy/compose.yml', r'services: {app: {"\U00000069mage": alpine:3}}'),
            ('.github/workflows/test.yml', r'steps: [{"\x72un": "docker pull alpine:3"}]'),
            ('.github/workflows/test.yml', r'steps: [{"\u0075ses": docker://alpine:3}]'),
            ('.github/workflows/test.yml', r'jobs: {check: {"\x63ontainer": alpine:3}}'),
            (
                '.github/workflows/test.yml',
                r'"\x6aobs": {check: {"\x73teps": [{"\x72un": docker pull alpine:3}]}}',
            ),
            ('.github/workflows/test.yml', r'steps: [{run: "docker\x20pull\x20alpine:3"}]'),
        ]
        for path, source in cases:
            with self.subTest(path=path, source=source):
                self.assert_scan({path: source}, ['alpine:3'])
                self.assert_scan({path: source.replace('alpine:3', PIN)})
        self.assert_scan({
            'deploy/compose.yml': 'services: {app: {"\\x69mage": "'
            + PIN.replace('/', r'\/') + '"}}\n',
            '.github/workflows/test.yml': r'''
name: "\a\b\e\f\n\r\t\v\0\ \_\N\L\P\x41\u0041\U00000041"
env: {"\x72un": 'docker pull alpine:3', "\x69mage": alpine:3}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - {run: "echo '\x64ocker pull alpine:3'"}
''',
        })
        for key, message in [
            (r'\qimage', 'unsupported YAML escape:'),
            (r'\xGGmage', 'invalid YAML hexadecimal escape'),
            (r'\uD800mage', 'invalid YAML Unicode escape'),
            (r'\U00110000mage', 'invalid YAML Unicode escape'),
        ]:
            with self.subTest(key=key):
                self.assert_scan({
                    'deploy/compose.yml': 'services: {app: {"' + key + '": ' + PIN + '}}',
                }, [message])

    def test_workflow_metadata_is_inert_at_every_mapping_depth(self):
        source = '''
name: Image pin fixtures
on: push
env: {run: 'docker pull alpine:3', image: alpine:3, uses: docker://alpine:3}
defaults: {run: {shell: bash, working-directory: 'docker pull alpine:3'}}
jobs:
  check:
    runs-on: ubuntu-latest
    env:
      run: 'docker pull alpine:3'
      image: alpine:3
    outputs: {run: 'docker pull alpine:3'}
    steps:
      - name: '{run: docker pull alpine:3}'
        env: {run: 'docker pull alpine:3', image: alpine:3}
        run: docker pull TARGET
      - uses: actions/example@anything
        with: {run: 'docker pull alpine:3', image: alpine:3}
'''
        self.assert_scan({'.github/workflows/test.yml': source.replace('TARGET', PIN)})
        self.assert_scan(
            {'.github/workflows/test.yml': source.replace('TARGET', 'alpine:3')},
            ['alpine:3'],
        )
        self.assert_scan({'.github/workflows/test.yml': f'''
env: {{run: 'docker pull alpine:3'}}
jobs: {{check: {{runs-on: ubuntu-latest,
  env: {{run: 'docker pull alpine:3', image: alpine:3}},
  steps: [{{env: {{run: 'docker pull alpine:3'}}, run: docker pull {PIN}}}]}}}}
'''})

    def test_dotenv_reads_assignments_after_quoted_values(self):
        for variable in ['NEXUS_IMAGE', 'FERRUM_EDGE_IMAGE']:
            compose = 'services:\n  app:\n    image: ${' + variable + '}\n'
            cases = [
                f'export {variable} = "{PIN}" {variable}: TARGET\n',
                f'{variable}="{PIN}"{variable}=TARGET\n',
                f"{variable}='{PIN}' export {variable} : 'TARGET'\n",
                f'NOTES="docker pull alpine:3" {variable} = TARGET\n',
                f'{variable}="{PIN}" NOTES="docker pull alpine:3" {variable}: "TARGET"\n',
            ]
            for source in cases:
                with self.subTest(variable=variable, source=source):
                    files = {
                        'deploy/compose.yml': compose,
                        'deploy/.env': source.replace('TARGET', 'alpine:3'),
                    }
                    self.assert_scan(files, ['deploy/.env:1:', 'alpine:3'])
                    files['deploy/.env'] = source.replace('TARGET', PIN)
                    self.assert_scan(files)
            self.assert_scan({
                'deploy/compose.yml': compose,
                'deploy/.env': f'''NOTES='{variable}: alpine:3
docker pull alpine:3'
{variable}="{PIN}" # {variable}=alpine:3
NOTES="export {variable} = \\"{PIN}\\" {variable}: alpine:3"
''',
            })
            self.assert_scan({
                'deploy/.env': f'{variable}="{PIN}" ; {variable}=alpine:3\n',
            }, ['unsupported dotenv assignment stream'])
            self.assert_scan({
                'deploy/.env': f'{variable}="{PIN}" unexpected suffix\n',
            }, ['unsupported dotenv assignment stream'])
            self.assert_scan({
                'deploy/.env': f'NOTES="quoted\ncommand prose"\n{variable}=alpine:3\n',
            }, ['deploy/.env:3:', 'alpine:3'])

    def test_unsupported_operational_yaml_cannot_hide_declarations(self):
        for source in [
            'services: {app: *external}',
            'services:\n  app: &external\n    image: alpine:3\n',
            'services: {app: {<<: *external}}',
            'services: {app: {image: !!str alpine:3}}',
        ]:
            with self.subTest(source=source):
                self.assert_scan({'deploy/compose.yml': source}, ['unsupported operational YAML'])
        self.assert_scan({'.github/workflows/test.yml': rf'''
env: {{run: 'docker pull alpine:3'}}
name: |
  services: {{app: {{"\x69mage": alpine:3}}}}
  - {{run: docker pull alpine:3}}
steps:
  - run: |
      echo 'docker pull alpine:3'
      docker pull {PIN}
'''})

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
