import type {
  ApprovalFreeze,
  FrozenFileVersion,
  LicenseRule,
  MaterialFile,
  MaterialPackage,
  ValidationFinding,
} from '@/types/domain'

export interface RuleQuotaPool {
  rule: LicenseRule
  used: number
  reserved: number
  available: number
  activeFreezes: ApprovalFreeze[]
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * 按许可规则汇总额度池：已转用额度（consumed）+ 冻结中预占额度（active）。
 * 失效、退回、撤回的冻结单不占额度，但保留记录。
 */
export function summarizeRulePools(
  rules: LicenseRule[],
  freezes: ApprovalFreeze[],
): RuleQuotaPool[] {
  return rules.map((rule) => {
    const ruleFreezes = freezes.filter((freeze) => freeze.ruleId === rule.id)
    const used = ruleFreezes
      .filter((freeze) => freeze.status === 'consumed')
      .reduce((total, freeze) => total + freeze.amount, 0)
    const activeFreezes = ruleFreezes.filter((freeze) => freeze.status === 'active')
    const reserved = activeFreezes.reduce((total, freeze) => total + freeze.amount, 0)
    return {
      rule,
      used,
      reserved,
      available: rule.quotaLimit - used - reserved,
      activeFreezes,
    }
  })
}

export function getRulePool(
  ruleId: string,
  rules: LicenseRule[],
  freezes: ApprovalFreeze[],
): RuleQuotaPool | undefined {
  return summarizeRulePools(rules, freezes).find((pool) => pool.rule.id === ruleId)
}

export function getActiveFreeze(
  packageId: string,
  freezes: ApprovalFreeze[],
): ApprovalFreeze | undefined {
  return freezes.find(
    (freeze) => freeze.packageId === packageId && freeze.status === 'active',
  )
}

/** 固定文件现行版本及其逐页核对结果。 */
export function buildFrozenFiles(files: MaterialFile[]): FrozenFileVersion[] {
  return files
    .filter((file) => file.activeVersionId)
    .map((file) => {
      const version =
        file.versions.find((item) => item.id === file.activeVersionId) ?? file.versions[0]
      return {
        fileId: file.id,
        fileName: file.name,
        fileKind: file.kind,
        activeVersionId: file.activeVersionId,
        versionLabel: version.label,
        versionHash: version.hash,
        pages: clone(version.pages),
      }
    })
}

/**
 * 提交前的冻结单就绪校验：声明、文件现行版本、逐页核对、规则额度池。
 * 返回阻断性（高风险）结论；空数组表示可以冻结。
 */
export function checkFreezeReadiness(
  packageItem: MaterialPackage,
  files: MaterialFile[],
  rules: LicenseRule[],
  freezes: ApprovalFreeze[],
  amount: number,
  ruleId?: string,
): ValidationFinding[] {
  const packageId = packageItem.id
  const findings: ValidationFinding[] = []
  const rule = rules.find((item) => item.id === ruleId)
  const add = (
    type: ValidationFinding['type'],
    message: string,
    action: string,
  ) => {
    findings.push({
      id: `${packageId}-${type}-${findings.length + 1}`,
      packageId,
      type,
      level: 'high',
      message,
      action,
      ruleId: rule?.id,
    })
  }

  if (!rule) {
    add('escalation', '未匹配到适用许可规则，不能创建审批冻结单。', '补充规范依据或提交人工规则判定。')
    return findings
  }

  rule.requiredDeclarations.forEach((declaration) => {
    if (!packageItem.declarations.includes(declaration)) {
      add(
        'missing-declaration',
        `缺少必要声明：${declaration}。`,
        '补充最终用途、最终用户或不扩散声明后重新提交。',
      )
    }
  })

  const packageFiles = files.filter((file) => file.packageId === packageId)
  if (!packageFiles.length) {
    add('version-mismatch', '资料包尚未拆解任何文件，无法固定审批版本。', '先登记资料文件并完成逐页核对。')
  }
  packageFiles.forEach((file) => {
    if (file.referencedVersionId !== file.activeVersionId) {
      add(
        'version-mismatch',
        `${file.name} 审批引用版本与文件现行版本不一致。`,
        '选择唯一引用版本，禁止跨版本拼装后重新提交。',
      )
    }
    const activeVersion = file.versions.find((version) => version.id === file.activeVersionId)
    const pendingPages = activeVersion?.pages.filter((page) => !page.reviewedAt) ?? []
    if (pendingPages.length) {
      add(
        'unclassified-page',
        `${file.name} 现行版本 ${activeVersion?.label ?? ''} 尚有 ${pendingPages.length} 页未完成逐页核对。`,
        '逐页确认资料分类、受控技术属性和脱敏状态后重新提交。',
      )
    }
  })

  const pool = getRulePool(rule.id, rules, freezes)
  if (amount <= 0) {
    add('quota', '预占额度必须大于 0。', '按本次申请数量填写预占额度。')
  } else if (pool && amount > pool.available) {
    add(
      'quota',
      `许可规则额度池可用额度不足：${rule.name} 剩余可用 ${pool.available}（含审批中预占 ${pool.reserved}），本次申请预占 ${amount}。`,
      '等待其他冻结单释放，或调整本次额度后重新提交。',
    )
  }

  return findings
}

export function createApprovalFreeze(params: {
  packageItem: MaterialPackage
  ruleId: string
  ruleName: string
  amount: number
  files: MaterialFile[]
  findings: ValidationFinding[]
  createdBy?: string
}): ApprovalFreeze {
  const { packageItem, ruleId, ruleName, amount, files, findings } = params
  return {
    id: `freeze-${crypto.randomUUID()}`,
    packageId: packageItem.id,
    round: packageItem.currentRound + 1,
    ruleId,
    ruleName,
    amount,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: params.createdBy ?? packageItem.applicant,
    declarations: clone(packageItem.declarations),
    files: buildFrozenFiles(files),
    findings: clone(findings),
  }
}

export const freezeStatusLabels: Record<ApprovalFreeze['status'], string> = {
  active: '冻结中',
  consumed: '已转用',
  released: '已释放',
  invalidated: '已失效',
}
