/**
 * Media File Validation for WhatsApp
 *
 * Validates media files (images, videos, documents) before processing.
 *
 * Protections:
 * - File type validation (MIME type)
 * - File size limits
 * - Extension validation
 * - Magic number verification (future enhancement)
 */

import { logger } from '../logger.js';

export interface MediaValidationConfig {
  // Allowed MIME types
  allowedMimeTypes: string[];

  // Max file size in bytes
  maxSizeBytes: number;

  // Allowed file extensions
  allowedExtensions: string[];
}

export interface MediaValidationResult {
  valid: boolean;
  reason?: string;
  details?: {
    mimeType?: string;
    size?: number;
    extension?: string;
  };
}

export class MediaValidator {
  private config: MediaValidationConfig;

  constructor(config: MediaValidationConfig) {
    this.config = config;
  }

  /**
   * Validate media file
   *
   * @param mimetype MIME type from WhatsApp
   * @param data File data buffer (base64 or Buffer)
   * @param filename Optional filename
   * @returns Validation result
   */
  validate(
    mimetype: string,
    data: string | Buffer,
    filename?: string
  ): MediaValidationResult {
    // Check MIME type
    if (!this.config.allowedMimeTypes.includes(mimetype)) {
      logger.warn({ mimetype, filename }, 'Media file rejected: unsupported MIME type');
      return {
        valid: false,
        reason: `Unsupported file type: ${mimetype}`,
        details: { mimeType: mimetype },
      };
    }

    // Check file size
    const size = typeof data === 'string' ? Buffer.from(data, 'base64').length : data.length;
    if (size > this.config.maxSizeBytes) {
      const sizeMB = (size / (1024 * 1024)).toFixed(2);
      const maxMB = (this.config.maxSizeBytes / (1024 * 1024)).toFixed(2);
      logger.warn(
        { size, maxSize: this.config.maxSizeBytes, filename },
        'Media file rejected: file too large'
      );
      return {
        valid: false,
        reason: `File too large: ${sizeMB}MB (max ${maxMB}MB)`,
        details: { size },
      };
    }

    // Check file extension (if filename provided)
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext && !this.config.allowedExtensions.includes(`.${ext}`)) {
        logger.warn({ extension: ext, filename }, 'Media file rejected: unsupported extension');
        return {
          valid: false,
          reason: `Unsupported file extension: .${ext}`,
          details: { extension: ext },
        };
      }
    }

    // All checks passed
    logger.debug({ mimetype, size, filename }, 'Media file validated successfully');
    return {
      valid: true,
      details: { mimeType: mimetype, size },
    };
  }
}

/**
 * Default media validation config
 *
 * Allows common safe file types with reasonable size limits.
 */
export const DEFAULT_MEDIA_CONFIG: MediaValidationConfig = {
  allowedMimeTypes: [
    // Images
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',

    // Documents
    'application/pdf',
    'text/plain',
    'text/csv',

    // Office documents (if needed - commented out for security)
    // 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    // 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  ],

  // 10MB max file size
  maxSizeBytes: 10 * 1024 * 1024,

  allowedExtensions: [
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.webp',

    // Documents
    '.pdf', '.txt', '.csv',

    // Office (if needed)
    // '.docx', '.xlsx',
  ],
};

/**
 * Strict media validation config
 *
 * Only allows images and PDFs, smaller file size.
 */
export const STRICT_MEDIA_CONFIG: MediaValidationConfig = {
  allowedMimeTypes: [
    'image/jpeg',
    'image/png',
    'application/pdf',
  ],

  maxSizeBytes: 5 * 1024 * 1024, // 5MB

  allowedExtensions: ['.jpg', '.jpeg', '.png', '.pdf'],
};
