import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { fetchAllUsage, fetchOneUsage, PROVIDER_KEYS } from './providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load .env relative to this file so cwd doesn't matter.
dotenv.config({ path: path.join(__dirname, '../.env') });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/usage', async (_req, res) => {
  const providers = await fetchAllUsage();
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    providers,
  });
});

app.get('/api/usage/:provider', async (req, res) => {
  const key = req.params.provider;
  if (!PROVIDER_KEYS.includes(key)) {
    return res
      .status(404)
      .json({ ok: false, error: `Unknown provider. Valid: ${PROVIDER_KEYS.join(', ')}` });
  }
  const data = await fetchOneUsage(key);
  res.json({ ok: true, timestamp: new Date().toISOString(), provider: data });
});

app.listen(PORT, () => {
  console.log(`quota-peek → http://localhost:${PORT}`);
});
