// 端到端业务验证：并发提交幂等 / 额度池预占 / 失效与退回释放 / 末步转用不重复扣减。
import { mockBaseQuery } from '@/app/api'

const storage: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (key: string) => (key in storage ? storage[key] : null),
  setItem: (key: string, value: string) => {
    storage[key] = String(value)
  },
  removeItem: (key: string) => delete storage[key],
}
;(globalThis as any).window = { setTimeout, localStorage: (globalThis as any).localStorage }
if (!globalThis.crypto?.randomUUID) {
  let counter = 0
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => `uuid-${Date.now()}-${counter++}` },
  })
}

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

type State = any
async function post(url: string, body?: unknown): Promise<{ data?: State; error?: { error: string } }> {
  return mockBaseQuery({ url, method: 'POST', body }) as any
}
async function getState(): Promise<State> {
  const result = await mockBaseQuery({ url: '/workspace', method: 'GET' })
  return (result as any).data
}

function pool(state: State, ruleId: string) {
  const freezes = state.freezes
  const rule = state.rules.find((r: any) => r.id === ruleId)
  const used = freezes
    .filter((f: any) => f.ruleId === ruleId && f.status === 'consumed')
    .reduce((t: number, f: any) => t + f.amount, 0)
  const reserved = freezes
    .filter((f: any) => f.ruleId === ruleId && f.status === 'active')
    .reduce((t: number, f: any) => t + f.amount, 0)
  return { rule, used, reserved, available: rule.quotaLimit - used - reserved }
}

async function run() {
  await post('/workspace/reset')
  let state = await getState()

  console.log('1) 种子数据：pkg-005 生效冻结单预占兜底规则 10，池剩余 10')
  const globalPool = pool(state, 'rule-global-default')
  check('兜底池：已转用 0', globalPool.used === 0)
  check('兜底池：预占 10', globalPool.reserved === 10)
  check('兜底池：可用 10/20', globalPool.available === 10)
  const dePool = pool(state, 'rule-de-software')
  check('德国池：已转用 42（pkg-002）', dePool.used === 42)
  check('德国池：可用 78', dePool.available === 78)

  console.log('2) 重复点击 / 前后脚并发提交同一资料包：只产生一张冻结单、只预占一次')
  // 新建一个干净的德国软件资料包（标签命中德国规则，评分高于兜底），再登记一个 3 页文件
  const created = await post('/package/create', {
    package: {
      code: 'EC-2026-TEST',
      title: '并发测试软件包',
      category: 'software',
      applicant: '测试员',
      recipient: 'Rhein Automation GmbH',
      destination: '德国',
      endUse: '测试',
      technologyTags: ['工业控制'],
      personnelScopes: [],
      declarations: ['最终用户声明', '软件用途声明'],
      status: 'draft',
      quotaUsed: 0,
      quotaLimit: 120,
    },
  })
  check('新建测试包成功', !created.error, created.error?.error)
  state = await getState()
  const testPkg = state.packages.find((p: any) => p.code === 'EC-2026-TEST')
  const pkg004 = testPkg.id
  const newFile: any = {
    id: 'file-test-a',
    packageId: pkg004,
    name: '测试软件.zip',
    kind: 'software',
    activeVersionId: 'ver-test-a',
    referencedVersionId: 'ver-test-a',
    versions: [
      {
        id: 'ver-test-a',
        label: 'V1.0',
        uploadedAt: '2026-10-05T00:00:00.000Z',
        hash: 'TEST-0001',
        sizeKb: 1000,
        changeSummary: '初始版本',
        pages: [1, 2, 3].map((page) => ({
          id: `page-test-${page}`,
          page,
          category: 'drawing',
          controlled: false,
          desensitized: false,
          note: '',
          reviewer: '测试',
          reviewedAt: '2026-10-05T00:00:00.000Z',
        })),
      },
    ],
  }
  await post('/file/save', { file: newFile })
  state = await getState()
  const file004 = state.files.find((f: any) => f.id === 'file-test-a')
  check('命中德国软件规则', state.packages.find((p: any) => p.id === pkg004).matchedRuleId === 'rule-de-software')
  const myPoolBefore = pool(state, 'rule-de-software')
  check('德国池提交前可用 78（42 已被 pkg-002 转用）', myPoolBefore.available === 78)

  const concurrent = await Promise.all([
    post('/approval/submit', { packageId: pkg004, amount: 12 }),
    post('/approval/submit', { packageId: pkg004, amount: 12 }),
    post('/approval/submit', { packageId: pkg004, amount: 12 }),
  ])
  const okCount = concurrent.filter((r) => !r.error).length
  const errCount = concurrent.filter((r) => r.error).length
  if (okCount !== 1) console.log('   调试：', concurrent.map((r) => r.error?.error))
  check('3 次并发提交：恰好 1 次成功', okCount === 1, `ok=${okCount}`)
  check('2 次被幂等守卫拒绝', errCount === 2, `err=${errCount}`)
  state = await getState()
  const freezes004 = state.freezes.filter((f: any) => f.packageId === pkg004)
  check('该包只有 1 张冻结单', freezes004.length === 1, `count=${freezes004.length}`)
  check('冻结单为 active 且金额 12', freezes004[0].status === 'active' && freezes004[0].amount === 12)
  const myPoolAfter = pool(state, 'rule-de-software')
  check('德国池预占 12、可用 66', myPoolAfter.reserved === 12 && myPoolAfter.available === 66)

  console.log('3) 审批期间改核对页：冻结单失效、审批退回、预占释放、旧快照保留')
  const freezeId = freezes004[0].id
  const page = state.files
    .find((f: any) => f.packageId === pkg004)
    .versions[0].pages[0]
  const editResult = await post('/page/save', {
    fileId: file004.id,
    versionId: file004.activeVersionId,
    page: { ...page, controlled: true, note: '审批期间改动', reviewer: '测试' },
  })
  check('修改核对页成功', !editResult.error)
  state = await getState()
  const invalidated = state.freezes.find((f: any) => f.id === freezeId)
  check('冻结单状态为 invalidated', invalidated.status === 'invalidated')
  check('失效原因已记录', Boolean(invalidated.invalidatedReason))
  check('旧快照文件与页结果保留', invalidated.files[0].pages.length === 3)
  check('预占已释放，德国池可用恢复 78', pool(state, 'rule-de-software').available === 78)
  const pkg4 = state.packages.find((p: any) => p.id === pkg004)
  check('资料包状态回到 returned', pkg4.status === 'returned')
  check('activeFreezeId 已清空', !pkg4.activeFreezeId)
  const step1 = pkg4.approvalRoute[0]
  check('活动步骤标记为 returned', step1.status === 'returned')

  console.log('4) 退回释放预占：pkg-005 第一步退回后池额度归还')
  const p5 = state.packages.find((p: any) => p.id === 'pkg-005')
  const step5 = p5.approvalRoute.find((s: any) => s.status === 'active')
  const ret = await post('/approval/decide', {
    packageId: 'pkg-005',
    stepId: step5.id,
    decision: 'return',
    comment: '补正',
  })
  check('退回成功', !ret.error, ret.error?.error)
  state = await getState()
  check('退回后兜底池可用恢复 20', pool(state, 'rule-global-default').available === 20)
  check('退回冻结单标记 released', state.freezes.find((f: any) => f.id === 'freeze-pkg-005-r1').status === 'released')

  console.log('5) 末步通过仅按同一冻结单转用，重复决定不多占')
  // 补正后重新提交测试包（德国软件规则，standard 两级）
  await post('/package/save', {
    packageId: pkg004,
    patch: { declarations: ['最终用户声明', '软件用途声明'] },
  })
  // 核对全部页（上一步改了第 1 页，需要重新确认）
  state = await getState()
  const f004 = state.files.find((f: any) => f.packageId === pkg004)
  for (const p of f004.versions[0].pages) {
    await post('/page/save', {
      fileId: f004.id,
      versionId: f004.activeVersionId,
      page: { ...p, reviewer: '测试', reviewedAt: '2026-10-05T00:00:00.000Z' },
    })
  }
  const submit2 = await post('/approval/submit', { packageId: pkg004, amount: 7 })
  check('补正后重新提交成功', !submit2.error, submit2.error?.error)
  state = await getState()
  const pkg4b = state.packages.find((p: any) => p.id === pkg004)
  const freeze2 = state.freezes.find((f: any) => f.id === pkg4b.activeFreezeId)
  check('第 2 轮冻结单金额 7', freeze2.round === 2 && freeze2.amount === 7)
  const s1 = pkg4b.approvalRoute.find((s: any) => s.status === 'active')
  await post('/approval/decide', { packageId: pkg004, stepId: s1.id, decision: 'approve', comment: '一级通过' })
  state = await getState()
  const pkg4c = state.packages.find((p: any) => p.id === pkg004)
  const s2 = pkg4c.approvalRoute.find((s: any) => s.status === 'active')
  check('第二级激活', Boolean(s2))
  // 重复决定同一个已通过的步骤
  const dup = await post('/approval/decide', {
    packageId: pkg004,
    stepId: s1.id,
    decision: 'approve',
    comment: '重复点击',
  })
  check('对已通过步骤重复操作被拒绝', Boolean(dup.error))
  const finalDecision = await post('/approval/decide', {
    packageId: pkg004,
    stepId: s2.id,
    decision: 'approve',
    comment: '终审通过',
  })
  check('终审通过成功', !finalDecision.error, finalDecision.error?.error)
  // 终审后立刻再点一次
  const afterState = await getState()
  const pkgFinal = afterState.packages.find((p: any) => p.id === pkg004)
  const dupFinal = await post('/approval/decide', {
    packageId: pkg004,
    stepId: s2.id,
    decision: 'approve',
    comment: '末步重复点击',
  })
  check('末步重复点击被拒绝（无活动步骤/冻结单）', Boolean(dupFinal.error))
  check('资料包已 licensed', pkgFinal.status === 'licensed')
  check('quotaUsed 恰为 7（不是 14）', pkgFinal.quotaUsed === 7, `quotaUsed=${pkgFinal.quotaUsed}`)
  const myPoolFinal = pool(afterState, 'rule-de-software')
  check('德国池：已转用 49、预占 0、可用 71（42+7，未重复扣）', myPoolFinal.used === 49 && myPoolFinal.reserved === 0 && myPoolFinal.available === 71)
  const consumed = afterState.freezes.find((f: any) => f.id === freeze2.id)
  check('冻结单 consumed', consumed.status === 'consumed')
  check('已许可后再次提交被拒绝', Boolean((await post('/approval/submit', { packageId: pkg004, amount: 1 })).error))

  console.log('6) 撤回释放预占')
  state = await getState()
  const wd0 = await post('/approval/withdraw', { packageId: 'pkg-003' })
  check('无生效冻结单时撤回被拒绝', Boolean(wd0.error))
  // pkg-005 退回后重新提交，再由申请人撤回
  const resubmit5 = await post('/approval/submit', { packageId: 'pkg-005', amount: 8 })
  check('pkg-005 重新冻结成功', !resubmit5.error, resubmit5.error?.error)
  state = await getState()
  check('撤回前兜底池预占 8、可用 12', pool(state, 'rule-global-default').reserved === 8 && pool(state, 'rule-global-default').available === 12)
  const wd = await post('/approval/withdraw', { packageId: 'pkg-005' })
  check('撤回成功', !wd.error, wd.error?.error)
  state = await getState()
  const p5after = state.packages.find((p: any) => p.id === 'pkg-005')
  check('撤回后状态为 draft', p5after.status === 'draft')
  check('撤回后预占释放，兜底池可用恢复 20', pool(state, 'rule-global-default').available === 20)
  check('撤回冻结单保留为 released', state.freezes.some((f: any) => f.packageId === 'pkg-005' && f.status === 'released'))

  console.log('7) 额度不足时拒绝创建冻结单')
  // 兜底池 20，pkg-005 已退回释放；直接让一个目的地日本的草稿预占 25
  // pkg-005 现在 returned，补齐后申请 25（>20）
  const over = await post('/approval/submit', { packageId: 'pkg-005', amount: 25 })
  check('超额预占被拒绝', Boolean(over.error) && over.error!.error.includes('可用额度不足'))
  state = await getState()
  check('拒绝后没有新增冻结单', state.freezes.filter((f: any) => f.packageId === 'pkg-005').every((f: any) => f.status !== 'active'))

  console.log(failures === 0 ? '\n全部断言通过 ✅' : `\n${failures} 项断言失败 ❌`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
