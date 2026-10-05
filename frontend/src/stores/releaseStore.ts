/**
 * 放水登记状态管理（Solid 原生能力）
 * 闸门值守员一侧的台账：用 createSignal 维护记录与筛选条件；
 * 与调度员的走水计划各记各的，互不改写，只在出卤前按「池 + 日期」对账。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { liveQuery } from 'dexie';
import type { Release, ReleaseDraft } from '../types/release';
import { db, initDatabase, removeRelease, upsertRelease } from '../utils/db';
import { nowIso, today, uuid } from '../utils/id';

/** 放水登记筛选条件（关键字 + 日期区间），池系筛选由 pondStore.currentSeries 承载 */
export interface ReleaseFilters {
  keyword: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: ReleaseFilters = { keyword: '', from: '', to: '' };

function createReleaseStore() {
  const [filters, setFilters] = createSignal<ReleaseFilters>({ ...EMPTY_FILTERS });
  const [rows, setRows] = createSignal<Release[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [lastMessage, setLastMessage] = createSignal('');

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 值守员改完记录后调度侧的对账结果不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.releases.toArray();
  }).subscribe({
    next: (list) => {
      setRows([...list].sort((a, b) => b.date.localeCompare(a.date)));
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取放水登记失败');
      setLoading(false);
    },
  });

  function patchFilters(patch: Partial<ReleaseFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  /** 滤波后的放水登记（供页面直接消费） */
  const visible = createMemo<Release[]>(() => {
    const current = filters();
    const keyword = current.keyword.trim().toLowerCase();
    return rows().filter((row) => {
      if (current.from !== '' && row.date < current.from) return false;
      if (current.to !== '' && row.date > current.to) return false;
      if (keyword === '') return true;
      return (
        row.date.includes(keyword) ||
        row.keeper.toLowerCase().includes(keyword) ||
        row.note.toLowerCase().includes(keyword) ||
        String(row.volumeM3).includes(keyword)
      );
    });
  });

  /** 单条保存：同闸同日（无闸则同池同日）覆盖写入，值守员改错直接重录 */
  async function saveOne(draft: ReleaseDraft): Promise<Release> {
    const stamp = nowIso();
    const row = await upsertRelease({
      id: uuid('release'),
      pondId: draft.pondId,
      gateId: draft.gateId,
      date: draft.date === '' ? today() : draft.date,
      volumeM3: draft.volumeM3,
      keeper: draft.keeper.trim(),
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 0,
    });
    setLastMessage(`已登记 ${row.date} 放水 ${row.volumeM3} m³（同闸同日自动覆盖）`);
    return row;
  }

  async function remove(id: string): Promise<void> {
    await removeRelease(id);
    setLastMessage('放水登记已删除');
  }

  return {
    filters,
    patchFilters,
    resetFilters,
    rows,
    visible,
    loading,
    error,
    lastMessage,
    setLastMessage,
    saveOne,
    remove,
  };
}

const store = createRoot(createReleaseStore);

export function useReleaseStore() {
  return store;
}
