/**
 * /discharges 值守放水记录录入台
 * 闸门值守员侧的记账：每天记录各池的实际放水量，与调度员的走水计划分开记账。
 * 同池同日仅保留一条（覆盖写入）；记录旁显示与计划的对账状态，对不上时值守员可核对后重试。
 * 消费模型：DischargeRecord、Schedule、Pond；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { useDischargeStore } from '../stores/dischargeStore';
import { usePondStore } from '../stores/pondStore';
import { useScheduleStore } from '../stores/scheduleStore';
import type { DischargeRecord, DischargeDraft } from '../types/discharge';
import { reconcileDischarge } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

function emptyDraft(pondId: string): DischargeDraft {
  return { pondId, date: today(), volumeM3: 800, operator: '', note: '' };
}

export default function DischargeEntry() {
  const dischargeStore = useDischargeStore();
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<DischargeRecord | null>(null);
  const [draft, setDraft] = createStore<DischargeDraft>(emptyDraft(''));
  const [keyword, setKeyword] = createSignal('');

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 值守记录的对账状态：与同池同日的走水计划比对 */
  const reconciliationOf = (row: DischargeRecord) => {
    const schedule = scheduleStore.state.rows.find((item) => item.pondId === row.pondId && item.planDate === row.date);
    if (schedule === undefined) return null;
    return reconcileDischarge(schedule, row);
  };

  /** 组合池系筛选 + 关键字筛选（池号 / 值守员 / 备注 / 日期） */
  const filtered = createMemo<DischargeRecord[]>(() => {
    const series = pondStore.state.currentSeries;
    const kw = keyword().trim().toLowerCase();
    return dischargeStore.rows().filter((row) => {
      if (series !== null && pondOf(row.pondId)?.seriesName !== series) return false;
      if (kw === '') return true;
      const pond = pondOf(row.pondId);
      return (
        (pond?.code.toLowerCase().includes(kw) ?? false) ||
        row.operator.toLowerCase().includes(kw) ||
        row.note.toLowerCase().includes(kw) ||
        row.date.includes(kw)
      );
    });
  });

  const stats = createMemo(() => {
    const list = dischargeStore.rows();
    const mismatched = list.filter((row) => {
      const reconciliation = reconciliationOf(row);
      return reconciliation !== null && !reconciliation.matched;
    }).length;
    const unmatched = list.filter((row) => reconciliationOf(row) === null).length;
    return {
      count: list.length,
      totalVolume: dischargeStore.stats().totalVolume,
      latestDate: dischargeStore.stats().latestDate,
      mismatched,
      unmatched,
    };
  });

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (row: DischargeRecord): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      date: row.date,
      volumeM3: row.volumeM3,
      operator: row.operator,
      note: row.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      dischargeStore.setLastMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      await dischargeStore.saveOne({ ...draft });
    } else {
      const existing = dischargeStore.rows().find((row) => row.id === editingId());
      if (existing === undefined) return;
      await dischargeStore.saveOne({ ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await dischargeStore.removeOne(row.id);
    setDeleting(null);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="值守记录" value={stats().count} suffix="条" tone="primary" />
        <StatBadge label="累计放水量" value={stats().totalVolume} suffix="m³" tone="info" />
        <StatBadge label="与计划对不上" value={stats().mismatched} suffix="条" tone="danger" />
        <StatBadge label="暂无计划" value={stats().unmatched} suffix="条" tone="default" />
        <StatBadge label="最近记录日期" value={stats().latestDate === '' ? '—' : stats().latestDate} tone="default" />
      </div>

      <Show when={dischargeStore.lastMessage() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {dischargeStore.lastMessage()}
        </div>
      </Show>

      <Show when={dischargeStore.error() !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          {dischargeStore.error()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">值守放水记录</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 录入放水量
          </button>
        </header>

        <FilterBar
          keyword={keyword()}
          onKeyword={(value) => setKeyword(value)}
          fields={[{ key: 'series', label: '池系', options: pondStore.seriesOptions() }]}
          values={{ series: pondStore.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => {
            setKeyword('');
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${dischargeStore.rows().length} 条`}
        />

        <Show when={dischargeStore.rows().length === 0 && !dischargeStore.loading()}>
          <EmptyPanel
            title="还没有值守放水记录"
            description="闸门值守员每天记录各池的实际放水量，与调度员的走水计划分开记账；同池同日只保留一条记录。"
            actionText="录入第一条放水记录"
            onAction={openCreate}
          />
        </Show>

        <Show when={dischargeStore.rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[860px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">蒸发池</th>
                  <th class="px-3 py-2">放水日期</th>
                  <th class="px-3 py-2 text-right">实际放水量（m³）</th>
                  <th class="px-3 py-2">值守员</th>
                  <th class="px-3 py-2">备注</th>
                  <th class="px-3 py-2">与计划对账</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => {
                    const reconciliation = (): ReturnType<typeof reconciliationOf> => reconciliationOf(row);
                    return (
                      <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                        <td class="px-3 py-2.5">{pondLabel(row.pondId)}</td>
                        <td class="px-3 py-2.5">{row.date}</td>
                        <td class="px-3 py-2.5 text-right tabular-nums font-medium text-slate-800">{row.volumeM3}</td>
                        <td class="px-3 py-2.5">{row.operator === '' ? '—' : row.operator}</td>
                        <td class="px-3 py-2.5 max-w-[200px] truncate text-slate-500" title={row.note}>
                          {row.note === '' ? '—' : row.note}
                        </td>
                        <td class="px-3 py-2.5">
                          <Show
                            when={reconciliation() !== null}
                            fallback={<span class="text-xs text-slate-400">该日无计划</span>}
                          >
                            {(() => {
                              const rec = reconciliation();
                              if (rec === null) return null;
                              if (rec.matched) {
                                return (
                                  <span class="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                                    对得上（差 ±0）
                                  </span>
                                );
                              }
                              return (
                                <span class="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">
                                  对不上（计划 {rec.planVolume}，差 {rec.diff === null ? '—' : `${rec.diff > 0 ? '+' : ''}${rec.diff}`}）
                                </span>
                              );
                            })()}
                          </Show>
                        </td>
                        <td class="px-3 py-2.5">
                          <div class="flex gap-2">
                            <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                              {reconciliation() !== null && !reconciliation()?.matched ? '核对重试' : '编辑'}
                            </button>
                            <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={dischargeStore.rows().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的值守记录"
            description="可以切换池系，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null)}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '录入放水量' : '编辑值守放水记录'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>放水日期</span>
            <input type="date" class={INPUT} value={draft.date} onInput={(event) => setDraft('date', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>实际放水量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>值守员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注（闸门开度 / 水头与异常情况）</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-brine-50 px-3 py-2 text-xs leading-relaxed text-brine-800">
          值守员侧记录实际放水量，与调度员的走水计划分开记账；同池同日只保留一条，重复保存覆盖原记录。
          对账对不上时，调度员的计划照旧保留，值守员在本页核对后重试即可。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除值守放水记录？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.date} 的值守放水记录，删除后该池该日的对账会按「未登记」处理。
        </p>
      </AppDialog>
    </div>
  );
}
