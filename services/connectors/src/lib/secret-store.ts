import { createStorage } from '@atlas/storage';
import { newToken } from '@atlas/utils';

/**
 * `connector_accounts.secret_ref` is documented (docs/02, docs/09 § Token
 * handling) as "a pointer into AWS Secrets Manager — never the credential
 * itself," and never stored in Postgres. This interface is that boundary:
 * the repo layer only ever sees a `ref` string, never the plaintext.
 */
export interface SecretStore {
  put(plaintext: string): Promise<{ ref: string }>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export interface LocalSecretStoreOptions {
  root: string;
}

/**
 * DEV-ONLY. Writes plaintext credentials to disk with no encryption — this
 * exists so connector-account lifecycle logic (connect/disconnect/status)
 * can be built and tested without a real KMS, not because it's an
 * acceptable production posture. `createSecretStore` refuses to hand this
 * out under a production-looking driver name.
 */
export function createLocalSecretStore(options: LocalSecretStoreOptions): SecretStore {
  const storage = createStorage({ driver: 'local', localRoot: options.root });
  return {
    async put(plaintext: string) {
      const ref = newToken(24);
      await storage.put(ref, Buffer.from(plaintext, 'utf8'));
      return { ref };
    },
    async get(ref: string) {
      const buffer = await storage.get(ref);
      return buffer.toString('utf8');
    },
    async delete(ref: string) {
      await storage.delete(ref);
    },
  };
}

export interface CreateSecretStoreOptions {
  driver: 'local' | 'kms';
  localRoot: string;
}

export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
  if (options.driver === 'local') {
    return createLocalSecretStore({ root: options.localRoot });
  }
  throw new Error(
    "Secret store driver 'kms' is not implemented yet — set SECRET_STORE_DRIVER=local for development. " +
      'Production must never fall back to the local driver (docs/09 § Token handling).',
  );
}
