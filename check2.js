const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.classroom.findMany({
  where: { name: { equals: 'test', mode: 'insensitive' } }
}).then(c => console.log(JSON.stringify(c, null, 2))).catch(console.error).finally(() => prisma.$disconnect());
