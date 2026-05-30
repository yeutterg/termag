# Contributing to termag-next

Thank you for your interest in contributing to termag-next! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on what is best for the community
- Show empathy towards other community members

## Getting Started

### Prerequisites

- Node.js >= 20.x
- npm >= 9.x
- Docker >= 20.x (for containerized development)
- Git

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/your-username/termag-next.git
   cd termag-next
   ```
3. Add the upstream remote:
   ```bash
   git remote add upstream https://github.com/yeutterg/termag-next.git
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Set up environment variables:
   ```bash
   cp .env.example apps/web/.env.local
   # Edit apps/web/.env.local with your settings
   ```
6. Set up the database:
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

## Development Workflow

### Branch Strategy

- `main`/`master`: Production-ready code
- `develop`: Development branch for next release
- `feature/*`: Feature branches
- `bugfix/*`: Bug fix branches
- `hotfix/*`: Urgent production fixes

### Creating a Branch

```bash
git checkout develop
git pull upstream develop
git checkout -b feature/your-feature-name
```

### Making Changes

1. Make your changes following coding standards
2. Add tests for new functionality
3. Update documentation as needed
4. Run linting and formatting:
   ```bash
   npm run lint:fix
   npm run format
   ```
5. Run tests:
   ```bash
   npm test
   ```
6. Run type checking:
   ```bash
   npm run typecheck
   ```

### Committing Changes

Follow conventional commits format:

```
type(scope): subject

body

footer
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**

```
feat(web): add session recording feature

- Added recording controls to UI
- Implemented recording storage
- Added playback functionality

Closes #123
```

```
fix(agent): resolve memory leak in WebSocket handler

- Fixed unclosed connections
- Added proper cleanup on disconnect

Fixes #456
```

## Pull Request Process

### Before Submitting

1. Update documentation
2. Add/update tests
3. Ensure all tests pass
4. Run linting and type checking
5. Sync with upstream:
   ```bash
   git fetch upstream
   git rebase upstream/develop
   ```

### Submitting a PR

1. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```
2. Create a pull request on GitHub
3. Fill in the PR template:
   - Describe your changes
   - Link related issues
   - Add screenshots if applicable
   - List breaking changes

### PR Review Process

1. Automated checks must pass
2. At least one maintainer approval required
3. Address review feedback
4. Keep PRs focused and small

### After Merge

1. Delete your feature branch
2. Update your local develop branch:
   ```bash
   git checkout develop
   git pull upstream develop
   ```

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Avoid `any` types
- Use proper typing for all functions and variables
- Enable strict mode in tsconfig.json

### React

- Use functional components with hooks
- Follow React best practices
- Use TypeScript for props
- Keep components small and focused

### Code Style

- Follow ESLint rules (auto-fixed on pre-commit)
- Follow Prettier formatting (auto-fixed on pre-commit)
- Use meaningful variable and function names
- Add comments for complex logic

### File Organization

- Keep related files together
- Use clear, descriptive filenames
- Follow existing directory structure
- Add index files for cleaner imports

### Security

- Never commit secrets or API keys
- Validate all user inputs
- Use parameterized queries
- Follow security best practices

## Testing Guidelines

### Writing Tests

- Write tests for all new features
- Update tests for bug fixes
- Aim for high code coverage
- Test edge cases and error conditions

### Test Structure

```typescript
describe("FeatureName", () => {
  beforeEach(() => {
    // Setup
  });

  it("should do something specific", () => {
    // Arrange
    // Act
    // Assert
  });

  afterEach(() => {
    // Cleanup
  });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage
```

## Documentation

### When to Update Documentation

- Adding new features
- Changing existing functionality
- Updating configuration
- Modifying APIs

### Documentation Files

- `README.md`: Main project documentation
- `DEVELOPMENT.md`: Development guide
- `docs/TROUBLESHOOTING.md`: Troubleshooting guide
- `docs/ENVIRONMENT_VARIABLES.md`: Environment variables reference
- Inline code comments: Complex logic explanations

### Documentation Style

- Use clear, concise language
- Include examples where helpful
- Keep documentation up to date
- Use consistent formatting

## Reporting Issues

### Before Reporting

1. Search existing issues
2. Check documentation
3. Try to reproduce the issue

### Issue Report Template

```markdown
**Description**
A clear description of what the issue is.

**Reproduction Steps**

1. Step one
2. Step two
3. Step three

**Expected Behavior**
What you expected to happen.

**Actual Behavior**
What actually happened.

**Environment**

- OS: [e.g., macOS, Linux]
- Node.js version: [e.g., 20.x]
- termag-next version: [e.g., 0.1.0]

**Additional Context**
Add any other context about the problem here.
```

### Feature Requests

Use the same template but focus on:

- What problem this feature solves
- Why it's needed
- Proposed implementation approach
- Alternative solutions considered

## Getting Help

- Check existing documentation
- Search GitHub issues
- Ask questions in GitHub discussions
- Contact maintainers for security issues

## Recognition

Contributors will be recognized in:

- CONTRIBUTORS.md file
- Release notes
- Project documentation

Thank you for contributing to termag-next!
