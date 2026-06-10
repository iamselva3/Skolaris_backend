/* Read-only: dump _prisma_migrations applied order. Throwaway diagnostic. */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ migration_name: string; finished_at: Date | null; started_at: Date; applied_steps_count: number }>
  >(
    `SELECT migration_name, started_at, finished_at, applied_steps_count
       FROM "_prisma_migrations"
      ORDER BY started_at ASC`,
  );
  for (const r of rows) {
    console.log(
      `${r.finished_at ? 'OK ' : 'PENDING'}  started=${r.started_at.toISOString()}  ${r.migration_name}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
