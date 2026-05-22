import { lazy, Suspense, useEffect, useState } from 'react';
import { ScalarViewer } from './ScalarViewer.js';

const RedocViewer = lazy(async () => ({
  default: (await import('./RedocViewer.js')).RedocViewer,
}));

type Viewer = 'scalar' | 'redoc';

export function OasViewer({ rawSpec }: { rawSpec: string | null }) {
  const [viewer, setViewer] = useState<Viewer>(() => {
    return (localStorage.getItem('nexus:oas-viewer') as Viewer | null) ?? 'scalar';
  });

  useEffect(() => {
    localStorage.setItem('nexus:oas-viewer', viewer);
  }, [viewer]);

  if (!rawSpec) {
    return <p className="muted rounded-md border border-dashed border-slate-300 p-4 text-sm">No spec on file.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <select className="input max-w-[180px]" value={viewer} onChange={(e) => setViewer(e.target.value as Viewer)}>
          <option value="scalar">Scalar</option>
          <option value="redoc">Redoc</option>
        </select>
      </div>
      {viewer === 'scalar' ? (
        <ScalarViewer rawSpec={rawSpec} />
      ) : (
        <Suspense fallback={<p className="muted">Loading viewer…</p>}>
          <RedocViewer rawSpec={rawSpec} />
        </Suspense>
      )}
    </div>
  );
}

