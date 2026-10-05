import { Alert, Descriptions, Space, Table, Tag, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import type { ApprovalFreeze, FrozenFileVersion } from '@/types/domain'
import { categoryLabels } from '@/services/mockData'
import { freezeStatusLabels } from '@/services/freezes'

const statusColor: Record<ApprovalFreeze['status'], string> = {
  active: 'processing',
  consumed: 'success',
  released: 'warning',
  invalidated: 'error',
}

const fileColumns: TableColumnsType<FrozenFileVersion> = [
  { title: '文件', dataIndex: 'fileName', minWidth: 200 },
  {
    title: '资料分类',
    dataIndex: 'fileKind',
    width: 100,
    render: (value: FrozenFileVersion['fileKind']) => categoryLabels[value],
  },
  {
    title: '冻结的现行版本',
    width: 150,
    render: (_, record) => (
      <Space size={4}>
        <Tag color="blue">{record.versionLabel}</Tag>
        <Typography.Text code>{record.versionHash}</Typography.Text>
      </Space>
    ),
  },
  {
    title: '逐页核对',
    width: 180,
    render: (_, record) => {
      const total = record.pages.length
      const reviewed = record.pages.filter((page) => page.reviewedAt).length
      const controlled = record.pages.filter((page) => page.controlled).length
      return (
        <Space size={4} wrap>
          <Tag color={reviewed === total ? 'success' : 'error'}>
            {reviewed}/{total} 页已核对
          </Tag>
          {controlled ? <Tag color="volcano">{controlled} 页受控</Tag> : null}
        </Space>
      )
    },
  },
]

interface FreezePanelProps {
  freeze: ApprovalFreeze
}

/** 冻结单详情：固定声明、文件现行版本与逐页核对结果。 */
export function FreezePanel({ freeze }: FreezePanelProps) {
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Descriptions column={2} bordered size="small">
        <Descriptions.Item label="冻结单">
          <Typography.Text code>{freeze.id}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusColor[freeze.status]}>{freezeStatusLabels[freeze.status]}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="冻结轮次">第 {freeze.round} 轮</Descriptions.Item>
        <Descriptions.Item label="预占额度">{freeze.amount} 个额度单位</Descriptions.Item>
        <Descriptions.Item label="许可规则" span={2}>
          {freeze.ruleName}
        </Descriptions.Item>
        <Descriptions.Item label="冻结时间">
          {new Date(freeze.createdAt).toLocaleString('zh-CN')}
        </Descriptions.Item>
        <Descriptions.Item label="提交人">{freeze.createdBy}</Descriptions.Item>
      </Descriptions>

      {freeze.status === 'invalidated' ? (
        <Alert
          type="error"
          showIcon
          message="该冻结单已失效，审批人看到的旧页面不得作为通过依据"
          description={
            <Space direction="vertical" size={2}>
              <span>失效原因：{freeze.invalidatedReason}</span>
              {freeze.invalidatedAt ? (
                <span className="muted">
                  失效时间：{new Date(freeze.invalidatedAt).toLocaleString('zh-CN')}
                </span>
              ) : null}
              <span className="muted">旧快照仍完整保留，预占额度已释放回规则池。</span>
            </Space>
          }
        />
      ) : null}
      {freeze.status === 'released' ? (
        <Alert
          type="warning"
          showIcon
          message="该冻结单的预占额度已释放"
          description={
            freeze.releasedAt
              ? `释放时间：${new Date(freeze.releasedAt).toLocaleString('zh-CN')}`
              : undefined
          }
        />
      ) : null}
      {freeze.status === 'consumed' ? (
        <Alert
          type="success"
          showIcon
          message="最后一步通过后，预占额度已按本冻结单转为实际使用"
          description={
            freeze.consumedAt
              ? `转用时间：${new Date(freeze.consumedAt).toLocaleString('zh-CN')}`
              : undefined
          }
        />
      ) : null}

      <div>
        <strong>固定声明</strong>
        <div style={{ marginTop: 8 }}>
          {freeze.declarations.length ? (
            freeze.declarations.map((declaration) => (
              <Tag key={declaration} color="gold">
                {declaration}
              </Tag>
            ))
          ) : (
            <span className="muted">冻结时未提供声明</span>
          )}
        </div>
      </div>

      <div>
        <strong style={{ display: 'block', marginBottom: 8 }}>
          冻结的文件现行版本与逐页核对结果
        </strong>
        <Table
          rowKey="fileId"
          size="small"
          columns={fileColumns}
          dataSource={freeze.files}
          pagination={false}
        />
      </div>

      {freeze.findings.length ? (
        <div>
          <strong style={{ display: 'block', marginBottom: 8 }}>提交瞬间的核对结论</strong>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {freeze.findings.map((finding) => (
              <Alert
                key={finding.id}
                type={
                  finding.level === 'high'
                    ? 'error'
                    : finding.level === 'medium'
                      ? 'warning'
                      : 'info'
                }
                showIcon
                message={finding.message}
              />
            ))}
          </Space>
        </div>
      ) : null}
    </Space>
  )
}
