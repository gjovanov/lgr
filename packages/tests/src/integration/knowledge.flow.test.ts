import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { getRepos } from 'services/context'
import type { Types } from 'mongoose'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
})

async function createTestArticle(orgId: Types.ObjectId, overrides: any = {}) {
  return repos.knowledgeArticles.create({
    orgId: String(orgId),
    name: 'Test Article',
    content: 'Initial content for the article.',
    authorId: String(orgId),
    lastEditorId: String(orgId),
    accessLevel: 'internal',
    sharedWith: [],
    tags: [],
    isFavorite: false,
    version: 1,
    versions: [],
    isPublished: false,
    ...overrides,
  } as any)
}

describe('Knowledge Base Articles', () => {
  it('creates an article with initial version', async () => {
    const org = await createTestOrg()
    const article = await createTestArticle(org._id)

    expect(article.name).toBe('Test Article')
    expect(article.content).toBe('Initial content for the article.')
    expect(article.version).toBe(1)
    expect(article.versions).toHaveLength(0)
    expect(article.isPublished).toBe(false)
    expect(article.accessLevel).toBe('internal')
  })

  it('updates article content, increments version, pushes old to versions[]', async () => {
    const org = await createTestOrg()
    const article = await createTestArticle(org._id)

    // Simulate the update logic from the controller
    const oldVersion = {
      content: article.content,
      editorId: article.lastEditorId,
      date: article.updatedAt || article.createdAt,
    }
    const updated = await repos.knowledgeArticles.update(article.id, {
      content: 'Updated content v2.',
      lastEditorId: String(org._id),
      versions: [...(article.versions || []), oldVersion],
      version: (article.version || 1) + 1,
    } as any)

    expect(updated!.content).toBe('Updated content v2.')
    expect(updated!.version).toBe(2)
    expect(updated!.versions).toHaveLength(1)
    expect(updated!.versions[0].content).toBe('Initial content for the article.')
  })

  it('creates nested articles with parentId', async () => {
    const org = await createTestOrg()
    const parent = await createTestArticle(org._id, { name: 'Parent Article' })
    const child = await createTestArticle(org._id, {
      name: 'Child Article',
      parentId: parent.id,
    })

    expect(child.parentId).toBe(parent.id)

    // Verify we can filter by parentId
    const children = await repos.knowledgeArticles.findMany({
      orgId: String(org._id),
      parentId: parent.id,
    } as any)
    expect(children).toHaveLength(1)
    expect(children[0].name).toBe('Child Article')
  })

  it('publishes an article', async () => {
    const org = await createTestOrg()
    const article = await createTestArticle(org._id)

    expect(article.isPublished).toBe(false)

    const published = await repos.knowledgeArticles.update(article.id, {
      isPublished: true,
    } as any)

    expect(published!.isPublished).toBe(true)
  })

  it('shares an article with a user', async () => {
    const org = await createTestOrg()
    const article = await createTestArticle(org._id)

    const shareUserId = '000000000000000000000099'
    const sharedWith = [...(article.sharedWith || []), { userId: shareUserId, canEdit: true }]

    const updated = await repos.knowledgeArticles.update(article.id, {
      sharedWith,
    } as any)

    expect(updated!.sharedWith).toHaveLength(1)
    expect(String(updated!.sharedWith[0].userId)).toBe(shareUserId)
    expect(updated!.sharedWith[0].canEdit).toBe(true)
  })

  it('filters by accessLevel, tags, and isPublished', async () => {
    const org = await createTestOrg()
    await createTestArticle(org._id, { name: 'Public Article', accessLevel: 'public', isPublished: true, tags: ['faq'] })
    await createTestArticle(org._id, { name: 'Internal Article', accessLevel: 'internal', isPublished: false, tags: ['dev'] })
    await createTestArticle(org._id, { name: 'Private Article', accessLevel: 'private', isPublished: false, tags: ['faq', 'dev'] })

    // Filter by accessLevel
    const publicArticles = await repos.knowledgeArticles.findMany({
      orgId: String(org._id),
      accessLevel: 'public',
    } as any)
    expect(publicArticles).toHaveLength(1)
    expect(publicArticles[0].name).toBe('Public Article')

    // Filter by isPublished
    const published = await repos.knowledgeArticles.findMany({
      orgId: String(org._id),
      isPublished: true,
    } as any)
    expect(published).toHaveLength(1)

    // Filter by tags
    const faqArticles = await repos.knowledgeArticles.findMany({
      orgId: String(org._id),
      tags: { $in: ['faq'] },
    } as any)
    expect(faqArticles).toHaveLength(2)
  })

  it('searches articles by name and content', async () => {
    const org = await createTestOrg()
    await createTestArticle(org._id, { name: 'How to Reset Password', content: 'Steps to reset your password.' })
    await createTestArticle(org._id, { name: 'API Documentation', content: 'Guide for using the REST API.' })

    // Search by name match
    const results = await repos.knowledgeArticles.findMany({
      orgId: String(org._id),
      name: { $regex: 'Reset', $options: 'i' },
    } as any)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('How to Reset Password')
  })

  it('returns empty for non-existent article', async () => {
    const org = await createTestOrg()
    const article = await repos.knowledgeArticles.findOne({
      id: '000000000000000000000099',
      orgId: String(org._id),
    } as any)
    expect(article).toBeNull()
  })
})
