import { PrismaClient } from '@prisma/client';
console.log('Imported');
try {
  const p = new PrismaClient();
  console.log('Created instance');
  await p.$connect();
  console.log('Connected');
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
