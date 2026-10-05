/**
 * 值守放水记录状态管理（Solid 原生能力）
 * 用 createSignal 维护值守员侧的实际放水量记录，与调度员的走水计划分开记账。
 * 同池同日仅保留一条（upsert by [pondId+date]）。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { liveQuery } from 'dexie';
import type { DischargeRecord, DischargeDraft } from '../types/discharge';
import { db, initDatabase, upsertDischarge, removeDischarge } from '../utils/db';
import { nowIso, today, uuid } from '../utils/id';

function createDischargeStore() {
  const [rows, setRows] = createSignal<DischargeRecord[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [lastMessage, setLastMessage] = createSignal('');

  // 建库/播种必须在 liveQuery 的 querier **之外**发起（与 observationStore 同理）：
  // Dexie liveQuery 依赖同一次微任务作用域内的读操作采集可观测性集合，
  // 若在 querier 里先 await initDatabase() 再查询，会落到另一个微任务，
  // 采集不到表/索引范围，数据库变更后订阅永不重查。
  void initDatabase();

  liveQuery(async () => {
    return db.discharges.toArray();
  }).subscribe({
    next: (list) => {
      setRows([...list].sort((a, b) => b.date.localeCompare(a.date) || a.pondId.localeCompare(b.pondId)));
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取值守放水记录失败');
      setLoading(false);
    },
  });

  /** 按池 + 日期取一条值守记录（对账用） */
  function findByPondDate(pondId: string, date: string): DischargeRecord | null {
    return rows().find((row) => row.pondId === pondId && row.date === date) ?? null;
  }

  /** 某口池的全部值守记录（按日期倒序） */
  function ofPond(pondId: string): DischargeRecord[] {
    return rows()
      .filter((row) => row.pondId === pondId)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /** 派生统计：记录条数、总放水量、最近记录日期 */
  const stats = createMemo(() => {
    const list = rows();
    const totalVolume = Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10;
    const latestDate = list.length === 0 ? '' : list.reduce((acc, row) => (row.date > acc ? row.date : acc), '');
    return { count: list.length, totalVolume, latestDate };
  });

  /** 单条保存（同池同日覆盖） */
  async function saveOne(draft: DischargeDraft): Promise<DischargeRecord> {
    const stamp = nowIso();
    const row = await upsertDischarge({
      id: uuid('discharge'),
      pondId: draft.pondId,
      date: draft.date === '' ? today() : draft.date,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    });
    setLastMessage(`已保存 ${row.date} 的值守放水记录（同池同日自动覆盖）`);
    return row;
  }

  async function removeOne(id: string): Promise<void> {
    await removeDischarge(id);
    setLastMessage('值守放水记录已删除');
  }

  return {
    rows,
    loading,
    error,
    lastMessage,
    setLastMessage,
    findByPondDate,
    ofPond,
    stats,
    saveOne,
    removeOne,
  };
}

const store = createRoot(createDischargeStore);

export function useDischargeStore() {
  return store;
}
