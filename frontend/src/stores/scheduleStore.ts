/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；出卤前按池 + 日期与值守放水记录对账，
 * 对不上（或没登记放水量）的走水先压住不给出卤，差额写在计划旁。
 * 调度员的计划照旧保留，值守侧重试只改值守记录、不改计划。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import type { DischargeRecord } from '../types/discharge';
import { SCHEDULE_STATE_FLOW } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  putSchedule,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import { findDischarge, reconcileDischarge, type ReconciliationResult } from '../utils/brine';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  discharges: DischargeRecord[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    discharges: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  // 值守放水记录：单独订阅，值守侧重试后这里会原地重算对账结果
  liveQuery(async () => {
    return db.discharges.toArray();
  }).subscribe({
    next: (list) => {
      setState('discharges', list);
    },
    error: () => {
      /* 值守记录读取失败不阻塞走水编排主流程，对账时按「未登记」处理 */
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
    });
    setState('lastMessage', '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  /** 对账：某条走水计划与同池同日值守放水记录的比对结果（计划旁写清差多少） */
  function reconciliationOf(scheduleId: string): ReconciliationResult | null {
    const schedule = state.rows.find((row) => row.id === scheduleId);
    if (schedule === undefined) return null;
    const discharge = findDischarge(state.discharges, schedule.pondId, schedule.planDate);
    return reconcileDischarge(schedule, discharge);
  }

  async function advance(scheduleId: string): Promise<ScheduleState | null | 'blocked'> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return null;
    const index = SCHEDULE_STATE_FLOW.indexOf(existing.state);
    if (index < 0 || index >= SCHEDULE_STATE_FLOW.length - 1) return null;
    const next = SCHEDULE_STATE_FLOW[index + 1];

    // 出卤前先对账：放水量和计划量对不上（或没登记）的走水先压住，不给出卤。
    // 调度员这份计划照旧保留，值守侧重试补登后再来推进。
    if (next === '已出卤') {
      const reconciliation = reconciliationOf(scheduleId);
      if (reconciliation !== null && reconciliation.blocked) {
        if (!reconciliation.hasRecord) {
          setState(
            'lastMessage',
            `已压住出卤：${existing.planDate} 没有值守放水记录，说不清放了多少水。请让值守员在「值守放水记录」页补登实际放水量后重试。`,
          );
        } else {
          const diffText = reconciliation.diff === null ? '' : `，差额 ${reconciliation.diff > 0 ? '+' : ''}${reconciliation.diff} m³`;
          setState(
            'lastMessage',
            `已压住出卤：${existing.planDate} 计划量 ${reconciliation.planVolume} m³ 与实际放水量 ${reconciliation.actualVolume} m³ 对不上${diffText}。请让值守员核对重试，调度员计划已保留。`,
          );
        }
        return 'blocked';
      }
    }

    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    await advanceScheduleState(scheduleId, next, actualDensity);
    await pondStore.refreshCounts();
    setState(
      'lastMessage',
      next === '已出卤'
        ? `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`
        : `状态已推进为「${next}」`,
    );
    return next;
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    reconciliationOf,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
