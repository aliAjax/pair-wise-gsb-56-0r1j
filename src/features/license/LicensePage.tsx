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
import {
  useGetWorkspaceQuery,
  useValidatePackageMutation,
} from '@/app/api'
import type { ApprovalFreeze, LicenseRule } from '@/types/domain'
import { approvalLevelLabels, findApplicableRule } from '@/services/rules'
import {
  freezeInvalidReasonLabels,
  freezeStatusLabels,
  getRuleQuotaPool,
} from '@/services/freezes'

const freezeTagColors: Record<ApprovalFreeze['status'], string> = {
  active: 'gold',
  consumed: 'green',
  released: 'default',
  invalidated: 'error',
}

function unpackError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const detail = (error.data as { error?: string }).error
    if (detail) return detail
  }
  return '操作失败'
}

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
  const currentPool = currentRule && data ? getRuleQuotaPool(currentRule, data.freezes) : undefined
  const packageFreezes = useMemo(
    () =>
      data
        ? [...data.freezes]
            .filter((freeze) => freeze.packageId === selectedId)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        : [],
    [data, selectedId],
  )

  if (isLoading || !data) return <div className="panel">正在加载许可规则...</div>

  const ruleColumns: TableColumnsType<LicenseRule> = [
    { title: '规则名称', dataIndex: 'name', minWidth: 240 },
    {
      title: '国家或地区',
      dataIndex: 'destinations',
      width: 135,
      render: (values: string[]) => values.join('、'),
    },
    {
      title: '技术标签',
      dataIndex: 'technologyTags',
      width: 200,
      render: (values: string[]) => values.join('、') || '通用',
    },
    {
      title: '审批等级',
      dataIndex: 'approvalLevel',
      width: 100,
      render: (value: LicenseRule['approvalLevel']) => approvalLevelLabels[value],
    },
    {
      title: '额度池（已转用/预占/上限）',
      width: 210,
      render: (_, rule) => {
        const pool = getRuleQuotaPool(rule, data.freezes)
        return (
          <Space size={4}>
            <Tag color="green">{pool.consumed}</Tag>
            <Tag color="gold">{pool.reserved}</Tag>
            <span className="muted">/ {pool.limit}</span>
            <Tag color={pool.available <= 0 ? 'error' : pool.available <= 10 ? 'warning' : 'blue'}>
              可用 {pool.available}
            </Tag>
          </Space>
        )
      },
    },
  ]

  const freezeColumns: TableColumnsType<ApprovalFreeze> = [
    { title: '冻结单', dataIndex: 'code', width: 170 },
    {
      title: '轮次',
      dataIndex: 'round',
      width: 70,
      render: (value: number) => `第 ${value} 轮`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: ApprovalFreeze['status']) => (
        <Tag color={freezeTagColors[value]}>{freezeStatusLabels[value]}</Tag>
      ),
    },
    { title: '额度', dataIndex: 'reservedAmount', width: 90 },
    {
      title: '固定内容',
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{record.declarations.length} 项声明 · {record.files.length} 个文件版本</span>
          <span className="muted">
            {record.files.reduce((sum, file) => sum + file.pages.length, 0)} 页逐页核对结果已固定
          </span>
        </Space>
      ),
    },
    {
      title: '时间与去向',
      width: 260,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{new Date(record.createdAt).toLocaleString('zh-CN')}</span>
          {record.status === 'invalidated' ? (
            <span className="muted">
              失效：{record.invalidatedReason ? freezeInvalidReasonLabels[record.invalidatedReason] : '未知'}
              {record.invalidatedAt ? ` · ${new Date(record.invalidatedAt).toLocaleString('zh-CN')}` : ''}
            </span>
          ) : record.status === 'released' ? (
            <span className="muted">
              {record.releaseReason === 'approval-withdrawn' ? '撤回释放' : '退回释放'} ·{' '}
              {record.releasedAt ? new Date(record.releasedAt).toLocaleString('zh-CN') : ''}
            </span>
          ) : record.status === 'consumed' ? (
            <span className="muted">
              最终通过后转用 · {record.consumedAt ? new Date(record.consumedAt).toLocaleString('zh-CN') : ''}
            </span>
          ) : (
            <span className="muted">预占占用中，等待审批</span>
          )}
        </Space>
      ),
    },
  ]

  async function refreshValidation() {
    if (!selected) return
    try {
      await validatePackage({ packageId: selected.id }).unwrap()
      message.success('规则匹配、冻结快照与缺失声明已重新校验')
    } catch (error) {
      message.error(unpackError(error))
    }
  }

  return (
    <div>
      <PageHeader
        title="许可与额度"
        description="额度按许可规则池管理：提交时预占，退回或撤回释放，最后一步审批通过后只按同一冻结单转用。"
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
              <Descriptions.Item label="审批状态">
                {selected.status === 'licensed'
                  ? '已按冻结单转用额度'
                  : selected.status === 'freeze-invalid'
                    ? '冻结单已失效，需重新提交'
                    : selected.status === 'reviewing'
                      ? '审批中，额度预占中'
                      : selected.status === 'returned'
                        ? '已退回，预占已释放'
                        : '尚未进入审批'}
              </Descriptions.Item>
            </Descriptions>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>规则额度池</h3>
            <SafetyCertificateOutlined />
          </div>
          {currentPool ? (
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <div>
                <strong>{currentPool.ruleName}</strong>
                <div className="muted" style={{ marginTop: 4 }}>
                  {currentRule ? approvalLevelLabels[currentRule.approvalLevel] : ''} · 上限{' '}
                  {currentPool.limit}
                </div>
              </div>
              <Progress
                percent={Math.round(
                  ((currentPool.consumed + currentPool.reserved) / currentPool.limit) * 100,
                )}
                status={currentPool.available <= 0 ? 'exception' : 'active'}
              />
              <Space wrap>
                <Tag color="green">已转用 {currentPool.consumed}</Tag>
                <Tag color="gold">冻结预占 {currentPool.reserved}</Tag>
                <Tag color={currentPool.available <= 10 ? 'error' : 'blue'}>
                  可用 {currentPool.available}
                </Tag>
              </Space>
              <Alert
                type="info"
                showIcon
                message="多个资料包同时提交时，按提交顺序从同一额度池预占；退回、撤回或冻结单失效会立即归还额度，最终通过只把已有预占转为实占，不额外占用。"
              />
            </Space>
          ) : (
            <Alert type="warning" showIcon message="当前资料包没有匹配规则，无法确定额度池。" />
          )}
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-title">
            <h3>缺失声明、升级与冻结结论</h3>
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
            </Space>
          ) : (
            <Alert type="error" showIcon message="没有匹配到规则，必须执行人工判定。" />
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>冻结单台账（本资料包）</h3>
          <span className="muted">有效、已转用、已释放和已失效的冻结单全部保留，旧快照可追溯</span>
        </div>
        <Table
          rowKey="id"
          columns={freezeColumns}
          dataSource={packageFreezes}
          pagination={false}
          locale={{ emptyText: '该资料包尚未提交过审批冻结单' }}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>规则清单与额度池占用</h3>
          <span className="muted">规则不允许在审批页面直接修改</span>
        </div>
        <Table rowKey="id" columns={ruleColumns} dataSource={data.rules} pagination={false} />
      </section>
    </div>
  )
}
