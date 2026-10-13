/**
 * The pipeline as the latest current state holds it, read as this reader (audit 2026-10-13: a manager could not see
 * their own deals as a table). One read shared by the Cockpit's quarter panel and the Pipeline page.
 */

import { useEffect, useMemo, useState } from 'react';
import { readPipeline, quarterKeyOf, type PipelinePosition, type PipelineReadable, type TwinItem, type TwinViewer } from '@helm/twin-runtime';
import { useHelmStore } from './helmStore.ts';
import { useMemoireLive } from './memoireLiveSync.ts';
import { cloudScope, demoScope } from './ontologyGraph.ts';
import { listSnapshots, loadSnapshotView, resolveTwinContext } from './twinRuntime.ts';
import { pipelineReadable } from '../components/cockpit/pipelineReadable.ts';

export type PipelineRead = {
  readonly rows: readonly PipelinePosition[];
  readonly items: readonly TwinItem[];
  readonly readable: PipelineReadable;
  /** What the state was composed from, and when. */
  readonly recordedThrough: string;
  readonly composedAt: string;
  /** "2026-Q4": the quarter the reader is in. */
  readonly quarter: string;
  readonly now: string;
  readonly mode: 'demo' | 'cloud';
  readonly viewer: TwinViewer;
};

/** Memoire opens a deal at this address. Only the cloud has one; the demo's source is a fixture. */
export const memoireDealUrl = (sourceId: string): string => `https://www.memoire-official.com/app/opportunities?opportunityId=${encodeURIComponent(sourceId)}`;

export function usePipeline(): { data: PipelineRead | null; error: string | null; empty: boolean } {
  const mode = useHelmStore((s) => s.mode);
  const activeOrgId = useHelmStore((s) => s.activeOrgId);
  const userId = useHelmStore((s) => s.userId);
  const myRole = useHelmStore((s) => s.myRole);
  const version = useMemoireLive((s) => s.version);
  const scope = useMemo(() => (mode === 'demo' ? demoScope() : activeOrgId ? cloudScope(activeOrgId, userId ?? '', myRole()) : null), [mode, activeOrgId, userId, myRole]);
  const [state, setState] = useState<{ data: PipelineRead | null; error: string | null; empty: boolean }>({ data: null, error: null, empty: false });

  useEffect(() => {
    if (!scope || !mode) return;
    let live = true;
    void (async () => {
      try {
        const ctx = await resolveTwinContext(mode, scope);
        if (!ctx) throw new Error('The pipeline is unavailable in this mode.');
        const viewer = (ctx.viewers.find((v) => v.key === 'countryGM') ?? ctx.viewers[0])?.viewer;
        if (!viewer) throw new Error('No reader is defined for this organization.');
        const all = await listSnapshots(ctx);
        const current = [...all].filter((s) => s.spec.kind === 'CURRENT').at(-1);
        if (!current) {
          if (live) setState({ data: null, error: null, empty: true });
          return;
        }
        const view = await loadSnapshotView(ctx, current.id, viewer);
        const items = (view.projection?.items ?? []) as readonly TwinItem[];
        const now = current.spec.lens.effectiveAsOf;
        if (live)
          setState({
            data: { rows: readPipeline(items), items, readable: pipelineReadable(viewer, now), recordedThrough: current.spec.lens.recordedThrough, composedAt: current.createdAt, quarter: quarterKeyOf(now), now, mode, viewer },
            error: null,
            empty: false,
          });
      } catch (e) {
        if (live) setState({ data: null, error: e instanceof Error ? e.message : String(e), empty: false });
      }
    })();
    return () => {
      live = false;
    };
  }, [mode, scope, version]);

  return state;
}
