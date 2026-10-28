"""Configuration settings for AI service."""
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    DATABASE_URL: str
    DB_POOL_MAX_SIZE: int = 20
    DB_COMMAND_TIMEOUT_SECONDS: float = 60.0

    # LLM: Claude for all text generation and grading.
    # "mock" returns schema-valid placeholder output with no API calls (local dev, e2e runs).
    LLM_PROVIDER: str = "anthropic"  # anthropic or mock
    ANTHROPIC_API_KEY: str = ""
    # The two fallback models. A purpose below with no value of its own uses the main model
    # (notes, examples, practice, quizzes, exams, chat) or the fast one (grading, topics, voice,
    # validation), each with its effort.
    ANTHROPIC_MODEL: str = "claude-opus-5-5"
    ANTHROPIC_FAST_MODEL: str = "claude-haiku-5-5"
    # Effort controls how much the model thinks; thinking tokens are billed as output.
    ANTHROPIC_EFFORT: str = "medium"
    ANTHROPIC_FAST_EFFORT: str = "low"
    LLM_TIMEOUT_SECONDS: float = 180.0
    # Retries the SDK makes itself (connection errors, 408/409, 429, 5xx) with backoff, honouring
    # the retry-after header. A call that still fails is a transient job failure and is retried
    # by the dispatcher.
    LLM_MAX_RETRIES: int = 4
    # Model calls running at once, across every job and chat answer in this process.
    LLM_MAX_CONCURRENCY: int = 4
    # The mock provider (LLM_PROVIDER=mock) takes this long per call, to look like a model.
    MOCK_LLM_LATENCY_SECONDS: float = 0.0

    # One model per purpose, "<model-id>:<effort>" (see app/services/llm/models.py for every form
    # that is accepted, and which call sites use which setting). Empty means the fallback above:
    # today's behaviour is Opus at medium effort for MODEL_NOTES, MODEL_EXAMPLES, MODEL_PRACTICE,
    # MODEL_QUIZ and MODEL_EXAM, and Haiku at low effort for MODEL_GRADING and MODEL_VALIDATION.
    # MODEL_TOPICS plans the whole course in one call and structure quality decides how good
    # every later lesson is, so it defaults to the notes model at low effort.
    MODEL_NOTES: str = ""
    MODEL_EXAMPLES: str = ""
    MODEL_PRACTICE: str = ""
    MODEL_QUIZ: str = ""
    MODEL_EXAM: str = ""
    MODEL_GRADING: str = ""
    MODEL_TOPICS: str = "claude-opus-5-5:low"
    # "Ask your materials" answers: the main model, short thinking.
    MODEL_CHAT: str = ":low"
    # Voice coach turns and drills: the fast model, short thinking. The browser does
    # speech-to-text and text-to-speech; the model only sees text.
    MODEL_VOICE: str = ":low"
    MODEL_VALIDATION: str = ""

    VOICE_MAX_TOKENS: int = 800

    # Course structure. A topic is taught from the chunks of its primary sources, in document
    # order, up to this many tokens (whole sections are kept, the rest dropped from the end).
    TOPIC_SOURCE_TOKEN_BUDGET: int = 16000
    # Chunks from content files the topic is not taught from, added as supporting excerpts.
    TOPIC_SUPPORTING_CHUNKS: int = 4
    # The course planner sends the whole outline in one call. Past this many outline tokens, this
    # many sections, or this many tokens of source (the plan lists about one topic per 3,000 and
    # must fit one answer), it plans per group of files and then fixes the order across them.
    PLANNER_MAX_OUTLINE_TOKENS: int = 120000
    PLANNER_MAX_SECTIONS_PER_CALL: int = 400
    PLANNER_MAX_SOURCE_TOKENS_PER_CALL: int = 150000
    # Syllabus or calendar text given to the planner, for ordering and unit names.
    PLANNER_SYLLABUS_TOKENS: int = 6000

    CHAT_MAX_TOKENS: int = 4000
    # Excerpts offered to the model per question, and the cosine similarity below which a chunk
    # is not offered at all. A question is shorter than a topic query, so its floor is lower
    # than retrieval's MIN_SIMILARITY. When nothing clears it the answer is "not in your
    # materials" and no model call is made.
    CHAT_TOP_K: int = 12
    CHAT_MIN_SIMILARITY: float = 0.5
    CHAT_MAX_QUESTION_CHARS: int = 2000
    # Earlier turns sent along with a question, and how much of each is kept.
    CHAT_HISTORY_TURNS: int = 6
    CHAT_HISTORY_TURN_CHARS: int = 3000

    # Embeddings. "local" runs a small ONNX model in-process (no API key, no per-call cost);
    # "openai" uses text-embedding-3-small and needs OPENAI_API_KEY.
    # The chunk column is vector(384) (EMBEDDING_DIMENSIONS in embeddings/generator.py), so only
    # 384-number models fit; after changing the model, re-embed with scripts/reembed_chunks.py.
    EMBEDDING_PROVIDER: str = "local"
    EMBEDDING_MODEL: str = "BAAI/bge-small-en-v1.5"
    EMBEDDING_CACHE_DIR: str = ""

    # OpenAI: only the optional "openai" embedding provider.
    OPENAI_API_KEY: str = ""
    OPENAI_EMBEDDING_MODEL: str = "text-embedding-3-small"

    # Processing control
    ENABLE_PROCESSING: bool = True
    AUTO_EXTRACT_TOPICS_ON_CHUNK: bool = True

    # Jobs. A job is claimed with a lease that its handler keeps extending; the reaper
    # takes over jobs whose lease ran out. 0 turns the periodic reaper off (POST /jobs/reap
    # still works).
    JOB_REAPER_INTERVAL_SECONDS: float = 60.0
    # A job still pending (never claimed) this long after creation is dispatched again, then
    # again after twice, three times this long, and so on. After JOB_MAX_REDISPATCHES
    # re-dispatches it is failed with JOB_DISPATCH_FAILED.
    JOB_PENDING_REDISPATCH_SECONDS: float = 120.0
    JOB_MAX_REDISPATCHES: int = 3
    # Most a user's LLM-backed jobs and chat answers may cost per UTC day, from the stored
    # costs. 0 turns the cap off.
    DAILY_LLM_BUDGET_USD: float = 8.00
    # Most ALL users together may cost per UTC day, from the same ledger. Sign-up is open and
    # the API key is shared, so this is the ceiling on the day's bill. 0 turns it off.
    GLOBAL_DAILY_LLM_BUDGET_USD: float = 40.00

    # S3-compatible bucket (Railway Buckets, AWS S3, R2, MinIO) for `s3://` material paths.
    S3_ENDPOINT: str = ""
    S3_REGION: str = "auto"
    S3_ACCESS_KEY_ID: str = ""
    S3_SECRET_ACCESS_KEY: str = ""
    S3_FORCE_PATH_STYLE: bool = False

    # Where the frontend writes uploads when it has no S3 bucket (`local://` material paths).
    LOCAL_UPLOADS_DIR: str = "/data/uploads"

    # Service Configuration
    AI_SERVICE_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"  # Frontend URL for CORS
    ENVIRONMENT: str = "development"
    AI_INTERNAL_TOKEN: str = ""

    @field_validator(
        "MODEL_NOTES", "MODEL_EXAMPLES", "MODEL_PRACTICE", "MODEL_QUIZ", "MODEL_EXAM",
        "MODEL_GRADING", "MODEL_TOPICS", "MODEL_CHAT", "MODEL_VOICE", "MODEL_VALIDATION",
    )
    @classmethod
    def _check_model_spec(cls, value: str) -> str:
        # Fail at startup, not on the first call, when an effort is misspelt.
        from app.model_spec import ModelChoice, parse_model_spec

        parse_model_spec(value, ModelChoice("placeholder", None))
        return value

    @property
    def is_production(self) -> bool:
        """Check if running in production."""
        return self.ENVIRONMENT == "production"

    @property
    def is_development(self) -> bool:
        """Check if running in development."""
        return self.ENVIRONMENT == "development"

    @property
    def llm_configured(self) -> bool:
        """Whether text generation can run (a key is set, or the mock provider is on)."""
        provider = self.LLM_PROVIDER.lower()
        return provider == "mock" or (provider == "anthropic" and bool(self.ANTHROPIC_API_KEY))

    @property
    def voice_enabled(self) -> bool:
        """The voice coach is a Claude conversation, so it needs the LLM to be configured."""
        return self.llm_configured


# Global settings instance
settings = Settings()
