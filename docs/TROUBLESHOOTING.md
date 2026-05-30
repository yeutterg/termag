# Troubleshooting Guide

This guide covers common issues and their solutions when developing or deploying termag-next.

## Table of Contents

- [Development Issues](#development-issues)
- [Build Issues](#build-issues)
- [Database Issues](#database-issues)
- [WebSocket Issues](#websocket-issues)
- [Authentication Issues](#authentication-issues)
- [Agent Issues](#agent-issues)
- [Performance Issues](#performance-issues)
- [Deployment Issues](#deployment-issues)

## Development Issues

### Port Already in Use

**Problem**: `Error: listen EADDRINUSE: address already in use :::3000`

**Solutions**:

```bash
# Find and kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or use a different port
PORT=3001 npm run dev
```

### TypeScript Compilation Errors

**Problem**: TypeScript errors during development

**Solutions**:

```bash
# Regenerate Prisma client
npm run db:generate

# Clean Next.js cache
rm -rf apps/web/.next
npm run dev

# Check TypeScript configuration
npm run typecheck
```

### Module Not Found Errors

**Problem**: `Module not found: Can't resolve '@/components/...'`

**Solutions**:

```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Check tsconfig.json paths configuration
# Ensure baseUrl and paths are correctly set
```

## Build Issues

### Build Fails with Memory Errors

**Problem**: Build process runs out of memory

**Solutions**:

```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Or use environment variable
export NODE_OPTIONS="--max-old-space-size=4096"
```

### Docker Build Failures

**Problem**: Docker build fails during dependency installation

**Solutions**:

```bash
# Clean Docker cache
docker system prune -a

# Rebuild without cache
docker compose build --no-cache

# Check Docker disk space
docker system df
```

### Production Build Errors

**Problem**: Build works in development but fails in production

**Solutions**:

```bash
# Check environment variables
# Ensure all required env vars are set

# Test build locally
NODE_ENV=production npm run build

# Check for missing dependencies
npm audit fix
```

## Database Issues

### Database Connection Failed

**Problem**: `Can't reach database server at localhost`

**Solutions**:

```bash
# Check DATABASE_URL in .env.local
# Ensure SQLite file path is correct

# Reset database (WARNING: deletes data)
rm apps/web/prisma/dev.db
npm run db:migrate

# Check Prisma schema
npm run db:generate
```

### Migration Conflicts

**Problem**: Database migration conflicts or failures

**Solutions**:

```bash
# Resolve migration conflicts
cd apps/web
npx prisma migrate resolve --rolled-back [migration-name]

# Reset database (dev only)
npx prisma migrate reset

# Create new migration
npx prisma migrate dev --name [migration-name]
```

### Slow Database Queries

**Problem**: Database operations are slow

**Solutions**:

```bash
# Analyze query performance
# Add indexes to Prisma schema
# Use Prisma's include/select to optimize queries

# Check for N+1 queries
# Use Prisma's findMany with proper relations
```

## WebSocket Issues

### WebSocket Connection Fails

**Problem**: Agent cannot connect to broker via WebSocket

**Solutions**:

```bash
# Check TERMAG_URL is correct
# Ensure URL includes /api/ws/agent path

# Check firewall settings
# Ensure WebSocket port is accessible

# Test WebSocket connection
wscat -c ws://localhost:3000/api/ws/agent
```

### Connection Drops Frequently

**Problem**: WebSocket connections disconnect frequently

**Solutions**:

```bash
# Check network stability
# Increase timeout settings in broker

# Check reverse proxy configuration
# Ensure WebSocket upgrades are allowed

# Monitor broker logs for connection errors
```

### WebSocket Message Errors

**Problem**: Messages not reaching destination or malformed

**Solutions**:

```bash
# Check message format matches protocol
# Enable debug logging in broker

# Verify agent and broker protocol versions
# Check for breaking changes in protocol
```

## Authentication Issues

### OAuth Login Fails

**Problem**: Google OAuth login redirects or fails

**Solutions**:

```bash
# Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
# Verify redirect URI matches NEXTAUTH_URL/api/auth/callback/google

# Check NEXTAUTH_SECRET is set
# Ensure NEXTAUTH_URL matches exactly (including port)

# Test OAuth configuration
# Use Google OAuth playground for testing
```

### Session Not Persisting

**Problem**: User gets logged out frequently

**Solutions**:

```bash
# Check NEXTAUTH_SECRET consistency
# Ensure cookie settings are correct

# Check browser cookie settings
# Verify SameSite and Secure cookie attributes

# Check session duration settings
# Review NextAuth configuration
```

### Trusted Network Mode Issues

**Problem**: Trusted network mode not working as expected

**Solutions**:

```bash
# Verify TERMAG_TRUSTED_NETWORK=true
# Check TERMAG_PASSWORD if needed

# Ensure bound address is correct
# Check HOSTNAME environment variable

# Test with curl
curl -v http://localhost:3000/api/health
```

## Agent Issues

### Agent Won't Start

**Problem**: Agent process fails to start

**Solutions**:

```bash
# Check TERMAG_URL and TERMAG_AGENT_TOKEN
# Verify TERMAG_AGENT_ROOTS configuration

# Check Node.js version (>=18 required)
node --version

# Run agent in debug mode
TERMAG_AGENT_DEBUG=true npm run agent
```

### Agent Can't Find tmux

**Problem**: Agent reports tmux not found

**Solutions**:

```bash
# Install tmux
brew install tmux  # macOS
sudo apt-get install tmux  # Linux

# Check tmux is in PATH
which tmux

# Verify tmux version
tmux -V
```

### Agent Permission Errors

**Problem**: Agent can't access files or directories

**Solutions**:

```bash
# Check file permissions on project directories
# Ensure agent has read access to roots

# Run agent with appropriate user
# Don't run as root unless necessary

# Check TERMAG_AGENT_ROOTS paths
# Ensure paths are absolute or correctly expanded
```

## Performance Issues

### High Memory Usage

**Problem**: Application uses excessive memory

**Solutions**:

```bash
# Check memory leaks
# Use Node.js memory profiling

# Monitor WebSocket connections
# Close idle connections

# Check scrollback chunk retention
# Implement TTL cleanup for old data

# Profile with:
node --inspect apps/web/server.js
```

### Slow Terminal Response

**Problem**: Terminal input/output is sluggish

**Solutions**:

```bash
# Check network latency between agent and broker
# Optimize WebSocket message batching

# Reduce scrollback buffer size
# Adjust COALESCE_MS in broker

# Check PTY spawn time
# Monitor system resources
```

### Database Performance

**Problem**: Database queries are slow

**Solutions**:

```bash
# Add database indexes
# Optimize Prisma queries

# Use connection pooling
# Implement query caching

# Monitor database size
# Clean up old scrollback chunks
```

## Deployment Issues

### Docker Container Won't Start

**Problem**: Docker container fails to start

**Solutions**:

```bash
# Check Docker logs
docker compose logs web

# Check environment variables in docker-compose.yml
# Ensure volume mounts are correct

# Test container locally
docker compose up --build

# Check resource limits
# Ensure sufficient memory/CPU available
```

### SSL/TLS Certificate Issues

**Problem**: HTTPS certificate errors

**Solutions**:

```bash
# Check Caddy configuration
# Ensure TERMAG_HOST is correct

# For local development with self-signed certs:
export TERMAG_TLS_INSECURE_SKIP_VERIFY=true

# Check Let's Encrypt rate limits
# Use staging environment for testing
```

### Database Migration in Production

**Problem**: Database migrations fail in production

**Solutions**:

```bash
# Backup database before migration
# Test migrations in staging first

# Use prisma migrate deploy
# Don't use migrate dev in production

# Rollback if needed:
# Restore from backup or use migration rollback
```

## Getting Additional Help

If you can't resolve your issue:

1. **Check logs**: Look at application logs for detailed error messages
2. **Search issues**: Check existing GitHub issues for similar problems
3. **Enable debug mode**: Set LOG_LEVEL=debug for more detailed logging
4. **Create minimal reproduction**: Create a simple test case that demonstrates the issue
5. **File an issue**: Report the problem on GitHub with:
   - Detailed description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details
   - Relevant logs

## Health Check

Use the health check endpoint to diagnose system status:

```bash
curl http://localhost:3000/api/health
```

Response includes:

- Overall system status (healthy/degraded/unhealthy)
- Memory usage
- Database status and latency
- Configuration warnings
- Uptime information
