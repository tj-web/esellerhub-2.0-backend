cd /home/ubuntu/esellerhub-2.0-backend
gsutil cp gs://${CREDS_BUCKET:-tj-creds}/config.eseller-backend.env .env
docker compose up --build -d