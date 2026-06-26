# Build context must be the repository root (shares common/ and gen/):
#   docker build -f anomaly/Dockerfile -t tft-anomaly .
FROM python:3.11-slim
WORKDIR /app
COPY anomaly/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY gen ./gen
COPY common ./common
COPY anomaly ./anomaly
ENV PROTO_DIR=/app/gen/python PYTHONUNBUFFERED=1
CMD ["python", "-m", "anomaly.main"]
