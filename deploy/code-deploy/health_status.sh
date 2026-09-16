#!/bin/bash
# Logic to monitor container health
APP_CONTAINER='esellerhub-2.0-backend'
MAX_RETRIES=18
RETRY_COUNT=0

echo "------------------------------------------------"
echo "Monitoring Container Health: $APP_CONTAINER"
echo "------------------------------------------------"

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  STATUS=$(sudo docker inspect --format="{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $APP_CONTAINER 2>/dev/null || echo "notfound")
  
  echo "[$((RETRY_COUNT+1))/$MAX_RETRIES] Current Status: $STATUS"

  if [ "$STATUS" = "healthy" ]; then
    echo "✅ SUCCESS: Container is healthy."
    exit 0
  fi

  if [ "$STATUS" = "unhealthy" ]; then
    echo "❌ ERROR: Container reported UNHEALTHY."
    sudo docker inspect --format="{{json .State.Health.Log}}" $APP_CONTAINER
    exit 1
  fi
  
  HAS_HC=$(sudo docker inspect --format="{{json .State.Health}}" $APP_CONTAINER)
  if [ "$STATUS" = "running" ] && [ "$HAS_HC" = "null" ]; then
    echo "⚠️ WARNING: No healthcheck defined, but running."
    exit 0
  fi

  sleep 5
  RETRY_COUNT=$((RETRY_COUNT + 1))
done

echo "❌ TIMEOUT: Health check failed after $((MAX_RETRIES * 5)) seconds."
exit 1