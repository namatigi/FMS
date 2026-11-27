import { erbExportHandler } from './erb_export.js';
import { fiscaliseHandler } from './fiscalise.js';
import { notifyHandler } from './notify.js';
import { rollupHandler } from './rollup.js';
import type { JobHandler } from './types.js';
import { webhookHandler } from './webhook.js';

export const ALL_HANDLERS: JobHandler[] = [fiscaliseHandler, rollupHandler, webhookHandler, notifyHandler, erbExportHandler];

export { erbExportHandler, fiscaliseHandler, notifyHandler, rollupHandler, webhookHandler };
export type { HandlerContext, JobHandler, WorkerDeps } from './types.js';
