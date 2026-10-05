/**
 * 值守放水记录（DischargeRecord）
 * 闸门值守员每天记录各道闸门的实际放水量，与调度员的走水计划（Schedule）分开记账。
 * 对账时按「池 + 日期」匹配：计划量（schedule.volumeM3）与实际放水量（volumeM3）对不上的那条走水先压住不给出卤。
 */
export interface DischargeRecord {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 放水日期 YYYY-MM-DD */
  date: string
  /** 实际放水量（m³）——值守员侧记录 */
  volumeM3: number
  /** 值守员 */
  operator: string
  /** 备注（可记录闸门开度 / 水头与异常情况） */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑值守放水记录的表单草稿 */
export interface DischargeDraft {
  pondId: string
  date: string
  volumeM3: number
  operator: string
  note: string
}
