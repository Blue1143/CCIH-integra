#!/bin/sh
# Cópia de segurança do banco e dos anexos. Rode nesta pasta (deploy/), por exemplo diariamente pelo cron:
#   0 2 * * * cd /opt/ccih-integra/deploy && ./backup.sh >> backups/backup.log 2>&1
# Guarde as cópias também fora do servidor. Os anexos estão cifrados: guarde a chave separada das cópias.
set -eu
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
docker compose exec -T db pg_dump -U ccih_owner -d ccih --format=custom > "backups/ccih-$stamp.dump"
docker compose run --rm --no-deps -T --entrypoint tar api -czf - -C /app/apps/api var > "backups/anexos-$stamp.tar.gz"
# Mantém as últimas 14 cópias de cada tipo.
ls -1t backups/ccih-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
ls -1t backups/anexos-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "$stamp backup concluído"
