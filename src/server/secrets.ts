import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EbaySecretsStatus, UpdateEbayCredentialsInput } from '../shared/index.ts';

const SecretsFileSchema = z.object({
  ebay: z
    .object({
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
    })
    .optional(),
});

export interface RawEbayCredentials {
  clientId: string | null;
  clientSecret: string | null;
  origin: 'env' | 'file' | 'none';
  configured: boolean;
}

export function maskSecret(secret: string | null | undefined): string | null {
  const trimmed = secret?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= 4) {
    return '••••';
  }
  return `••••••••${trimmed.slice(-4)}`;
}

/**
 * Manages untracked secrets.json eBay credentials with environment variable precedence.
 */
export class SecretsStore {
  private readonly filePath: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.filePath = path.join(dataDir, 'secrets.json');
    this.env = env;
  }

  private readFileEbay(): { clientId: string | null; clientSecret: string | null } {
    if (!fs.existsSync(this.filePath)) {
      return { clientId: null, clientSecret: null };
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = SecretsFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || !parsed.data.ebay) {
        return { clientId: null, clientSecret: null };
      }
      const clientId = parsed.data.ebay.client_id?.trim() || null;
      const clientSecret = parsed.data.ebay.client_secret?.trim() || null;
      return { clientId, clientSecret };
    } catch {
      return { clientId: null, clientSecret: null };
    }
  }

  getRawCredentials(): RawEbayCredentials {
    const envClientId = this.env.EBAY_CLIENT_ID?.trim() || null;
    const envClientSecret = this.env.EBAY_CLIENT_SECRET?.trim() || null;
    const file = this.readFileEbay();

    const clientId = envClientId ?? file.clientId;
    const clientSecret = envClientSecret ?? file.clientSecret;

    let origin: 'env' | 'file' | 'none' = 'none';
    if (envClientId || envClientSecret) {
      origin = 'env';
    } else if (file.clientId || file.clientSecret) {
      origin = 'file';
    }

    return {
      clientId,
      clientSecret,
      origin,
      configured: Boolean(clientId && clientSecret),
    };
  }

  getStatus(): EbaySecretsStatus {
    const raw = this.getRawCredentials();
    return {
      configured: raw.configured,
      origin: raw.origin,
      clientId: raw.clientId,
      clientSecretMasked: maskSecret(raw.clientSecret),
    };
  }

  saveEbayCredentials(input: UpdateEbayCredentialsInput): EbaySecretsStatus {
    let existingRoot: Record<string, unknown> = {};
    if (fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          existingRoot = parsed as Record<string, unknown>;
        }
      } catch {
        existingRoot = {};
      }
    }

    if (input.clear) {
      delete existingRoot.ebay;
      fs.writeFileSync(this.filePath, `${JSON.stringify(existingRoot, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return this.getStatus();
    }

    const currentFile = this.readFileEbay();
    const rawClientId = input.clientId !== undefined ? input.clientId : input.client_id;
    const nextClientId =
      rawClientId === null
        ? ''
        : (rawClientId?.trim() ?? currentFile.clientId ?? '');

    const rawSecret = input.clientSecret !== undefined ? input.clientSecret : input.client_secret;
    const trimmedSecret = rawSecret?.trim();
    const nextClientSecret = trimmedSecret ? trimmedSecret : (currentFile.clientSecret ?? '');

    const nextPayload = {
      ...existingRoot,
      ebay: {
        client_id: nextClientId,
        client_secret: nextClientSecret,
      },
    };

    fs.writeFileSync(this.filePath, `${JSON.stringify(nextPayload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    return this.getStatus();
  }
}
