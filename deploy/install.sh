#!/usr/bin/env bash
set -euo pipefail

# 仅安装本项目服务；运行前须确认80和3000端口不被已有业务使用。
if [ "$(id -u)" -ne 0 ]; then echo '请使用sudo运行'; exit 1; fi
task_root=/opt/little-family-care
task_source=$(cd "$(dirname "$0")/.." && pwd)
if [ "$task_source" != "$task_root/current" ]; then echo '源码目录不正确'; exit 1; fi
test -x "$task_root/runtime/node-v24.15.0-linux-x64/bin/node"

# 独立系统用户与数据目录，源码和SQLite文件不共享写权限。
id littlecare >/dev/null 2>&1 || useradd --system --home-dir /var/lib/little-family-care --shell /sbin/nologin littlecare
install -d -o littlecare -g littlecare -m 700 /var/lib/little-family-care
install -d -o littlecare -g littlecare /var/lib/little-family-care/nginx/body /var/lib/little-family-care/nginx/proxy
install -d -m 755 /etc/little-family-care /var/log/little-family-care
chown -R root:root "$task_root/current"
chmod -R go-w "$task_root/current"

# 首次启动只生成签名密钥，微信配置由本人后续安全补齐，绝不打印密钥。
if [ ! -f /etc/little-family-care.env ]; then
  install -m 600 "$task_source/deploy/env.example" /etc/little-family-care.env
  task_secret=$("$task_root/runtime/node-v24.15.0-linux-x64/bin/node" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
  sed -i "s/^SIGNING_SECRET=.*/SIGNING_SECRET=$task_secret/" /etc/little-family-care.env
fi
chmod 600 /etc/little-family-care.env
# 已经配置HTTPS的实例保留现有入口，避免后续更新退回HTTP。
if [ ! -f /etc/little-family-care/nginx.conf ]; then
  install -m 644 "$task_source/deploy/nginx.conf" /etc/little-family-care/nginx.conf
fi
install -m 644 "$task_source/deploy/little-family-care.service" /etc/systemd/system/little-family-care.service
install -m 644 "$task_source/deploy/little-family-care-proxy.service" /etc/systemd/system/little-family-care-proxy.service

# 两项服务分别受systemd管理；Nginx使用独立配置，不覆盖系统已有配置文件。
/usr/sbin/nginx -t -c /etc/little-family-care/nginx.conf
systemctl daemon-reload
systemctl enable --now little-family-care.service
systemctl enable --now little-family-care-proxy.service
curl --fail --silent --retry 6 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/health
echo
curl --fail --silent --retry 6 --retry-connrefused --retry-delay 1 http://127.0.0.1/health
echo
