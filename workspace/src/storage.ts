import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export const bytesHash = (b: Buffer) =>
  createHash("sha256").update(b).digest("hex");
function checked(key: string) {
  if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(key))
    throw new Error("invalid_blob_key");
  return key;
}
export class LocalBlobs implements BlobStore {
  constructor(private root: string) {}
  private path(k: string) {
    return resolve(this.root, checked(k));
  }
  async put(k: string, b: Buffer) {
    const p = this.path(k);
    await mkdir(dirname(p), { recursive: true });
    const stage = p + "." + randomUUID() + ".staged";
    await writeFile(stage, b, { mode: 0o600, flag: "wx" });
    await rename(stage, p);
  }
  get(k: string) {
    return readFile(this.path(k));
  }
}
export class S3Blobs implements BlobStore {
  private client: S3Client;
  constructor(
    private bucket: string,
    config: NonNullable<ConstructorParameters<typeof S3Client>[0]>,
  ) {
    this.client = new S3Client(config);
  }
  async put(key: string, bytes: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: checked(key),
        Body: bytes,
        ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
      }),
    );
  }
  async get(key: string) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: checked(key) }),
    );
    if (!r.Body) throw new Error("blob_missing");
    return Buffer.from(await r.Body.transformToByteArray());
  }
}
