import type { TenantEntity } from '../types.js'

export interface IKnowledgeArticleVersion { content: string; editorId: string; date: Date }
export interface IKnowledgeArticleShare { userId: string; canEdit: boolean }

export interface IKnowledgeArticle extends TenantEntity {
  name: string; content: string; parentId?: string; authorId: string; lastEditorId: string
  accessLevel: string; sharedWith: IKnowledgeArticleShare[]; tags?: string[]
  isFavorite: boolean; version: number; versions: IKnowledgeArticleVersion[]
  isPublished: boolean; relatedEntityType?: string; relatedEntityId?: string
}
