# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs) for the termag-next project. ADRs document important architectural decisions, their context, and consequences.

## ADR Index

| ADR                                 | Title             | Status   | Date       |
| ----------------------------------- | ----------------- | -------- | ---------- |
| [0001](./0001-use-sqlite-for-v1.md) | Use SQLite for v1 | Accepted | 2024-12-15 |

## ADR Template

Use [0000-template.md](./0000-template.md) as a starting point for new ADRs.

## ADR Process

1. Create a new ADR using the template
2. Number ADRs sequentially (0001, 0002, etc.)
3. Discuss the decision with the team
4. Update status to "Accepted" when consensus is reached
5. Update this index file
6. Reference the ADR in related code documentation

## ADR Lifecycle

- **Proposed**: Initial draft under discussion
- **Accepted**: Decision has been made and implemented
- **Deprecated**: Decision is no longer relevant but kept for historical reference
- **Superseded**: Decision has been replaced by a newer ADR (reference the new ADR)
