import type { WorkspaceState } from '@/types/domain'
import { createInitialState } from './mockData'

const STORAGE_KEY = 'export-control-review-v1'

function isCompatibleWorkspace(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WorkspaceState>
  return (
    Array.isArray(state.packages) &&
    Array.isArray(state.files) &&
    Array.isArray(state.rules) &&
    Array.isArray(state.findings) &&
    Array.isArray(state.comments) &&
    Array.isArray(state.audit) &&
    Array.isArray(state.freezes)
  )
}

export function loadWorkspace(): WorkspaceState {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    // 旧版工作区没有审批冻结单结构，直接升级为新的演示数据，避免额度池缺数据。
    if (!isCompatibleWorkspace(parsed)) {
      const initial = createInitialState()
      saveWorkspace(initial)
      return initial
    }
    return parsed
  } catch {
    const initial = createInitialState()
    saveWorkspace(initial)
    return initial
  }
}

export function saveWorkspace(state: WorkspaceState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspace(): WorkspaceState {
  const initial = createInitialState()
  saveWorkspace(initial)
  return initial
}
