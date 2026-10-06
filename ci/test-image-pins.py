"""Small positive and negative cases for the image pin policy."""

import unittest
from pathlib import Path

from check_image_pins import error_for, image_fields


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
        self.assertIsNone(error_for('${FERRUM_EDGE_IMAGE:?set FERRUM_EDGE_IMAGE}'))

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
        workflow = f'''jobs:\n  check:\n    container:\n      image: registry.example/ci:2.3.4@sha256:{DIGEST}\n    steps:\n      - uses: docker://registry.example/action:3.4.5@sha256:{DIGEST}\n'''
        self.assertEqual(len(list(image_fields(Path('compose.yml'), compose))), 1)
        self.assertEqual(len(list(image_fields(Path('.github/workflows/ci.yml'), workflow))), 2)

    def test_workflow_direct_docker_command(self):
        workflow = f'''steps:\n  - run: docker run --rm registry.example/job:1.2.3@sha256:{DIGEST}\n'''
        self.assertEqual(len(list(image_fields(Path('.github/workflows/ci.yml'), workflow))), 1)


if __name__ == '__main__':
    unittest.main()
