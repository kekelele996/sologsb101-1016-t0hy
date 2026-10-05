/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { DischargeRecord } from '../types/discharge';
import { estimateEvapMm } from './brine';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  discharges!: Table<DischargeRecord, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：新增值守放水记录表，并为旧走水计划补一份默认放水量 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
        discharges: 'id, pondId, date, [pondId+date], volumeM3',
      })
      .upgrade(async (tx) => {
        // 迁移 5：旧计划没登记放水量，升级时按旧计划量补一份默认值守记录。
        // 这样老数据对账时计划量与实际放水量一致，不会被当作对不上而压住出卤。
        const existing = await tx.table('discharges').toArray();
        const registered = new Set(
          existing.map((row: DischargeRecord) => `${row.pondId}__${row.date}`),
        );
        const schedules = await tx.table('schedules').toArray();
        const defaults: DischargeRecord[] = [];
        for (const schedule of schedules) {
          const key = `${schedule.pondId}__${schedule.planDate}`;
          if (registered.has(key)) continue;
          defaults.push({
            id: uuid('discharge'),
            pondId: schedule.pondId,
            date: schedule.planDate,
            volumeM3: typeof schedule.volumeM3 === 'number' ? schedule.volumeM3 : 0,
            operator: '',
            note: '升级时按旧计划量补登的默认放水量',
            createdAt: nowIso(),
            updatedAt: nowIso(),
            revision: ROW_REVISION,
          });
        }
        if (defaults.length > 0) await tx.table('discharges').bulkPut(defaults);
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划与值守放水记录 */
export async function removePond(id: string): Promise<void> {
  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.discharges], async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.discharges.where('pondId').equals(id).delete();
    await db.ponds.delete(id);
  });
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态 */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 值守放水记录 ------------------------------ */

export async function listDischarges(): Promise<DischargeRecord[]> {
  const rows = await db.discharges.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.pondId.localeCompare(b.pondId));
}

export async function listDischargesByPond(pondId: string): Promise<DischargeRecord[]> {
  const rows = await db.discharges.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * 写入值守放水记录：同池同日仅保留一条（存在即覆盖原记录）。
 * 与调度员的走水计划分开记账，互不改写。
 */
export async function upsertDischarge(row: DischargeRecord): Promise<DischargeRecord> {
  const existing = await db.discharges.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: DischargeRecord = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.discharges.put(next);
  return next;
}

export async function removeDischarge(id: string): Promise<void> {
  await db.discharges.delete(id);
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  discharges: DischargeRecord[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, discharges] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
    db.discharges.toArray(),
  ]);
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), ponds, gates, observations, assays, schedules, discharges };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  // v2 及更早的存档没有 discharges 数组：按旧计划量补默认值守记录，
  // 与升级迁移逻辑一致，避免导入后老计划全部被压住出卤。
  const incomingDischarges = snapshot.discharges ?? [];
  const registered = new Set(incomingDischarges.map((row) => `${row.pondId}__${row.date}`));
  const defaultDischarges: DischargeRecord[] = [];
  for (const schedule of snapshot.schedules) {
    const key = `${schedule.pondId}__${schedule.planDate}`;
    if (registered.has(key)) continue;
    defaultDischarges.push({
      id: uuid('discharge'),
      pondId: schedule.pondId,
      date: schedule.planDate,
      volumeM3: typeof schedule.volumeM3 === 'number' ? schedule.volumeM3 : 0,
      operator: '',
      note: '导入存档时按计划量补登的默认放水量',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  }
  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.discharges], async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
      db.discharges.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.discharges.bulkPut([
      ...incomingDischarges.map((row) => ({ ...row, revision: ROW_REVISION })),
      ...defaultDischarges,
    ]);
  });
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.discharges], async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
      db.discharges.clear(),
    ]);
  });
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, discharges] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.discharges.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, discharges };
}
