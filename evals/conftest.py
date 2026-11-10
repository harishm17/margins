import os

# The app settings have no default ENVIRONMENT (SEC-L2). The evals' unit tests run as development, like
# ai-service/tests/conftest.py; CI sets the same value.
os.environ.setdefault("ENVIRONMENT", "development")
