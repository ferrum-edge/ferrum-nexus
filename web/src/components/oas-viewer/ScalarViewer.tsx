import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';

export function ScalarViewer({ rawSpec }: { rawSpec: string }) {
  return (
    <div className="min-h-[640px] overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
      <ApiReferenceReact configuration={{ content: rawSpec }} />
    </div>
  );
}

