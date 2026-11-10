# Margins

## What tests to write here

This section overrides any skill or plan that asks for a test for every change or every function.

- Write a test only for behaviour a user or another service relies on: a public function's result, an API route's contract, a parser's input and output, or a bug that really happened (name the bug in the test).
- Critical flows are covered by `frontend/tests/e2e` and `frontend/tests/workflows`; add a unit test only when the logic can break without those noticing.
- Don't test private helpers, call order on mocks, copy wording or style, what the types already enforce, plain wrappers, or the mock provider itself.
- Before adding a test, look for one that already covers the case. Extend it, or turn near-duplicates into one table, instead of adding another.
- A test that would pass even with the behaviour removed is not a test. Delete it.
- Fixtures under `frontend/tests/e2e/fixtures` and `evals/**/fixtures` are data; keep them while any test uses them.
