import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across the process (and across dev HMR reloads)
// so we never open more connection pools than intended on the Postgres server.
const prisma = global.prismaGlobal ?? new PrismaClient();

if (!global.prismaGlobal) {
  global.prismaGlobal = prisma;
}

export default prisma;
