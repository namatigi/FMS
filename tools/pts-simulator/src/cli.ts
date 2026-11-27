#!/usr/bin/env node
/**
 * PTS-2 controller simulator CLI.
 *
 *   node dist/cli.js --url http://localhost:18100/jsonPTS --pts-id 003B00265030500420303531 \
 *        --secret devsecret-lus-0001 --pumps 4 --tanks 2 --rate 2
 *
 *   node dist/cli.js --url http://localhost:8081/ingest/pts --controllers 50 --pts-id 003B00265030500420303531
 *   node dist/cli.js --station-map stations.json
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PtsControllerSim, incrementPtsId, type SimFuelGrade, type SimTankConfig } from './generator.js';
import { runSimulators, type UploaderOptions } from './client.js';

const HELP = `pts-simulator: simulate PTS-2 forecourt controllers uploading jsonPTS

Options:
  --url <url>            upload URL (default http://localhost:8100/jsonPTS)
  --pts-id <hex24>       controller id (default 003B00265030500420303531)
  --secret <key>         controller secret key; signs X-Pts-Signature (HMAC-SHA256 of body)
  --pumps <n>            pumps per controller (default 4)
  --tanks <n>            tanks per controller (default 2)
  --rate <tx/s>          average pump transactions per second per controller (default 0.5)
  --controllers <n>      number of controllers; ids increment from --pts-id (default 1)
  --station-map <file>   JSON array [{pts_id, secret?, url?, pumps?, tanks?, rate?, grades?, tanks_config?}]
  --status-interval <s>  seconds between UploadStatus packets (default 5)
  --upload-interval <ms> ms between upload requests when idle (default 1000)
  --duration <s>         stop after s seconds (default: run until Ctrl+C)
  --fault-inject         occasionally inject manual-mode totaliser jumps (theft simulation)
  --fault-rate <p>       probability per sale of a jump when --fault-inject is set (default 0.02)
  --seed <n>             PRNG seed
  --basic-auth user:pass send HTTP basic auth
  --quiet                only print the summary
  --help`;

interface StationMapEntry {
  pts_id: string;
  secret?: string | null;
  url?: string;
  pumps?: number;
  tanks?: number;
  rate?: number;
  grades?: SimFuelGrade[];
  tanks_config?: SimTankConfig[];
}

function main(): void {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'http://localhost:8100/jsonPTS' },
      'pts-id': { type: 'string', default: '003B00265030500420303531' },
      secret: { type: 'string' },
      pumps: { type: 'string', default: '4' },
      tanks: { type: 'string', default: '2' },
      rate: { type: 'string', default: '0.5' },
      controllers: { type: 'string', default: '1' },
      'station-map': { type: 'string' },
      'status-interval': { type: 'string', default: '5' },
      'upload-interval': { type: 'string', default: '1000' },
      duration: { type: 'string' },
      'fault-inject': { type: 'boolean', default: false },
      'fault-rate': { type: 'string', default: '0.02' },
      seed: { type: 'string' },
      'basic-auth': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const fault = values['fault-inject'] ? Number(values['fault-rate']) : 0;

  const entries: StationMapEntry[] = values['station-map']
    ? (JSON.parse(readFileSync(values['station-map'], 'utf8')) as StationMapEntry[])
    : Array.from({ length: Number(values.controllers) }, (_, i) => ({
        pts_id: incrementPtsId(values['pts-id']!, i),
        secret: values.secret ?? null,
      }));

  const headers: Record<string, string> = {};
  if (values['basic-auth']) headers.authorization = `Basic ${Buffer.from(values['basic-auth']).toString('base64')}`;
  const baseSeed = values.seed !== undefined ? Number(values.seed) : undefined;

  const quiet = values.quiet;
  const sims = entries.map((e, i) => {
    const sim = new PtsControllerSim({
      ptsId: e.pts_id,
      pumps: e.pumps ?? Number(values.pumps),
      tanks: e.tanks ?? Number(values.tanks),
      rate: e.rate ?? Number(values.rate),
      grades: e.grades,
      tankConfigs: e.tanks_config,
      statusIntervalS: Number(values['status-interval']),
      faultInject: fault,
      seed: baseSeed !== undefined ? baseSeed + i : undefined,
    });
    const upload: UploaderOptions = {
      url: e.url ?? values.url!,
      secret: e.secret ?? null,
      headers,
      onResult: quiet ? undefined : (r) => {
        if (r.error) console.log(`[${r.ptsId}] sent=${r.sent} confirmed=${r.confirmed} pending=${r.pending} ERROR ${r.error}`);
        else if (r.sent) console.log(`[${r.ptsId}] sent=${r.sent} confirmed=${r.confirmed} pending=${r.pending}`);
      },
    };
    return { sim, upload };
  });

  const durationMs = values.duration ? Number(values.duration) * 1000 : undefined;
  const run = runSimulators(sims, { uploadMs: Number(values['upload-interval']), durationMs });
  console.log(`simulating ${sims.length} controller(s) -> ${sims[0]?.upload.url}${fault ? ` (fault-inject p=${fault})` : ''}`);

  const summary = () => {
    for (const { sim } of sims) {
      const s = sim.stats;
      console.log(`[${sim.ptsId}] tx=${s.transactions} vol=${s.volumeL}L amount=${s.amount} tankMsr=${s.tankMeasurements} deliveries=${s.deliveries} alerts=${s.alerts} status=${s.statuses} faults=${s.faultsInjected} confirmed=${s.packetsConfirmed} resent=${s.packetsResent} pending=${sim.pending}`);
    }
  };
  const onSignal = () => {
    void run.stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  void run.done.then(() => {
    summary();
    process.exit(0);
  });
}

main();
