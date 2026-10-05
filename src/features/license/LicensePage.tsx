import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Descriptions,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { FreezePanel } from '@/components/FreezePanel'
import { useGetWorkspaceQuery, useValidatePackageMutation } from '@/app/api'
import type { ApprovalFreeze, LicenseRule } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'
import { freezeStatusLabels, summarizeRulePools } from '@/services/freezes'

export function LicensePage() {
  const [searchParams] = useSearchParams()
  const { data, isLoading } = useGetWorkspaceQuery()
  const [validatePackage] = useValidatePackageMutation()
  const [selectedId, setSelectedId] = useState(searchParams.get('package') ?? '')

  useEffect(() => {
    if (!selectedId && data?.packages[0]) setSelectedId(data.packages[0].id)
  }, [data, selectedId])

  const selected = useMemo(
    () => data?.packages.find((item) => item.id === selectedId),
    [data, selectedId],
  )
  const applicableRule = selected && data ? findApplicableRule(selected, data.rules) : undefined
  const currentRule = data?.rules.find((item) => item.id === selected?.matchedRuleId)
  const packageFindings = data?.findings.filter((item) => item.packageId === selectedId) ?? []
  const hasHighFindings = packageFindings.some((item) => item.level === 'high')
  const pools = useMemo(
    () => (data ? summarizeRulePools(data.rules, data.freezes) : []),
    [data],
  )
  const selectedPool = pools.find((pool) => pool.rule.id === currentRule?.id)
  const selectedFreezes = useMemo(
    () =>
      data
        ? data.freezes
            .filter((freeze) => freeze.packageId === selectedId)
            .sort((left, right) => right.round - left.round)
        : [],
    [data, selectedId],
  )
  const activeFreeze = selectedFreezes.find((freeze) => freeze.status === 'active')

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const poolColumns: TableColumnsType<(typeof pools)[number]> = [
    { title: '规则名称', dataIndex: 'rule', minWidth: 230, render: (rule: LicenseRule) => rule.name },
    {
      title: '国家或地区',
      width: 130,
      render: (_, record) => record.rule.destinations.join('、'),
    },
    {
      title: '审批等级',
      width: 100,
      render: (_, record) => approvalLevelLabels[record.rule.approvalLevel],
    },
    { title: '上限', dataIndex: ['rule', 'quotaLimit'], width: 70 },
    { title: '已转用', dataIndex: 'used', width: 80 },
    {
      title: '冻结中预占',
      dataIndex: 'reserved',
      width: 100,
      render: (value: number) =>
        value ? <Tag color="processing">{value}</Tag> : <span className="muted">0</span>,
    },
    {
      title: '可用',
      dataIndex: 'available',
      width: 80,
      render: (value: number) => (
        <Tag color={value <= 0 ? 'error' : value <= 5 ? 'warning' : 'success'}>{value}</Tag>
      ),
    },
    {
      title: '池占用',
      width: 170,
      render: (_, record) => (
        <Progress
          percent={Math.round(
            ((record.used + record.reserved) / record.rule.quotaLimit) * 100,
          )}
          size="small"
          status={record.available <= 0 ? 'exception' : 'active'}
        />
      ),
    },
  ]

  const freezeColumns: TableColumnsType<ApprovalFreeze> = [
    {
      title: '冻结单',
      dataIndex: 'id',
      width: 210,
      render: (value: string) => <span className="mono">{value}</span>,
    },
    { title: '轮次', dataIndex: 'round', width: 70, render: (value: number) => `第 ${value} 轮` },
    { title: '预占额度', dataIndex: 'amount', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
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
      title: '去向',
      render: (_, record) =>
        record.invalidatedReason ??
        (record.status === 'consumed'
          ? '末步通过，已转用'
          : record.status === 'released'
            ? '退回/撤回，已释放'
            : '审批进行中'),
    },
  ]

  async function refreshValidation() {
    if (!selected) return
    await validatePackage({ packageId: selected.id }).unwrap()
    message.success('规则匹配和缺失声明已重新校验')
  }

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="额度按许可规则池管理：提交审批即冻结预占，退回/撤回/失效释放，最后一步通过仅按同一冻结单转用。"
        actions={
          selected ? (
            <Button onClick={refreshValidation}>
              重新校验
            </Button>
          ) : null
        }
      />

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>选择资料包</h3>
            <Tag>{data.rules.length} 条规则</Tag>
          </div>
          <Select
            value={selectedId || undefined}
            style={{ width: '100%' }}
            onChange={setSelectedId}
            options={data.packages.map((item) => ({
              value: item.id,
              label: `${item.code} · ${item.title} · ${item.destination}`,
            }))}
          />
          {selected ? (
            <Descriptions column={1} bordered size="small" style={{ marginTop: 16 }}>
              <Descriptions.Item label="收件方">{selected.recipient}</Descriptions.Item>
              <Descriptions.Item label="最终用途">{selected.endUse}</Descriptions.Item>
              <Descriptions.Item label="技术参数">
                {selected.technologyTags.join('、')}
              </Descriptions.Item>
              <Descriptions.Item label="人员范围">
                {selected.personnelScopes.join('、') || '无特别范围'}
              </Descriptions.Item>
              <Descriptions.Item label="审批与额度">
                {selected.status === 'licensed'
                  ? `已许可，冻结单预占 ${selectedFreezes.find((item) => item.status === 'consumed')?.amount ?? selected.quotaUsed} 已转用`
                  : activeFreeze
                    ? `审批冻结中，已从规则池预占 ${activeFreeze.amount}（末步通过后自动转用）`
                    : selected.status === 'returned'
                      ? '已退回，冻结单失效且预占已释放，补正后重新提交'
                      : '未提交冻结单，规则池额度尚未预占'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>规则匹配解释</h3>
            <Tag color={applicableRule ? 'success' : 'error'}>
              {applicableRule ? '存在适用规则' : '无适用规则'}
            </Tag>
          </div>
          {applicableRule ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message={applicableRule.name}
                description={applicableRule.explanation}
              />
              <div>
                <strong>必要声明核对</strong>
                <div style={{ marginTop: 8 }}>
                  {applicableRule.requiredDeclarations.map((declaration) => (
                    <Tag
                      key={declaration}
                      color={selected?.declarations.includes(declaration) ? 'success' : 'error'}
                    >
                      {declaration}
                    </Tag>
                  ))}
                </div>
              </div>
              {selectedPool ? (
                <div>
                  <strong>规则额度池</strong>
                  <Progress
                    percent={Math.round(
                      ((selectedPool.used + selectedPool.reserved) / selectedPool.rule.quotaLimit) *
                        100,
                    )}
                    style={{ marginTop: 10 }}
                    status={selectedPool.available <= 0 ? 'exception' : 'active'}
                  />
                  <div className="muted">
                    已转用 {selectedPool.used} · 冻结中预占 {selectedPool.reserved} · 可用{' '}
                    {selectedPool.available} / 上限 {selectedPool.rule.quotaLimit}
                  </div>
                </div>
              ) : null}
            </Space>
          ) : (
            <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明与升级要求</h3>
            <Tag color={hasHighFindings ? 'error' : 'success'}>{packageFindings.length} 项</Tag>
          </div>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {packageFindings.map((finding) => (
              <Alert
                key={finding.id}
                type={finding.level === 'high' ? 'error' : finding.level === 'medium' ? 'warning' : 'info'}
                showIcon
                message={finding.message}
                description={finding.action}
              />
            ))}
            {!packageFindings.length ? (
              <Alert type="success" showIcon message="当前资料包没有许可核对缺口。" />
            ) : null}
          </Space>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>额度预占与转用</h3>
            <SafetyCertificateOutlined />
          </div>
          {selected ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Alert
                type={activeFreeze ? 'info' : selected.status === 'licensed' ? 'success' : 'warning'}
                showIcon
                message={
                  activeFreeze
                    ? `生效冻结单已预占 ${activeFreeze.amount} 个额度`
                    : selected.status === 'licensed'
                      ? `已按冻结单转用 ${selected.quotaUsed} 个额度`
                      : '当前没有生效冻结单，未预占额度'
                }
                description="额度在提交审批时从规则池预占；重复提交会被拦截。最后一步审批通过后只把本冻结单的预占转为实际使用，无需也不能手工扣减。"
              />
              <Table
                rowKey="id"
                size="small"
                columns={freezeColumns}
                dataSource={selectedFreezes}
                pagination={false}
                expandable={{
                  expandedRowRender: (record) => (
                    <div style={{ padding: '8px 12px' }}>
                      <FreezePanel freeze={record} />
                    </div>
                  ),
                }}
              />
            </Space>
          ) : null}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>许可规则额度池</h3>
          <span className="muted">“冻结中预占”会阻止同规则其他资料包占用，退回或撤回立即归还</span>
        </div>
        <Table rowKey={(record) => record.rule.id} columns={poolColumns} dataSource={pools} pagination={false} />
      </section>
    </div>
  )
}
