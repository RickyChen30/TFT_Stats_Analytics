# Build context must be the repository root (shares common/ and gen/):
#   docker build -f api/Dockerfile -t tft-api .
FROM python:3.11-slim
WORKDIR /app
COPY api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY gen ./gen
COPY common ./common
COPY api ./api
ENV PROTO_DIR=/app/gen/python PYTHONUNBUFFERED=1 API_PORT=8000
EXPOSE 8000
CMD ["python", "-m", "api.main"]
