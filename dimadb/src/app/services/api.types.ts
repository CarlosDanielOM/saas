export interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface DbConnection {
  id: string;
  name: string;
  url: string;
  source: 'env' | 'local';
}

export interface RedisKeyRow {
  name: string;
  type?: string;
  ttl?: number;
}

export interface RedisScanResult {
  cursor: string;
  keys: RedisKeyRow[];
}

export interface RedisTreeFolder {
  prefix: string;
  label: string;
  seen: number;
}

export interface RedisTreeResult {
  prefix: string;
  match: string;
  cursor: string;
  folders: RedisTreeFolder[];
  keys: RedisKeyRow[];
  scanned: number;
}

export interface RedisKeyDetail {
  key: string;
  type: string;
  ttl: number;
  value: unknown;
}

export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset';

export type RedisMutateOp =
  | 'ttl'
  | 'hset'
  | 'hdel'
  | 'lset'
  | 'lpush'
  | 'rpush'
  | 'ldel'
  | 'sadd'
  | 'srem'
  | 'zadd'
  | 'zrem';

export interface RedisMutateRequest {
  key: string;
  op: RedisMutateOp;
  field?: string;
  renameFrom?: string;
  value?: string;
  index?: number;
  member?: string;
  score?: number;
  ttl?: number;
}

export interface RedisCreateRequest {
  key: string;
  type: RedisKeyType;
  value?: string;
  field?: string;
  score?: number;
}
