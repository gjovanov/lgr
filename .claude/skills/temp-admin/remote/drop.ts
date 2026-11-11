// drop.ts — runs ON the build host, from /tmp (see drop.sh). Deletes a temp account by its e-mail in EVERY org, and its
// Identity, then prints what is left. By e-mail and not by org on purpose: a test-org sync that ran while the account
// existed has copied it into the test copy of each shop, and those rows have to go too.
//
// Only an address under @lgr.internal is accepted: that domain is the throwaway accounts' own, no person has one.
// The connection builds no index and creates no collection (a script that connects the usual way does both).
import mongoose from 'mongoose'

const email = process.env.EMAIL ?? ''
if (!/^jamesbond-[a-z0-9]+@lgr\.internal$/.test(email)) {
  console.error(`refusing to delete "${email}": only a jamesbond-<tag>@lgr.internal account is dropped here`)
  process.exit(2)
}
await mongoose.connect(process.env.MONGODB_URI!, { autoIndex: false, autoCreate: false } as any)
const db = mongoose.connection.db!
const users = await db.collection('users').deleteMany({ email })
const identities = await db.collection('identities').deleteMany({ email })
console.log('users deleted', users.deletedCount, '| identities deleted', identities.deletedCount)
console.log('left: users', await db.collection('users').countDocuments({ email }), '| identities', await db.collection('identities').countDocuments({ email }))
await mongoose.disconnect()
