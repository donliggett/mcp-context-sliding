#!/usr/bin/env node
/**
 * Entry point: build the shared context, then serve over stdio or HTTP.
 *
 * Startup deliberately does NOT block on the LLM endpoint. LM Studio spawns
 * this process and expects the JSON-RPC handshake immediately; waiting on a
 * model that may not be loaded yet would look like a hung server. Token
 * calibration is fired off in the background instead, and everything works on
 * estimates until it lands.
 */

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { createServer } from 'node:http';
import * as path from 'node:path';

import { loadConfig, ConfigError, HELP_TEXT, type Config } from './config.js';
import { Auditor, protectStdout } from './util/audit.js';
import { TokenCounter, type Calibration } from './core/tokens.js';
import { LlmClient } from './core/llm.js';
import { Summarizer } from './core/summarize.js';
import { SessionStore } from './store/sessions.js';
import { DocumentStore } from './store/documents.js';
import { IngestSandbox } from './util/safepath.js';
import { ensureDir, readJson, writeJson } from './store/jsonl.js';
import { registerAllTools, type ToolContext } from './tools/index.js';

const SERVER_NAME = 'context-window';
const SERVER_VERSION = '1.0.0';

function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAllTools(server, ctx);
  return server;
}

/**
 * Measure the loaded model's real tokens-per-character ratio and remember it.
 *
 * Runs detached from startup. A cached value from a previous run is used
 * immediately so only the first ever run is uncalibrated.
 */
async function calibrateInBackground(
  counter: TokenCounter,
  llm: LlmClient,
  config: Config,
  auditor: Auditor,
): Promise<void> {
  const file = path.join(config.dataDir, 'calibration.json');

  const cached = await readJson<Calibration>(file);
  if (cached && cached.source === 'measured') {
    counter.load(cached);
    auditor.info('token calibration loaded from cache', { ratio: cached.ratio });
  }

  if (!llm.enabled) return;

  const measured = await counter.calibrate(llm).catch(() => false);
  if (measured) {
    const calibration = counter.current;
    await writeJson(file, calibration).catch(() => {});
    auditor.info('token calibration measured', { ratio: Number(calibration.ratio.toFixed(4)) });
  }
}

async function serveHttp(ctx: ToolContext, config: Config): Promise<void> {
  const handler = createMcpHandler(() => buildServer(ctx));
  const nodeHandler = toNodeHandler(handler);

  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const bindsPublicly = config.httpHost !== '127.0.0.1' && config.httpHost !== 'localhost';

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }
    // Inside a container the Host header is the container name, so the
    // localhost validators would reject every request.
    if (!bindsPublicly) {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    }
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.httpPort, config.httpHost, resolve);
  });

  ctx.auditor.info('listening', {
    transport: 'http',
    url: `http://${config.httpHost}:${config.httpPort}/`,
  });

  if (bindsPublicly) {
    ctx.auditor.error(
      'WARNING: bound to a non-loopback address with no authentication. Anyone who can ' +
        'reach this port can read and modify every stored session and document.',
      { host: config.httpHost },
    );
  }

  const shutdown = () => {
    ctx.auditor.info('shutting down');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function serveStdioTransport(ctx: ToolContext): void {
  const handle = serveStdio(() => buildServer(ctx));
  ctx.auditor.info('listening', { transport: 'stdio' });

  const shutdown = () => {
    // Wrapped so this works whether serveStdio returns the handle or a promise.
    void Promise.resolve(handle)
      .then((h) => h.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  let config: Config;
  try {
    config = loadConfig(argv, process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n\nRun with --help for usage.\n`);
      process.exit(2);
    }
    throw err;
  }

  const auditor = new Auditor(config.audit);
  if (config.transport === 'stdio') protectStdout(auditor);

  await ensureDir(config.dataDir);

  const counter = new TokenCounter(config.tokenRatio, 'default');
  const llm = new LlmClient(config.llm);
  const summarizer = new Summarizer(llm, counter);
  const ingest = await IngestSandbox.create(config.ingestRoots);

  const ctx: ToolContext = {
    config,
    auditor,
    counter,
    summarizer,
    llm,
    sessions: new SessionStore(config.dataDir),
    documents: new DocumentStore(config.dataDir),
    ingest,
  };

  auditor.info('starting', {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: config.transport,
    dataDir: config.dataDir,
    llm: config.llm.enabled ? config.llm.baseUrl : 'disabled',
    ingestRoots: ingest.allowed,
    budget: config.defaultBudget,
  });

  // Detached on purpose — see the doc comment at the top of this file.
  void calibrateInBackground(counter, llm, config, auditor).catch((err: unknown) => {
    auditor.error('calibration failed', { reason: String(err) });
  });

  if (config.transport === 'http') {
    await serveHttp(ctx, config);
  } else {
    serveStdioTransport(ctx);
  }
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'fatal',
      message: 'unhandled rejection',
      reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    }) + '\n',
  );
  process.exit(1);
});

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'fatal',
      message: 'failed to start',
      reason: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }) + '\n',
  );
  process.exit(1);
});
