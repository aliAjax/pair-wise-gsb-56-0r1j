// 冻结单端到端冒烟测试：驱动真实 RTK Query endpoints（mock baseQuery 经 localStorage 持久化）。
import { configureStore } from '@reduxjs/toolkit'
import { workspaceApi } from '../src/app/api'
import type { WorkspaceState } from '../src/types/domain'
import { getRuleQuotaPool, findSnapshotDrift } from '../src/services/freezes'

interface StorageMap {
  [key: string]: string
}

const memoryStorage = (): Storage => {
  const map: StorageMap = {}
  return {
    get length() {
      return Object.keys(map).length
    },
    clear: () => Object.keys(map).forEach((key) => delete map[key]),
    getItem: (key: string) => (key in map ? map[key] : null),
    key: (index: number) => Object.keys(map)[index] ?? null,
    removeItem: (key: string) => delete map[key],
    setItem: (key: string, value: string) => {
      map[key] = String(value)
    },
  }
}

;(globalThis as { localStorage?: Storage }).localStorage = memoryStorage()
;(globalThis as { window?: unknown }).window = globalThis

let store = configureStore({
  reducer: { [workspaceApi.reducerPath]: workspaceApi.reducer },
  middleware: (getDefault) => getDefault().concat(workspaceApi.middleware),
})

const reset = async () => {
  const result = await store.dispatch(workspaceApi.endpoints.resetWorkspace.initiate(undefined)).unwrap()
  return result
}

type RawDispatchResult = PromiseLike<{ data?: WorkspaceState; error?: { status: number; error: string } }>
const unwrap = (p: RawDispatchResult) =>
  Promise.resolve(p).then(
    (result) =>
      result.error
        ? { ok: false as const, error: result.error.error }
        : { ok: true as const, value: result.data as WorkspaceState },
    (error: unknown) => ({
      ok: false as const,
      error:
        typeof error === 'object' && error !== null && 'data' in error
          ? ((error.data as { error: string }).error)
          : String(error),
    }),
  )

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1. 初始演示数据额度池
{
  const state = await reset()
  const sgRule = state.rules.find((rule) => rule.id === 'rule-sg-composite')!
  const pool = getRuleQuotaPool(sgRule, state.freezes)
  console.log('初始额度池（新加坡规则）:', pool)
  check('新加坡规则池：上限80 / 已转用0 / 预占64 / 可用16', pool.limit === 80 && pool.consumed === 0 && pool.reserved === 64 && pool.available === 16, JSON.stringify(pool))
  const deRule = state.rules.find((rule) => rule.id === 'rule-de-software')!
  const dePool = getRuleQuotaPool(deRule, state.freezes)
  check('德国规则池：已转用42（pkg-002 冻结单）', dePool.consumed === 42 && dePool.reserved === 0 && dePool.available === 78)
  const usPool = getRuleQuotaPool(state.rules.find((rule) => rule.id === 'rule-us-lithography')!, state.freezes)
  check('美国规则池：退回后预占释放，可用30', usPool.consumed === 0 && usPool.reserved === 0 && usPool.available === 30)
}

// 2. 重复点击提交：同一资料包第二次提交被拒，不产生第二张冻结单、不多占
{
  const state = await reset()
  // pkg-004 是马来西亚草稿，补齐规则要求的两条声明
  await store.dispatch(
    workspaceApi.endpoints.savePackage.initiate({
      packageId: 'pkg-004',
      patch: { declarations: ['最终用户声明', '最终用途声明'] },
    }),
  )
  const r1 = await unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-004', amount: 5 })))
  const r2 = await unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-004', amount: 7 })))
  check('第一次提交成功', r1.ok)
  check('重复提交被拒绝', !r2.ok && r2.error.includes('有效的审批冻结单'), r2.ok ? '' : r2.error)
  const active = r1.ok ? r1.value.freezes.filter((f) => f.packageId === 'pkg-004') : []
  check('只生成一张冻结单且预占5', active.length === 1 && active[0].status === 'active' && active[0].reservedAmount === 5)
}

// 3. 前后脚并发提交两个包，串行预占，第三个超额失败且不占额度
{
  await reset()
  const withdrawn = await unwrap(store.dispatch(workspaceApi.endpoints.withdrawApproval.initiate({ packageId: 'pkg-005' })))
  check('撤回 pkg-005 释放64', withdrawn.ok, withdrawn.ok ? '' : withdrawn.error)

  // 让 pkg-001 达到可提交条件：补齐不扩散声明、引用切到现行版本、完成逐页核对
  const sgFile = (await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)).unwrap() as WorkspaceState).files.find((f) => f.id === 'file-001-a')!
  await store.dispatch(
    workspaceApi.endpoints.savePackage.initiate({
      packageId: 'pkg-001',
      patch: {
        declarations: ['最终用户声明', '最终用途声明', '不扩散声明'],
        status: 'returned',
      },
    }),
  )
  await store.dispatch(
    workspaceApi.endpoints.setReferenceVersion.initiate({ fileId: 'file-001-a', versionId: sgFile.activeVersionId }),
  )
  const ws2 = (await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)).unwrap()) as WorkspaceState
  const file001a = ws2.files.find((f) => f.id === 'file-001-a')!
  const vCurrent = file001a.versions.find((v) => v.id === file001a.activeVersionId)!
  for (const page of vCurrent.pages) {
    await store.dispatch(
      workspaceApi.endpoints.savePageReview.initiate({
        fileId: file001a.id,
        versionId: vCurrent.id,
        page: { ...page, reviewer: '测试员', reviewedAt: new Date().toISOString() },
      }),
    )
  }
  // 上述保存操作会触发冻结单失效逻辑（pkg-001 初始没有 active 冻结单，无副作用），
  // 但 savePackage 可能把状态置为 freeze-invalid，重置为 returned 后再校验。
  await store.dispatch(
    workspaceApi.endpoints.savePackage.initiate({ packageId: 'pkg-001', patch: { status: 'returned' } }),
  )
  await store.dispatch(workspaceApi.endpoints.validatePackage.initiate({ packageId: 'pkg-001' }))

  // 池可用 80（撤回后）；并发：72 + 5 = 77 成功，第三个 5 超额（剩3）
  const results = await Promise.all([
    unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-001', amount: 72 }))),
    unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-005', amount: 5 }))),
  ])
  check('并发提交一：预占72成功（串行顺序1）', results[0].ok, results[0].ok ? '' : results[0].error)
  check('并发提交二：预占5成功（串行顺序2，剩3）', results[1].ok, results[1].ok ? '' : results[1].error)
  // 没有有效冻结单的新包，因池仅剩3、申请4 被拒（真正的额度不足路径）
  const created = await store.dispatch(
    workspaceApi.endpoints.createPackage.initiate({
      package: {
        code: 'EC-2026-099',
        title: '新加坡额度竞争验证包',
        category: 'technical',
        applicant: '测试员',
        recipient: 'SG Overflow Pte. Ltd.',
        destination: '新加坡',
        endUse: '民用试制',
        technologyTags: ['复合材料'],
        personnelScopes: [],
        declarations: ['最终用户声明', '最终用途声明', '不扩散声明'],
        status: 'draft',
      },
    }),
  ).unwrap()
  const overflowPkgId = created.packages.find((p) => p.code === 'EC-2026-099')!.id
  const overflow = await unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: overflowPkgId, amount: 4 })))
  check('同池新包超额提交被拒且不预占（池仅剩3）', !overflow.ok && overflow.error.includes('可用额度不足'), overflow.ok ? '' : overflow.error)
  const finalState = (await store.dispatch(workspaceApi.endpoints.getWorkspace.initiate(undefined)).unwrap()) as WorkspaceState
  const pool = getRuleQuotaPool(finalState.rules.find((r) => r.id === 'rule-sg-composite')!, finalState.freezes)
  check('池预占合计77、可用3', pool.reserved === 77 && pool.available === 3, JSON.stringify(pool))
}

// 4. 保存核对页让冻结单失效并释放预占；旧快照与原因保留
{
  const state = await reset()
  const before = getRuleQuotaPool(state.rules.find((r) => r.id === 'rule-my-general')!, state.freezes)
  await store.dispatch(
    workspaceApi.endpoints.savePackage.initiate({
      packageId: 'pkg-004',
      patch: { declarations: ['最终用户声明', '最终用途声明'] },
    }),
  )
  const submitted = await unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-004', amount: 10 })))
  check('pkg-004 提交预占10成功', submitted.ok, submitted.ok ? '' : submitted.error)
  const file = submitted.ok ? submitted.value.files.find((f) => f.id === 'file-004-a')! : undefined
  const page = file!.versions.find((v) => v.id === file!.activeVersionId)!.pages[0]
  const saved = await unwrap(
    store.dispatch(
      workspaceApi.endpoints.savePageReview.initiate({
        fileId: file!.id,
        versionId: file!.activeVersionId,
        page: { ...page, controlled: true, desensitized: true, reviewer: '测试员', reviewedAt: new Date().toISOString(), note: '冻结失效验证' },
      }),
    ),
  )
  check('保存核对页成功', saved.ok)
  const after = saved.ok ? saved.value : undefined!
  const freeze = after.freezes.find((f) => f.packageId === 'pkg-004')!
  check('冻结单状态为 invalidated', freeze.status === 'invalidated')
  check('失效原因为 page-review-changed', freeze.invalidatedReason === 'page-review-changed')
  check('旧快照仍固定旧核对结果（受控页为0）', freeze.files[0].pages.every((p) => !p.controlled))
  const pkg = after.packages.find((p) => p.id === 'pkg-004')!
  check('资料包状态为冻结失效', pkg.status === 'freeze-invalid')
  const poolAfter = getRuleQuotaPool(after.rules.find((r) => r.id === 'rule-my-general')!, after.freezes)
  check('预占已释放（马来西亚池回到可用100）', poolAfter.reserved === before.reserved && poolAfter.available === before.available, JSON.stringify(poolAfter))
}

// 5. 审批中漂移被拦截；退回释放；最终通过按同一冻结单转用且重复点击不多占
{
  const state = await reset()
  // 撤回 pkg-005，释放后用它（声明齐全、逐页已核对、引用一致）走完整流程
  const withdrawn = await unwrap(store.dispatch(workspaceApi.endpoints.withdrawApproval.initiate({ packageId: 'pkg-005' })))
  check('撤回 pkg-005 释放64', withdrawn.ok)
  if (!withdrawn.ok) throw new Error(withdrawn.error)
  check('撤回后状态为 draft', withdrawn.value.packages.find((p) => p.id === 'pkg-005')!.status === 'draft')

  const submitted = await unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-005', amount: 20 })))
  check('重新提交 pkg-005 预占20', submitted.ok, submitted.ok ? '' : submitted.error)
  if (!submitted.ok) throw new Error(submitted.error)
  const freezeId = submitted.value.freezes.find((f) => f.packageId === 'pkg-005' && f.status === 'active')!.id
  const pkg = submitted.value.packages.find((p) => p.id === 'pkg-005')!

  // 5a. 快照漂移纯函数校验（声明变化）
  const driftedPkg = { ...pkg, declarations: [...pkg.declarations, '不扩散声明', '多余声明'] }
  const drift = findSnapshotDrift(
    submitted.value.freezes.find((f) => f.id === freezeId)!,
    driftedPkg as typeof pkg,
    submitted.value.files,
  )
  check('声明变化可检测为快照漂移', Boolean(drift) && drift?.reason === 'snapshot-drift')

  // 5b. 前两步正常通过
  const steps = [...pkg.approvalRoute].sort((x, y) => x.order - y.order)
  const d1 = await unwrap(store.dispatch(workspaceApi.endpoints.decideApproval.initiate({ packageId: 'pkg-005', stepId: steps[0].id, decision: 'approve', comment: '第一步通过' })))
  check('第一步通过', d1.ok, d1.ok ? '' : d1.error)
  const stateAfter1 = d1.ok ? d1.value : null
  const step2Id = stateAfter1!.packages.find((p) => p.id === 'pkg-005')!.approvalRoute.find((s) => s.status === 'active')!.id
  const d2 = await unwrap(store.dispatch(workspaceApi.endpoints.decideApproval.initiate({ packageId: 'pkg-005', stepId: step2Id, decision: 'approve', comment: '第二步通过' })))
  check('第二步通过', d2.ok, d2.ok ? '' : d2.error)

  // 5c. 最后一步重复点击：同一活动步骤并发两次，只允许一次成功
  const stateAfter2 = d2.value
  const step3Id = stateAfter2.packages.find((p) => p.id === 'pkg-005')!.approvalRoute.find((s) => s.status === 'active')!.id
  const [last1, last2] = await Promise.all([
    unwrap(store.dispatch(workspaceApi.endpoints.decideApproval.initiate({ packageId: 'pkg-005', stepId: step3Id, decision: 'approve', comment: '终审A' }))),
    unwrap(store.dispatch(workspaceApi.endpoints.decideApproval.initiate({ packageId: 'pkg-005', stepId: step3Id, decision: 'approve', comment: '终审B（重复点击）' }))),
  ])
  check('终审并发：恰好一次成功', Number(last1.ok) + Number(last2.ok) === 1, `last1=${last1.ok} last2=${last2.ok}`)
  const winner = last1.ok ? last1.value : last2.ok ? last2.value : null
  check('资料包已许可', winner!.packages.find((p) => p.id === 'pkg-005')!.status === 'licensed')
  const consumedFreeze = winner!.freezes.find((f) => f.id === freezeId)!
  check('冻结单转用 consumed 且金额20', consumedFreeze.status === 'consumed' && consumedFreeze.reservedAmount === 20)
  const pool = getRuleQuotaPool(winner!.rules.find((r) => r.id === 'rule-sg-composite')!, winner!.freezes)
  check('转用后池净占用不变（consumed=20, reserved=0）', pool.consumed === 20 && pool.reserved === 0, JSON.stringify(pool))
}

// 6. 退回释放预占
{
  await reset()
  await store.dispatch(
    workspaceApi.endpoints.savePackage.initiate({
      packageId: 'pkg-004',
      patch: { declarations: ['最终用户声明', '最终用途声明'] },
    }),
  )
  const submitted = await unwrap(store.dispatch(workspaceApi.endpoints.submitApproval.initiate({ packageId: 'pkg-004', amount: 12 })))
  check('pkg-004 提交预占12', submitted.ok, submitted.ok ? '' : submitted.error)
  const stepId = submitted.value.packages.find((p) => p.id === 'pkg-004')!.approvalRoute[0].id
  const returned = await unwrap(store.dispatch(workspaceApi.endpoints.decideApproval.initiate({ packageId: 'pkg-004', stepId, decision: 'return', comment: '缺材料' })))
  check('第一步退回成功', returned.ok, returned.ok ? '' : returned.error)
  const freeze = returned.value.freezes.find((f) => f.packageId === 'pkg-004')!
  check('冻结单 released 且原因为退回', freeze.status === 'released' && freeze.releaseReason === 'approval-returned')
  const pool = getRuleQuotaPool(returned.value.rules.find((r) => r.id === 'rule-my-general')!, returned.value.freezes)
  check('退回后马来西亚池预占归零、可用100', pool.reserved === 0 && pool.available === 100, JSON.stringify(pool))
  check('资料包状态为 returned', returned.value.packages.find((p) => p.id === 'pkg-004')!.status === 'returned')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
