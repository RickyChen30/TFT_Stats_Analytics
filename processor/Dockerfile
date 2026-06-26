# Build context must be the repository root (shares common/ and gen/):
#   docker build -f processor/Dockerfile -t tft-processor .
FROM python:3.11-slim
WORKDIR /app
COPY processor/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY gen ./gen
COPY common ./common
COPY processor ./processor
ENV PROTO_DIR=/app/gen/python PYTHONUNBUFFERED=1
CMD ["python", "-m", "processor.main"]
