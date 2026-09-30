import { useEffect, useMemo, useState } from 'react';
import type { TwinViewer } from '@helm/twin-runtime';
import { useHelmStore } from '../../services/helmStore.ts';
import { cloudScope, demoScope } from '../../services/ontologyGraph.ts';
import { resolveTwinContext } from '../../services/twinRuntime.ts';

/**
 * The reader an AI panel asks AS on a page that has no reader picker of its own: the Country GM in the demo,
 * the signed-in user in the cloud. The AI reads through this person's access and never past it.
 */
export function useDefaultViewer(): TwinViewer | null {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [viewer, setViewer] = useState<TwinViewer | null>(null);
  useEffect(() => {
    let live = true;
    if (!scope || !mode) return;
    void resolveTwinContext(mode, scope)
      .then((c) => {
        if (live && c) setViewer((c.viewers.find((v) => v.key === 'countryGM') ?? c.viewers[0])?.viewer ?? null);
      })
      .catch(() => {
        if (live) setViewer(null);
      });
    return () => {
      live = false;
    };
  }, [mode, scope]);
  return viewer;
}
