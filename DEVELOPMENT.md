# Development Guide

This guide covers setting up a development environment, coding standards, testing, and contribution guidelines for termag-next.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Debugging](#debugging)
- [Build Process](#build-process)
- [Deployment](#deployment)

## Prerequisites

- **Node.js**: >= 20.x
- **npm**: >= 9.x
- **Docker**: >= 20.x (for containerized development)
- **Git**: >= 2.x
- **tmux**: (for agent functionality)

## Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/yeutterg/termag-next.git
cd termag-next
npm install
```

### 2. Environment Configuration

```bash
cp .env.example apps/web/.env.local
```

Edit `apps/web/.env.local` with your development settings:

```env
DATABASE_URL="file:./dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="dev-secret-change-in-production"
TERMAG_TRUSTED_USER_EMAIL="dev@example.com"
TERMAG_ROOTS='{"local":"~/Projects"}'
TERMAG_TRUSTED_NETWORK="true"
```

### 3. Database Setup

```bash
npm run db:generate
npm run db:migrate
```

### 4. Start Development Server

```bash
npm run dev
```

The web app will be available at `http://localhost:3000`.

### 5. Start Agent (Optional)

In a separate terminal:

```bash
export TERMAG_URL=ws://localhost:3000/api/ws/agent
export TERMAG_AGENT_TOKEN=<token-from-web-ui>
export TERMAG_AGENT_ROOTS='{"local":"~/Projects"}'
cargo run --manifest-path apps/agent-rs/Cargo.toml
```

## Project Structure

```
termag-next/
├── apps/
│   ├── web/                 # Next.js web application
│   │   ├── app/            # Next.js app directory
│   │   ├── components/     # React components
│   │   ├── lib/            # Utility libraries
│   │   ├── prisma/         # Database schema and migrations
│   │   ├── server/         # Custom server and WebSocket broker
│   │   └── public/         # Static assets
│   └── agent/              # Laptop agent
│       ├── src/            # Agent source code
│       └── dist/           # Compiled JavaScript
├── infra/                  # Infrastructure configuration
│   ├── docker-compose.yml
│   └── Caddyfile
├── docs/                   # Documentation
├── .eslintrc.json         # ESLint configuration
├── .prettierrc            # Prettier configuration
├── package.json           # Root package.json
└── tsconfig.base.json     # Base TypeScript configuration
```

## Coding Standards

### Code Style

We use ESLint and Prettier for code formatting and linting:

```bash
# Check code style
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

### TypeScript Guidelines

- Use TypeScript for all new code
- Avoid `any` types - use `unknown` or proper typing
- Enable strict mode in tsconfig.json
- Use interfaces for object shapes, types for unions/primitives

### React Guidelines

- Use functional components with hooks
- Follow React best practices
- Use TypeScript for props typing
- Keep components focused and small

### Naming Conventions

- **Files**: kebab-case (`my-component.tsx`)
- **Components**: PascalCase (`MyComponent`)
- **Functions/Variables**: camelCase (`myFunction`)
- **Constants**: UPPER_SNAKE_CASE (`MY_CONSTANT`)
- **Types/Interfaces**: PascalCase (`MyType`)

### Git Commit Messages

Follow conventional commits format:

```
type(scope): subject

body

footer
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

Example:

```
feat(web): add health check endpoint with detailed status

- Added memory usage tracking
- Added database latency monitoring
- Added structured logging for health checks

Closes #123
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage
```

### Writing Tests

- Use Jest for unit tests
- Use React Testing Library for component tests
- Test files should be co-located with source files or in `__tests__` directories
- Name test files: `*.test.ts` or `*.spec.ts`

### Test Structure

```typescript
describe("MyComponent", () => {
  beforeEach(() => {
    // Setup
  });

  it("should render correctly", () => {
    // Test
  });

  afterEach(() => {
    // Cleanup
  });
});
```

## Debugging

### VS Code Debugging

Create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Next.js: debug server-side",
      "program": "${workspaceFolder}/node_modules/.bin/next",
      "args": ["dev"],
      "cwd": "${workspaceFolder}/apps/web"
    }
  ]
}
```

### Browser Debugging

- Use Chrome DevTools for React component debugging
- Install React DevTools extension
- Use the browser's network tab for API debugging

### Logging

The project uses Winston for structured logging:

```typescript
import logger from "@/lib/logger";

logger.info("User logged in", { userId: "123" });
logger.error("Database connection failed", { error });
logger.debug("Debug information", { data });
```

## Build Process

### Development Build

```bash
npm run dev
```

### Production Build

```bash
npm run build
```

### Build Verification

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Format check
npm run format:check
```

## Deployment

### Docker Deployment

```bash
cd infra
docker compose up -d --build
```

### Environment Variables

Key environment variables for production:

- `DATABASE_URL`: Production database connection
- `NEXTAUTH_URL`: Public URL of the application
- `NEXTAUTH_SECRET`: Secret for NextAuth session signing
- `TERMAG_TRUSTED_NETWORK`: Set to `false` for OAuth
- `GOOGLE_CLIENT_ID`: Google OAuth client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `TERMAG_ALLOWED_EMAIL`: Allowed email for OAuth

### Monitoring

Check application health:

```bash
curl http://localhost:3000/api/health
```

## Troubleshooting

### Common Issues

**Port already in use**

```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

**Database migration issues**

```bash
# Reset database (WARNING: deletes data)
rm apps/web/prisma/dev.db
npm run db:migrate
```

**TypeScript errors**

```bash
# Regenerate TypeScript types
npm run db:generate
```

## Getting Help

- Check existing [GitHub Issues](https://github.com/yeutterg/termag-next/issues)
- Review [AGENTS.md](./AGENTS.md) for project-specific guidelines
- Consult the main [README.md](./README.md) for usage documentation
