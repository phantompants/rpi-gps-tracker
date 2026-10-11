#!/bin/bash
# Kiosk on the fbtft LCD (/dev/fb0): Xorg fbdev + Chromium started by a systemd service, no desktop.
# labwc can't draw on an fbdev-only screen, so the desktop is switched off (boot to console).
# Run from the repo folder: sudo bash pi_setup/lcd_kiosk_x.sh
set -e
APP=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=${SUDO_USER:-jp226}
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
export DEBIAN_FRONTEND=noninteractive

apt-get install -y -q xserver-xorg-core xserver-xorg-legacy xserver-xorg-video-fbdev xserver-xorg-input-libinput \
  xinit x11-xserver-utils unclutter device-tree-compiler

# LCD overlay (tft35a init through fb_ili9486)
dtc -q -@ -I dts -O dtb -o /boot/firmware/overlays/lcd35-fbtft.dtbo "$APP/pi_setup/lcd35-fbtft.dts"
sed -i 's/^dtoverlay=lcd35-drm/#dtoverlay=lcd35-drm/' /boot/firmware/config.txt
grep -q '^dtoverlay=lcd35-fbtft' /boot/firmware/config.txt || \
  printf '\n# 3.5in GPIO LCD (LCD35/tft35a): fbtft, rotate=270 for the vehicle mount (90 = flipped 180)\ndtoverlay=lcd35-fbtft,speed=16000000,rotate=270\n' >> /boot/firmware/config.txt

# X on the LCD framebuffer only; don't let it add the vc4 GPU as a second screen.
# Touch matrix matches rotate=270 (for rotate=90 use "0 -1 1 1 0 0 0 0 1").
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/99-lcd35.conf <<'EOF'
Section "ServerFlags"
    Option "AutoAddGPU" "false"
EndSection

Section "Device"
    Identifier "LCD35"
    Driver "fbdev"
    Option "fbdev" "/dev/fb0"
EndSection

Section "Screen"
    Identifier "LCD35Screen"
    Device "LCD35"
EndSection

Section "InputClass"
    Identifier "LCD35 touch"
    MatchProduct "ADS7846 Touchscreen"
    Driver "libinput"
    Option "CalibrationMatrix" "0 1 0 -1 0 1 0 0 1"
EndSection
EOF
printf 'allowed_users=anybody\nneeds_root_rights=yes\n' > /etc/X11/Xwrapper.config

install -D -m 755 -o "$USER_NAME" -g "$USER_NAME" /dev/stdin "$HOME_DIR/bin/gps-kiosk-x.sh" <<'EOF'
#!/bin/sh
# Runs inside X on the LCD: no blanking, hide the pointer, then the tracker UI full screen.
xset s off; xset s noblank; xset -dpms
unclutter -idle 1 -root &
until curl -s -o /dev/null http://localhost:8000/; do sleep 2; done
exec chromium --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run --password-store=basic \
  --disable-features=Translate --window-position=0,0 --window-size=480,320 http://localhost:8000
EOF

cat > /etc/systemd/system/gps-kiosk.service <<EOF
[Unit]
Description=GPS tracker kiosk on the 3.5in LCD
After=rpi-gps-backend.service systemd-user-sessions.service
Wants=rpi-gps-backend.service

[Service]
User=$USER_NAME
PAMName=login
TTYPath=/dev/tty7
StandardInput=tty
StandardOutput=journal
ExecStart=/usr/bin/xinit $HOME_DIR/bin/gps-kiosk-x.sh -- :0 vt7 -nolisten tcp -nocursor
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# No desktop: the kiosk service owns the screen
rm -f "$HOME_DIR/.config/autostart/rpi-gps-kiosk.desktop"
systemctl disable lightdm 2>/dev/null || true
systemctl set-default multi-user.target
systemctl daemon-reload
systemctl enable gps-kiosk
echo "Done. Reboot to start the kiosk on the LCD."
