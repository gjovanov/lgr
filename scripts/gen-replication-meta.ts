#!/usr/bin/env bun
/**
 * `bun run gen:replication-meta` (FR-20.62, plan step P3-1a): read every model's `replicate()`
 * decision into `packages/db/src/replication/meta.generated.ts`. Run it after adding a model or
 * changing what one replicates, and commit the file with the change: the snapshot test
 * (`unit/replication-meta.test.ts`) fails the build otherwise.
 *
 * Loads the models only; connects to nothing.
 */
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mongoose } from '../packages/db/src/connection.js'
import '../packages/db/src/models/index.js'
import { renderMeta, replicationMeta } from '../packages/db/src/replication/generate.js'

const file = join(resolve(import.meta.dir, '..'), 'packages', 'db', 'src', 'replication', 'meta.generated.ts')
const models = mongoose.modelNames().map(n => mongoose.model(n))
const meta = replicationMeta(models as any)
writeFileSync(file, renderMeta(meta))
const by = (c: string) => Object.values(meta).filter(e => e.class === c).length
console.log(`${file}: ${models.length} models, ${by('R')} replicated, ${by('S')} split, ${by('N')} node-local, ${by('G')} global-only`)
