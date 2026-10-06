import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { config } from "./config.mjs";

export class LocalStorage {
  constructor(root = config.storagePath) {
    this.root = path.resolve(root);
  }

  async initialize() {
    for (const directory of ["apps", "icons", "updates", "signing"]) {
      await fs.mkdir(path.join(this.root, directory), { recursive: true });
    }
  }

  async save(category, filename, contents) {
    if (!["apps", "icons", "updates"].includes(category)) {
      throw new Error("Unsupported public storage category");
    }
    const destination = path.join(this.root, category, filename);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents, { flag: "wx", mode: 0o600 });
    return destination;
  }

  async saveStream(category, filename, readable, { maxBytes, expectedLength, validate }) {
    if (!["apps", "icons", "updates"].includes(category)) {
      throw new Error("Unsupported public storage category");
    }
    const directory = path.join(this.root, category);
    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, filename);
    const temporary = path.join(directory, `.${randomUUID()}.uploading`);
    const file = await fs.open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    const prefix = [];
    let prefixSize = 0;
    let tail = Buffer.alloc(0);
    let size = 0;

    try {
      for await (const chunk of readable) {
        size += chunk.length;
        if (size > maxBytes || size > expectedLength) {
          throw Object.assign(new Error("Upload exceeds the configured size limit"), { statusCode: 413 });
        }
        if (prefixSize < 16) {
          const take = chunk.subarray(0, 16 - prefixSize);
          prefix.push(take);
          prefixSize += take.length;
        }
        tail = Buffer.concat([tail, chunk]).subarray(-2);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error("Unable to persist uploaded file");
          offset += bytesWritten;
        }
      }

      if (size !== expectedLength) {
        throw Object.assign(new Error("Upload size did not match Content-Length"), { statusCode: 400 });
      }
      const header = Buffer.concat(prefix);
      if (!validate(header, tail)) {
        throw Object.assign(new Error("Uploaded file content does not match its declared type"), { statusCode: 400 });
      }
      await file.close();
      await fs.rename(temporary, destination);
      return { path: destination, file_size: size, sha256: hash.digest("hex"), filename };
    } catch (error) {
      await file.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async read(filename) {
    const absolutePath = path.resolve(filename);
    if (!absolutePath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage path is outside the configured root");
    }
    return fs.readFile(absolutePath);
  }

  async remove(filename) {
    const absolutePath = path.resolve(filename);
    if (!absolutePath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage path is outside the configured root");
    }
    await fs.rm(absolutePath, { force: true });
  }

  async sha256(filename) {
    const absolutePath = path.resolve(filename);
    if (!absolutePath.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Storage path is outside the configured root");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
    return hash.digest("hex");
  }
}

export class EncryptedSigningStorage {
  constructor(root = config.signingStoragePath, keyHex = config.encryptionKey) {
    this.root = path.resolve(root);
    this.key = Buffer.from(keyHex, "hex");
    if (this.key.length !== 32) throw new Error("Signing storage key must be 32 bytes");
  }

  async save(name, plaintext) {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(name)) throw new Error("Invalid signing material name");
    await fs.mkdir(this.root, { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const payload = Buffer.concat([Buffer.from("FPLUS1"), iv, cipher.getAuthTag(), ciphertext]);
    const destination = path.join(this.root, `${name}.enc`);
    await fs.writeFile(destination, payload, { flag: "wx", mode: 0o600 });
    return destination;
  }

  async read(name) {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(name)) throw new Error("Invalid signing material name");
    const payload = await fs.readFile(path.join(this.root, `${name}.enc`));
    if (payload.length < 34 || payload.subarray(0, 6).toString() !== "FPLUS1") {
      throw new Error("Invalid encrypted signing material");
    }
    const iv = payload.subarray(6, 18);
    const tag = payload.subarray(18, 34);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload.subarray(34)), decipher.final()]);
  }
}
