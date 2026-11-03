import 'dotenv/config';
import { resolve } from 'node:path';
import { createApplication } from './app.js';
const runtime=createApplication({dataDir:resolve(process.env.QUICKEN_DATA_DIR||'.quicken'),staticDir:resolve('dist')});
runtime.server.listen(Number(process.env.PORT||4317),process.env.HOST||'127.0.0.1',()=>console.log(`Quicken ready on http://127.0.0.1:${process.env.PORT||4317}. Run npm run open to launch.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void runtime.endActive().finally(()=>runtime.close()).then(()=>process.exit(0)));
