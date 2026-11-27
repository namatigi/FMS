import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Object storage abstraction for exports. LocalDirStorage writes to a directory
 * (mount a volume / NFS / s3fs in production); an S3/MinIO or Azure Blob
 * implementation only needs to implement put().
 */
export interface ObjectStorage {
  put(key: string, body: string | Buffer, contentType: string): Promise<{ uri: string }>;
}

export class LocalDirStorage implements ObjectStorage {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  async put(key: string, body: string | Buffer): Promise<{ uri: string }> {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { uri: `file://${path.replace(/\\/g, '/')}` };
  }
}
