// Tiny key-value store with expiry. Uses Upstash Redis when configured (needed on
// Vercel, where every request may hit a fresh function instance), otherwise an
// in-memory Map so local development needs no accounts.

import { Redis } from "@upstash/redis";

export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec: number): Promise<void>;
  /** Set only if the key does not exist. Returns true when this call wrote it. */
  setIfAbsent(key: string, value: unknown, ttlSec?: number): Promise<boolean>;
  /** Atomically read and delete (single-use values such as authorization codes). */
  getdel<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSec: number): Promise<number>;
  /** Append to a list, keep only the newest `max` items. */
  push(key: string, value: unknown, max: number, ttlSec: number): Promise<void>;
  /** Last `count` items of a list, oldest first. */
  tail<T>(key: string, count: number): Promise<T[]>;
}

class MemoryKV implements KV {
  private data = new Map<string, { v: unknown; exp: number }>();

  private live(key: string) {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.exp && e.exp < Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  private clone<T>(v: unknown): T {
    return structuredClone(v) as T;
  }
  async get<T>(key: string) {
    const e = this.live(key);
    return e ? this.clone<T>(e.v) : null;
  }
  async set(key: string, value: unknown, ttlSec: number) {
    this.data.set(key, { v: this.clone(value), exp: Date.now() + ttlSec * 1000 });
  }
  async setIfAbsent(key: string, value: unknown, ttlSec?: number) {
    if (this.live(key)) return false;
    this.data.set(key, { v: this.clone(value), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
    return true;
  }
  async getdel<T>(key: string) {
    const e = this.live(key);
    this.data.delete(key);
    return e ? this.clone<T>(e.v) : null;
  }
  async del(key: string) {
    this.data.delete(key);
  }
  async incr(key: string, ttlSec: number) {
    const n = ((this.live(key)?.v as number) ?? 0) + 1;
    this.data.set(key, { v: n, exp: Date.now() + ttlSec * 1000 });
    return n;
  }
  async push(key: string, value: unknown, max: number, ttlSec: number) {
    const list = ((this.live(key)?.v as unknown[]) ?? []).concat([this.clone(value)]);
    this.data.set(key, { v: list.slice(-max), exp: Date.now() + ttlSec * 1000 });
  }
  async tail<T>(key: string, count: number) {
    const list = (this.live(key)?.v as unknown[]) ?? [];
    return this.clone<T[]>(list.slice(-count));
  }
}

class UpstashKV implements KV {
  constructor(private r: Redis) {}
  get<T>(key: string) {
    return this.r.get<T>(key);
  }
  async set(key: string, value: unknown, ttlSec: number) {
    await this.r.set(key, value, { ex: ttlSec });
  }
  async setIfAbsent(key: string, value: unknown, ttlSec?: number) {
    const res = ttlSec
      ? await this.r.set(key, value, { nx: true, ex: ttlSec })
      : await this.r.set(key, value, { nx: true });
    return res === "OK";
  }
  getdel<T>(key: string) {
    return this.r.getdel<T>(key);
  }
  async del(key: string) {
    await this.r.del(key);
  }
  async incr(key: string, ttlSec: number) {
    const p = this.r.pipeline();
    p.incr(key);
    p.expire(key, ttlSec);
    const [n] = await p.exec<[number, number]>();
    return n;
  }
  async push(key: string, value: unknown, max: number, ttlSec: number) {
    const p = this.r.pipeline();
    p.rpush(key, value);
    p.ltrim(key, -max, -1);
    p.expire(key, ttlSec);
    await p.exec();
  }
  tail<T>(key: string, count: number) {
    return this.r.lrange<T>(key, -count, -1);
  }
}

function createStore(): { kv: KV; backend: string } {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { kv: new UpstashKV(new Redis({ url, token })), backend: "upstash" };
  if (process.env.VERCEL) {
    console.warn(
      "[store] No Upstash Redis env vars found. Using in-memory state, which BREAKS on Vercel " +
        "(each request can land on a different instance). Add Upstash Redis from the Vercel Marketplace.",
    );
  }
  return { kv: new MemoryKV(), backend: "memory" };
}

export const { kv, backend: storeBackend } = createStore();
