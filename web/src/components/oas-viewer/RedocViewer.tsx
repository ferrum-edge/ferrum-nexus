import { RedocStandalone } from 'redoc';

export function RedocViewer({ rawSpec }: { rawSpec: string }) {
  const spec = parseJson(rawSpec);
  if (!spec) {
    return (
      <pre className="max-h-[640px] overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-950">
        {rawSpec}
      </pre>
    );
  }
  return (
    <div className="min-h-[640px] overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
      <RedocStandalone spec={spec} />
    </div>
  );
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

