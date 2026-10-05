export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'quota'
  | 'freeze'
export type FreezeStatus = 'active' | 'consumed' | 'released' | 'invalidated'

export interface PageReview {
  id: string
  page: number
  category: MaterialCategory
  controlled: boolean
  desensitized: boolean
  note: string
  reviewer: string
  reviewedAt?: string
}

/** 冻结单中固定下来的逐页核对结果，不再随后续改动变化。 */
export type FrozenPageReview = PageReview

export interface FrozenFileVersion {
  fileId: string
  fileName: string
  fileKind: MaterialCategory
  activeVersionId: string
  versionLabel: string
  versionHash: string
  pages: FrozenPageReview[]
}

export interface ApprovalFreeze {
  id: string
  packageId: string
  round: number
  ruleId: string
  ruleName: string
  amount: number
  status: FreezeStatus
  createdAt: string
  createdBy: string
  /** 固定的声明。 */
  declarations: string[]
  /** 固定的文件现行版本与逐页核对结果。 */
  files: FrozenFileVersion[]
  /** 提交瞬间的逐页核对/许可校验结论。 */
  findings: ValidationFinding[]
  consumedAt?: string
  releasedAt?: string
  invalidatedAt?: string
  invalidatedReason?: string
}

export interface FileVersion {
  id: string
  label: string
  uploadedAt: string
  hash: string
  sizeKb: number
  pages: PageReview[]
  changeSummary: string
}

export interface MaterialFile {
  id: string
  packageId: string
  name: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versions: FileVersion[]
}

export interface ApprovalStep {
  id: string
  order: number
  role: string
  assignee: string
  level: ApprovalLevel
  status: 'waiting' | 'active' | 'approved' | 'returned'
  comment: string
  decidedAt?: string
}

export interface PackageVersion {
  id: string
  label: string
  createdAt: string
  createdBy: string
  summary: string
  snapshot: {
    title: string
    category: MaterialCategory
    destination: string
    endUse: string
    technologyTags: string[]
    personnelScopes: string[]
    declarations: string[]
    activeFileVersions: Record<string, string>
  }
}

export interface ReviewComment {
  id: string
  packageId: string
  author: string
  content: string
  createdAt: string
  round: number
}

export interface MaterialPackage {
  id: string
  code: string
  title: string
  category: MaterialCategory
  applicant: string
  recipient: string
  destination: string
  endUse: string
  technologyTags: string[]
  personnelScopes: string[]
  declarations: string[]
  status: PackageStatus
  matchedRuleId?: string
  /** 当前生效冻结单；冻结单失效（退回/撤回/资料变更）后清空。 */
  activeFreezeId?: string
  approvalRoute: ApprovalStep[]
  currentRound: number
  quotaUsed: number
  quotaLimit: number
  createdAt: string
  updatedAt: string
  versions: PackageVersion[]
}

export interface LicenseRule {
  id: string
  name: string
  categories: MaterialCategory[]
  destinations: string[]
  technologyTags: string[]
  personnelScopes: string[]
  requiredDeclarations: string[]
  approvalLevel: ApprovalLevel
  quotaLimit: number
  explanation: string
}

export interface ValidationFinding {
  id: string
  packageId: string
  type: FindingType
  level: FindingLevel
  message: string
  action: string
  ruleId?: string
}

export interface AuditEntry {
  id: string
  packageId?: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
}

export interface WorkspaceState {
  packages: MaterialPackage[]
  files: MaterialFile[]
  rules: LicenseRule[]
  findings: ValidationFinding[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  freezes: ApprovalFreeze[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
