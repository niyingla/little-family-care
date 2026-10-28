#!/usr/bin/env bash
set -euo pipefail

# 只接受完整域名，禁止将路径、端口或替换表达式带入Nginx配置。
if [ "$(id -u)" -ne 0 ]; then echo '请使用sudo运行'; exit 1; fi
task_domain=${1:-}
task_domain=${task_domain,,}
if [[ ! "$task_domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || [ "${#task_domain}" -gt 253 ]; then
  echo '请传入合法域名，不包含协议、端口或路径'; exit 1
fi
task_source=$(cd "$(dirname "$0")/.." && pwd)
if [ "$task_source" != /opt/little-family-care/current ]; then echo '源码目录不正确'; exit 1; fi
command -v certbot >/dev/null
test -f /etc/little-family-care/nginx.conf
test -f /etc/little-family-care.env

# 配置修改前备份；失败回退入口与私有配置，不打印任何密钥。
task_backup=/etc/little-family-care/https-backup-$(date +%s)
install -d -m 700 "$task_backup"
cp -p /etc/little-family-care/nginx.conf "$task_backup/nginx.conf"
cp -p /etc/little-family-care.env "$task_backup/application.env"
rollback() {
  trap - ERR
  cp -p "$task_backup/nginx.conf" /etc/little-family-care/nginx.conf
  cp -p "$task_backup/application.env" /etc/little-family-care.env
  /usr/sbin/nginx -t -c /etc/little-family-care/nginx.conf && systemctl reload little-family-care-proxy.service
  systemctl restart little-family-care.service
  echo 'HTTPS配置未完成，已恢复之前的服务配置' >&2
}
trap rollback ERR

# HTTP挑战路径独立于家庭接口，不需要停掉API或向公网暴露数据库。
install -d -m 755 /var/lib/little-family-care/acme/.well-known/acme-challenge
if [ ! -f "/etc/letsencrypt/live/$task_domain/fullchain.pem" ]; then
  install -m 644 "$task_source/deploy/nginx.conf" /etc/little-family-care/nginx.conf
  /usr/sbin/nginx -t -c /etc/little-family-care/nginx.conf
  systemctl reload little-family-care-proxy.service
fi
certbot certonly --webroot -w /var/lib/little-family-care/acme -d "$task_domain" \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --keep-until-expiring --preferred-challenges http --key-type rsa --rsa-key-size 2048

# 先检验待发布配置，再原子替换并平滑重载完整证书链。
sed "s/__DOMAIN__/$task_domain/g" "$task_source/deploy/nginx-https.conf.example" > /etc/little-family-care/nginx.conf.next
chmod 644 /etc/little-family-care/nginx.conf.next
/usr/sbin/nginx -t -c /etc/little-family-care/nginx.conf.next
mv /etc/little-family-care/nginx.conf.next /etc/little-family-care/nginx.conf
systemctl reload little-family-care-proxy.service
sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=https://$task_domain|" /etc/little-family-care.env
systemctl restart little-family-care.service

# 持久定时器每天检查两次；只有实际续期成功后才重新加载证书。
install -m 755 "$task_source/deploy/renew-certificate-hook.sh" /etc/little-family-care/renew-certificate-hook.sh
install -m 644 "$task_source/deploy/little-family-care-cert-renew.service" /etc/systemd/system/little-family-care-cert-renew.service
install -m 644 "$task_source/deploy/little-family-care-cert-renew.timer" /etc/systemd/system/little-family-care-cert-renew.timer
systemctl daemon-reload
systemctl enable --now little-family-care-cert-renew.timer
curl --fail --silent --show-error --retry 6 --retry-connrefused --retry-delay 1 \
  --connect-timeout 5 --max-time 10 --resolve "$task_domain:443:127.0.0.1" "https://$task_domain/health"
echo
trap - ERR
echo 'HTTPS入口及证书自动续期已配置'
