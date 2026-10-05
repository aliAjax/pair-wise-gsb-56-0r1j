import { Modal } from 'antd'
import type { ApprovalFreeze } from '@/types/domain'

/**
 * 资料变更前提示：保存资料包、换版本或修改核对页都会让生效冻结单失效。
 * 返回 Promise<boolean>，确认后才继续执行变更。
 */
export function confirmFreezeInvalidation(
  freeze: ApprovalFreeze,
  action: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: '该操作会让审批冻结单失效',
      okText: '继续并失效冻结单',
      okButtonProps: { danger: true },
      cancelText: '取消',
      content: `当前有生效中的审批冻结单（第 ${freeze.round} 轮，预占 ${freeze.amount} 个额度）。${action}后冻结单立即失效、预占额度释放，审批按退回处理；旧快照与失效原因会保留。是否继续？`,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}
