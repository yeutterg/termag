import { createClient, RedisClientType } from "redis";

let redisClient: RedisClientType | null = null;

/**
 * Initialize Redis client connection
 */
export async function initRedis(): Promise<RedisClientType> {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  redisClient = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: retries => {
        if (retries > 10) {
          return new Error("Redis reconnection failed after 10 retries");
        }
        return Math.min(retries * 100, 3000);
      },
    },
  });

  redisClient.on("error", err => {
    console.error("Redis Client Error:", err);
  });

  redisClient.on("connect", () => {
    console.log("Redis Client Connected");
  });

  try {
    await redisClient.connect();
  } catch (error) {
    console.error("Failed to connect to Redis:", error);
    redisClient = null;
    throw error;
  }

  return redisClient;
}

/**
 * Get Redis client (initializes if not already connected)
 */
export async function getRedisClient(): Promise<RedisClientType | null> {
  if (!process.env.REDIS_URL) {
    return null; // Redis not configured
  }

  if (!redisClient) {
    try {
      return await initRedis();
    } catch (error) {
      console.error("Failed to initialize Redis client:", error);
      return null;
    }
  }

  return redisClient;
}

/**
 * Cache interface with fallback when Redis is not available
 */
export interface CacheOptions {
  ttl?: number; // Time to live in seconds
}

/**
 * Get value from cache
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();

  if (!client) {
    return null; // Cache not available
  }

  try {
    const value = await client.get(key);
    if (!value) {
      return null;
    }
    return JSON.parse(value) as T;
  } catch (error) {
    console.error("Cache get error:", error);
    return null;
  }
}

/**
 * Set value in cache
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  options: CacheOptions = {}
): Promise<void> {
  const client = await getRedisClient();

  if (!client) {
    return; // Cache not available, silently skip
  }

  try {
    const serialized = JSON.stringify(value);

    if (options.ttl) {
      await client.setEx(key, options.ttl, serialized);
    } else {
      await client.set(key, serialized);
    }
  } catch (error) {
    console.error("Cache set error:", error);
  }
}

/**
 * Delete value from cache
 */
export async function cacheDelete(key: string): Promise<void> {
  const client = await getRedisClient();

  if (!client) {
    return; // Cache not available
  }

  try {
    await client.del(key);
  } catch (error) {
    console.error("Cache delete error:", error);
  }
}

/**
 * Clear all cache entries matching a pattern
 */
export async function cacheClearPattern(pattern: string): Promise<void> {
  const client = await getRedisClient();

  if (!client) {
    return; // Cache not available
  }

  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (error) {
    console.error("Cache clear pattern error:", error);
  }
}

/**
 * Get or set pattern - fetch from cache or compute and cache
 */
export async function cacheGetOrSet<T>(
  key: string,
  fn: () => Promise<T>,
  options: CacheOptions = {}
): Promise<T> {
  const cached = await cacheGet<T>(key);

  if (cached !== null) {
    return cached;
  }

  const value = await fn();
  await cacheSet(key, value, options);

  return value;
}

/**
 * Increment a counter in cache
 */
export async function cacheIncrement(key: string): Promise<number> {
  const client = await getRedisClient();

  if (!client) {
    return 0; // Cache not available
  }

  try {
    return await client.incr(key);
  } catch (error) {
    console.error("Cache increment error:", error);
    return 0;
  }
}

/**
 * Set counter with expiration
 */
export async function cacheSetWithExpire(key: string, value: number, ttl: number): Promise<void> {
  const client = await getRedisClient();

  if (!client) {
    return; // Cache not available
  }

  try {
    await client.setEx(key, ttl, value.toString());
  } catch (error) {
    console.error("Cache set with expire error:", error);
  }
}

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Health check for Redis
 */
export async function redisHealthCheck(): Promise<{
  healthy: boolean;
  latency?: number;
  error?: string;
}> {
  const client = await getRedisClient();

  if (!client) {
    return { healthy: false, error: "Redis not configured or not connected" };
  }

  try {
    const start = Date.now();
    await client.ping();
    const latency = Date.now() - start;
    return { healthy: true, latency };
  } catch (error) {
    return { healthy: false, error: (error as Error).message };
  }
}
