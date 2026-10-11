#!/bin/bash
# Pi system settings for unattended use in the vehicle. Run: sudo bash pi_setup/system_extras.sh
#  - The clock: the Pi has no RTC, so chrony takes the time from the GPS (through gpsd) when there's
#    no internet; internet NTP is preferred when it's reachable. fake-hwclock restores the last
#    known time at boot, so the clock never starts in the past.
#  - Hardware watchdog: if the Pi locks up, the Broadcom watchdog reboots it.
set -e
export DEBIAN_FRONTEND=noninteractive

# chrony replaces systemd-timesyncd
apt-get install -y -q chrony fake-hwclock

# gpsd opens the GPS as root before dropping to the gpsd user, so it publishes the time on shared
# memory unit 0 (check with: sudo ntpshmmon -n 4). A USB GPS without PPS is good to about 0.1 s.
cat > /etc/chrony/conf.d/gps.conf <<'EOF'
# GPS time from gpsd (shared memory unit 0) for when there's no internet.
# offset: the u-blox 7's NMEA arrives ~0.06 s after the second it reports (measured with ntpshmmon).
refclock SHM 0 refid GPS precision 1e-1 offset 0.06 delay 0.2 poll 3
EOF
systemctl restart chrony

# Hardware watchdog (bcm2835 maxes out at 15 s): systemd pets it; a hang reboots the Pi
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF
systemctl daemon-reexec
echo "Clock sources:"
chronyc -n sources || true
