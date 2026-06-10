const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.classroom.findMany().then(c => console.log(c)).catch(console.error).finally(() => prisma.$disconnect());
