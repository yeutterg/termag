#!/bin/bash

# Staging Deployment Script for termag-next
# This script deploys the application to the staging environment

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
STAGING_DIR="$PROJECT_ROOT/infra"
ENV_FILE="$STAGING_DIR/.env.staging"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== termag-next Staging Deployment ===${NC}"

# Check if staging env file exists
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}Error: Staging environment file not found at $ENV_FILE${NC}"
  echo -e "${YELLOW}Copy .env.staging.example to .env.staging and configure it${NC}"
  exit 1
fi

# Change to staging directory
cd "$STAGING_DIR"

# Load staging environment variables
set -a
source "$ENV_FILE"
set +a

# Validate required variables
if [ -z "$NEXTAUTH_SECRET" ]; then
  echo -e "${RED}Error: NEXTAUTH_SECRET is not set in staging environment${NC}"
  exit 1
fi

echo -e "${YELLOW}Building Docker images...${NC}"
docker compose -f docker-compose.staging.yml build

echo -e "${YELLOW}Stopping existing staging containers...${NC}"
docker compose -f docker-compose.staging.yml down

echo -e "${YELLOW}Starting staging containers...${NC}"
docker compose -f docker-compose.staging.yml up -d

echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
sleep 10

# Check if web service is running
if docker compose -f docker-compose.staging.yml ps web | grep -q "Up"; then
  echo -e "${GREEN}✓ Web service is running${NC}"
else
  echo -e "${RED}✗ Web service failed to start${NC}"
  docker compose -f docker-compose.staging.yml logs web
  exit 1
fi

# Check if Caddy is running
if docker compose -f docker-compose.staging.yml ps caddy | grep -q "Up"; then
  echo -e "${GREEN}✓ Caddy service is running${NC}"
else
  echo -e "${RED}✗ Caddy service failed to start${NC}"
  docker compose -f docker-compose.staging.yml logs caddy
  exit 1
fi

# Run database migrations
echo -e "${YELLOW}Running database migrations...${NC}"
docker compose -f docker-compose.staging.yml exec -T web npx prisma migrate deploy

echo -e "${GREEN}=== Staging deployment completed successfully ===${NC}"
echo -e "${GREEN}Staging URL: https://$TERMAG_HOST${NC}"
echo -e "${YELLOW}Note: If using self-signed certificates, your browser may show a warning${NC}"

# Optional: Run health check
read -p "Run health check? (y/n): " run_health
if [ "$run_health" = "y" ]; then
  echo -e "${YELLOW}Running health check...${NC}"
  sleep 5
  if curl -f "https://$TERMAG_HOST/api/health"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
  else
    echo -e "${YELLOW}⚠ Health check failed (may need authentication)${NC}"
  fi
fi

echo -e "${GREEN}=== Deployment Summary ===${NC}"
echo "Services running:"
docker compose -f docker-compose.staging.yml ps