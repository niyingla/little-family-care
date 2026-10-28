#!/usr/bin/env bash
set -euo pipefail

# 续期成功后先检查完整配置，证书异常时保留现有Nginx进程。
/usr/sbin/nginx -t -c /etc/little-family-care/nginx.conf
/bin/systemctl reload little-family-care-proxy.service
