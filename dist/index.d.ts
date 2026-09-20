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
export {};
