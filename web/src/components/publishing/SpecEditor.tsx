import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import { MAX_SPEC_BYTES, MAX_SPEC_OPERATIONS } from '@ferrum-nexus/shared';
import { formatBytes } from '../../lib/format';
import { parseSpecText, specByteLength } from '../openapi/parse';
import { FormNotice } from '../auth/AuthShell';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Input';
import { Icon } from '../ui/Icon';

export interface SpecEditorProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  id?: string;
}

/**
 * OpenAPI document editor: paste or upload, with client-side parse validation
 * so obvious mistakes are caught before the server round-trip.
 */
export function SpecEditor({
  value,
  onChange,
  label = 'OpenAPI specification',
  id = 'spec-editor',
}: SpecEditorProps): ReactElement {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Every selection, manual edit and unmount bumps this, so a file read that
  // finishes after any of them is dropped instead of overwriting newer work.
  const readGeneration = useRef(0);
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  }, [value]);
  useEffect(() => {
    const generation = readGeneration;
    return () => {
      generation.current += 1;
    };
  }, []);
  const byteLength = useMemo(() => specByteLength(value), [value]);
  const tooLarge = byteLength > MAX_SPEC_BYTES;
  // An over-budget document cannot be published, so it is not worth parsing.
  const result = useMemo(
    () => (!tooLarge && value.trim() ? parseSpecText(value) : null),
    [tooLarge, value],
  );
  // The server enforces this too; saying it here avoids a round trip and tells
  // the provider the number before they hit it.
  const tooManyOperations = result?.ok === true && result.spec.operationCount > MAX_SPEC_OPERATIONS;

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    readGeneration.current += 1;
    const generation = readGeneration.current;
    // `File.size` is the byte count, so an oversized file is refused before any
    // of it is read; the current draft stays as it is.
    if (file.size > MAX_SPEC_BYTES) {
      setUploadError(
        `${file.name} is ${formatBytes(file.size)}, larger than the ${formatBytes(MAX_SPEC_BYTES)} limit. Choose a smaller document.`,
      );
      return;
    }
    setUploadError(null);
    const valueAtSelection = latestValue.current;
    file.text().then(
      (text) => {
        // Superseded by a later selection, an edit, or the editor going away.
        if (generation !== readGeneration.current) return;
        if (latestValue.current !== valueAtSelection) return;
        onChange(text);
      },
      () => {
        if (generation !== readGeneration.current) return;
        setUploadError(`${file.name} could not be read.`);
      },
    );
  };

  const onEdit = (next: string): void => {
    readGeneration.current += 1;
    setUploadError(null);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2.5">
      {/* Toolbar above the document: the label, what the box accepts, and the
          upload affordance, so the textarea itself is the tallest thing here. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-fg">
            {label}
            <span className="ml-1 text-danger" aria-hidden="true">
              *
            </span>
          </label>
          <p id={hintId} className="mt-0.5 text-xs text-fg-subtle">
            YAML or JSON. The document is stored exactly as uploaded.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,.json,application/json,text/yaml"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={onFile}
          />
          <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" />
            Upload file
          </Button>
        </div>
      </div>

      <Textarea
        id={id}
        aria-describedby={hintId}
        mono
        rows={24}
        spellCheck={false}
        className="min-h-[28rem] leading-6"
        value={value}
        onChange={(event) => onEdit(event.target.value)}
        placeholder={'openapi: 3.0.3\ninfo:\n  title: My API\n  version: 1.0.0\npaths: {}'}
      />

      {/* What the document parsed as, read back to the provider. */}
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-2">
        {result?.ok ? (
          <Badge tone={tooManyOperations ? 'danger' : 'success'} dot>
            {tooManyOperations ? 'Too many operations' : 'Valid'}
          </Badge>
        ) : null}
        {result?.ok ? (
          <span className="text-xs text-fg-muted">
            {result.spec.title}
            {result.spec.version ? ` v${result.spec.version}` : ''} · {result.spec.operationCount}{' '}
            operations
          </span>
        ) : null}
        {tooLarge ? (
          <Badge tone="danger">Larger than the {formatBytes(MAX_SPEC_BYTES)} limit</Badge>
        ) : null}
        {value ? (
          <span className="ml-auto text-xs text-fg-subtle tabular-nums">
            {formatBytes(byteLength)}
          </span>
        ) : null}
      </div>

      {uploadError ? <FormNotice tone="danger">{uploadError}</FormNotice> : null}
      {result && !result.ok ? <FormNotice tone="danger">{result.error}</FormNotice> : null}
      {tooManyOperations ? (
        <FormNotice tone="danger">
          This document declares more than {MAX_SPEC_OPERATIONS.toLocaleString()} operations, which
          the portal will not publish. Split it into several APIs.
        </FormNotice>
      ) : null}
    </div>
  );
}

/**
 * Why the portal would refuse `text` as an OpenAPI document, or null when it
 * would accept it.
 *
 * Mirrors the server's checks — the byte ceiling first, before any parsing —
 * so the provider is stopped before the request, not after it; the server
 * remains the authority.
 */
export function specProblem(text: string): string | null {
  if (specByteLength(text, MAX_SPEC_BYTES) > MAX_SPEC_BYTES) {
    return `The OpenAPI document is larger than the ${formatBytes(MAX_SPEC_BYTES)} limit.`;
  }
  const result = parseSpecText(text);
  if (!result.ok) return 'The OpenAPI document could not be parsed.';
  if (result.spec.operationCount > MAX_SPEC_OPERATIONS) {
    return `The OpenAPI document declares more than ${MAX_SPEC_OPERATIONS.toLocaleString()} operations.`;
  }
  return null;
}

/** True when `text` is an OpenAPI document the portal will accept. */
export function isSpecValid(text: string): boolean {
  return specProblem(text) === null;
}
