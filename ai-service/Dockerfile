# Multi-stage build for the Python AI service

# Stage 1: install the locked dependencies with uv
FROM python:3.14-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never

COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

# Bake the local embedding model into the image so cold starts never download it.
ARG EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
RUN /opt/venv/bin/python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${EMBEDDING_MODEL}', cache_dir='/opt/models')"
# The exam guard's meaning check compares across languages with a second model (app.config EXAM_GUARD_EMBEDDING_MODEL).
# The runtime is offline (HF_HUB_OFFLINE=1), so it must be baked here too, or the check is silently off in production.
ARG EXAM_GUARD_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
RUN /opt/venv/bin/python -c "from fastembed import TextEmbedding; TextEmbedding(model_name='${EXAM_GUARD_EMBEDDING_MODEL}', cache_dir='/opt/models')"

# Same for the tokenizer the chunker counts with (tiktoken downloads its vocabulary on first use).
ENV TIKTOKEN_CACHE_DIR=/opt/tiktoken
RUN /opt/venv/bin/python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')"

# Stage 2: Runtime
FROM python:3.14-slim

WORKDIR /app

# catdoc reads legacy .doc uploads (a few hundred KB, where LibreOffice would be several hundred MB)
RUN apt-get update \
    && apt-get install -y --no-install-recommends catdoc \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app

# Copy Python dependencies and the embedding model from builder
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder --chown=app:app /opt/models /opt/models
COPY --from=builder --chown=app:app /opt/tiktoken /opt/tiktoken
ENV PATH=/opt/venv/bin:$PATH \
    EMBEDDING_CACHE_DIR=/opt/models \
    TIKTOKEN_CACHE_DIR=/opt/tiktoken \
    HF_HUB_OFFLINE=1

# Copy application code last, owned by root and read-only to the app user
COPY . .
RUN chmod 755 start.sh

USER app

# Expose port
EXPOSE 8000

# Run the application
CMD ["./start.sh"]
