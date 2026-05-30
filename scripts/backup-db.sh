#!/bin/bash

# Database Backup Script for termag-next
# This script creates timestamped backups of the SQLite database

set -e

# Configuration
DB_DIR="${DB_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_FILE="${DB_FILE:-termag.db}"
RETENTION_DAYS=${RETENTION_DAYS:-7}

# Create directories if they don't exist
mkdir -p "$DB_DIR"
mkdir -p "$BACKUP_DIR"

# Generate timestamp
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_FILE="$BACKUP_DIR/${DB_FILE}.backup.$TIMESTAMP"
COMPRESSED_FILE="$BACKUP_FILE.gz"

echo "Starting database backup..."
echo "Database: $DB_DIR/$DB_FILE"
echo "Backup: $COMPRESSED_FILE"

# Check if database file exists
if [ ! -f "$DB_DIR/$DB_FILE" ]; then
    echo "Error: Database file not found at $DB_DIR/$DB_FILE"
    exit 1
fi

# Create backup
if command -v sqlite3 &> /dev/null; then
    # Use sqlite3 backup command for consistency
    sqlite3 "$DB_DIR/$DB_FILE" ".backup '$BACKUP_FILE'"
    echo "SQLite backup created successfully"
else
    # Fallback to file copy
    cp "$DB_DIR/$DB_FILE" "$BACKUP_FILE"
    echo "File copy backup created"
fi

# Compress backup
gzip "$BACKUP_FILE"
echo "Backup compressed: $COMPRESSED_FILE"

# Get file size
SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)
echo "Backup size: $SIZE"

# Clean up old backups
echo "Cleaning up backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "${DB_FILE}.backup.*.gz" -mtime +$RETENTION_DAYS -delete

# List remaining backups
echo "Current backups:"
ls -lh "$BACKUP_DIR"/${DB_FILE}.backup.*.gz 2>/dev/null || echo "No backups found"

echo "Backup completed successfully!"