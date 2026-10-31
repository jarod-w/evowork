#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  pnpm install
fi
pnpm build
ssh -o BatchMode=yes root@119.3.221.92 'mkdir -p /opt/evowork-console'
rsync -az --delete dist/ root@119.3.221.92:/opt/evowork-console/dist/
rsync -az server.mjs evowork-console.service root@119.3.221.92:/opt/evowork-console/
ssh -o BatchMode=yes root@119.3.221.92 'sh -s' <<'EOF'
set -eu
id evowork-proto >/dev/null 2>&1 || useradd --system --home-dir /opt/evowork-console --shell /usr/sbin/nologin evowork-proto
chown -R evowork-proto:evowork-proto /opt/evowork-console
cp /opt/evowork-console/evowork-console.service /etc/systemd/system/evowork-console.service
systemctl daemon-reload
systemctl enable --now evowork-console
systemctl restart evowork-console
if command -v ufw >/dev/null 2>&1 && ufw status | head -n 1 | grep -q active; then
  ufw allow 8888/tcp
fi
EOF
