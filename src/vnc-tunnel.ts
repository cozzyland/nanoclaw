/**
 * VNC Tunnel Manager
 *
 * Starts a Cloudflare Quick Tunnel exposing noVNC (port 6080) to the internet.
 * The tunnel URL is written to a file so Raiden can read and send it to users.
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { logger } from './logger.js';

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
      tunnelProcess = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:6080'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logger.warn({ err }, 'cloudflared not found — VNC tunnel disabled');
      resolve(null);
      return;
    }

    let resolved = false;
    const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      const match = line.match(urlRegex);
      if (match && !resolved) {
        resolved = true;
        const url = match[0];
        fs.writeFileSync(TUNNEL_URL_FILE, url);
        logger.info({ url }, 'VNC tunnel started');
        resolve(url);
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
      // Clean up URL file so Raiden doesn't send a stale link
      try { fs.unlinkSync(TUNNEL_URL_FILE); } catch {}
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.warn('VNC tunnel URL not found after 30s');
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
