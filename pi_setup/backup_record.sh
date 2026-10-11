#!/bin/sh
# ExecStopPost of gps-log-backup.service: note when the backup ran and whether it worked, for the
# LOGS screen (/api/backup/status). systemd sets SERVICE_RESULT and STATE_DIRECTORY.
dir=${STATE_DIRECTORY:-/var/lib/gps-log-backup}
now=$(date +%s)
echo "$now ${SERVICE_RESULT:-unknown}" > "$dir/last_run"
if [ "$SERVICE_RESULT" = success ]; then
    echo "$now" > "$dir/last_success"
fi
