// scripts/backfill-password-hash.js
// Usage:
//   node scripts/backfill-password-hash.js --dry-run   (preview only)
//   node scripts/backfill-password-hash.js             (apply)

import bcrypt from 'bcrypt'; // or 'bcryptjs', whichever your project uses
import prisma from '../config/db.js'; // adjust path to your db config

const SALT_ROUNDS = 10;
const DRY_RUN = process.argv.includes('--dry-run');

// DD/MM/YYYY. Uses local getters to match how dates are handled elsewhere in
// your backend (server timezone = gym timezone).
const formatDob = (date) => {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
};

const main = async () => {
    const totalUsers = await prisma.user.count();

    const users = await prisma.user.findMany({
        where: {
            OR: [{ passwordHash: null }, { passwordHash: '' }],
        },
        select: { id: true, name: true, dateOfBirth: true },
    });

    console.log(`Total users: ${totalUsers}`);
    console.log(`Users with empty passwordHash: ${users.length}`);
    if (DRY_RUN) console.log('DRY RUN: no changes will be written\n');

    let updated = 0;
    let skippedNoDob = 0;
    let failed = 0;

    for (const user of users) {
        if (!user.dateOfBirth) {
            skippedNoDob++;
            console.warn(`SKIP  ${user.id} (${user.name}): no date of birth`);
            continue;
        }

        const password = formatDob(user.dateOfBirth);
        if (!password) {
            skippedNoDob++;
            console.warn(`SKIP  ${user.id} (${user.name}): invalid date of birth`);
            continue;
        }

        try {
            if (!DRY_RUN) {
                const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
                await prisma.user.update({
                    where: { id: user.id },
                    data: { passwordHash },
                });
            }
            updated++;
            console.log(`${DRY_RUN ? 'WOULD UPDATE' : 'OK   '} ${user.id} (${user.name}) -> ${password}`);
        } catch (err) {
            failed++;
            console.error(`FAIL  ${user.id} (${user.name}):`, err.message);
        }
    }

    console.log('\n── Summary ──');
    console.log(`${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`);
    console.log(`Skipped (no/invalid DOB): ${skippedNoDob}`);
    console.log(`Failed: ${failed}`);
};

main()
    .catch((err) => {
        console.error('Script failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());