import express from 'express';
import { PUBLIC_DIR, PROJECT_DIR } from './paths.mjs';
import { ensureDir } from './storage.mjs';
import { router as apiRouter } from './api.mjs';
import { reconcileJobsOnStartup } from './lib/jobs.mjs';
import * as downloadDaemon from './lib/download_daemon.mjs';
import * as embedDaemon from './lib/embed_daemon.mjs';
import * as snowballDaemon from './lib/snowball_daemon.mjs';
import * as llmLocal from './lib/llm_local.mjs';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;

async function main() {
  await ensureDir(PROJECT_DIR);
  await reconcileJobsOnStartup();
  await downloadDaemon.init();
  // Embed daemon scans candidates_triaged.csv and notes/ for anything new
  // or changed and feeds the encoder. Runs in background; safe even if the
  // user never opens an embedding-driven feature.
  embedDaemon.init().catch((err) => {
    console.error('embed daemon init failed:', err.message);
  });
  snowballDaemon.init().catch((err) => {
    console.error('snowball daemon init failed:', err.message);
  });
  // Restore the user's last-selected local LLM in the background. If
  // nothing is persisted, no work is done; the user picks one in the
  // Setup view and the server loads it then.
  llmLocal.bootRestore().catch((err) => {
    console.warn('local LLM boot-restore failed:', err.message);
  });

  const app = express();
  app.use(apiRouter);
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

  app.listen(PORT, () => {
    console.log(`litreview-webapp ready`);
    console.log(`  open http://localhost:${PORT}`);
    console.log(`  project dir: ${PROJECT_DIR}`);
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
