import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Space,
  Steps,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { StatusTag } from '@/components/StatusTag'
import {
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useSubmitApprovalMutation,
  useWithdrawApprovalMutation,
} from '@/app/api'
import type { ApprovalFreeze, ApprovalStep, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import {
  findSnapshotDrift,
  freezeInvalidReasonLabels,
  freezeStatusLabels,
  getRuleQuotaPool,
} from '@/services/freezes'

function unpackError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const detail = (error.data as { error?: string }).error
    if (detail) return detail
  }
  return '操作失败'
}

export function ApprovalPage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [submitApproval, submitState] = useSubmitApprovalMutation()
  const [decideApproval, decideState] = useDecideApprovalMutation()
  const [withdrawApproval, withdrawState] = useWithdrawApprovalMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')
  const [decision, setDecision] = useState<'approve' | 'return'>('approve')
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [decidingStep, setDecidingStep] = useState<ApprovalStep>()
  const [submitOpen, setSubmitOpen] = useState(false)
  const [reserveAmount, setReserveAmount] = useState(5)
  const [withdrawOpen, setWithdrawOpen] = useState(false)

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const rule = data?.rules.find((item) => item.id === selected?.matchedRuleId)

  const activeFreeze = useMemo(
    () =>
      selected
        ? data?.freezes.find((freeze) => freeze.packageId === selected.id && freeze.status === 'active')
        : undefined,
    [data, selected],
  )
  const latestFreeze = useMemo<ApprovalFreeze | undefined>(() => {
    if (!selected || !data) return undefined
    return [...data.freezes]
      .filter((freeze) => freeze.packageId === selected.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  }, [data, selected])
  const pool = useMemo(() => {
    if (!rule || !data) return undefined
    return getRuleQuotaPool(rule, data.freezes)
  }, [rule, data])
  const drift = useMemo(
    () =>
      activeFreeze && selected && data
        ? findSnapshotDrift(activeFreeze, selected, data.files)
        : undefined,
    [activeFreeze, selected, data],
  )

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>
  const workspace = data

  const packageColumns: TableColumnsType<MaterialPackage> = [
    { title: '编号', dataIndex: 'code', width: 135 },
    { title: '资料包', dataIndex: 'title', minWidth: 220 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: MaterialPackage['status']) => <StatusTag status={value} />,
    },
    {
      title: '冻结单',
      width: 150,
      render: (_, record) => {
        const freeze = record.id
          ? [...workspace.freezes]
              .filter((item) => item.packageId === record.id)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
          : undefined
        if (!freeze) return <span className="muted">未提交</span>
        const color =
          freeze.status === 'active'
            ? 'gold'
            : freeze.status === 'consumed'
              ? 'green'
              : freeze.status === 'invalidated'
                ? 'error'
                : 'default'
        return (
          <Space direction="vertical" size={0}>
            <Tag color={color}>{freeze.code}</Tag>
            <span className="muted">{freezeStatusLabels[freeze.status]}</span>
          </Space>
        )
      },
    },
    {
      title: '轮次',
      dataIndex: 'currentRound',
      width: 85,
      render: (value: number) => (value ? `第 ${value} 轮` : '未提交'),
    },
    {
      title: '当前步骤',
      width: 150,
      render: (_, record) =>
        record.approvalRoute.find((step) => step.status === 'active')?.role ?? '无活动步骤',
    },
  ]

  const stepColumns: TableColumnsType<ApprovalStep> = [
    { title: '顺序', dataIndex: 'order', width: 60 },
    { title: '审批角色', dataIndex: 'role', width: 150 },
    { title: '处理人', dataIndex: 'assignee', width: 120 },
    {
      title: '等级',
      dataIndex: 'level',
      width: 100,
      render: (value: ApprovalStep['level']) => approvalLevelLabels[value],
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ApprovalStep['status']) => (
        <Tag
          color={
            value === 'approved'
              ? 'success'
              : value === 'active'
                ? 'processing'
                : value === 'returned'
                  ? 'error'
                  : 'default'
          }
        >
          {value === 'approved'
            ? '已通过'
            : value === 'active'
              ? '待审批'
              : value === 'returned'
                ? '已退回'
                : '未开始'}
        </Tag>
      ),
    },
    {
      title: '意见',
      dataIndex: 'comment',
      render: (value: string) => value || <span className="muted">无</span>,
    },
    {
      title: '操作',
      width: 150,
      render: (_, record) =>
        record.status === 'active' && activeFreeze && !drift ? (
          <Space>
            <Button
              type="link"
              onClick={() => {
                setDecidingStep(record)
                setDecision('approve')
                setDecisionOpen(true)
              }}
            >
              通过
            </Button>
            <Button
              type="link"
              danger
              onClick={() => {
                setDecidingStep(record)
                setDecision('return')
                setDecisionOpen(true)
              }}
            >
              退回
            </Button>
          </Space>
        ) : null,
    },
  ]

  const frozenFileColumns: TableColumnsType<ApprovalFreeze['files'][number]> = [
    { title: '文件', dataIndex: 'fileName', minWidth: 200 },
    {
      title: '固定现行版本',
      width: 150,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Tag color="blue">{record.versionLabel}</Tag>
          <span className="muted">{record.versionHash}</span>
        </Space>
      ),
    },
    {
      title: '逐页核对结果',
      width: 220,
      render: (_, record) => {
        const total = record.pages.length
        const reviewed = record.pages.filter((page) => page.reviewedAt).length
        const controlled = record.pages.filter((page) => page.controlled).length
        return (
          <Space direction="vertical" size={0}>
            <span>
              共 {total} 页 · 已核对 {reviewed} 页
            </span>
            <span className="muted">受控 {controlled} 页（结果已随冻结单固定）</span>
          </Space>
        )
      },
    },
  ]

  const canSubmit = Boolean(selected) && !activeFreeze
  const openSubmit = () => {
    if (!selected) return
    setReserveAmount(5)
    setSubmitOpen(true)
  }

  async function submitCurrent() {
    if (!selected) return
    try {
      await submitApproval({ packageId: selected.id, amount: reserveAmount }).unwrap()
      message.success('审批冻结单已生成，声明、版本与核对结果已固定，额度已预占')
      setSubmitOpen(false)
    } catch (error) {
      message.error(unpackError(error))
    }
  }

  async function confirmDecision() {
    if (!selected || !decidingStep) return
    try {
      await decideApproval({
        packageId: selected.id,
        stepId: decidingStep.id,
        decision,
        comment,
      }).unwrap()
      message.success(
        decision === 'approve'
          ? '已按冻结单固定快照通过本步骤'
          : '资料包已退回，冻结单释放预占额度，进入新一轮补正',
      )
      setDecisionOpen(false)
      setComment('')
      setDecidingStep(undefined)
    } catch (error) {
      message.error(unpackError(error))
    }
  }

  async function confirmWithdraw() {
    if (!selected) return
    try {
      await withdrawApproval({ packageId: selected.id }).unwrap()
      message.success('审批已撤回，冻结单失效并释放预占额度')
      setWithdrawOpen(false)
    } catch (error) {
      message.error(unpackError(error))
    }
  }

  return (
    <div>
      <PageHeader
        title="审批路线"
        description="提交即生成审批冻结单：固定声明、文件现行版本与逐页核对结果，并从许可规则额度池预占额度。"
        actions={
          selected ? (
            <Space>
              <Button
                danger
                ghost
                disabled={!activeFreeze}
                loading={withdrawState.isLoading}
                onClick={() => setWithdrawOpen(true)}
              >
                撤回审批并释放预占
              </Button>
              <Button type="primary" disabled={!canSubmit} loading={submitState.isLoading} onClick={openSubmit}>
                {activeFreeze ? '已有有效冻结单' : latestFreeze ? '重新发起（新冻结单）' : '提交审批冻结'}
              </Button>
            </Space>
          ) : null
        }
      />

      {selected && activeFreeze && drift ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`冻结单 ${activeFreeze.code} 与当前资料漂移，审批已阻断：${drift.detail}`}
          description="请撤回当前审批并重新提交，系统会按现行资料生成新的冻结单；漂移期间任何步骤都无法通过。"
        />
      ) : null}
      {selected && !activeFreeze && latestFreeze?.status === 'invalidated' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`冻结单 ${latestFreeze.code} 已失效（原因：${
            latestFreeze.invalidatedReason
              ? freezeInvalidReasonLabels[latestFreeze.invalidatedReason]
              : '未知'
          }），预占额度 ${latestFreeze.reservedAmount} 已释放`}
          description={
            latestFreeze.invalidatedDetail ?? '旧快照与失效原因已保留，核对资料后可重新发起审批。'
          }
        />
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>待处理资料包</h3>
          <span className="muted">选择资料包后查看完整审批路线与冻结单</span>
        </div>
        <Table
          rowKey="id"
          columns={packageColumns}
          dataSource={data.packages}
          pagination={false}
          rowClassName={(record) => (record.id === selectedId ? 'ant-table-row-selected' : '')}
          onRow={(record) => ({ onClick: () => setSelectedId(record.id) })}
        />
      </section>

      {selected ? (
        <div className="two-column">
          <section className="panel">
            <div className="panel-title">
              <h3>{selected.title}</h3>
              <StatusTag status={selected.status} />
            </div>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {activeFreeze ? (
                <Alert
                  type="info"
                  showIcon
                  message={`审批依据冻结单 ${activeFreeze.code}（第 ${activeFreeze.round} 轮）`}
                  description={`已从「${activeFreeze.ruleName}」额度池预占 ${activeFreeze.reservedAmount}，最后一步通过后按同一冻结单转用。`}
                />
              ) : (
                <Alert
                  type={latestFreeze ? 'warning' : 'info'}
                  showIcon
                  message={
                    latestFreeze
                      ? `当前没有有效冻结单（最近一张：${latestFreeze.code} · ${freezeStatusLabels[latestFreeze.status]}）`
                      : '尚未提交审批，没有冻结单。'
                  }
                />
              )}
              {selected.approvalRoute.length ? (
                <Steps
                  direction="vertical"
                  current={selected.approvalRoute.findIndex((step) => step.status === 'active')}
                  items={selected.approvalRoute.map((step) => ({
                    title: step.role,
                    description: `${step.assignee} · ${
                      step.status === 'approved'
                        ? '已通过'
                        : step.status === 'returned'
                          ? '已退回'
                          : step.status === 'active'
                            ? '待处理'
                            : '等待前序步骤'
                    }`,
                    status:
                      step.status === 'approved'
                        ? 'finish'
                        : step.status === 'returned'
                          ? 'error'
                          : step.status === 'active'
                            ? 'process'
                            : 'wait',
                  }))}
                />
              ) : (
                <Alert type="info" showIcon message="尚未生成审批路线。" />
              )}
            </Space>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>规则、轮次与额度池</h3>
              <Tag>{selected.currentRound ? `第 ${selected.currentRound} 轮` : '未提交'}</Tag>
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="匹配规则">{rule?.name ?? '未匹配'}</Descriptions.Item>
              <Descriptions.Item label="规则等级">
                {rule ? approvalLevelLabels[rule.approvalLevel] : '未知'}
              </Descriptions.Item>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              <Descriptions.Item label="未关闭高风险">
                {
                  data.findings.filter(
                    (item) => item.packageId === selected.id && item.level === 'high',
                  ).length
                }
              </Descriptions.Item>
              {pool ? (
                <Descriptions.Item label="规则额度池">
                  上限 {pool.limit} · 已转用 {pool.consumed} · 预占 {pool.reserved} · 可用{' '}
                  <strong style={{ color: pool.available <= 10 ? '#c74d4d' : undefined }}>
                    {pool.available}
                  </strong>
                </Descriptions.Item>
              ) : null}
            </Descriptions>
          </section>
        </div>
      ) : null}

      {activeFreeze ? (
        <section className="panel">
          <div className="panel-title">
            <h3>冻结单固定内容 · {activeFreeze.code}</h3>
            <Space>
              <Tag color="gold">{freezeStatusLabels.active}</Tag>
              <span className="muted">
                {activeFreeze.createdBy} · {new Date(activeFreeze.createdAt).toLocaleString('zh-CN')}
              </span>
            </Space>
          </div>
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            <div>
              <strong>固定声明</strong>
              <div style={{ marginTop: 8 }}>
                {activeFreeze.declarations.length ? (
                  activeFreeze.declarations.map((declaration) => (
                    <Tag key={declaration} color="blue">
                      {declaration}
                    </Tag>
                  ))
                ) : (
                  <span className="muted">无声明</span>
                )}
              </div>
            </div>
            <Table
              rowKey="fileId"
              size="small"
              columns={frozenFileColumns}
              dataSource={activeFreeze.files}
              pagination={false}
            />
            {activeFreeze.findings.length ? (
              <Alert
                type="info"
                showIcon
                message={`提交时固定了 ${activeFreeze.findings.length} 条核对结论，审批全程以该结论为准。`}
              />
            ) : (
              <Alert type="success" showIcon message="提交时无高风险或中风险核对缺口，核对结论已随冻结单固定。" />
            )}
          </Space>
        </section>
      ) : null}

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见</h3>
          </div>
          <Table
            rowKey="id"
            columns={stepColumns}
            dataSource={selected.approvalRoute}
            pagination={false}
          />
        </section>
      ) : null}

      <Modal
        title="提交审批冻结"
        open={submitOpen}
        onCancel={() => setSubmitOpen(false)}
        onOk={submitCurrent}
        confirmLoading={submitState.isLoading}
        okText="生成冻结单并提交"
        cancelText="取消"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="提交后审批全程只认这张冻结单"
          description="系统将固定当前声明、每个文件的现行版本（含 hash）和全部逐页核对结果，并立即从规则额度池预占额度。保存资料包、换版本或修改核对页都会让冻结单失效并释放预占。"
        />
        {pool ? (
          <Descriptions column={1} bordered size="small" style={{ marginBottom: 14 }}>
            <Descriptions.Item label="许可规则额度池">
              {pool.ruleName}
            </Descriptions.Item>
            <Descriptions.Item label="池状态">
              上限 {pool.limit} · 已转用 {pool.consumed} · 已预占 {pool.reserved} · 可用{' '}
              <strong>{pool.available}</strong>
            </Descriptions.Item>
          </Descriptions>
        ) : null}
        <div>本次预占额度</div>
        <InputNumber
          min={1}
          max={pool ? Math.max(1, pool.available) : undefined}
          value={reserveAmount}
          onChange={(value) => setReserveAmount(value ?? 1)}
          addonAfter="额度单位"
          style={{ width: '100%', marginTop: 8 }}
        />
        {pool && reserveAmount > pool.available ? (
          <Alert
            style={{ marginTop: 10 }}
            type="error"
            showIcon
            message={`额度池可用额度不足（仅剩 ${pool.available}），无法预占 ${reserveAmount}`}
          />
        ) : null}
      </Modal>

      <Modal
        title="撤回审批"
        open={withdrawOpen}
        onCancel={() => setWithdrawOpen(false)}
        onOk={confirmWithdraw}
        confirmLoading={withdrawState.isLoading}
        okText="确认撤回并释放预占"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Alert
          type="warning"
          showIcon
          message={`撤回后冻结单 ${activeFreeze?.code ?? ''} 保留为「已释放预占」，预占的 ${
            activeFreeze?.reservedAmount ?? 0
          } 个额度立即归还规则额度池。`}
          description="审批路线清空，资料包恢复草稿状态；如需继续审批请重新提交并生成新的冻结单。"
        />
      </Modal>

      <Modal
        title={decision === 'approve' ? '按冻结单通过当前审批步骤' : '退回并释放预占'}
        open={decisionOpen}
        onCancel={() => setDecisionOpen(false)}
        onOk={confirmDecision}
        confirmLoading={decideState.isLoading}
        okText={decision === 'approve' ? '确认通过' : '确认退回'}
        okButtonProps={{ danger: decision === 'return' }}
        cancelText="取消"
      >
        <Alert
          type={decision === 'approve' ? 'info' : 'warning'}
          showIcon
          message={
            decision === 'approve'
              ? `本步骤依据冻结单 ${activeFreeze?.code ?? ''} 的固定声明、版本与逐页核对结果审批，最后一步通过后按同一冻结单转用 ${
                  activeFreeze?.reservedAmount ?? 0
                } 个额度。`
              : '退回后冻结单立即失效并释放预占额度，本轮审批结束，补充资料后需重新发起。'
          }
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          rows={4}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={decision === 'approve' ? '填写审批意见' : '明确说明退回原因和补正要求'}
        />
      </Modal>
    </div>
  )
}
