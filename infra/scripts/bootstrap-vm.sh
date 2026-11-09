#!/usr/bin/env bash
# The first setup of a staging VM (TASK-055; ARCHITECTURE 4.82, 15.1):
# Ubuntu 24.04 LTS, run once as root (sudo); running it again changes nothing
# that is already in place.
#
#   sudo bash bootstrap-vm.sh "<public SSH key of CI's deploy user>"
#
# What it does:
#   - Docker Engine and the compose plugin from Docker's own apt repository;
#   - the user `deploy` (SSH key only, in the docker group, no password, no sudo):
#     CI deploys as it, a person reaches the stack as it;
#   - the firewall (ufw): 22, 80, 443 in, everything else closed;
#   - unattended security updates; fail2ban for SSH; SSH without passwords;
#   - time zone UTC (the product's time is Almaty's in the application, 13.3);
#   - /opt/adclub (releases, docs) for deploy; /run/adclub for decrypted secrets (tmpfs);
#   - systemd timers: adclub-backup (daily 02:30 UTC — dump + files),
#     adclub-restore-check (Sundays 04:00 UTC).
set -euo pipefail

[[ "$(id -u)" == 0 ]] || {
  echo "run as root: sudo bash $0 \"<ssh public key>\"" >&2
  exit 1
}
deploy_key="${1:-}"
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf 'bootstrap: %s\n' "$*"; }

log "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  log "Docker Engine from download.docker.com"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

log "user deploy"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
passwd -l deploy >/dev/null
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
if [[ -n "$deploy_key" ]]; then
  touch /home/deploy/.ssh/authorized_keys
  grep -qxF "$deploy_key" /home/deploy/.ssh/authorized_keys || echo "$deploy_key" >>/home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
fi

log "SSH: keys only"
install -d /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/10-adclub.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh || systemctl reload sshd || true

log "firewall: 22, 80, 443"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# Docker publishes ports past ufw's INPUT chain; only the proxy publishes any
# (80, 443) — compose.staging.yml keeps every other service internal.

log "fail2ban for SSH"
cat >/etc/fail2ban/jail.d/adclub-sshd.conf <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

log "unattended security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

log "time zone UTC"
timedatectl set-timezone UTC

log "directories"
install -d -m 755 -o deploy -g deploy /opt/adclub /opt/adclub/releases /opt/adclub/docs
# The club's documents: placeholders until the texts come (replaced without a release).
for file in "${here}/../docker/proxy/docs/"*.html; do
  [[ -e "$file" ]] || continue
  [[ -e "/opt/adclub/docs/$(basename "$file")" ]] ||
    install -m 644 -o deploy -g deploy "$file" /opt/adclub/docs/
done
# Decrypted secrets live only in memory, readable by deploy only.
cat >/etc/tmpfiles.d/adclub.conf <<'EOF'
d /run/adclub 0700 deploy deploy -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/adclub.conf

log "timers: backup daily, restore check weekly"
for unit in backup restore-check; do
  cat >"/etc/systemd/system/adclub-${unit}.service" <<EOF
[Unit]
Description=Asia Drive Club ${unit} (infra/scripts/${unit}.sh)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=deploy
Environment=ADCLUB_HOME=/opt/adclub
# A run that hangs is stopped (and counted as failed) instead of blocking the next one.
TimeoutStartSec=2h
ExecStart=/bin/bash -c 'exec /bin/bash /opt/adclub/releases/\$(cat /opt/adclub/current)/infra/scripts/${unit}.sh'
EOF
done
cat >/etc/systemd/system/adclub-backup.timer <<'EOF'
[Unit]
Description=Daily backup of the database and the files bucket

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
EOF
cat >/etc/systemd/system/adclub-restore-check.timer <<'EOF'
[Unit]
Description=Weekly restore check of the latest dump

[Timer]
OnCalendar=Sun *-*-* 04:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now adclub-backup.timer adclub-restore-check.timer

log "done. Next: the first deployment (CI's deploy-staging, or deploy.sh --sha <commit> as deploy)"
