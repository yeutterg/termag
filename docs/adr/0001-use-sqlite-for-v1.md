# ADR 0001: Use SQLite for v1

## Status

Accepted

## Context

termag-next is being rebuilt as a single-user, single-VPS architecture. The original termag used PostgreSQL, but for the v1 rebuild we need to evaluate whether SQLite or PostgreSQL is the better fit.

## Decision

Use SQLite for the v1 release of termag-next.

## Rationale

### Advantages of SQLite for v1:

1. **Simplicity**: No database server setup or maintenance required
2. **Single-user architecture**: SQLite is optimized for single-user access patterns
3. **Deployment simplicity**: Single file database, easy to backup and migrate
4. **Resource efficiency**: Lower memory and CPU footprint compared to PostgreSQL
5. **Sufficient performance**: For single-user workloads, SQLite performance is excellent
6. **Built-in to Next.js ecosystem**: Prisma has excellent SQLite support
7. **Zero configuration**: No connection pooling, replication, or high availability setup needed
8. **Easy local development**: No need to run a separate database server locally

### Trade-offs:

1. **Concurrency**: Limited write concurrency (not an issue for single-user)
2. **Scaling**: Not designed for horizontal scaling (by design for v1)
3. **Advanced features**: Missing some PostgreSQL features (not needed for v1)
4. **Network access**: No network protocol (file-based only)

### Why PostgreSQL was not chosen for v1:

1. **Overkill for single-user**: PostgreSQL's strengths are in multi-user scenarios
2. **Additional complexity**: Requires separate server setup and maintenance
3. **Resource overhead**: Higher memory and CPU requirements
4. **Deployment complexity**: Additional infrastructure component to manage

## Future Considerations

If termag evolves to support multi-user scenarios in future versions, we can:

1. Migrate to PostgreSQL using Prisma's migration tools
2. Implement a migration script to convert SQLite to PostgreSQL
3. Add database abstraction layer to support multiple databases
4. Consider PostgreSQL for features like full-text search, advanced queries, etc.

The current schema is designed to be database-agnostic through Prisma, making future migration straightforward.

## Implementation

1. Configure Prisma to use SQLite
2. Set up file-based database storage
3. Implement backup/restore scripts for SQLite files
4. Add database migration workflow for deployment
5. Document SQLite-specific considerations

## Consequences

Positive:

- Simpler deployment and maintenance
- Lower resource requirements
- Faster development cycle
- Easier onboarding for new developers

Negative:

- Will need migration path if multi-user support is added
- Some PostgreSQL-specific features unavailable
- File-based storage requires careful backup procedures

## References

- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [Prisma SQLite Guide](https://www.prisma.io/docs/concepts/database-connectors/sqlite)
- [PostgreSQL vs SQLite Comparison](https://www.sqlite.org/whentouse.html)
