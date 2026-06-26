# Build context must be the repository root (shares common/ and gen/):
#   docker build -f ingestion/Dockerfile -t tft-ingestion .
FROM python:3.11-slim
WORKDIR /app
COPY ingestion/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY gen ./gen
COPY common ./common
COPY ingestion ./ingestion
ENV PROTO_DIR=/app/gen/python PYTHONUNBUFFERED=1
CMD ["python", "-m", "ingestion.main"]
