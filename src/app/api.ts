import { createApi } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn } from '@reduxjs/toolkit/query/react'
import type {
  MaterialFile,
  MaterialPackage,
  PageReview,
  ReviewComment,
  WorkspaceState,
} from '@/types/domain'
import { loadWorkspace, resetWorkspace, saveWorkspace } from '@/services/storage'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'
import {
  buildFreeze,
  findSnapshotDrift,
  freezeInvalidReasonLabels,
  getActiveFreeze,
  getRuleQuotaPool,
  invalidateActiveFreeze,
  runSerialized,
} from '@/services/freezes'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

/**
 * 保存、换版本、改核对页都会让有效冻结单失效：保留旧快照和失效原因，
 * 同时把资料包打回冻结失效状态并让出活动审批步骤，预占额度随冻结单退出 active 而释放。
 */
function invalidateFreezeAndBlockRoute(
  state: WorkspaceState,
  packageId: string,
  reason: Parameters<typeof invalidateActiveFreeze>[2]['reason'],
  detail: string,
  audit: (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => void,
): boolean {
  const freeze = invalidateActiveFreeze(state, packageId, { reason, detail })
  if (!freeze) return false
  const packageItem = state.packages.find((item) => item.id === packageId)
  if (packageItem) {
    packageItem.status = 'freeze-invalid'
    packageItem.approvalRoute = packageItem.approvalRoute.map((step) =>
      step.status === 'active' ? { ...step, status: 'waiting' } : step,
    )
  }
  audit({
    packageId,
    action: '冻结单失效',
    target: freeze.code,
    operator: '系统',
    detail: `因「${freezeInvalidReasonLabels[reason]}」冻结单失效，旧快照与原因保留，释放预占额度 ${freeze.reservedAmount}。${detail}`,
  })
  return true
}

const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({
  url,
  method,
  body,
}) => {
  await wait()
  const payload = (body ?? {}) as Record<string, unknown>

  const handle = ():
    | { data: WorkspaceState }
    | { error: MockError } => {
    let state = loadWorkspace()
    const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
      state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
    }

    try {
      if (url === '/workspace') return { data: state }

      if (url === '/package/save') {
        const packageId = String(payload.packageId)
        const patch = payload.patch as Partial<MaterialPackage>
        const current = state.packages.find((item) => item.id === packageId)
        if (!current) throw new Error('资料包不存在')
        Object.assign(current, patch, { updatedAt: now() })
        current.matchedRuleId = findApplicableRule(current, state.rules)?.id
        invalidateFreezeAndBlockRoute(
          state,
          packageId,
          'package-saved',
          '申报信息保存后与冻结时固定的声明不再保证一致，需按当前资料重新提交。',
          audit,
        )
        audit({
          packageId,
          action: '更新资料包',
          target: current.code,
          operator: '当前用户',
          detail: '更新收件方、最终用途、声明或技术参数。',
        })
      } else if (url === '/package/create') {
        const draft = payload.package as Omit<
          MaterialPackage,
          | 'id'
          | 'approvalRoute'
          | 'versions'
          | 'currentRound'
          | 'createdAt'
          | 'updatedAt'
        >
        const rule = findApplicableRule(
          {
            ...draft,
            id: 'temp',
            approvalRoute: [],
            versions: [],
            currentRound: 0,
            createdAt: '',
            updatedAt: '',
          },
          state.rules,
        )
        const packageItem: MaterialPackage = {
          ...draft,
          id: `pkg-${crypto.randomUUID()}`,
          matchedRuleId: rule?.id,
          approvalRoute: [],
          currentRound: 0,
          createdAt: now(),
          updatedAt: now(),
          versions: [],
        }
        packageItem.versions.push({
          id: `version-${crypto.randomUUID()}`,
          label: 'V1.0',
          createdAt: now(),
          createdBy: packageItem.applicant,
          summary: '创建资料包初始版本。',
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: {},
          },
        })
        state.packages.unshift(packageItem)
        audit({
          packageId: packageItem.id,
          action: '创建资料包',
          target: packageItem.code,
          operator: packageItem.applicant,
          detail: `目的地：${packageItem.destination}，资料类型：${packageItem.category}。`,
        })
      } else if (url === '/file/save') {
        const file = payload.file as MaterialFile
        const index = state.files.findIndex((item) => item.id === file.id)
        if (index >= 0) {
          state.files[index] = file
        } else {
          state.files.push(file)
          invalidateFreezeAndBlockRoute(
            state,
            file.packageId,
            'file-added',
            `登记新文件 ${file.name}，冻结时固定的文件清单发生变化。`,
            audit,
          )
        }
      } else if (url === '/file/version/add') {
        const packageId = String(payload.packageId)
        const fileId = String(payload.fileId)
        const file = state.files.find((item) => item.id === fileId && item.packageId === packageId)
        if (!file) throw new Error('文件不存在')
        const pageCount = Number(payload.pageCount)
        const label = String(payload.label)
        const summary = String(payload.summary)
        const newVersion = {
          id: `file-version-${crypto.randomUUID()}`,
          label,
          uploadedAt: now(),
          hash: crypto.randomUUID().slice(0, 8).toUpperCase(),
          sizeKb: pageCount * 96 + 720,
          pages: Array.from({ length: pageCount }, (_, index) => ({
            id: `page-${crypto.randomUUID()}`,
            page: index + 1,
            category: file.kind,
            controlled: false,
            desensitized: false,
            note: '',
            reviewer: '',
          })),
          changeSummary: summary,
        }
        file.versions.push(newVersion)
        file.activeVersionId = newVersion.id
        invalidateFreezeAndBlockRoute(
          state,
          packageId,
          'file-version-changed',
          `文件 ${file.name} 现行版本更换为 ${label}，冻结时固定的版本与逐页核对结果不再现行。`,
          audit,
        )
        audit({
          packageId,
          action: '上传文件版本',
          target: `${file.name} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
      } else if (url === '/file/reference') {
        const fileId = String(payload.fileId)
        const versionId = String(payload.versionId)
        const file = state.files.find((item) => item.id === fileId)
        if (!file) throw new Error('文件不存在')
        file.referencedVersionId = versionId
        invalidateFreezeAndBlockRoute(
          state,
          file.packageId,
          'reference-changed',
          `文件 ${file.name} 审批引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
          audit,
        )
        audit({
          packageId: file.packageId,
          action: '选择引用版本',
          target: file.name,
          operator: '当前用户',
          detail: `引用版本调整为 ${file.versions.find((item) => item.id === versionId)?.label ?? versionId}。`,
        })
      } else if (url === '/page/save') {
        const file = state.files.find((item) => item.id === String(payload.fileId))
        const version = file?.versions.find((item) => item.id === String(payload.versionId))
        if (!file || !version) throw new Error('文件版本不存在')
        const page = payload.page as PageReview
        const index = version.pages.findIndex((item) => item.id === page.id)
        if (index >= 0) version.pages[index] = page
        else version.pages.push(page)
        invalidateFreezeAndBlockRoute(
          state,
          file.packageId,
          'page-review-changed',
          `文件 ${file.name} 第 ${page.page} 页逐页核对结果被修改。`,
          audit,
        )
        audit({
          packageId: file.packageId,
          action: '逐页分类核对',
          target: `${file.name} 第 ${page.page} 页`,
          operator: page.reviewer || '当前用户',
          detail: page.controlled ? `标记受控，脱敏状态：${page.desensitized ? '已脱敏' : '待脱敏'}` : '标记为一般资料',
        })
      } else if (url === '/package/validate') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        state.findings = [
          ...state.findings.filter((item) => item.packageId !== packageId),
          ...validatePackage(packageItem, state.files, state.rules, state.freezes),
        ]
        audit({
          packageId,
          action: '执行许可校验',
          target: packageItem.code,
          operator: '当前用户',
          detail: `生成 ${state.findings.filter((item) => item.packageId === packageId).length} 条核对结果。`,
        })
      } else if (url === '/package/version') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const summary = String(payload.summary)
        const label = String(payload.label)
        packageItem.versions.push({
          id: `package-version-${crypto.randomUUID()}`,
          label,
          createdAt: now(),
          createdBy: '当前用户',
          summary,
          snapshot: {
            title: packageItem.title,
            category: packageItem.category,
            destination: packageItem.destination,
            endUse: packageItem.endUse,
            technologyTags: [...packageItem.technologyTags],
            personnelScopes: [...packageItem.personnelScopes],
            declarations: [...packageItem.declarations],
            activeFileVersions: Object.fromEntries(
              state.files
                .filter((file) => file.packageId === packageId)
                .map((file) => [file.id, file.activeVersionId]),
            ),
          },
        })
        audit({
          packageId,
          action: '创建资料包版本',
          target: `${packageItem.code} ${label}`,
          operator: '当前用户',
          detail: summary,
        })
      } else if (url === '/approval/submit') {
        const packageId = String(payload.packageId)
        const amount = Number(payload.amount)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('预占额度必须为正整数')
        if (getActiveFreeze(state.freezes, packageId)) {
          throw new Error('已有有效的审批冻结单，请勿重复提交；撤回或等待审批结束后再操作')
        }
        const rule = findApplicableRule(packageItem, state.rules)
        if (!rule) throw new Error('未匹配到许可规则')

        const pool = getRuleQuotaPool(rule, state.freezes)
        if (pool.available < amount) {
          throw new Error(
            `许可规则「${rule.name}」额度池可用额度不足：可用 ${pool.available}（上限 ${pool.limit}，已转用 ${pool.consumed}，预占 ${pool.reserved}），本次需要 ${amount}`,
          )
        }

        packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
        packageItem.matchedRuleId = rule.id
        packageItem.status = 'reviewing'
        packageItem.currentRound += 1

        const findings = validatePackage(packageItem, state.files, state.rules, state.freezes)
        const highFindings = findings.filter((item) => item.level === 'high')
        if (highFindings.length) {
          throw new Error(`仍存在 ${highFindings.length} 项高风险核对项，不能生成冻结单：${highFindings[0].message}`)
        }
        state.findings = [
          ...state.findings.filter((item) => item.packageId !== packageId),
          ...findings,
        ]

        const freeze = buildFreeze({
          packageItem,
          rule,
          files: state.files,
          round: packageItem.currentRound,
          reservedAmount: amount,
          findings,
        })
        state.freezes.unshift(freeze)
        audit({
          packageId,
          action: '提交审批冻结',
          target: freeze.code,
          operator: '当前用户',
          detail: `按 ${rule.name} 生成第 ${packageItem.currentRound} 轮审批路线，固定声明与 ${freeze.files.length} 个文件现行版本及逐页核对结果，从额度池预占 ${amount}（池可用 ${pool.available - amount}）。`,
        })
      } else if (url === '/approval/decide') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const freeze = getActiveFreeze(state.freezes, packageId)
        if (!freeze) throw new Error('没有有效的审批冻结单，当前审批已被阻断，请补正资料后重新提交')
        const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
        if (!step || step.status !== 'active') throw new Error('当前步骤不可审批（重复提交不会生效）')
        const decision = String(payload.decision)
        step.comment = String(payload.comment ?? '')
        step.decidedAt = now()
        if (decision === 'return') {
          step.status = 'returned'
          packageItem.status = 'returned'
          freeze.status = 'released'
          freeze.releasedAt = now()
          freeze.releaseReason = 'approval-returned'
          audit({
            packageId,
            action: '审批退回',
            target: `${packageItem.code} / ${step.role}`,
            operator: step.assignee,
            detail: `${step.comment || '无补充意见。'}冻结单 ${freeze.code} 释放预占额度 ${freeze.reservedAmount}，补正后需重新提交。`,
          })
        } else {
          const drift = findSnapshotDrift(freeze, packageItem, state.files)
          if (drift) {
            invalidateFreezeAndBlockRoute(state, packageId, 'snapshot-drift', drift.detail, audit)
            throw new Error(`冻结快照与当前资料不一致，审批被阻断：${drift.detail}。请重新提交生成新的冻结单`)
          }
          step.status = 'approved'
          const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
          if (next) {
            next.status = 'active'
            audit({
              packageId,
              action: '审批通过',
              target: `${packageItem.code} / ${step.role}`,
              operator: step.assignee,
              detail: `依据冻结单 ${freeze.code} 的固定快照通过，进入下一审批角色。${step.comment || '无补充意见。'}`,
            })
          } else {
            // 最后一步：只按同一张冻结单把预占转为实占，池净占用不变；重复点击会在步骤状态校验处失败。
            packageItem.status = 'licensed'
            freeze.status = 'consumed'
            freeze.consumedAt = now()
            const rule = state.rules.find((item) => item.id === freeze.ruleId)
            const pool = rule ? getRuleQuotaPool(rule, state.freezes) : undefined
            audit({
              packageId,
              action: '转用许可额度',
              target: freeze.code,
              operator: step.assignee,
              detail: `全部审批步骤通过，冻结单 ${freeze.code} 预占的 ${freeze.reservedAmount} 转为实际使用${
                pool ? `（规则池：已转用 ${pool.consumed}、预占 ${pool.reserved}、可用 ${pool.available}）` : ''
              }，重复提交不会多占。`,
            })
          }
        }
      } else if (url === '/approval/withdraw') {
        const packageId = String(payload.packageId)
        const packageItem = state.packages.find((item) => item.id === packageId)
        if (!packageItem) throw new Error('资料包不存在')
        const freeze = getActiveFreeze(state.freezes, packageId)
        if (!freeze) throw new Error('没有可撤回的有效冻结单')
        freeze.status = 'released'
        freeze.releasedAt = now()
        freeze.releaseReason = 'approval-withdrawn'
        packageItem.status = 'draft'
        packageItem.approvalRoute = []
        audit({
          packageId,
          action: '撤回审批',
          target: freeze.code,
          operator: '当前用户',
          detail: `申请人撤回审批，释放冻结单预占额度 ${freeze.reservedAmount}，申报资料恢复可编辑。`,
        })
      } else if (url === '/comment/add') {
        state.comments.unshift({
          ...(payload.comment as Omit<ReviewComment, 'id' | 'createdAt'>),
          id: `comment-${crypto.randomUUID()}`,
          createdAt: now(),
        })
      } else if (url === '/audit/add') {
        audit(payload.entry as Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>)
      } else if (url === '/workspace/reset') {
        state = resetWorkspace()
        saveWorkspace(state)
        return { data: state }
      } else {
        throw new Error(`未实现的本地接口：${url}`)
      }

      saveWorkspace(state)
      return { data: state }
    } catch (error) {
      return {
        error: {
          status: 400,
          error: error instanceof Error ? error.message : '本地操作失败',
        },
      }
    }
  }

  // 所有写操作经过同一临界区串行执行，前后脚提交也只能顺序预占同一额度池。
  return method === 'POST' && url !== '/workspace' ? runSerialized(handle) : handle()
}

export const workspaceApi = createApi({
  reducerPath: 'workspaceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Workspace'],
  endpoints: (builder) => ({
    getWorkspace: builder.query<WorkspaceState, void>({
      query: () => ({ url: '/workspace', method: 'GET' }),
      providesTags: ['Workspace'],
    }),
    savePackage: builder.mutation<
      WorkspaceState,
      { packageId: string; patch: Partial<MaterialPackage> }
    >({
      query: (body) => ({ url: '/package/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackage: builder.mutation<
      WorkspaceState,
      {
        package: Omit<
          MaterialPackage,
          'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
        >
      }
    >({
      query: (body) => ({ url: '/package/create', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    saveFile: builder.mutation<WorkspaceState, { file: MaterialFile }>({
      query: (body) => ({ url: '/file/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addFileVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; fileId: string; label: string; pageCount: number; summary: string }
    >({
      query: (body) => ({ url: '/file/version/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    setReferenceVersion: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string }
    >({
      query: (body) => ({ url: '/file/reference', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    savePageReview: builder.mutation<
      WorkspaceState,
      { fileId: string; versionId: string; page: PageReview }
    >({
      query: (body) => ({ url: '/page/save', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    validatePackage: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/package/validate', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    createPackageVersion: builder.mutation<
      WorkspaceState,
      { packageId: string; label: string; summary: string }
    >({
      query: (body) => ({ url: '/package/version', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    submitApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; amount: number }
    >({
      query: (body) => ({ url: '/approval/submit', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    decideApproval: builder.mutation<
      WorkspaceState,
      { packageId: string; stepId: string; decision: 'approve' | 'return'; comment: string }
    >({
      query: (body) => ({ url: '/approval/decide', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    withdrawApproval: builder.mutation<WorkspaceState, { packageId: string }>({
      query: (body) => ({ url: '/approval/withdraw', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addComment: builder.mutation<
      WorkspaceState,
      { comment: Omit<ReviewComment, 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/comment/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    addAudit: builder.mutation<
      WorkspaceState,
      { entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'> }
    >({
      query: (body) => ({ url: '/audit/add', method: 'POST', body }),
      invalidatesTags: ['Workspace'],
    }),
    resetWorkspace: builder.mutation<WorkspaceState, void>({
      query: () => ({ url: '/workspace/reset', method: 'POST' }),
      invalidatesTags: ['Workspace'],
    }),
  }),
})

export const {
  useGetWorkspaceQuery,
  useSavePackageMutation,
  useCreatePackageMutation,
  useSaveFileMutation,
  useAddFileVersionMutation,
  useSetReferenceVersionMutation,
  useSavePageReviewMutation,
  useValidatePackageMutation,
  useCreatePackageVersionMutation,
  useSubmitApprovalMutation,
  useDecideApprovalMutation,
  useWithdrawApprovalMutation,
  useAddCommentMutation,
  useAddAuditMutation,
  useResetWorkspaceMutation,
} = workspaceApi
