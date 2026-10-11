#!/bin/bash
# Set up the tracker on Raspberry Pi OS trixie (desktop, labwc). Run from the repo folder: sudo bash pi_setup/setup.sh
# Re-running is safe. Reboot afterwards for the LCD.
set -e
APP=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=${SUDO_USER:-jp226}
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -q gpsd gpsd-clients python3-venv python3-pip chromium curl device-tree-compiler

# gpsd: pick the u-blox by id (ttyACM numbers swap between boots); -n reads the GPS with no clients.
# The stock gpsd udev rules don't match the M5Stick's CH9102, so hotplug can stay on.
GPS=$(ls /dev/serial/by-id/ 2>/dev/null | grep -iE 'u-blox|gps|gnss' | head -1 || true)
cat > /etc/default/gpsd <<EOT
DEVICES="${GPS:+/dev/serial/by-id/$GPS}"
GPSD_OPTIONS="-n"
USBAUTO="true"
EOT
systemctl enable gpsd.socket gpsd.service
systemctl restart gpsd
usermod -aG dialout "$USER_NAME"

sudo -u "$USER_NAME" python3 -m venv "$APP/venv"
sudo -u "$USER_NAME" "$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"
cat > /etc/systemd/system/rpi-gps-backend.service <<EOT
[Unit]
Description=RPi GPS Tracker FastAPI Service
After=network.target gpsd.service

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$APP
ExecStart=$APP/venv/bin/python $APP/app.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOT
systemctl daemon-reload
systemctl enable rpi-gps-backend
systemctl restart rpi-gps-backend

# 3.5" LCD + kiosk: fbtft driver, Xorg on /dev/fb0 and Chromium, no desktop (see lcd_kiosk_x.sh)
bash "$APP/pi_setup/lcd_kiosk_x.sh"
echo "Done. Reboot to start the LCD. UI: http://$(hostname).local:8000"
