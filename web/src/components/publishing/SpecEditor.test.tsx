import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEC_BYTES, MAX_SPEC_OPERATIONS } from '@ferrum-nexus/shared';
import { RAW_SPEC } from '../../../test/fixtures';
import { SpecEditor, isSpecValid, specProblem } from './SpecEditor';

function Editor({ initialValue = '' }: { initialValue?: string }): ReactElement {
  const [value, setValue] = useState(initialValue);
  return <SpecEditor value={value} onChange={setValue} />;
}

function operationSpec(count: number): string {
  const paths: Record<string, Record<string, object>> = {};
  for (let index = 0; index < count; index += 1) {
    const path = `/resource-${Math.floor(index / 2)}`;
    paths[path] ??= {};
    paths[path][index % 2 === 0 ? 'get' : 'post'] = {
      responses: { '200': { description: 'OK' } },
    };
  }
  return JSON.stringify({ openapi: '3.0.3', info: { title: 'Large API', version: '1' }, paths });
}

/** A selected file whose browser `text()` read the test resolves by hand. */
function pendingFile(name: string, size?: number) {
  const file = new File(['{}'], name, { type: 'application/json' });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  let resolve: (text: string) => void = () => undefined;
  const text = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  Object.defineProperty(file, 'text', { value: text });
  return { file, text, resolve: (value: string) => resolve(value) };
}

/** A JSON document of exactly `bytes` UTF-8 bytes. */
function specOfBytes(bytes: number): string {
  const doc = (description: string): string =>
    JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Sized', version: '1', description },
      paths: {},
    });
  return doc('a'.repeat(bytes - doc('').length));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OpenAPI specification editor', () => {
  it('starts quietly, reports parse errors, and updates the summary when corrected', () => {
    render(<Editor />);
    const input = screen.getByLabelText(/OpenAPI specification/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '{ invalid JSON' } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: RAW_SPEC } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.getByText('Billing specification v1.0.0 · 2 operations')).toBeInTheDocument();
    expect(input).toHaveValue(RAW_SPEC);
    fireEvent.change(input, { target: { value: '  ' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
  });

  it('accepts YAML and preserves the original text', () => {
    const yaml = 'openapi: 3.0.3\ninfo:\n  title: YAML API\npaths: {}\n';
    render(<Editor initialValue={yaml} />);
    expect(screen.getByText('YAML API · 0 operations')).toBeInTheDocument();
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(yaml);
    expect(isSpecValid(yaml)).toBe(true);
    expect(isSpecValid('plain text')).toBe(false);
    expect(isSpecValid('')).toBe(false);
  });

  it('opens the file picker and permits uploading the same file again', async () => {
    const { container } = render(<Editor />);
    // The file input is intentionally hidden from the accessibility tree.
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(picker, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File([RAW_SPEC], 'billing.json', { type: 'application/json' });
    // jsdom's File does not implement Blob.text; supply that browser primitive.
    const text = vi.fn().mockResolvedValue(RAW_SPEC);
    Object.defineProperty(file, 'text', { value: text });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    });
    expect(picker.value).toBe('');
    fireEvent.change(picker, { target: { files: [] } });
    expect(text).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText(/OpenAPI specification/), { target: { value: '' } });
    fireEvent.change(picker, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    });
    expect(text).toHaveBeenCalledTimes(2);
  });

  it('counts UTF-8 bytes when warning about the upload size', () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Large description', description: 'é'.repeat(MAX_SPEC_BYTES / 2) },
      paths: {},
    });
    expect(text.length).toBeLessThan(MAX_SPEC_BYTES);
    render(<Editor initialValue={text} />);
    expect(screen.getByText('Larger than the 2.00 MB limit')).toBeInTheDocument();
    // Not parsed, and never labelled valid. The textarea holds the raw document,
    // so look for the parsed summary line rather than the title alone.
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    expect(screen.queryByText('Large description · 0 operations')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a document over the byte limit counted in UTF-8, and accepts one at it', () => {
    const multibyte = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Large', version: '1.0.0', description: 'é'.repeat(MAX_SPEC_BYTES / 2) },
      paths: {},
    });
    expect(multibyte.length).toBeLessThan(MAX_SPEC_BYTES);
    expect(isSpecValid(multibyte)).toBe(false);
    expect(specProblem(multibyte)).toBe('The OpenAPI document is larger than the 2.00 MB limit.');

    const atLimit = specOfBytes(MAX_SPEC_BYTES);
    expect(new TextEncoder().encode(atLimit).length).toBe(MAX_SPEC_BYTES);
    expect(isSpecValid(atLimit)).toBe(true);
    expect(specProblem(atLimit)).toBeNull();
    expect(isSpecValid(specOfBytes(MAX_SPEC_BYTES + 1))).toBe(false);
  });

  it('refuses an oversized file before reading it and keeps the draft', () => {
    const { container } = render(<Editor initialValue={RAW_SPEC} />);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const upload = pendingFile('huge.json', MAX_SPEC_BYTES + 1);
    fireEvent.change(picker, { target: { files: [upload.file] } });
    expect(upload.text).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'huge.json is 2.00 MB, larger than the 2.00 MB limit. Choose a smaller document.',
    );
    expect(picker.value).toBe('');
    // Editing clears the notice.
    fireEvent.change(screen.getByLabelText(/OpenAPI specification/), { target: { value: '' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads a file exactly at the byte limit', async () => {
    const { container } = render(<Editor />);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const upload = pendingFile('exact.json', MAX_SPEC_BYTES);
    fireEvent.change(picker, { target: { files: [upload.file] } });
    expect(upload.text).toHaveBeenCalledTimes(1);
    await act(async () => upload.resolve(RAW_SPEC));
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(RAW_SPEC);
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('drops an upload that finishes after the provider typed a newer draft', async () => {
    const { container } = render(<Editor />);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const upload = pendingFile('old.json');
    fireEvent.change(picker, { target: { files: [upload.file] } });
    const typed = 'openapi: 3.0.3\ninfo:\n  title: Typed\npaths: {}\n';
    fireEvent.change(screen.getByLabelText(/OpenAPI specification/), { target: { value: typed } });
    await act(async () => upload.resolve(RAW_SPEC));
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(typed);
  });

  it('keeps the latest selected file when an earlier read finishes last', async () => {
    const { container } = render(<Editor />);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const first = pendingFile('a.json');
    const second = pendingFile('b.json');
    fireEvent.change(picker, { target: { files: [first.file] } });
    fireEvent.change(picker, { target: { files: [second.file] } });
    const latest = 'openapi: 3.0.3\ninfo:\n  title: B\npaths: {}\n';
    await act(async () => second.resolve(latest));
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(latest);
    await act(async () => first.resolve(RAW_SPEC));
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue(latest);
  });

  it('drops a read superseded by a refused oversized selection', async () => {
    const { container } = render(<Editor />);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const first = pendingFile('a.json');
    const oversized = pendingFile('b.json', MAX_SPEC_BYTES + 1);
    fireEvent.change(picker, { target: { files: [first.file] } });
    fireEvent.change(picker, { target: { files: [oversized.file] } });
    await act(async () => first.resolve(RAW_SPEC));
    expect(oversized.text).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/OpenAPI specification/)).toHaveValue('');
  });

  it('drops a read the parent draft or unmounting superseded', async () => {
    const onChange = vi.fn();
    const { container, rerender, unmount } = render(<SpecEditor value="" onChange={onChange} />);
    const picker = (): HTMLInputElement =>
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const discarded = pendingFile('a.json');
    fireEvent.change(picker(), { target: { files: [discarded.file] } });
    // The page replaced the draft (say, "Discard changes") while the read ran.
    rerender(<SpecEditor value={RAW_SPEC} onChange={onChange} />);
    await act(async () => discarded.resolve('openapi: 3.0.3'));
    expect(onChange).not.toHaveBeenCalled();

    const orphaned = pendingFile('b.json');
    fireEvent.change(picker(), { target: { files: [orphaned.file] } });
    unmount();
    await act(async () => orphaned.resolve('openapi: 3.0.3'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('accepts the operation limit and refuses a document one operation over it', () => {
    const accepted = operationSpec(MAX_SPEC_OPERATIONS);
    const rejected = operationSpec(MAX_SPEC_OPERATIONS + 1);
    expect(isSpecValid(accepted)).toBe(true);
    expect(isSpecValid(rejected)).toBe(false);
    const { rerender } = render(<SpecEditor value={rejected} onChange={() => undefined} />);
    expect(screen.getByText('Too many operations')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Split it into several APIs.');
    expect(screen.queryByText('Valid')).not.toBeInTheDocument();
    rerender(<SpecEditor value={accepted} onChange={() => undefined} />);
    expect(screen.getByText('Valid')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
