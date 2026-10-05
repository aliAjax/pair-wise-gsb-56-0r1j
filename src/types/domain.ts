export type MaterialCategory = 'drawing' | 'technical' | 'software'
export type PackageStatus =
  | 'draft'
  | 'validating'
  | 'reviewing'
  | 'returned'
  | 'approved'
  | 'licensed'
  | 'locked'
  | 'freeze-invalid'
export type ApprovalLevel = 'standard' | 'enhanced' | 'senior'
export type FindingLevel = 'high' | 'medium' | 'low'
export type FindingType =
  | 'missing-declaration'
  | 'escalation'
  | 'version-mismatch'
  | 'unclassified-page'
  | 'quota'
  | 'freeze'

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

export type FreezeStatus = 'active' | 'consumed' | 'released' | 'invalidated'

export type FreezeInvalidReason =
  | 'package-saved'
  | 'file-added'
  | 'file-version-changed'
  | 'reference-changed'
  | 'page-review-changed'
  | 'snapshot-drift'

export type FreezeReleaseReason = 'approval-returned' | 'approval-withdrawn'

/** 冻结时逐页核对结果的固定副本 */
export type FrozenPageReview = PageReview

/** 冻结单固定的单个文件现行版本及其逐页核对结果 */
export interface FrozenFileSnapshot {
  fileId: string
  fileName: string
  kind: MaterialCategory
  activeVersionId: string
  referencedVersionId: string
  versionLabel: string
  versionHash: string
  pages: FrozenPageReview[]
}

/**
 * 审批冻结单：提交时固定声明、文件现行版本和逐页核对结果，
 * 并从许可规则额度池预占额度，审批全程只允许使用同一冻结单。
 */
export interface ApprovalFreeze {
  id: string
  code: string
  packageId: string
  packageCode: string
  round: number
  ruleId: string
  ruleName: string
  status: FreezeStatus
  reservedAmount: number
  createdAt: string
  createdBy: string
  /** 固定的申报声明 */
  declarations: string[]
  /** 固定的文件现行版本与逐页核对结果 */
  files: FrozenFileSnapshot[]
  /** 提交时固定的核对结论 */
  findings: ValidationFinding[]
  consumedAt?: string
  releasedAt?: string
  releaseReason?: FreezeReleaseReason
  invalidatedAt?: string
  invalidatedReason?: FreezeInvalidReason
  invalidatedDetail?: string
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
  approvalRoute: ApprovalStep[]
  currentRound: number
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
  freezes: ApprovalFreeze[]
  audit: AuditEntry[]
}

export interface VersionDiff {
  id: string
  field: string
  before: string
  after: string
  kind: 'package' | 'file'
}
