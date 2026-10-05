import type {
  ApprovalFreeze,
  FreezeInvalidReason,
  FrozenFileSnapshot,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  PageReview,
  ValidationFinding,
  WorkspaceState,
} from '@/types/domain'

export const freezeInvalidReasonLabels: Record<FreezeInvalidReason, string> = {
  'package-saved': '保存资料包',
  'file-added': '登记新文件',
  'file-version-changed': '更换文件现行版本',
  'reference-changed': '修改审批引用版本',
  'page-review-changed': '修改逐页核对结果',
  'snapshot-drift': '审批时发现快照漂移',
}

export const freezeStatusLabels: Record<ApprovalFreeze['status'], string> = {
  active: '冻结有效',
  consumed: '已转用额度',
  released: '已释放预占',
  invalidated: '已失效',
}

/** 序列化所有本地写操作，避免前后脚请求并发读到同一额度池而重复预占。 */
let writeChain: Promise<unknown> = Promise.resolve()

export function runSerialized<T>(task: () => Promise<T> | T): Promise<T> {
  const result = writeChain.then(task, task)
  // 单个任务失败不能中断后续任务链。
  writeChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** 深拷贝逐页核对结果，冻结后源数据修改不影响快照。 */
function clonePages(pages: PageReview[]): PageReview[] {
  return pages.map((page) => ({ ...page }))
}

/** 抓取提交时刻每个文件的现行版本与全部逐页核对结果。 */
export function captureFrozenFiles(
  packageId: string,
  files: MaterialFile[],
): FrozenFileSnapshot[] {
  return files
    .filter((file) => file.packageId === packageId)
    .map((file) => {
      const version =
        file.versions.find((item) => item.id === file.activeVersionId) ?? file.versions[0]
      return {
        fileId: file.id,
        fileName: file.name,
        kind: file.kind,
        activeVersionId: file.activeVersionId,
        referencedVersionId: file.referencedVersionId,
        versionLabel: version?.label ?? '未知版本',
        versionHash: version?.hash ?? '',
        pages: clonePages(version?.pages ?? []),
      }
    })
}

export interface FreezeDraft {
  packageItem: MaterialPackage
  rule: LicenseRule
  files: MaterialFile[]
  round: number
  reservedAmount: number
  findings: ValidationFinding[]
  createdBy?: string
  existing?: ApprovalFreeze
}

/** 生成新的冻结单或重发轮次的冻结单。 */
export function buildFreeze({
  packageItem,
  rule,
  files,
  round,
  reservedAmount,
  findings,
  createdBy = '当前用户',
}: FreezeDraft): ApprovalFreeze {
  return {
    id: `freeze-${crypto.randomUUID()}`,
    code: `FRZ-${packageItem.code.slice(-7)}-R${round}`,
    packageId: packageItem.id,
    packageCode: packageItem.code,
    round,
    ruleId: rule.id,
    ruleName: rule.name,
    status: 'active',
    reservedAmount,
    createdAt: new Date().toISOString(),
    createdBy,
    declarations: [...packageItem.declarations],
    files: captureFrozenFiles(packageItem.id, files),
    findings: findings.map((finding) => ({ ...finding })),
  }
}

export function getActiveFreeze(
  freezes: ApprovalFreeze[],
  packageId: string,
): ApprovalFreeze | undefined {
  return freezes.find((freeze) => freeze.packageId === packageId && freeze.status === 'active')
}

export interface QuotaPool {
  ruleId: string
  ruleName: string
  limit: number
  consumed: number
  reserved: number
  available: number
}

/** 许可规则额度池：已转用 + 有效预占共同占用额度。 */
export function getRuleQuotaPool(rule: LicenseRule, freezes: ApprovalFreeze[]): QuotaPool {
  const ofRule = freezes.filter((freeze) => freeze.ruleId === rule.id)
  const consumed = ofRule
    .filter((freeze) => freeze.status === 'consumed')
    .reduce((sum, freeze) => sum + freeze.reservedAmount, 0)
  const reserved = ofRule
    .filter((freeze) => freeze.status === 'active')
    .reduce((sum, freeze) => sum + freeze.reservedAmount, 0)
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    limit: rule.quotaLimit,
    consumed,
    reserved,
    available: rule.quotaLimit - consumed - reserved,
  }
}

export interface SnapshotDrift {
  reason: FreezeInvalidReason
  detail: string
}

/**
 * 逐字段核对冻结快照与当前数据是否漂移：
 * 声明、文件现行版本（含 hash）、逐页核对结果任一不同即漂移。
 */
export function findSnapshotDrift(
  freeze: ApprovalFreeze,
  packageItem: MaterialPackage,
  files: MaterialFile[],
): SnapshotDrift | undefined {
  if (JSON.stringify([...freeze.declarations].sort()) !== JSON.stringify([...packageItem.declarations].sort())) {
    return {
      reason: 'snapshot-drift',
      detail: '申报声明与提交时固定的声明不一致。',
    }
  }

  const currentFiles = files.filter((file) => file.packageId === packageItem.id)
  if (currentFiles.length !== freeze.files.length) {
    return {
      reason: 'snapshot-drift',
      detail: '资料文件数量与提交时固定的清单不一致。',
    }
  }

  for (const frozen of freeze.files) {
    const file = currentFiles.find((item) => item.id === frozen.fileId)
    if (!file) {
      return {
        reason: 'snapshot-drift',
        detail: `文件 ${frozen.fileName} 已从资料包中移除。`,
      }
    }
    if (file.activeVersionId !== frozen.activeVersionId) {
      return {
        reason: 'snapshot-drift',
        detail: `文件 ${file.name} 的现行版本已更换（冻结时为 ${frozen.versionLabel}）。`,
      }
    }
    const version = file.versions.find((item) => item.id === frozen.activeVersionId)
    if (!version || version.hash !== frozen.versionHash) {
      return {
        reason: 'snapshot-drift',
        detail: `文件 ${file.name} 冻结版本内容（${frozen.versionHash}）已变化。`,
      }
    }
    if (JSON.stringify(version.pages) !== JSON.stringify(frozen.pages)) {
      return {
        reason: 'snapshot-drift',
        detail: `文件 ${file.name} 的逐页核对结果与冻结时不一致。`,
      }
    }
  }

  return undefined
}

export interface InvalidateFreezeOptions {
  reason: FreezeInvalidReason
  detail?: string
  at?: string
}

/**
 * 使资料包的有效冻结单失效：保留旧快照与原因，预占额度随 active 状态退出而释放。
 * 返回是否存在被失效的冻结单。
 */
export function invalidateActiveFreeze(
  state: WorkspaceState,
  packageId: string,
  options: InvalidateFreezeOptions,
): ApprovalFreeze | undefined {
  const freeze = getActiveFreeze(state.freezes, packageId)
  if (!freeze) return undefined
  freeze.status = 'invalidated'
  freeze.invalidatedReason = options.reason
  freeze.invalidatedDetail = options.detail
  freeze.invalidatedAt = options.at ?? new Date().toISOString()
  return freeze
}
