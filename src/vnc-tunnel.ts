/**
 * VNC Tunnel Manager
 *
 * Starts a Cloudflare Named Tunnel exposing noVNC (port 6080) via a fixed
 * custom domain: https://vnc.cozzyland.net
 *
 * The URL is written to a file so Raiden can read and send it to users.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { DATA_DIR } from './config.js';

const TUNNEL_URL = 'https://vnc.cozzyland.net';
const TUNNEL_URL_FILE = '/tmp/nanoclaw-vnc-url.txt';
let tunnelProcess: ChildProcess | null = null;

export function getVncTunnelUrl(): string | null {
  try {
    return fs.readFileSync(TUNNEL_URL_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function startVncTunnel(): Promise<string | null> {
  return new Promise((resolve) => {
    // Kill any existing tunnel
    if (tunnelProcess) {
      tunnelProcess.kill();
      tunnelProcess = null;
    }

    try {
      tunnelProcess = spawn('cloudflared', ['tunnel', 'run', 'nanoclaw-vnc'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logger.warn({ err }, 'cloudflared not found — VNC tunnel disabled');
      resolve(null);
      return;
    }

    let resolved = false;

    // Named tunnel uses config.yml — URL is fixed, just wait for "registered" log
    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      if (!resolved && (line.includes('Registered tunnel connection') || line.includes('INF Connection'))) {
        resolved = true;
        fs.writeFileSync(TUNNEL_URL_FILE, TUNNEL_URL);
        broadcastVncUrl(TUNNEL_URL);
        logger.info({ url: TUNNEL_URL }, 'VNC tunnel started');
        resolve(TUNNEL_URL);
      }
    });

    tunnelProcess.on('error', (err) => {
      logger.warn({ err }, 'cloudflared failed to start — VNC tunnel disabled');
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    tunnelProcess.on('exit', (code) => {
      logger.info({ code }, 'VNC tunnel exited');
      tunnelProcess = null;
      try { fs.unlinkSync(TUNNEL_URL_FILE); } catch {}
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.warn('VNC tunnel connection not established after 30s');
        resolve(null);
      }
    }, 30000);
  });
}

export function stopVncTunnel(): void {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
  try { fs.unlinkSync(TUNNEL_URL_FILE); } catch {}
}

/**
 * Write the VNC URL to all active group IPC dirs so Raiden always has the
 * current tunnel URL.
 */
function broadcastVncUrl(url: string): void {
  try {
    const ipcBase = path.join(DATA_DIR, 'ipc');
    if (!fs.existsSync(ipcBase)) return;
    for (const group of fs.readdirSync(ipcBase)) {
      const vncFile = path.join(ipcBase, group, 'vnc-url.txt');
      try {
        fs.writeFileSync(vncFile, url);
      } catch { /* group dir may not be fully set up yet */ }
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to broadcast VNC URL to IPC dirs');
  }
}
