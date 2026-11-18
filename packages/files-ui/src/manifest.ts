import type { ModuleManifest } from 'ui-shell/module'

/**
 * FR-24.3: the files module as data. Paths are relative to the module (`/files`), never to a
 * router's base: the one SPA's router composes them under the module's shell record.
 */
export const manifest: ModuleManifest = {
  id: 'files',
  base: '/files',
  titleKey: 'apps.files',
  pendingChanges: false,
  menu: null,
  routes: [
      { path: '', name: 'files.hub', component: () => import('./views/FilesHubView.vue') },
      { path: 'upload', name: 'files.upload', component: () => import('./views/FileUploadView.vue') },
      { path: 'documents', name: 'files.documents', component: () => import('./views/DocumentsView.vue') },
      { path: 'audit', name: 'files.audit', component: () => import('./views/UploadAuditView.vue') },
      // FR-13.42 (#24) — the archive index. Reachable by `nra_auditor` (Приложение 29 т. 19);
      // the server's `readGate` is the control, this route carries no gate of its own.
      { path: 'archives', name: 'files.archives', component: () => import('./views/ArchivesView.vue') },
    ],
}
