const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const c = await prisma.classroom.findMany({ where: { name: 'TEST' } });
  console.log(JSON.stringify(c, null, 2));
}

check().catch(console.error).finally(() => prisma.$disconnect());
