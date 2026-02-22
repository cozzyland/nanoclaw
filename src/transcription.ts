/**
 * Voice Message Transcription (Local Whisper)
 *
 * Transcribes WhatsApp voice notes using whisper.cpp running locally.
 * Audio never leaves the machine — zero third-party dependency.
 *
 * Requires: brew install whisper-cpp ffmpeg
 * Model: ~/.local/share/whisper-models/ggml-base.en.bin
 */

import { execSync } from 'child_process';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

const MODEL_PATH = path.join(os.homedir(), '.local/share/whisper-models/ggml-base.en.bin');
const WHISPER_BIN = 'whisper-cli';

/** Check if a message is a voice note (push-to-talk audio) */
export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

/** Transcribe a WhatsApp voice message using local whisper.cpp */
export async function transcribeVoiceMessage(
  msg: WAMessage,
  sock: { updateMediaMessage: any },
): Promise<string | null> {
  if (!fs.existsSync(MODEL_PATH)) {
    logger.warn({ modelPath: MODEL_PATH }, 'Whisper model not found — transcription disabled');
    return null;
  }

  const tmpOgg = path.join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  const tmpWav = path.join(os.tmpdir(), `voice-${Date.now()}.wav`);

  try {
    // Download audio from WhatsApp
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    ) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download voice message');
      return null;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded voice message');

    // Write to temp file
    fs.writeFileSync(tmpOgg, buffer);

    // Convert to 16kHz mono WAV (required by whisper.cpp)
    execSync(
      `ffmpeg -y -i ${tmpOgg} -ar 16000 -ac 1 -c:a pcm_s16le ${tmpWav} 2>/dev/null`,
      { timeout: 30000 },
    );

    // Transcribe with whisper.cpp
    const result = execSync(
      `${WHISPER_BIN} -m ${MODEL_PATH} -f ${tmpWav} --no-timestamps -l en --print-special false 2>/dev/null`,
      { encoding: 'utf-8', timeout: 60000 },
    );

    const transcript = result.replace(/<\|[^>]+\|>/g, '').trim();
    if (!transcript) return null;

    logger.info({ length: transcript.length }, 'Transcribed voice message');
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Voice transcription failed');
    return null;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(tmpOgg); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}
