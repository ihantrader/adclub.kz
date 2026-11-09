#!/bin/sh
# The `ops` service waits for `docker compose exec`; it stops at once on SIGTERM.
trap 'exit 0' TERM INT
while :; do
  sleep 3600 &
  wait $!
done
