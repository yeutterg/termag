#!/bin/bash

# Database restore script for Terminalz
# This script restores a SQLite database from a backup

set -e

# Configuration
DB_DIR="${DB_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_FILE="${DB_FILE:-terminalz.db}"

# Function to show usage
usage() {
    echo "Usage: $0 <backup_file>"
    echo "Example: $0 terminalz.db.backup.20260805-143000.gz"
    echo "Example: $0 latest"
    exit 1
}

# Check arguments
if [ $# -eq 0 ]; then
    usage
fi

# Handle "latest" keyword
if [ "$1" = "latest" ]; then
    BACKUP_FILE=$(ls -t "$BACKUP_DIR"/${DB_FILE}.backup.*.gz 2>/dev/null | head -n1)
    if [ -z "$BACKUP_FILE" ]; then
        echo "Error: No backups found in $BACKUP_DIR"
        exit 1
    fi
    echo "Using latest backup: $(basename "$BACKUP_FILE")"
else
    BACKUP_FILE="$BACKUP_DIR/$1"
fi

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found at $BACKUP_FILE"
    exit 1
fi

# Create directory if it doesn't exist
mkdir -p "$DB_DIR"

# Confirm restore
echo "You are about to restore the database from:"
echo "  Backup: $BACKUP_FILE"
echo "  Target: $DB_DIR/$DB_FILE"
echo ""
read -p "This will REPLACE the current database. Are you sure? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "Restore cancelled"
    exit 0
fi

# Stop any running processes that might be using the database
echo "Warning: Make sure the application is stopped before restoring"
read -p "Has the application been stopped? (yes/no): " stopped_confirm

if [ "$stopped_confirm" != "yes" ]; then
    echo "Please stop the application first, then run this script again"
    exit 1
fi

# Create a backup of the current database before restoring
if [ -f "$DB_DIR/$DB_FILE" ]; then
    CURRENT_BACKUP="$BACKUP_DIR/${DB_FILE}.pre-restore.$(date +%Y%m%d-%H%M%S)"
    cp "$DB_DIR/$DB_FILE" "$CURRENT_BACKUP"
    echo "Current database backed up to: $CURRENT_BACKUP"
fi

# Extract and restore
echo "Restoring database..."
TEMP_FILE="$BACKUP_DIR/temp_restore.db"

# Decompress
gunzip -c "$BACKUP_FILE" > "$TEMP_FILE"

# Move to final location
mv "$TEMP_FILE" "$DB_DIR/$DB_FILE"

echo "Database restored successfully!"
echo "Restored from: $BACKUP_FILE"
echo "Current database: $DB_DIR/$DB_FILE"

# Run integrity check if sqlite3 is available
if command -v sqlite3 &> /dev/null; then
    echo "Running database integrity check..."
    if sqlite3 "$DB_DIR/$DB_FILE" "PRAGMA integrity_check;"; then
        echo "Integrity check passed"
    else
        echo "Warning: Integrity check failed"
    fi
fi
