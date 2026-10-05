import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
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
import { FreezePanel } from '@/components/FreezePanel'
import {
  useDecideApprovalMutation,
  useGetWorkspaceQuery,
  useSubmitApprovalMutation,
  useWithdrawApprovalMutation,
} from '@/app/api'
import type { ApprovalFreeze, ApprovalStep, MaterialPackage } from '@/types/domain'
import { approvalLevelLabels } from '@/services/rules'
import { freezeStatusLabels, summarizeRulePools } from '@/services/freezes'

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
  const [amount, setAmount] = useState(5)

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const freezes = useMemo(
    () =>
      selected
        ? (data?.freezes.filter((item) => item.packageId === selected.id) ?? []).slice().sort(
            (left, right) => right.round - left.round,
          )
        : [],
    [data, selected],
  )
  const activeFreeze = freezes.find((item) => item.status === 'active')
  const pools = useMemo(
    () => (data ? summarizeRulePools(data.rules, data.freezes) : []),
    [data],
  )
  const rule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const matchedPool = pools.find((pool) => pool.rule.id === rule?.id)
  const activeStep = selected?.approvalRoute.find((step) => step.status === 'active')
  const isLastStep =
    Boolean(activeStep) &&
    (selected?.approvalRoute.length ?? 0) > 0 &&
    activeStep?.order === selected?.approvalRoute.length

  if (isLoading || !data) return <div className="panel">正在加载审批路线...</div>

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
      width: 110,
      render: (_, record) => {
        const freeze = data.freezes.find(
          (item) => item.id === record.activeFreezeId && item.status === 'active',
        )
        return freeze ? (
          <Tag color="processing">冻结中 · {freeze.amount}</Tag>
        ) : (
          <span className="muted">无</span>
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
      width: 160,
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
        record.status === 'active' && activeFreeze ? (
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
        ) : (
          <span className="muted">需有效冻结单</span>
        ),
    },
  ]

  const historyColumns: TableColumnsType<ApprovalFreeze> = [
    {
      title: '冻结单',
      dataIndex: 'id',
      width: 220,
      render: (value: string) => <span className="mono">{value}</span>,
    },
    { title: '轮次', dataIndex: 'round', width: 70, render: (value: number) => `第 ${value} 轮` },
    { title: '预占额度', dataIndex: 'amount', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: ApprovalFreeze['status']) => (
        <Tag
          color={
            value === 'active'
              ? 'processing'
              : value === 'consumed'
                ? 'success'
                : value === 'released'
                  ? 'warning'
                  : 'error'
          }
        >
          {freezeStatusLabels[value]}
        </Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '原因 / 去向',
      render: (_, record) =>
        record.invalidatedReason ??
        (record.status === 'consumed'
          ? '末步通过，预占额度已转用'
          : record.status === 'released'
            ? '退回或撤回，预占额度已释放'
            : '审批进行中'),
    },
  ]

  function openSubmit() {
    setAmount(5)
    setSubmitOpen(true)
  }

  async function confirmSubmit() {
    if (!selected) return
    try {
      await submitApproval({ packageId: selected.id, amount }).unwrap()
      message.success(`审批冻结单已创建，从规则池预占 ${amount} 个额度，审批按冻结快照执行`)
      setSubmitOpen(false)
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '提交失败')
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
      if (decision === 'return') {
        message.success('资料包已退回，冻结单释放预占额度，补正后可重新提交')
      } else if (isLastStep) {
        message.success('最后一步通过：已按同一冻结单把预占额度转为实际使用，未二次扣减')
      } else {
        message.success('审批步骤已通过')
      }
      setDecisionOpen(false)
      setComment('')
      setDecidingStep(undefined)
    } catch (error) {
      const detail =
        typeof error === 'object' && error && 'data' in error
          ? (error.data as { error?: string }).error
          : undefined
      message.error(detail ?? '审批操作失败')
    }
  }

  async function withdraw() {
    if (!selected) return
    await withdrawApproval({ packageId: selected.id }).unwrap()
    message.success('已撤回审批，冻结单失效并释放预占额度')
  }

  const canSubmit =
    Boolean(selected) &&
    !activeFreeze &&
    selected?.status !== 'licensed' &&
    (['draft', 'returned'].includes(selected?.status ?? '') || !selected?.approvalRoute.length)

  return (
    <div>
      <PageHeader
        title="审批路线"
        description="提交即创建审批冻结单：固定声明、文件现行版本与逐页核对结果，并从许可规则额度池预占额度。"
        actions={
          selected && canSubmit ? (
            <Space>
              <Button type="primary" loading={submitState.isLoading} onClick={openSubmit}>
                提交并冻结审批
              </Button>
            </Space>
          ) : null
        }
      />

      {selected && activeFreeze ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`审批按冻结单 ${activeFreeze.id} 执行（第 ${activeFreeze.round} 轮 · 预占 ${activeFreeze.amount} 个额度）`}
          description="审批人看到的是冻结时刻的声明、文件版本和逐页核对结果。保存资料包、换版本或修改核对页都会使冻结单失效并退回本流程。"
          action={
            <Popconfirm
              title="撤回本次审批？"
              description="冻结单将失效，预占额度立即释放回规则池。"
              okText="撤回并释放"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={withdraw}
            >
              <Button danger loading={withdrawState.isLoading}>
                撤回审批
              </Button>
            </Popconfirm>
          }
        />
      ) : null}
      {selected && !activeFreeze && selected.status === 'returned' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="当前没有生效冻结单：上一冻结单已退回或失效，额度已释放，补正后需重新提交冻结。"
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
              {canSubmit ? (
                <Button type="primary" ghost onClick={openSubmit} loading={submitState.isLoading}>
                  提交并冻结审批
                </Button>
              ) : null}
            </Space>
          </section>

          <section className="panel">
            <div className="panel-title">
              <h3>规则与额度池</h3>
              <Tag>{selected.currentRound ? `第 ${selected.currentRound} 轮` : '未提交'}</Tag>
            </div>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="匹配规则">{rule?.name ?? '未匹配'}</Descriptions.Item>
              <Descriptions.Item label="规则等级">
                {rule ? approvalLevelLabels[rule.approvalLevel] : '未知'}
              </Descriptions.Item>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              {matchedPool ? (
                <Descriptions.Item label="规则池额度">
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Progress
                      percent={Math.round(
                        ((matchedPool.used + matchedPool.reserved) / matchedPool.rule.quotaLimit) *
                          100,
                      )}
                      size="small"
                      status={matchedPool.available <= 0 ? 'exception' : 'active'}
                    />
                    <span>
                      已转用 {matchedPool.used} · 冻结中预占 {matchedPool.reserved} · 可用{' '}
                      {matchedPool.available} / 上限 {matchedPool.rule.quotaLimit}
                    </span>
                  </Space>
                </Descriptions.Item>
              ) : null}
              <Descriptions.Item label="未关闭高风险">
                {
                  data.findings.filter(
                    (item) => item.packageId === selected.id && item.level === 'high',
                  ).length
                }
              </Descriptions.Item>
            </Descriptions>
          </section>
        </div>
      ) : null}

      {selected && activeFreeze ? (
        <section className="panel">
          <div className="panel-title">
            <h3>生效审批冻结单</h3>
            <Tag color="processing">{activeFreeze.id}</Tag>
          </div>
          <FreezePanel freeze={activeFreeze} />
        </section>
      ) : null}

      {selected ? (
        <section className="panel">
          <div className="panel-title">
            <h3>步骤明细与历史意见</h3>
            {activeFreeze ? null : <Tag color="warning">无生效冻结单，步骤不可审批</Tag>}
          </div>
          <Table
            rowKey="id"
            columns={stepColumns}
            dataSource={selected.approvalRoute}
            pagination={false}
          />
        </section>
      ) : null}

      {freezes.length ? (
        <section className="panel">
          <div className="panel-title">
            <h3>历史冻结单</h3>
            <span className="muted">旧快照与失效原因完整保留；仅“冻结中”单据占用额度池</span>
          </div>
          <Table
            rowKey="id"
            size="small"
            columns={historyColumns}
            dataSource={freezes}
            pagination={false}
            expandable={{
              expandedRowRender: (record) => (
                <div style={{ padding: '8px 12px' }}>
                  <FreezePanel freeze={record} />
                </div>
              ),
              rowExpandable: () => true,
            }}
          />
        </section>
      ) : null}

      <Modal
        title="提交并创建审批冻结单"
        open={submitOpen}
        onCancel={() => setSubmitOpen(false)}
        onOk={confirmSubmit}
        confirmLoading={submitState.isLoading}
        okText="确认提交并预占"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="提交后固定声明、文件现行版本和逐页核对结果"
            description="审批人全程只看冻结快照；保存资料包、换版本或修改核对页会令冻结单失效并退回。退回、撤回或失效均释放预占；最后一步通过后只按本冻结单转用额度。"
          />
          {matchedPool ? (
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="许可规则">{matchedPool.rule.name}</Descriptions.Item>
              <Descriptions.Item label="规则池额度">
                已转用 {matchedPool.used} · 冻结中预占 {matchedPool.reserved} · 可用{' '}
                {matchedPool.available} / {matchedPool.rule.quotaLimit}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
          <div>
            <div style={{ marginBottom: 6 }}>本次预占额度（提交后固定）</div>
            <InputNumber
              min={1}
              max={Math.max(1, matchedPool?.available ?? 1)}
              value={amount}
              onChange={(value) => setAmount(value ?? 1)}
              addonAfter="额度单位"
              style={{ width: '100%' }}
            />
            <div className="muted" style={{ marginTop: 6 }}>
              同规则其他资料包审批中的冻结单会占用可用额度；重复点击或前后脚提交会被幂等守卫拦截。
            </div>
          </div>
        </Space>
      </Modal>

      <Modal
        title={decision === 'approve' ? '通过当前审批步骤' : '退回并释放冻结单'}
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
          style={{ marginBottom: 14 }}
          message={
            decision === 'approve'
              ? isLastStep
                ? '这是最后一步：通过后冻结单预占额度将直接转为实际使用，流程完成。'
                : '通过后进入下一审批角色，冻结单继续持有预占额度。'
              : '退回后冻结单立即失效并释放预占额度，申请人补正后需重新提交冻结。'
          }
        />
        {activeFreeze ? (
          <Descriptions column={1} size="small" style={{ marginBottom: 12 }}>
            <Descriptions.Item label="依据冻结单">
              <span className="mono">{activeFreeze.id}</span>（{activeFreeze.amount} 个额度）
            </Descriptions.Item>
          </Descriptions>
        ) : null}
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
