"""Configuration settings for AI service."""
from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# The places this service may run. ENVIRONMENT has no default and must be exactly one of these.
ENVIRONMENTS = ("development", "test", "production")


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # hide_input_in_errors: a failed load names the field, never the values, which are secrets (91).
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    # Database
    DATABASE_URL: str
    DB_POOL_MAX_SIZE: int = 20
    DB_COMMAND_TIMEOUT_SECONDS: float = 60.0
    # How long a query waits for a free pooled connection before failing, instead of queueing for ever.
    DB_ACQUIRE_TIMEOUT_SECONDS: float = 10.0
    # How long a lock on one topic (app/services/locks.py) is waited for, in seconds, before the job fails and retries.
    TOPIC_LOCK_WAIT_SECONDS: float = 600.0
    # Connections that only hold those locks, apart from DB_POOL_MAX_SIZE: a lock is held for a whole job (a model call
    # included), so holders must not take the connections that interactive routes, heartbeats and ledger writes need.
    # More locked jobs at once than this wait for a free one, inside TOPIC_LOCK_WAIT_SECONDS.
    DB_LOCK_POOL_MAX_SIZE: int = 20
    # On shutdown, running jobs get this long to finish before they are cancelled and their leases released.
    JOB_SHUTDOWN_GRACE_SECONDS: float = 20.0
    # Queued file deletions (pending_file_deletions) that failed this many times raise a watchdog alert.
    FILE_DELETION_ALERT_ATTEMPTS: int = 5

    # LLM: Claude for all text generation and grading.
    # "mock" returns schema-valid placeholder output with no API calls (local dev, e2e runs).
    LLM_PROVIDER: str = "anthropic"  # anthropic, mock or replay
    # LLM_PROVIDER=replay (the workflow suite): answers come from recordings in this folder (see
    # app/services/llm/replay_provider.py). LLM_REPLAY_MISS=record calls the real model for a request
    # with no recording and stores the answer; "error" fails the call instead.
    LLM_CASSETTE_DIR: str = ""
    LLM_REPLAY_MISS: str = "error"
    # A file the workflow suite writes a provider error code into to stage an outage (WF11); empty or
    # missing means no outage. Read only by the replay provider.
    LLM_REPLAY_FAULT_FILE: str = ""
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
    # Background jobs hold at most LLM_MAX_CONCURRENCY - 1 of those slots; a student-facing call waits this long for a
    # slot, then fails with LLM_BUSY (app/services/llm/limiter.py).
    LLM_INTERACTIVE_WAIT_SECONDS: float = 20.0
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
    # Concept extraction (the knowledge graph of a topic). Empty means MODEL_TOPICS.
    MODEL_CONCEPTS: str = ""
    # Warm-up (pretest) questions. Empty means MODEL_QUIZ.
    MODEL_WARMUP: str = ""
    # Short explanations of what a recall answer missed. Empty means MODEL_NOTES.
    MODEL_GAP_EXPLAINER: str = ""
    # Cheap routing and checking calls: the answer-key support check of every generated set.
    MODEL_ROUTER: str = "claude-haiku-5-5:low"
    # The practice tutor: the words of each hint-ladder reply (the leak judge runs on MODEL_ROUTER).
    MODEL_TUTOR: str = "claude-sonnet-5-5:low"
    # Grading what a student recalls against a topic's claims (verdicts with the student's own quotes).
    MODEL_RECALL_GRADING: str = "claude-sonnet-5-5:low"
    # "Ask your materials" answers: the main model, short thinking.
    MODEL_CHAT: str = ":low"
    # Voice coach turns and drills: the fast model, short thinking. The browser does
    # speech-to-text and text-to-speech; the model only sees text.
    MODEL_VOICE: str = ":low"
    MODEL_VALIDATION: str = ""

    VOICE_MAX_TOKENS: int = 800
    # Voice transcripts (what a student said out loud) are deleted after this many days; evidence events stay.
    # 0 keeps them. The purge runs every VOICE_RETENTION_INTERVAL_SECONDS (0 = off; POST /voice/retention still works).
    VOICE_RETENTION_DAYS: int = 180
    VOICE_RETENTION_INTERVAL_SECONDS: float = 86400.0

    # PR 1.6 behaviour flags, all off by default.
    # 99: a hint or reply whose only match with an answer is a number word ("pick any two items" for 2) goes to a leak
    # judge instead of being dropped (app/services/tutor/leak.py). A numeral or the exact answer text stays a hard leak.
    LEAK_WORD_FORMS_TO_JUDGE: bool = False
    # 102: a generated set left under its floor is regenerated once for the missing items instead of failing the job
    # (app/services/content_generator/refill.py).
    SUPPORT_REFILL: bool = False
    # F0: the requote_concepts job gives a concept with no claims new ones from the topic's remaining files, keeping its
    # id (app/services/concepts/requote.py). Off: the job completes without a model call.
    CLAIM_REQUOTE: bool = False

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

    # Areas that use the audited prompts (app/prompt_revision.py): "generation,tutor" or "all".
    # Empty keeps every area on its earlier prompts.
    PROMPTS_V2: str = ""

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

    # The exam guard's meaning check (app/services/exam_guard.py): a small multilingual model, so a mock exam question
    # reworded or translated is still recognised. Cosine at or above the threshold declines. Calibrated 2026-11-02 on
    # paraphrases and Spanish/French/German translations of exam questions (lowest 0.69) against concept questions on
    # the same topics (highest 0.59); see evals/tutoring and tests/test_exam_guard.py.
    EXAM_GUARD_EMBEDDING_MODEL: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    EXAM_GUARD_SEMANTIC_THRESHOLD: float = 0.65

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
    # Jobs that wait for AI instead of failing (exam grading: the answers are the student's work)
    # wait at most this long, then fail with the reason they were waiting for.
    JOB_AI_WAIT_MAX_SECONDS: float = 7 * 24 * 3600.0
    # How soon the reaper may look again at a job waiting for the AI (not the allowance, which
    # waits for its reset). The e2e stack sets it low so a spec's outage ends in seconds.
    JOB_AI_WAIT_RECHECK_SECONDS: float = 30.0
    # Most a user's LLM-backed jobs and chat answers may cost per UTC day, from the stored
    # costs. 0 turns the cap off (development and test only: production refuses to start at 0).
    DAILY_LLM_BUDGET_USD: float = 8.00
    # Most ALL users together may cost per UTC day, from the same ledger. Sign-up is open and
    # the API key is shared, so this is the ceiling on the day's bill. 0 turns it off (not in production).
    GLOBAL_DAILY_LLM_BUDGET_USD: float = 40.00
    # An account under 24 hours old (by its spend_key's first_seen_at) may spend this much per UTC day instead of
    # DAILY_LLM_BUDGET_USD. 0 turns the smaller first-day allowance off (not in production).
    FIRST_DAY_LLM_BUDGET_USD: float = 4.00
    # The share of GLOBAL_DAILY_LLM_BUDGET_USD kept for accounts older than GLOBAL_RESERVE_MIN_AGE_DAYS: a younger
    # account is refused once the day's global spend reaches (1 - share) of the cap.
    GLOBAL_RESERVE_SHARE: float = 0.25
    GLOBAL_RESERVE_MIN_AGE_DAYS: float = 7.0

    # The shared AI status (app/services/ai_status.py). An "unavailable" status older than this
    # many seconds counts as unknown, so the next real call tests the provider again.
    AI_STATUS_TTL_S: float = 300.0
    # Rate limits or outages in a row (each after the SDK's own retries) that mark the AI
    # unavailable. Credit, key and configuration errors mark it at once.
    AI_STATUS_TRANSIENT_THRESHOLD: int = 3
    # Webhook (ntfy, Discord or Slack) for operator alerts: the AI going down and coming back, and everything the
    # watchdog finds (app/services/watchdog.py; the alert table is in docs/deployment/RAILWAY.md). Empty: logged only.
    OPS_ALERT_WEBHOOK_URL: str = ""
    # The same watchdog alert is sent again at most this often while its cause lasts.
    OPS_ALERT_COOLDOWN_SECONDS: float = 21600.0
    # Optional URL the watchdog GETs on every run, for an external dead-man check (healthchecks.io and the like).
    OPS_DEADMAN_URL: str = ""
    # How often the watchdog runs (from the reaper loop). 0 turns it off.
    WATCHDOG_INTERVAL_SECONDS: float = 300.0
    # Failed jobs with one error code in the last hour that make an alert.
    WATCHDOG_FAILED_JOBS_PER_HOUR: int = 5
    # Whether a nightly backup is expected (true on Railway): the watchdog then alerts when the newest is older
    # than BACKUP_MAX_AGE_HOURS, or when none has ever been recorded.
    BACKUPS_EXPECTED: bool = False
    BACKUP_MAX_AGE_HOURS: float = 36.0

    # S3-compatible bucket (Railway Buckets, AWS S3, R2, MinIO) for `s3://` material paths.
    S3_ENDPOINT: str = ""
    # The uploads bucket. Materials name their own bucket in their `s3://` path; this one is what the watchdog
    # lists for files no material points to. Empty: no orphan check.
    S3_BUCKET: str = ""
    S3_REGION: str = "auto"
    S3_ACCESS_KEY_ID: str = ""
    S3_SECRET_ACCESS_KEY: str = ""
    S3_FORCE_PATH_STYLE: bool = False
    # The weekly sweep of bucket files no material points to (watchdog.py). It ignores files younger than an hour and
    # refuses to delete when the orphans are more than STORAGE_SWEEP_MAX_SHARE of the bucket, or more than
    # STORAGE_SWEEP_MAX_FILES files: it alerts instead. While STORAGE_SWEEP_DRY_RUN is true it only reports; the
    # operator turns it off in .railway/railway.ts after reading a few reports.
    STORAGE_SWEEP_DRY_RUN: bool = True
    STORAGE_SWEEP_MAX_SHARE: float = 0.05
    STORAGE_SWEEP_MAX_FILES: int = 200

    # Where the frontend writes uploads when it has no S3 bucket (`local://` material paths).
    LOCAL_UPLOADS_DIR: str = "/data/uploads"

    # Reading uploads: the parsers run in a child process with these limits (see
    # services/document_processor/sandbox.py). A file over any limit is refused with a fixed note.
    PARSE_MEMORY_MB: int = 1536  # address space a parse may map beyond loading the parsers
    PARSE_CPU_SECONDS: int = 120  # CPU time limit of the child
    PARSE_WALL_SECONDS: int = 180  # wall-clock time before the child is killed
    PARSE_MAX_OUTPUT_MB: int = 64  # size of the child's result file
    PARSE_MAX_CONCURRENCY: int = 2  # parses running at once in this process
    PARSE_MAX_PDF_PAGES: int = 600
    PARSE_MAX_CHARS: int = 4_000_000  # extracted characters per file
    PARSE_MAX_CHUNKS: int = 4000  # chunks per file
    PARSE_MAX_ZIP_MEMBERS: int = 2000  # parts in a DOCX or PPTX
    PARSE_MAX_XML_MB: int = 300  # total uncompressed XML in a DOCX or PPTX
    PARSE_MAX_XML_RATIO: int = 200  # one XML part may not expand more than this many times

    # Service Configuration
    AI_SERVICE_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"  # Frontend URL for CORS
    # No default: a service that forgot to say where it runs must not start as a development one (SEC-L2). One of
    # ENVIRONMENTS, spelt exactly; anything else refuses to start.
    ENVIRONMENT: str
    # The shared secret between the web app and this service. Required (non-empty) when ENVIRONMENT is test or
    # production; only development may leave it empty (internal_auth.py then lets local calls through).
    AI_INTERNAL_TOKEN: str = ""

    @field_validator(
        "MODEL_NOTES", "MODEL_EXAMPLES", "MODEL_PRACTICE", "MODEL_QUIZ", "MODEL_EXAM",
        "MODEL_GRADING", "MODEL_TOPICS", "MODEL_CONCEPTS", "MODEL_WARMUP", "MODEL_GAP_EXPLAINER", "MODEL_ROUTER", "MODEL_TUTOR", "MODEL_RECALL_GRADING", "MODEL_CHAT",
        "MODEL_VOICE", "MODEL_VALIDATION",
    )
    @classmethod
    def _check_model_spec(cls, value: str) -> str:
        # Fail at startup, not on the first call, when an effort is misspelt.
        from app.model_spec import ModelChoice, parse_model_spec

        parse_model_spec(value, ModelChoice("placeholder", None))
        return value

    @field_validator("ENVIRONMENT")
    @classmethod
    def _known_environment(cls, value: str) -> str:
        if value not in ENVIRONMENTS:
            raise ValueError(f"ENVIRONMENT must be one of {', '.join(ENVIRONMENTS)}, spelt exactly")
        return value

    @model_validator(mode="after")
    def _fail_closed_outside_development(self) -> "Settings":
        # SEC-L2: a missing or odd setting must never mean "development". Test and production need the shared
        # token; production also needs the caps that stop the bill (0 turns a cap off) and the model key.
        if self.ENVIRONMENT != "development" and not self.AI_INTERNAL_TOKEN.strip():
            raise ValueError(f"AI_INTERNAL_TOKEN must be set when ENVIRONMENT={self.ENVIRONMENT}")
        if self.ENVIRONMENT == "production":
            for name in ("DAILY_LLM_BUDGET_USD", "GLOBAL_DAILY_LLM_BUDGET_USD", "FIRST_DAY_LLM_BUDGET_USD"):
                if getattr(self, name) <= 0:
                    raise ValueError(f"{name} must be above 0 when ENVIRONMENT=production (0 turns the cap off)")
            if not self.ANTHROPIC_API_KEY.strip():
                raise ValueError("ANTHROPIC_API_KEY must be set when ENVIRONMENT=production")
        return self

    @model_validator(mode="after")
    def _no_mock_model_in_production(self) -> "Settings":
        # The mock and replay providers answer with canned or recorded text and never fail a leak check: in
        # production they would hand students replies nobody reviewed, so the service refuses to start with them.
        provider = self.LLM_PROVIDER.strip().lower()
        if self.ENVIRONMENT == "production" and provider in ("mock", "replay"):
            raise ValueError(f"LLM_PROVIDER={provider} is not allowed when ENVIRONMENT=production")
        # Without a bucket the services fall back to the container's disk, which a deploy wipes: uploads would vanish
        # without an error. Refuse to start rather than lose students' files.
        if self.ENVIRONMENT == "production" and not self.S3_BUCKET.strip():
            raise ValueError("S3_BUCKET must be set when ENVIRONMENT=production (uploads would go to local disk)")
        if provider == "replay" and not self.LLM_CASSETTE_DIR.strip():
            raise ValueError("LLM_PROVIDER=replay needs LLM_CASSETTE_DIR (the folder of recordings)")
        return self

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
        """Whether text generation can run (a key is set, or the mock or replay provider is on)."""
        provider = self.LLM_PROVIDER.lower()
        return provider in ("mock", "replay") or (provider == "anthropic" and bool(self.ANTHROPIC_API_KEY))

    @property
    def voice_enabled(self) -> bool:
        """The voice coach is a Claude conversation, so it needs the LLM to be configured."""
        return self.llm_configured


# Global settings instance
settings = Settings()
