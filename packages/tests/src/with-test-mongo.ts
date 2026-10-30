/**
 * Runs a command with ONE replica set for every test file it starts, named by LGR_TEST_MONGO_URI
 * (setup.ts says what a test process does with it). What CI runs:
 *
 *   bun packages/tests/src/with-test-mongo.ts bun run test --parallel=4
 *
 * Without it every file starts and stops its own replica set, which is most of a typical file's
 * time. The replica set is stopped, and its data dir removed, when the command ends.
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server'

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: bun packages/tests/src/with-test-mongo.ts <command> [args...]')
  process.exit(2)
}

const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
const uri = rs.getUri()
console.log(`with-test-mongo: one replica set for the run at ${uri}`)

let code = 1
try {
  const child = Bun.spawn([cmd, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, LGR_TEST_MONGO_URI: uri },
  })
  // A cancelled job signals this process: pass it on, and still stop the replica set below.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig))
  code = await child.exited
} finally {
  await rs.stop()
}
process.exit(code)
