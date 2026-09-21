import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const users = await prisma.user.findMany({
        select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            status: true,
            membershipStart: true,
            membershipEnd: true,
            membershipPlan: { select: { id: true, name: true } },
            assignedTrainer: { select: { id: true, name: true } },
        },
    });

    console.log(JSON.stringify(users, null, 2));
}

main().catch((e) => console.error(e));