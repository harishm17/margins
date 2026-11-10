"""Tests for embedding generation and vector search."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.embeddings import generator
from app.services.embeddings.generator import (
    EMBEDDING_DIMENSIONS,
    LocalEmbedder,
    OpenAIEmbedder,
    embedding_text,
    generate_embeddings,
    generate_query_embedding,
    get_embedder,
    reset_embedder,
)


@pytest.fixture(autouse=True)
def _fresh_embedder():
    reset_embedder()
    yield
    reset_embedder()


class FakeTextEmbedding:
    """Stands in for fastembed.TextEmbedding: documents get 1.0s, queries 2.0s."""

    def __init__(self, *args, **kwargs):
        self.calls = []

    def embed(self, texts, batch_size=32):
        self.calls.append(("embed", list(texts), batch_size))
        for _ in texts:
            yield MagicMock(tolist=lambda: [1.0] * EMBEDDING_DIMENSIONS)

    def query_embed(self, text):
        self.calls.append(("query", text))
        yield MagicMock(tolist=lambda: [2.0] * EMBEDDING_DIMENSIONS)


class TestEmbedderSelection:
    def test_local_is_the_default(self):
        with patch.object(generator, "settings") as settings:
            settings.EMBEDDING_PROVIDER = "local"
            settings.EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
            settings.EMBEDDING_CACHE_DIR = ""
            embedder = get_embedder()
        assert isinstance(embedder, LocalEmbedder)
        assert embedder.name == "BAAI/bge-small-en-v1.5"

    def test_openai_needs_a_key(self):
        with patch.object(generator, "settings") as settings:
            settings.EMBEDDING_PROVIDER = "openai"
            settings.OPENAI_API_KEY = ""
            with pytest.raises(ValueError, match="OPENAI_API_KEY"):
                get_embedder()

    def test_unknown_provider(self):
        with patch.object(generator, "settings") as settings:
            settings.EMBEDDING_PROVIDER = "voyage"
            with pytest.raises(ValueError, match="EMBEDDING_PROVIDER"):
                get_embedder()


class TestLocalEmbedder:
    @pytest.mark.asyncio
    async def test_documents_and_queries_use_different_paths(self):
        fake = FakeTextEmbedding()
        embedder = LocalEmbedder("model")
        embedder._model = fake
        generator._embedder = embedder

        docs = await generate_embeddings(["a", "b"])
        query = await generate_query_embedding("question")

        assert docs == [[1.0] * EMBEDDING_DIMENSIONS] * 2
        assert query == [2.0] * EMBEDDING_DIMENSIONS
        assert fake.calls[0][0] == "embed" and fake.calls[1] == ("query", "question")

    @pytest.mark.asyncio
    async def test_empty_input_skips_the_model(self):
        generator._embedder = MagicMock()
        assert await generate_embeddings([]) == []
        generator._embedder.embed_documents.assert_not_called()

    def test_model_loads_once(self):
        with patch("fastembed.TextEmbedding", FakeTextEmbedding) as _:
            embedder = LocalEmbedder("model", cache_dir="/tmp/x")
            assert embedder._get_model() is embedder._get_model()


class TestOpenAIEmbedder:
    @pytest.mark.asyncio
    async def test_batches_of_100(self):
        embedder = OpenAIEmbedder("key", "text-embedding-3-small")
        create = AsyncMock(
            side_effect=lambda model, input: MagicMock(data=[MagicMock(embedding=[0.5]) for _ in input])
        )
        embedder._client = MagicMock()
        embedder._client.embeddings.create = create
        vectors = await embedder.embed_documents([str(i) for i in range(250)])
        assert len(vectors) == 250
        assert [len(call.kwargs["input"]) for call in create.call_args_list] == [100, 100, 50]


class TestEmbeddingText:
    def test_heading_comes_first_and_the_text_follows(self):
        assert embedding_text("Ch 6 > 6.2 Operant", "Rats pressed a lever.") == "Ch 6 > 6.2 Operant\n\nRats pressed a lever."

    def test_no_heading_embeds_the_text_alone(self):
        assert embedding_text(None, "Plain text") == "Plain text"
        assert embedding_text("  ", "Plain text") == "Plain text"

    def test_null_bytes_are_dropped(self):
        assert embedding_text("A\x00B", "te\x00xt") == "AB\n\ntext"


class TestVectorSize:
    @pytest.mark.asyncio
    async def test_wrong_size_documents_are_rejected(self):
        embedder = MagicMock(name="openai-like")
        embedder.name = "text-embedding-3-small"
        embedder.embed_documents = AsyncMock(return_value=[[0.1] * 1536])
        generator._embedder = embedder
        with pytest.raises(ValueError, match=r"vector\(384\)"):
            await generate_embeddings(["a"])

    @pytest.mark.asyncio
    async def test_wrong_size_queries_are_rejected(self):
        embedder = MagicMock()
        embedder.name = "x"
        embedder.embed_query = AsyncMock(return_value=[0.1] * 10)
        generator._embedder = embedder
        with pytest.raises(ValueError, match="10-number"):
            await generate_query_embedding("q")
