/**
 * 放水登记（Release）
 * 闸门值守员一侧的台账：每天按闸门记录实际放水量。
 * 与调度员的走水计划（Schedule）各记各的，出卤前按「池 + 日期」对账。
 */

export interface Release {
  id: string
  /** 放水口所在蒸发池（对账时与走水计划的 pondId 对齐） */
  pondId: string
  /** 放水闸门；池口直排不指定闸门时为空串 */
  gateId: string
  /** 放水日期 YYYY-MM-DD（对账时与走水计划的 planDate 对齐） */
  date: string
  /** 实际放水量（m³） */
  volumeM3: number
  /** 闸门值守员 */
  keeper: string
  /** 备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑放水登记的表单草稿 */
export interface ReleaseDraft {
  pondId: string
  gateId: string
  date: string
  volumeM3: number
  keeper: string
  note: string
}
