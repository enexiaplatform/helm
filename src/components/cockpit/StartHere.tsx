import { useState } from 'react';
import { Link } from 'react-router-dom';
import { pipelineFacts, readPipeline, type TwinItem } from '@helm/twin-runtime';
import type { ReviewView } from '@helm/review-runtime';
import { Pill } from '../ui/Pill.tsx';

/**
 * "Bắt đầu từ đây": how a manager uses HELM, on the page they land on, in their language.
 *
 * Audit 2026-10-12, after every finding was fixed: "I log in to HELM and still don't know how to use it." The app said
 * what it refuses to do and never what to do with it. Four things, each a link to where it is done, each with what the
 * organization's own records say about it — what is open, what is done. A guide to the instrument, not advice about the
 * business: it never says which deal or which future to choose.
 */

const COMMITTED_STATES = ['COMMITTED', 'EXECUTING', 'COMPLETED', 'REVIEWED'];
const HIDDEN_KEY = 'helm:start-here:hidden';

const readHidden = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
};
const writeHidden = (v: boolean) => {
  try {
    if (v) globalThis.localStorage?.setItem(HIDDEN_KEY, '1');
    else globalThis.localStorage?.removeItem(HIDDEN_KEY);
  } catch {
    /* a private window keeps the guide open; nothing depends on it */
  }
};

const quarterOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

type Step = { n: number; title: string; why: string; status: string; done: boolean | null; actions: { label: string; to?: string; onClick?: () => void }[] };

export function StartHere({ items, reviews, now }: { items: readonly TwinItem[]; reviews: readonly ReviewView[]; now: string }) {
  const [hidden, setHidden] = useState(readHidden);
  const toggle = (v: boolean) => {
    setHidden(v);
    writeHidden(v);
  };
  if (hidden) {
    return (
      <p className="mt-6 text-meta">
        <button type="button" onClick={() => toggle(false)} className="font-medium text-accent-700 hover:underline">
          Hiện hướng dẫn “Bắt đầu từ đây”
        </button>
      </p>
    );
  }

  const f = pipelineFacts(readPipeline(items));
  const gaps = [
    f.zeroValue > 0 && `${f.zeroValue} deal giá trị 0`,
    f.noValue > 0 && `${f.noValue} deal không có giá trị`,
    f.noProbability > 0 && `${f.noProbability} deal chưa có xác suất`,
    f.noClosePeriod > 0 && `${f.noClosePeriod} deal chưa có kỳ chốt`,
    f.withoutCustomer > 0 && `${f.withoutCustomer} deal chưa gắn khách hàng`,
  ].filter((x): x is string => typeof x === 'string');

  const decisions = items.filter((i) => i.kind === 'DECISION');
  const stateOf = (i: TwinItem) => String((i.state as { state?: string }).state ?? '');
  const committed = decisions.filter((i) => COMMITTED_STATES.includes(stateOf(i))).length;
  const open = decisions.filter((i) => (i.state as { open?: boolean }).open === true).length;

  const quarter = quarterOf(now);
  const thisQuarter = reviews.filter((r) => r.review.periodLabel === quarter);
  const openReview = thisQuarter.find((r) => r.status === 'OPEN') ?? null;
  const closedReview = thisQuarter.find((r) => r.status === 'CLOSED') ?? null;

  const scrollTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const steps: Step[] = [
    {
      n: 1,
      title: 'Mỗi tuần: xem pipeline và dọn dữ liệu trong Memoire',
      why: 'Con số chỉ đáng tin khi dữ liệu đủ. Sửa trong Memoire; HELM tự đọc lại, không cần nhập gì ở đây.',
      status: f.opportunities === 0 ? 'HELM chưa đọc được cơ hội nào từ Memoire.' : gaps.length === 0 ? `Dữ liệu ${f.opportunities} cơ hội đã đủ.` : `Còn thiếu: ${gaps.join(' · ')}.`,
      done: f.opportunities === 0 ? null : gaps.length === 0,
      actions: [{ label: 'Xem pipeline', onClick: scrollTo('pipeline') }],
    },
    {
      n: 2,
      title: 'Hỏi HELM về deal và khách hàng',
      why: 'Bấm một câu hỏi gợi ý: HELM liệt kê đúng các deal thỏa điều kiện, kèm khách hàng, giá trị và xác suất — không xếp hạng.',
      status: 'Có sẵn câu hỏi gợi ý trong ô Ask HELM.',
      done: null,
      actions: [{ label: 'Mở Ask HELM', onClick: scrollTo('ask-helm') }],
    },
    {
      n: 3,
      title: 'Khi có quyết định lớn về một deal: thử các phương án rồi chốt',
      why: 'Tạo scenario (ví dụ giảm xác suất một deal) và chạy Simulate để thấy doanh thu kỳ vọng đổi bao nhiêu; rồi frame quyết định, chọn deal, so các phương án — kể cả giữ nguyên — và commit một. Từ đó Cockpit đo thực tế so với điều đã cam kết.',
      status: committed > 0 ? `${committed} quyết định đã commit${open > 0 ? ` · ${open} đang mở` : ''}.` : open > 0 ? `${open} quyết định đang mở, chưa commit.` : 'Chưa có quyết định nào được commit.',
      done: committed > 0,
      actions: [
        { label: 'Tạo scenario', to: '/scenarios?new=1' },
        { label: 'Frame quyết định', to: '/decisions?frame=1' },
      ],
    },
    {
      n: 4,
      title: 'Đầu và cuối mỗi quý: mở và đóng review',
      why: 'Mở review chụp lại trạng thái lúc đó; đóng review ghi kết luận. Review sau tự mang theo những gì còn để mở.',
      status: openReview ? `Review ${quarter} đang mở — đóng nó khi kết thúc quý.` : closedReview ? `Review ${quarter} đã mở và đóng.` : `Chưa có review cho ${quarter}.`,
      done: !!closedReview && !openReview ? true : openReview ? null : false,
      actions: [{ label: openReview ? 'Đến review đang mở' : 'Mở review', to: '/reviews' }],
    },
  ];

  return (
    <section className="mt-6 rounded-xl border border-ink-200 bg-white px-5 py-4" aria-labelledby="start-here">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="start-here" className="font-serif text-panel text-ink-950">Bắt đầu từ đây</h2>
        <button type="button" onClick={() => toggle(true)} className="text-meta text-ink-500 hover:text-ink-900">Ẩn hướng dẫn</button>
      </div>
      <p className="mt-1 max-w-reading text-dense text-ink-600">
        HELM dùng cho bốn việc. Các trang trong nhóm Learning và Setup chỉ có ích sau khi đã có quyết định được commit và có kết quả — tạm thời có thể bỏ qua.
      </p>
      <ol className="mt-3">
        {steps.map((s) => (
          <li key={s.n} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-2 border-t border-ink-200 py-3 first:border-t-0">
            <span className="font-mono text-dense text-ink-500">{s.n}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-ui font-medium text-ink-950">{s.title}</span>
                {s.done === true && <Pill tone="committed">đã làm</Pill>}
                {s.done === false && <Pill tone="open">chưa làm</Pill>}
              </div>
              <p className="mt-1 max-w-reading text-dense text-ink-700">{s.why}</p>
              <p className="mt-1 text-meta text-ink-600">{s.status}</p>
              <p className="mt-1 flex flex-wrap gap-x-4 text-meta">
                {s.actions.map((a) =>
                  a.to ? (
                    <Link key={a.label} to={a.to} className="font-medium text-accent-700 underline">{a.label} →</Link>
                  ) : (
                    <button key={a.label} type="button" onClick={a.onClick} className="font-medium text-accent-700 underline">{a.label} →</button>
                  ),
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
