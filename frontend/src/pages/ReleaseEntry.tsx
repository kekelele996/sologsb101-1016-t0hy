/**
 * /releases 放水登记台（闸门值守员一侧）
 * 值守员每天按闸门记实际放水量，与调度员的走水计划各记各的；
 * 每条记录旁给出与走水计划的对账结果，核对失败后在**本侧**修正重录，调度侧计划照旧保留。
 * 消费模型：Release、Gate、Pond、Schedule；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { useReleaseStore } from '../stores/releaseStore';
import type { Gate } from '../types/gate';
import type { Release, ReleaseDraft } from '../types/release';
import { formatDiffM3, reconcileSchedule, releasesForSlot } from '../utils/reconcile';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

function emptyDraft(pondId: string): ReleaseDraft {
  return { pondId, gateId: '', date: today(), volumeM3: 500, keeper: '', note: '' };
}

export default function ReleaseEntry() {
  const releaseStore = useReleaseStore();
  const pondStore = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Release | null>(null);
  const [draft, setDraft] = createStore<ReleaseDraft>(emptyDraft(''));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const gateOptionLabel = (gate: Gate): string =>
    `${pondOf(gate.fromPondId)?.code ?? '?'} → ${pondOf(gate.toPondId)?.code ?? '?'}`;

  const gateLabel = (row: Release): string => {
    if (row.gateId === '') return '池口直排';
    const gate = pondStore.state.gates.find((item) => item.id === row.gateId);
    if (gate === undefined) return '（闸门已删除）';
    return gateOptionLabel(gate);
  };

  /** 池系筛选 + store 的关键字 / 日期区间 */
  const filtered = createMemo<Release[]>(() => {
    const series = pondStore.state.currentSeries;
    if (series === null) return releaseStore.visible();
    const pondIds = new Set(pondStore.state.ponds.filter((pond) => pond.seriesName === series).map((pond) => pond.id));
    return releaseStore.visible().filter((row) => pondIds.has(row.pondId));
  });

  /** 某条登记所在「池 + 日期」对应的对账结果（相对当日的走水计划） */
  const reconOf = (row: Release) => {
    const plans = pondStore.state.schedules.filter((item) => item.pondId === row.pondId && item.planDate === row.date);
    if (plans.length === 0) return null;
    return reconcileSchedule(plans[0], releasesForSlot(releaseStore.rows(), row.pondId, row.date));
  };

  const stats = createMemo(() => {
    const list = releaseStore.rows();
    const todayStr = today();
    const mismatched = pondStore.state.schedules.filter(
      (item) => item.state !== '已出卤' && !reconcileSchedule(item, releasesForSlot(list, item.pondId, item.planDate)).matched,
    ).length;
    return {
      count: list.length,
      todayVolume: Math.round(list.filter((row) => row.date === todayStr).reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      gates: new Set(list.filter((row) => row.gateId !== '').map((row) => row.gateId)).size,
      mismatched,
    };
  });

  /** 当前草稿所选池的出水闸门 */
  const gateOptions = createMemo(() => pondStore.state.gates.filter((gate) => gate.fromPondId === draft.pondId));

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (row: Release): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      gateId: row.gateId,
      date: row.date,
      volumeM3: row.volumeM3,
      keeper: row.keeper,
      note: row.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      releaseStore.setLastMessage('请选择蒸发池');
      return;
    }
    if (!(draft.volumeM3 > 0)) {
      releaseStore.setLastMessage('放水量必须大于 0');
      return;
    }
    // 编辑时若改了「池 / 日期 /闸门」键，upsert 会按新键另写一条，先把旧记录删掉
    const editId = editingId();
    if (editId !== null) {
      const original = releaseStore.rows().find((row) => row.id === editId);
      if (
        original !== undefined &&
        (original.pondId !== draft.pondId || original.date !== draft.date || original.gateId !== draft.gateId)
      ) {
        await releaseStore.remove(editId);
      }
    }
    await releaseStore.saveOne({ ...draft });
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await releaseStore.remove(row.id);
    setDeleting(null);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="放水登记" value={stats().count} suffix="条" tone="primary" />
        <StatBadge label="今日放水" value={stats().todayVolume} suffix="m³" tone="info" />
        <StatBadge label="涉及闸门" value={stats().gates} suffix="道" tone="default" />
        <StatBadge
          label="对账不符计划"
          value={stats().mismatched}
          suffix="条"
          tone={stats().mismatched > 0 ? 'danger' : 'success'}
          hint="实放合计与计划量对不上的未完成走水计划；在本侧修正登记后，调度员即可重试出卤"
        />
      </div>

      <Show when={releaseStore.lastMessage() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {releaseStore.lastMessage()}
        </div>
      </Show>

      <Show when={releaseStore.error() !== ''}>
        <div class="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2 text-sm text-rose-700">
          {releaseStore.error()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">闸门放水登记（值守员台账）</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 登记放水
          </button>
        </header>

        <FilterBar
          keyword={releaseStore.filters().keyword}
          onKeyword={(value) => releaseStore.patchFilters({ keyword: value })}
          fields={[{ key: 'series', label: '池系', options: pondStore.seriesOptions() }]}
          values={{ series: pondStore.state.currentSeries ?? 'all' }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
          }}
          onReset={() => {
            releaseStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${releaseStore.rows().length} 条`}
        >
          <label class="flex items-center gap-1.5 text-[13px] text-slate-600">
            <span>日期区间</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={releaseStore.filters().from}
              onInput={(event) => releaseStore.patchFilters({ from: event.currentTarget.value })}
            />
            <span class="text-slate-400">至</span>
            <input
              type="date"
              class="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={releaseStore.filters().to}
              onInput={(event) => releaseStore.patchFilters({ to: event.currentTarget.value })}
            />
          </label>
        </FilterBar>

        <Show when={releaseStore.rows().length === 0 && !releaseStore.loading()}>
          <EmptyPanel
            title="还没有放水登记"
            description="值守员每天按闸门登记实际放水量；调度员的走水计划在另一侧维护，出卤前按池和日期对账。"
            actionText="登记第一条放水"
            onAction={openCreate}
          />
        </Show>

        <Show when={releaseStore.rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1020px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">放水日期</th>
                  <th class="px-3 py-2">蒸发池</th>
                  <th class="px-3 py-2">闸门</th>
                  <th class="px-3 py-2 text-right">实际放水量（m³）</th>
                  <th class="px-3 py-2">值守员</th>
                  <th class="px-3 py-2">对账（按计划）</th>
                  <th class="px-3 py-2">备注</th>
                  <th class="px-3 py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => (
                    <tr class="border-b border-slate-100 align-middle hover:bg-slate-50/60">
                      <td class="px-3 py-2.5 tabular-nums">{row.date}</td>
                      <td class="px-3 py-2.5">{pondLabel(row.pondId)}</td>
                      <td class="px-3 py-2.5 text-[13px]">{gateLabel(row)}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">{row.volumeM3}</td>
                      <td class="px-3 py-2.5">{row.keeper === '' ? '未填写' : row.keeper}</td>
                      <td class="px-3 py-2.5">
                        {(() => {
                          const recon = reconOf(row);
                          if (recon === null) return <span class="text-xs text-slate-400">当日无走水计划</span>;
                          return (
                            <span
                              class={`rounded border px-1.5 py-0.5 text-[11px] ${
                                recon.matched
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                                  : 'border-rose-300 bg-rose-50 text-rose-700'
                              }`}
                              title={`计划 ${recon.plannedM3} m³ / 实放合计 ${recon.releasedM3} m³`}
                            >
                              {recon.matched ? '账实相符' : `差 ${formatDiffM3(recon.diffM3)} m³（计划 ${recon.plannedM3}）`}
                            </span>
                          );
                        })()}
                      </td>
                      <td class="px-3 py-2.5 text-xs text-slate-500">{row.note === '' ? '—' : row.note}</td>
                      <td class="px-3 py-2.5">
                        <div class="flex gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                            编辑
                          </button>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={releaseStore.rows().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的放水登记"
            description="可以放宽日期区间或切换池系，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => releaseStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '登记放水' : '编辑放水登记'}
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
            <span>蒸发池（放水口所在池）</span>
            <select
              class={INPUT}
              value={draft.pondId}
              onChange={(event) => {
                setDraft('pondId', event.currentTarget.value);
                setDraft('gateId', '');
              }}
            >
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
            <span>放水闸门</span>
            <select class={INPUT} value={draft.gateId} onChange={(event) => setDraft('gateId', event.currentTarget.value)}>
              <option value="">池口直排（不指定闸门）</option>
              <For each={gateOptions()}>
                {(gate) => <option value={gate.id}>{gateOptionLabel(gate)}</option>}
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
              min="0"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>值守员</span>
            <input class={INPUT} value={draft.keeper} onInput={(event) => setDraft('keeper', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-brine-50 px-3 py-2 text-xs leading-relaxed text-brine-800">
          同一闸门同一天只保留一条登记，重复保存自动覆盖；对账不符时在本侧修正重录即可，调度员的走水计划不受影响。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除放水登记？"
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
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.date} 的放水登记（{deleting()?.volumeM3} m³），
          删除后该日的对账结果会同步变化。
        </p>
      </AppDialog>
    </div>
  );
}
