import type { PublicSnapshot } from "@meridian/world-schema";
import { validateCurrentPublicSnapshot } from "./public-world.js";
export const PROJECTION_CACHE_SCHEMA_VERSION = 3;
export const PROJECTION_CACHE_KEY = `meridian.public-projection.snapshot-v${PROJECTION_CACHE_SCHEMA_VERSION}`;
export interface ProjectionStorage {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface ProjectionCacheRecord {
  projection: PublicSnapshot;
  lastVerifiedAt: string;
}
export interface ProjectionCache {
  load(): Promise<ProjectionCacheRecord | null>;
  save(projection: PublicSnapshot, lastVerifiedAt: string): Promise<void>;
}
interface StoredProjectionCacheRecord extends ProjectionCacheRecord {
  cacheSchemaVersion: typeof PROJECTION_CACHE_SCHEMA_VERSION;
}
async function parseRecord(value: unknown): Promise<ProjectionCacheRecord> {
  if (typeof value !== "object" || value === null) throw new TypeError("invalid projection cache record");
  if (Object.keys(value).sort().join(",") !== "cacheSchemaVersion,lastVerifiedAt,projection") throw new TypeError("unknown cache fields");
  const record = value as Partial<StoredProjectionCacheRecord>;
  if (record.cacheSchemaVersion !== PROJECTION_CACHE_SCHEMA_VERSION) {
    throw new TypeError("unsupported projection cache schema");
  }
  if (typeof record.lastVerifiedAt !== "string" || Number.isNaN(Date.parse(record.lastVerifiedAt))) {
    throw new TypeError("invalid projection verification time");
  }
  return {
    projection: await validateCurrentPublicSnapshot(record.projection),
    lastVerifiedAt: record.lastVerifiedAt
  };
}
export function createProjectionCache(storage: ProjectionStorage): ProjectionCache {
  let operations: Promise<void> = Promise.resolve();
  const serialize = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = operations.then(operation, operation);
    operations = result.then(() => undefined, () => undefined);
    return result;
  };
  let pending: ProjectionCacheRecord | undefined;
  let flushing: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    flushing = serialize(async () => {
      while (pending) {
        const candidate = pending;
        pending = undefined;
        const record = await parseRecord({
          cacheSchemaVersion: PROJECTION_CACHE_SCHEMA_VERSION,
          ...candidate
        });
        // A newer requested snapshot supersedes work still undergoing validation.
        if (pending) continue;
        await storage.write(PROJECTION_CACHE_KEY, {
          cacheSchemaVersion: PROJECTION_CACHE_SCHEMA_VERSION,
          ...record
        } satisfies StoredProjectionCacheRecord);
      }
    }).finally(() => {
      flushing = undefined;
      if (pending) void flush().catch(() => undefined);
    });
    return flushing;
  };
  return {
    load() {
      return serialize(async () => {
        await storage.remove("meridian.world-projection.snapshot-v1");
        await storage.remove("meridian.world-projection.snapshot-v2");
        await storage.remove("meridian.public-projection.snapshot-v1");
        await storage.remove("meridian.public-projection.snapshot-v2");
        const value = await storage.read(PROJECTION_CACHE_KEY);
        if (value === undefined || value === null) return null;
        try {
          return await parseRecord(value);
        } catch {
          await storage.remove(PROJECTION_CACHE_KEY);
          return null;
        }
      });
    },
    save(projection: PublicSnapshot, lastVerifiedAt: string): Promise<void> {
      pending = {
        projection,
        lastVerifiedAt
      };
      return flush();
    }
  };
}
const DATABASE_NAME = "meridian-world";
const STORE_NAME = "projection-cache";
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onerror = () => reject(request.error ?? new Error("unable to open projection cache"));
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
  });
}
export function createIndexedDbProjectionStorage(): ProjectionStorage {
  const database = openDatabase();
  const transaction = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await database;
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onerror = () => reject(request.error ?? new Error("projection cache transaction failed"));
      request.onsuccess = () => resolve(request.result);
    });
  };
  return {
    read: key => transaction("readonly", store => store.get(key)),
    write: async (key, value) => {
      await transaction("readwrite", store => store.put(value, key));
    },
    remove: async key => {
      await transaction("readwrite", store => store.delete(key));
    }
  };
}
