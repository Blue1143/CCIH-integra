#!/bin/sh
# Executado uma única vez, na criação do volume do banco: cria o papel da aplicação (só DML, sem DDL).
# As permissões nas tabelas são dadas pelo comando de migração (grantAppRole).
set -eu
: "${DB_APP_PASSWORD:?Defina DB_APP_PASSWORD}"
psql -v ON_ERROR_STOP=1 -v app_password="$DB_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE ccih_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE ccih TO ccih_app;
EOSQL
