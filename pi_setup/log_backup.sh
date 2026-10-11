#!/bin/bash
# Copy the tracker logs to Google Drive every 3 hours (and 10 minutes after boot) with rclone.
# "copy", not "sync": deleting logs on the Pi never deletes them from Drive. Runs with no
# internet just fail and the next run catches up, so it suits Starlink coming and going.
#
# Needs an rclone remote called "gdrive" in ~/.config/rclone/rclone.conf (scope drive.file, so rclone
# can only see the files it creates). Make it on a PC with a browser:
#   rclone config create gdrive drive scope=drive.file
# then copy that [gdrive] section to the Pi's ~/.config/rclone/rclone.conf (chmod 600).
#
# Run from the repo folder: sudo bash pi_setup/log_backup.sh
# Check it: systemctl list-timers gps-log-backup; journalctl -u gps-log-backup
set -e
APP=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=${SUDO_USER:-jp226}
DEST="gdrive:JP226-GPS-Logs/$(hostname)"
# Today's CSV grows while it uploads, which fails rclone's hash check, so upload a snapshot copy
SNAP="/var/cache/gps-log-backup"

apt-get install -y -q rclone

cat > /etc/systemd/system/gps-log-backup.service <<EOF
[Unit]
Description=Copy GPS tracker logs to Google Drive
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
Nice=10
# rclone's shared Google app ID gets rate limited; its default retries ride that out, given time
TimeoutStartSec=45min
CacheDirectory=gps-log-backup
ExecStartPre=/usr/bin/cp -a --update $APP/logs/. $SNAP/
ExecStart=/usr/bin/rclone copy $SNAP $DEST --contimeout 15s --timeout 60s --stats-one-line -v
# Record each run's time and result in /var/lib/gps-log-backup for the LOGS screen
StateDirectory=gps-log-backup
ExecStopPost=/bin/sh $APP/pi_setup/backup_record.sh
EOF

cat > /etc/systemd/system/gps-log-backup.timer <<'EOF'
[Unit]
Description=Copy GPS tracker logs to Google Drive every 3 hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=3h

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now gps-log-backup.timer
echo "Backups go to $DEST"
