// lib/prisma.js
//
// Standard PrismaClient singleton pattern — prevents creating a new
// connection pool on every hot-reload in dev, and is safe to import
// from any route file.

import { PrismaClient } from '@prisma/client';


const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}


export default prisma;