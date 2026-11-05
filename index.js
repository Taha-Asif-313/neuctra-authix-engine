import app from "./app.js";
import prisma from "./shared/prisma.js";

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

try {
  await prisma.$connect();
} catch (error) {
  console.error("Could not connect to the database. Check DATABASE_URL.", error.message);
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  console.log(`Neuctra Authix Engine running on http://${HOST}:${PORT}`);
  console.log(`SDK baseUrl: http://localhost:${PORT}/api`);
});
