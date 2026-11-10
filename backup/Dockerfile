# The nightly backup job (backup.sh). pg_dump must be at least the server's major version: production runs
# Postgres 18 (Railway's postgres-ssl:18 image).
FROM docker.io/library/postgres:18-alpine
RUN apk add --no-cache bash coreutils rclone
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
