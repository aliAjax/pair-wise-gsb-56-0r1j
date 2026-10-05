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
import { checkFreezeReadiness, createApprovalFreeze } from '@/services/freezes'
import { createApprovalRoute, findApplicableRule, validatePackage } from '@/services/rules'

type MockRequest = {
  url: string
  method: 'GET' | 'POST'
  body?: unknown
}

type MockError = { status: number; error: string }

const wait = (ms = 180) => new Promise((resolve) => window.setTimeout(resolve, ms))
const now = () => new Date().toISOString()

/**
 * 本地写操作串行化：重复点击或前后脚提交时，所有变更排队进入同一临界区，
 * 配合“存在生效冻结单即拒绝重复提交”的幂等守卫，确保额度不会被多占。
 */
let writeChain: Promise<unknown> = Promise.resolve()
function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task)
  writeChain = result.catch(() => undefined)
  return result
}

export const mockBaseQuery: BaseQueryFn<MockRequest, unknown, MockError> = async ({ url, method, body }) => {
  if (method === 'GET') return handleRequest(url, body)
  return runExclusive(() => handleRequest(url, body))
}

async function handleRequest(url: string, body: unknown) {
  await wait()
  let state = loadWorkspace()
  const payload = (body ?? {}) as Record<string, unknown>
  const audit = (entry: Omit<WorkspaceState['audit'][number], 'id' | 'createdAt'>) => {
    state.audit.unshift({ ...entry, id: `audit-${crypto.randomUUID()}`, createdAt: now() })
  }
  /**
   * 冻结单失效钩子：保存资料包、换版本或修改核对页都会让当前冻结单失效。
   * 失效冻结单（含旧快照与原因）永久保留，但预占额度立即释放回规则池，
   * 审批中的资料包回到“已退回”，审批人无法再按旧页面通过。
   */
  const invalidateFreeze = (packageId: string, reason: string) => {
    const freeze = state.freezes.find(
      (item) => item.packageId === packageId && item.status === 'active',
    )
    if (!freeze) return
    freeze.status = 'invalidated'
    freeze.invalidatedAt = now()
    freeze.invalidatedReason = reason
    const target = state.packages.find((item) => item.id === packageId)
    if (target) {
      target.activeFreezeId = undefined
      if (target.status === 'reviewing') {
        target.status = 'returned'
        const activeStep = target.approvalRoute.find((step) => step.status === 'active')
        if (activeStep) {
          activeStep.status = 'returned'
          activeStep.comment = `冻结单失效：${reason}`
          activeStep.decidedAt = now()
        }
      }
    }
    audit({
      packageId,
      action: '冻结单失效',
      target: target?.code ?? packageId,
      operator: '系统',
      detail: `冻结单 ${freeze.id} 已失效，预占额度 ${freeze.amount} 已释放回规则池。失效原因：${reason}`,
    })
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
      invalidateFreeze(packageId, '资料包保存后申报信息或声明已变更，审批依据不再一致。')
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
        'id' | 'approvalRoute' | 'versions' | 'currentRound' | 'createdAt' | 'updatedAt'
      >
      const rule = findApplicableRule(
        { ...draft, id: 'temp', approvalRoute: [], versions: [], currentRound: 0, createdAt: '', updatedAt: '' },
        state.rules,
      )
      const packageItem: MaterialPackage = {
        ...draft,
        id: `pkg-${crypto.randomUUID()}`,
        matchedRuleId: rule?.id,
        activeFreezeId: undefined,
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
      if (index >= 0) state.files[index] = file
      else state.files.push(file)
      invalidateFreeze(file.packageId, `资料文件 ${file.name} 已保存变更，冻结文件版本不再是现行版本。`)
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
      invalidateFreeze(packageId, `${file.name} 换版本至 ${label}，冻结的现行版本与逐页核对结果已过时。`)
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
      invalidateFreeze(
        file.packageId,
        `${file.name} 的审批引用版本被切换，冻结版本与引用版本不一致。`,
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
      invalidateFreeze(
        file.packageId,
        `${file.name} 第 ${page.page} 页逐页核对结果被修改，冻结的核对结论已过时。`,
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
      invalidateFreeze(packageId, `资料包换版本至 ${label}，冻结的申报快照不再是当前版本。`)
      audit({
        packageId,
        action: '创建资料包版本',
        target: `${packageItem.code} ${label}`,
        operator: '当前用户',
        detail: summary,
      })
    } else if (url === '/approval/submit') {
      const packageId = String(payload.packageId)
      const amount = Math.floor(Number(payload.amount))
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      // 幂等守卫：已有生效冻结单时直接拒绝，重复点击/并发提交不会产生第二张单。
      if (state.freezes.some((item) => item.packageId === packageId && item.status === 'active')) {
        throw new Error('审批冻结单已生效并预占额度，请勿重复提交；如需补正请先撤回。')
      }
      if (packageItem.status === 'licensed') {
        throw new Error('资料包已完成许可转用，无需再次提交。')
      }
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('请填写大于 0 的预占额度')
      const rule = findApplicableRule(packageItem, state.rules)
      if (!rule) throw new Error('未匹配到许可规则')
      const packageFiles = state.files.filter((file) => file.packageId === packageId)
      const blocking = checkFreezeReadiness(
        packageItem,
        state.files,
        state.rules,
        state.freezes,
        amount,
        rule.id,
      )
      if (blocking.length) throw new Error(blocking.map((item) => item.message).join('；'))

      // 固定审批路线并生成提交瞬间的核对结论快照。
      packageItem.approvalRoute = createApprovalRoute(rule.approvalLevel)
      const snapshotFindings = validatePackage(
        packageItem,
        state.files,
        state.rules,
        state.freezes,
      )
      state.findings = [
        ...state.findings.filter((item) => item.packageId !== packageId),
        ...snapshotFindings,
      ]
      const freeze = createApprovalFreeze({
        packageItem,
        ruleId: rule.id,
        ruleName: rule.name,
        amount,
        files: packageFiles,
        findings: snapshotFindings,
      })
      state.freezes.unshift(freeze)
      packageItem.matchedRuleId = rule.id
      packageItem.quotaLimit = rule.quotaLimit
      packageItem.status = 'reviewing'
      packageItem.activeFreezeId = freeze.id
      packageItem.currentRound += 1
      packageItem.updatedAt = now()
      audit({
        packageId,
        action: '提交审批',
        target: packageItem.code,
        operator: '当前用户',
        detail: `创建审批冻结单 ${freeze.id}，按 ${rule.name} 生成第 ${packageItem.currentRound} 轮审批路线。`,
      })
      audit({
        packageId,
        action: '预占许可额度',
        target: packageItem.code,
        operator: '系统',
        detail: `冻结单 ${freeze.id} 从规则池「${rule.name}」预占额度 ${amount}，审批期间其他资料包不能占用该额度。`,
      })
    } else if (url === '/approval/decide') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const freeze = state.freezes.find(
        (item) => item.id === packageItem.activeFreezeId && item.status === 'active',
      )
      // 审批只认冻结单：冻结失效后旧页面上的通过/退回一律拒绝。
      if (!freeze) throw new Error('审批冻结单不存在或已失效，请撤回补正后重新提交。')
      const step = packageItem.approvalRoute.find((item) => item.id === String(payload.stepId))
      if (!step || step.status !== 'active') throw new Error('当前步骤不可审批')
      const decision = String(payload.decision)
      step.comment = String(payload.comment ?? '')
      step.decidedAt = now()
      if (decision === 'return') {
        step.status = 'returned'
        packageItem.status = 'returned'
        freeze.status = 'released'
        freeze.releasedAt = now()
        packageItem.activeFreezeId = undefined
        audit({
          packageId,
          action: '审批退回',
          target: `${packageItem.code} / ${step.role}`,
          operator: step.assignee,
          detail: step.comment || '无补充意见。',
        })
        audit({
          packageId,
          action: '释放预占额度',
          target: packageItem.code,
          operator: '系统',
          detail: `冻结单 ${freeze.id} 因审批退回释放预占额度 ${freeze.amount}，已退回规则池「${freeze.ruleName}」。`,
        })
      } else {
        step.status = 'approved'
        const next = packageItem.approvalRoute.find((item) => item.order === step.order + 1)
        if (next) {
          next.status = 'active'
          audit({
            packageId,
            action: '审批通过',
            target: `${packageItem.code} / ${step.role}`,
            operator: step.assignee,
            detail: step.comment || '无补充意见。',
          })
        } else {
          // 最后一步通过：只按同一冻结单把预占额度转为实际使用，不再重新计算或二次占用。
          freeze.status = 'consumed'
          freeze.consumedAt = now()
          packageItem.activeFreezeId = undefined
          packageItem.status = 'licensed'
          packageItem.quotaUsed += freeze.amount
          audit({
            packageId,
            action: '审批通过',
            target: `${packageItem.code} / ${step.role}`,
            operator: step.assignee,
            detail: '全部审批步骤完成，冻结单固定的申报声明、文件版本与逐页核对结果通过。',
          })
          audit({
            packageId,
            action: '预占额度转用',
            target: packageItem.code,
            operator: '系统',
            detail: `冻结单 ${freeze.id} 的预占额度 ${freeze.amount} 转为实际使用，规则池「${freeze.ruleName}」未发生二次扣减。`,
          })
        }
      }
    } else if (url === '/approval/withdraw') {
      const packageId = String(payload.packageId)
      const packageItem = state.packages.find((item) => item.id === packageId)
      if (!packageItem) throw new Error('资料包不存在')
      const freeze = state.freezes.find(
        (item) => item.id === packageItem.activeFreezeId && item.status === 'active',
      )
      if (!freeze) throw new Error('没有生效中的审批冻结单，无法撤回。')
      const activeStep = packageItem.approvalRoute.find((step) => step.status === 'active')
      if (activeStep) activeStep.status = 'waiting'
      freeze.status = 'released'
      freeze.releasedAt = now()
      packageItem.activeFreezeId = undefined
      packageItem.status = 'draft'
      packageItem.updatedAt = now()
      audit({
        packageId,
        action: '撤回审批',
        target: packageItem.code,
        operator: '当前用户',
        detail: `申请人撤回第 ${freeze.round} 轮审批，冻结单 ${freeze.id} 固定内容保留备查。`,
      })
      audit({
        packageId,
        action: '释放预占额度',
        target: packageItem.code,
        operator: '系统',
        detail: `撤回后冻结单 ${freeze.id} 释放预占额度 ${freeze.amount}，已退回规则池「${freeze.ruleName}」。`,
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
      return { data: state }
    } else {
      throw new Error(`未实现的本地接口：${url}`)
    }

    saveWorkspace(state)
    return { data: state }
  } catch (error) {
    return {
      // 正常业务拒绝（如重复提交、额度不足）走 400 数据错误，不抛出未捕获异常。
      error: {
        status: 400,
        error: error instanceof Error ? error.message : '本地操作失败',
      },
    }
  }
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
