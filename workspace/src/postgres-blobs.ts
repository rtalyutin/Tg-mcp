import type { Database } from "./db.js";
import { bytesHash, type BlobStore } from "./storage.js";

/** Content-addressed immutable files in the existing database, independent of local disks. */
export class PostgresBlobs implements BlobStore {
  constructor(
    private db: Database,
    private owner: string,
  ) {}
  private check(key: string) {
    if (
      !key.startsWith(this.owner + "/") ||
      !/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(key)
    )
      throw new Error("invalid_blob_key");
  }
  async put(key: string, bytes: Buffer) {
    this.check(key);
    if (key !== this.owner + "/" + bytesHash(bytes))
      throw new Error("blob_hash_mismatch");
    await this.db.pool.query(
      "INSERT INTO host_blobs(key,bytes) VALUES($1,$2) ON CONFLICT(key) DO NOTHING",
      [key, bytes],
    );
    if (bytesHash(await this.get(key)) !== bytesHash(bytes))
      throw new Error("blob_hash_mismatch");
  }
  async get(key: string) {
    this.check(key);
    const row = (
      await this.db.pool.query("SELECT bytes FROM host_blobs WHERE key=$1", [
        key,
      ])
    ).rows[0];
    if (!row) throw new Error("blob_missing");
    const bytes = Buffer.from(row.bytes);
    if (key !== this.owner + "/" + bytesHash(bytes))
      throw new Error("blob_hash_mismatch");
    return bytes;
  }
}
