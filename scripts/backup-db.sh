#!/bin/bash
# Backup SQLite database safely (works while server is running)
# Keeps last 7 days of backups + pushes to GitHub

DB_PATH="/home/girish/backend/data/portal.db"
BACKUP_DIR="/home/girish/backend/backups"
REPO_DIR="/home/girish/backend"
DATE=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="$BACKUP_DIR/portal_$DATE.db"
KEEP_DAYS=7

# Use SQLite .backup command (safe with WAL mode)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

if [ $? -eq 0 ]; then
    # Compress it
    gzip "$BACKUP_FILE"
    echo "[$(date)] Backup OK: ${BACKUP_FILE}.gz ($(du -h "${BACKUP_FILE}.gz" | cut -f1))"
else
    echo "[$(date)] Backup FAILED" >&2
    exit 1
fi

# Delete backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "portal_*.db.gz" -mtime +$KEEP_DAYS -delete
echo "[$(date)] Cleaned up backups older than $KEEP_DAYS days"

# Push to GitHub
cd "$REPO_DIR"
git add backups/*.db.gz
git commit -m "backup: db snapshot $DATE" --no-verify 2>/dev/null
if [ $? -eq 0 ]; then
    git push origin main 2>&1
    echo "[$(date)] Pushed backup to GitHub"
else
    echo "[$(date)] No changes to push"
fi
