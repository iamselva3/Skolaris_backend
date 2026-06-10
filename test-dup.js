const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  const tenantId = 'c2b13eeb-211c-4ee3-a9a4-a691b879107b';
  const branchId = 'bb39f715-ae0b-4981-b914-97c95d0f8e46';
  const createdBy = '624eb573-531b-47bc-bc8e-6d5cafb33542';

  try {
    const c1 = await prisma.classroom.create({
      data: {
        tenantId,
        branchId,
        name: 'TEST_DUP',
        year: '2025',
        section: 'A',
        subject: 'TEST',
        createdBy,
      }
    });
    console.log('Created 1:', c1.id);

    const c2 = await prisma.classroom.create({
      data: {
        tenantId,
        branchId,
        name: 'TEST_DUP',
        year: '2025',
        section: 'A',
        subject: 'TEST',
        createdBy,
      }
    });
    console.log('Created 2:', c2.id);
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}

test();
