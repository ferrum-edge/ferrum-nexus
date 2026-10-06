"""Small positive and negative cases for the image pin policy."""

import unittest
from pathlib import Path

from check_image_pins import env_image_fields, error_for, image_fields


DIGEST = 'a' * 64


class ImagePinTests(unittest.TestCase):
    def test_valid_digest_and_exact_version(self):
        self.assertIsNone(error_for(f'registry.example/app:v1.2.3@sha256:{DIGEST}'))
        self.assertIsNone(error_for(f'registry.example/app@sha256:{DIGEST}'))

    def test_rejects_unpinned_variable_and_weak_tag(self):
        for ref in (
            'alpine:latest', 'busybox:1', '$IMAGE', '${IMAGE}', f'alpine@sha256:{DIGEST[:-1]}'
        ):
            with self.subTest(ref=ref):
                self.assertIsNotNone(error_for(ref))

    def test_documented_tag_and_compose_variable_exceptions(self):
        self.assertIsNone(error_for(f'alpine:3@sha256:{DIGEST}'))
        self.assertIsNone(error_for('${FERRUM_EDGE_IMAGE:?provide the candidate image}'))
        self.assertIsNone(error_for('${NEXUS_IMAGE:?provide the candidate image}'))
        self.assertIsNotNone(error_for('${OTHER_IMAGE:?provide an image}'))
        self.assertIsNotNone(error_for('${FERRUM_EDGE_IMAGE:-ferrumedge/edge:latest}'))
        self.assertIsNone(error_for('${NEXUS_IMAGE:-ferrum-nexus:e2e}'))
        self.assertIsNotNone(error_for('${NEXUS_IMAGE:-registry.example/app:latest}'))

    def test_dockerfile_base_and_external_copy_images(self):
        source = f'''FROM registry.example/base:1.2.3@sha256:{DIGEST} AS build
COPY --from=registry.example/tool:2.3.4@sha256:{DIGEST} /tool /tool
FROM build AS runtime
'''
        refs = list(image_fields(Path('Dockerfile'), source))
        self.assertEqual([ref for _, ref in refs], [
            f'registry.example/base:1.2.3@sha256:{DIGEST}',
            f'registry.example/tool:2.3.4@sha256:{DIGEST}',
        ])

    def test_compose_and_workflow_structural_fields(self):
        compose = f'''services:\n  app:\n    image: registry.example/app:1.2.3@sha256:{DIGEST}\n'''
        workflow = f'''jobs:\n  check:\n    container: registry.example/ci:2.3.4@sha256:{DIGEST}\n    steps:\n      - uses: docker://registry.example/action:3.4.5@sha256:{DIGEST}\n'''
        self.assertEqual(len(list(image_fields(Path('compose.yml'), compose))), 1)
        self.assertEqual(len(list(image_fields(Path('.github/workflows/ci.yml'), workflow))), 2)

    def test_workflow_direct_docker_command(self):
        workflow = f'''steps:\n  - run: docker run --rm registry.example/job:1.2.3@sha256:{DIGEST}\n'''
        self.assertEqual(len(list(image_fields(Path('.github/workflows/ci.yml'), workflow))), 1)

    def test_compose_quoted_list_and_flow_image_keys_fail_closed(self):
        for source in (
            'services:\n  app:\n    "image": alpine:latest\n',
            'services: {app: {image: alpine:latest, restart: always}}\n',
            'images:\n  - image: alpine:latest\n',
        ):
            with self.subTest(source=source):
                refs = list(image_fields(Path('docker-compose.yml'), source))
                self.assertTrue(refs)
                self.assertIsNotNone(error_for(refs[0][1]))

    def test_public_only_required_image_variables_are_allowed(self):
        source = '''services:\n  edge:\n    image: ${FERRUM_EDGE_IMAGE:?supply a qualified Edge image}\n  nexus:\n    image: ${NEXUS_IMAGE:?supply the candidate image}\n'''
        refs = list(image_fields(Path('docker-compose.yml'), source))
        self.assertEqual(len(refs), 2)
        self.assertTrue(all(error_for(ref) is None for _, ref in refs))

    def test_dotenv_image_overrides_are_checked(self):
        source = (
            f'FERRUM_EDGE_IMAGE=registry.example/edge:1.2.3@sha256:{DIGEST}\n'
            'NEXUS_IMAGE=registry.example/nexus:latest\n'
        )
        refs = list(env_image_fields(Path('release/compatibility.env'), source))
        self.assertEqual(len(refs), 2)
        self.assertIsNone(error_for(refs[0][1]))
        self.assertIsNotNone(error_for(refs[1][1]))
        unpinned = next(
            env_image_fields(Path('release/compatibility.env'), 'FERRUM_EDGE_IMAGE=latest')
        )[1]
        self.assertIsNotNone(error_for(unpinned))

    def test_workflow_docker_options_and_subcommands_find_the_image(self):
        image = f'registry.example/job:1.2.3@sha256:{DIGEST}'
        workflow = (
            'steps:\n  - run: docker --host unix:///var/run/docker.sock run '
            f'--label a=b -e K=V --name svc {image}\n'
            f'  - run: docker image pull {image}\n'
        )
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertEqual([ref for _, ref in refs], [
            f'registry.example/job:1.2.3@sha256:{DIGEST}',
            f'registry.example/job:1.2.3@sha256:{DIGEST}',
        ])

    def test_workflow_option_value_cannot_hide_an_unpinned_image(self):
        workflow = 'steps:\n  - run: docker run --label a=b@sha256:' + DIGEST + ' nginx:latest\n'
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertTrue(refs)
        self.assertIsNotNone(error_for(refs[0][1]))

    def test_dockerfile_comment_inside_continuation_does_not_hide_image(self):
        source = 'FROM \\\n# BuildKit ignores this comment\nnode:latest AS runtime\n'
        refs = list(image_fields(Path('Dockerfile'), source))
        self.assertTrue(refs)
        self.assertIsNotNone(error_for(refs[0][1]))


    def test_dockerfile_platform_and_substituted_images_are_checked(self):
        pinned = f'registry.example/base:v1.2.3@sha256:{DIGEST}'
        source = (
            f'FROM --platform=linux/amd64 {pinned} AS build\n'
            'FROM ${BASE_IMAGE} AS runtime\n'
            'COPY --from=${BUILD_IMAGE} /src /src\n'
        )
        refs = list(image_fields(Path('Dockerfile'), source))
        self.assertEqual(refs[0][1], pinned)
        self.assertTrue(all(error_for(ref) is not None for _, ref in refs[1:]))

    def test_local_env_image_exception_is_scoped_to_acceptance_example(self):
        image = 'NEXUS_IMAGE=ferrum-nexus:e2e'
        self.assertEqual(list(env_image_fields(Path('e2e/.env.example'), image)), [])
        ref = next(env_image_fields(Path('.env.example'), image))[1]
        self.assertIsNotNone(error_for(ref, local_ok=False))

    def test_workflow_unknown_docker_option_fails_closed(self):
        workflow = 'steps:\n  - run: docker run --mystery value registry.example/app:1.2.3\n'
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertEqual(len(refs), 1)
        self.assertIsNotNone(error_for(refs[0][1]))

    def test_workflow_continued_docker_run_fails_closed(self):
        workflow = 'steps:\n  - run: docker run --rm \\\n    nginx:latest\n'
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertEqual(len(refs), 1)
        self.assertIsNotNone(error_for(refs[0][1]))

    def test_workflow_docker_comment_with_apostrophe_is_scanned(self):
        workflow = "steps:\n  - run: docker pull alpine:latest  # we'll test this\n"
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertEqual([ref for _, ref in refs], ['alpine:latest'])
        self.assertIsNotNone(error_for(refs[0][1]))

    def test_workflow_quoted_run_scalar_is_scanned(self):
        workflow = 'steps:\n  - run: "docker run nginx:latest"\n'
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertEqual([ref for _, ref in refs], ['nginx:latest'])
        self.assertIsNotNone(error_for(refs[0][1]))

    def test_workflow_unknown_global_options_fail_closed(self):
        for command in (
            'docker -D run x',
            'docker -l debug run x',
            'docker --tlscacert ca.pem run nginx:latest',
        ):
            with self.subTest(command=command):
                refs = list(image_fields(
                    Path('.github/workflows/ci.yml'), f'steps:\n  - run: {command}\n'
                ))
                self.assertEqual(len(refs), 1)
                self.assertIsNotNone(error_for(refs[0][1]))

    def test_workflow_scans_each_docker_command_on_a_line(self):
        workflow = 'steps:\n  - run: docker version && docker run nginx:latest\n'
        refs = list(image_fields(Path('.github/workflows/ci.yml'), workflow))
        self.assertEqual([ref for _, ref in refs], ['nginx:latest'])
        self.assertIsNotNone(error_for(refs[0][1]))

    def test_env_file_exports_and_required_variables_are_checked(self):
        source = (
            'export FERRUM_EDGE_IMAGE=nginx:latest\n'
            'NEXUS_IMAGE=${NEXUS_IMAGE:?must not expand in an env file}\n'
        )
        refs = list(env_image_fields(Path('release/compatibility.env'), source))
        self.assertEqual([ref for _, ref in refs], [
            'nginx:latest', '${NEXUS_IMAGE:?must not expand in an env file}'
        ])
        self.assertTrue(all(error_for(ref, local_ok=False) is not None for _, ref in refs))

    def test_dockerfile_frontend_and_mount_images_are_checked(self):
        source = (
            '# syntax=docker/dockerfile:1\n'
            'RUN --mount=type=bind,from=nginx:latest,target=/src echo ok\n'
        )
        refs = list(image_fields(Path('Dockerfile'), source))
        self.assertEqual([ref for _, ref in refs], ['docker/dockerfile:1', 'nginx:latest'])
        self.assertTrue(all(error_for(ref) is not None for _, ref in refs))


if __name__ == '__main__':
    unittest.main()
