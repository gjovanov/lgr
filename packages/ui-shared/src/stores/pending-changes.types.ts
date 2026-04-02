export interface PendingChangeEntry {
  id: string
  orgId: string
  userId: string
  appId: string
  entityType: string
  mode: 'create' | 'edit'
  entityId?: string
  routeName?: string
  routeParams?: Record<string, string>
  routePath?: string
  dialogId?: string
  formData: Record<string, any>
  previewFields: { label: string; value: string }[]
  capturedAt: string
  icon?: string
}
