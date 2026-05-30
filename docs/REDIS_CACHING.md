# Redis Caching Setup

This document describes the Redis caching implementation in termag-next.

## Overview

Redis is used for caching frequently accessed data to improve performance and reduce database load. The caching implementation includes:

- Automatic connection management with reconnection strategy
- Graceful fallback when Redis is not available
- Common caching patterns (get, set, get-or-set, increment)
- Health check integration

## Configuration

### Environment Variables

- `REDIS_URL`: Redis connection string (default: `redis://localhost:6379`)

### Example Configuration

```bash
# Local development
REDIS_URL=redis://localhost:6379

# Production with authentication
REDIS_URL=redis://:password@redis.example.com:6379

# Using staging Redis from Docker Compose
REDIS_URL=redis://redis:6379
```

## Usage

### Basic Caching

```typescript
import { cacheGet, cacheSet } from "@/lib/cache";

// Set a value with 1 hour TTL
await cacheSet("user:123", userData, { ttl: 3600 });

// Get a value
const userData = await cacheGet("user:123");
```

### Get or Set Pattern

```typescript
import { cacheGetOrSet } from "@/lib/cache";

const projects = await cacheGetOrSet(
  "projects:user:123",
  async () => {
    return await prisma.project.findMany({ where: { userId: "123" } });
  },
  { ttl: 300 } // 5 minutes
);
```

### Counter Operations

```typescript
import { cacheIncrement, cacheSetWithExpire } from "@/lib/cache";

// Increment a rate limit counter
const count = await cacheIncrement("rate_limit:user:123");
if (count === 1) {
  // First request, set expiration
  await cacheSetWithExpire("rate_limit:user:123", count, 60);
}
```

### Cache Invalidation

```typescript
import { cacheDelete, cacheClearPattern } from "@/lib/cache";

// Delete specific key
await cacheDelete("user:123");

// Clear all user-related cache
await cacheClearPattern("user:*");
```

## Integration with Health Check

The health check endpoint includes Redis status:

```typescript
import { redisHealthCheck } from "@/lib/cache";

const redisHealth = await redisHealthCheck();
// Returns: { healthy: true, latency: 5 } or { healthy: false, error: '...' }
```

## Graceful Degradation

The caching implementation is designed to fail gracefully:

- If Redis is not configured, cache operations are no-ops
- If Redis connection fails, errors are logged but don't crash the application
- Cache misses fall back to database queries automatically

## Best Practices

### 1. Use Appropriate TTLs

- Static data (configs, settings): 1-24 hours
- User data: 5-15 minutes
- Session data: 30 minutes - 1 hour
- Rate limiting counters: 1-60 seconds

### 2. Use Descriptive Keys

```typescript
// Good
`user:${userId}:projects``project:${projectId}:tabs``rate_limit:${userId}:api`
// Avoid
`cache1``data``temp`;
```

### 3. Handle Cache Staleness

```typescript
// Use versioning for cache keys
const version = await getProjectVersion(projectId);
const cacheKey = `project:${projectId}:v${version}`;

// Or use explicit invalidation on updates
await cacheDelete(`project:${projectId}:*`);
await cacheSet(`project:${projectId}:latest`, updatedData, { ttl: 3600 });
```

### 4. Monitor Cache Performance

```typescript
// Track cache hit/miss ratios
let hits = 0;
let misses = 0;

const data = await cacheGet(key);
if (data) {
  hits++;
} else {
  misses++;
  const freshData = await fetchData();
  await cacheSet(key, freshData, { ttl: 300 });
}
```

## Example: Caching API Response

```typescript
import { cacheGetOrSet } from "@/lib/cache";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const userId = await getUserIdFromSession(request);

  const projects = await cacheGetOrSet(
    `projects:user:${userId}`,
    async () => {
      return await prisma.project.findMany({
        where: { userId },
        include: { tabs: true },
      });
    },
    { ttl: 300 } // 5 minutes
  );

  return NextResponse.json({ projects });
}
```

## Example: Cache Invalidation on Update

```typescript
import { cacheDelete } from "@/lib/cache";

export async function PATCH(request: Request, { params }: { params: { projectId: string } }) {
  const { projectId } = params;

  // Update project
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: await request.json(),
  });

  // Invalidate cache
  await cacheDelete(`project:${projectId}`);
  await cacheClearPattern(`projects:user:*`);

  return NextResponse.json(updated);
}
```

## Monitoring

### Redis Connection Status

Check the application logs for Redis connection events:

- `Redis Client Connected` - Successful connection
- `Redis Client Error` - Connection or operation error
- `Failed to connect to Redis` - Initial connection failure

### Performance Metrics

Monitor:

- Cache hit ratio (should be > 80% for effective caching)
- Redis latency (should be < 10ms for local, < 100ms for remote)
- Memory usage (ensure Redis has sufficient memory)

## Troubleshooting

### Redis Not Connecting

1. Check if Redis URL is correct
2. Verify Redis server is running: `redis-cli ping`
3. Check network connectivity to Redis server
4. Review application logs for specific error messages

### Cache Not Working

1. Verify Redis is configured (REDIS_URL set)
2. Check if Redis connection is healthy via health check endpoint
3. Ensure cache keys are consistent between set and get operations
4. Check TTL values - data may be expiring too quickly

### High Memory Usage

1. Review TTL values - some may be too long
2. Implement cache eviction policies
3. Monitor which keys are using the most memory
4. Consider using Redis memory optimization settings

## Future Enhancements

Potential improvements to the caching layer:

1. **Cache Warming**: Pre-populate cache with frequently accessed data
2. **Multi-layer Caching**: Add in-memory cache for hot data
3. **Cache Partitioning**: Separate caches for different data types
4. **Pub/Sub**: Use Redis pub/sub for cache invalidation across instances
5. **Cluster Support**: Add Redis Cluster support for horizontal scaling
