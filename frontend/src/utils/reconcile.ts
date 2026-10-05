/**
 * 走水对账工具（纯函数）
 * 调度员记计划（Schedule），值守员记实放（Release），两边各留各的记录；
 * 出卤前按「池 + 日期」对账：实放合计与计划量对不上的那条走水压住不给出卤。
 */
import type { Schedule } from '../types/schedule';
import type { Release } from '../types/release';
import { round1 } from './brine';

/** 对账容差（m³）：吸收浮点与读数误差，账实差在容差内视为相符 */
export const RECONCILE_TOLERANCE_M3 = 0.5;

export interface ReconcileResult {
  /** 计划量（m³） */
  plannedM3: number;
  /** 实放合计（m³） */
  releasedM3: number;
  /** 实放 − 计划（正为超放，负为欠放） */
  diffM3: number;
  /** 值守侧是否已有登记 */
  hasRecords: boolean;
  /** 账实是否相符 */
  matched: boolean;
}

/** 取出同一池同一日的全部放水登记 */
export function releasesForSlot(releases: Release[], pondId: string, date: string): Release[] {
  return releases.filter((row) => row.pondId === pondId && row.date === date);
}

/** 汇总实放量（m³） */
export function sumReleasedM3(releases: Array<Pick<Release, 'volumeM3'>>): number {
  return round1(releases.reduce((acc, row) => acc + row.volumeM3, 0));
}

/**
 * 按池和日期对账：把该池该日的实放合计与计划量比较。
 * 没有任何登记、或差额超过容差，都视为对不上。
 */
export function reconcileSchedule(
  schedule: Pick<Schedule, 'volumeM3'>,
  slotReleases: Array<Pick<Release, 'volumeM3'>>,
): ReconcileResult {
  const plannedM3 = round1(schedule.volumeM3);
  const releasedM3 = sumReleasedM3(slotReleases);
  const diffM3 = round1(releasedM3 - plannedM3);
  const hasRecords = slotReleases.length > 0;
  return {
    plannedM3,
    releasedM3,
    diffM3,
    hasRecords,
    matched: hasRecords && Math.abs(diffM3) <= RECONCILE_TOLERANCE_M3,
  };
}

/** 差额显示：超放 +120 / 欠放 −150 / 相符 0 */
export function formatDiffM3(diffM3: number): string {
  if (diffM3 > 0) return `+${round1(diffM3)}`;
  return String(round1(diffM3));
}
