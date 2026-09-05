# AGENTS.md

## Purpose

These instructions define how AI coding agents should work in this repository.

Language models often make predictable coding mistakes. They generate plausible code quickly, but plausible is not the same as correct. The discipline must come from the process used to inspect, plan, implement, verify, and communicate changes.

These rules apply to all coding tasks unless a more specific `AGENTS.md` file exists in a subdirectory.

---

## 1. Read Before You Write

Before changing code:

- Read every file you expect to modify.
- Read related files that establish the project’s patterns.
- Check imports, dependencies, naming conventions, and existing utilities.
- Follow the codebase’s current approach instead of introducing a new one without reason.
- Do not reach for Axios when the project already uses `fetch`, or add a new library when the existing stack already solves the problem.
- When no clear pattern exists, state the uncertainty instead of guessing.

Do not skim the codebase and immediately generate a solution.

---

## 2. Think Before You Code

Define the task before writing code.

For every non-trivial task:

- State what you believe the user is asking for.
- Identify important assumptions.
- Clarify ambiguous terms through the plan or implementation notes.
- Name meaningful tradeoffs.
- Define what success looks like.

For example, do not treat “add authentication” as a complete specification. Identify whether the task means session authentication, API-key authentication, OAuth, role-based authorization, route protection, or something else.

When information is genuinely missing, do not fill the gap with plausible-looking code.

---

## 3. Prefer Simplicity

Write the smallest amount of code that correctly solves the current problem.

- Avoid premature abstraction.
- Do not design for hypothetical future requirements.
- Do not add configuration merely because a value might change someday.
- Do not add error handling for impossible states.
- Do not introduce helper layers, factories, adapters, or services without a current need.
- Prefer clear duplication over a weak abstraction when the pattern is not yet established.

A useful rule:

> If the only reason for an abstraction is “in case we need it later,” do not add it yet.

---

## 4. Make Surgical Changes

Keep every change directly tied to the task.

- Do not modify unrelated files.
- Do not reformat unrelated code.
- Match the existing code style.
- Do not rename variables, reorganize folders, or rewrite working code unless the task requires it.
- Avoid broad formatter runs that bury a small functional change inside a large diff.
- Revert “while I was here” changes.

Every changed line should be explainable by the task.

---

## 5. Define Success Criteria

Before implementation, translate vague requests into measurable outcomes.

Example:

Instead of:

> Add email validation.

Use:

> Reject missing or malformed email addresses, return HTTP 400 with a clear message, and add tests for both cases.

Success criteria should describe:

- The expected behavior
- The relevant inputs
- The expected outputs
- Important failure cases
- The verification method

For multi-step tasks, state the plan before making changes.

---

## 6. Verify the Result

The difference between code that works and code that appears to work is verification.

- Reproduce bugs before fixing them.
- When practical, write or identify a failing test first.
- Confirm that the test fails for the original problem.
- Make the smallest correction.
- Confirm that the test now passes.
- Run relevant existing tests.
- Run type checking, linting, or build checks when they apply.
- Test behavior, not trivial implementation details.

Do not claim a task is complete without evidence.

If something is difficult to test, treat that as information about the design rather than permission to skip verification.

---

## 7. Debug Systematically

When something breaks, investigate before changing code.

- Read the complete error message.
- Read the entire stack trace.
- Reproduce the issue.
- Identify the earliest incorrect state.
- Change one thing at a time.
- Re-run the same reproduction after each meaningful change.
- Distinguish the root cause from the visible symptom.

Do not hide an unexpected `null`, exception, or invalid state with a defensive check until you understand why it occurred.

A workaround is not a fix unless the task explicitly calls for a workaround.

---

## 8. Protect Dependency Hygiene

Every dependency is permanent code that the project does not control.

Before adding a dependency:

- Check whether the project already includes a suitable library.
- Check whether the language or platform standard library can solve the problem.
- Consider whether a small local implementation is clearer and safer.
- Review the package’s maintenance status, compatibility, and security implications.
- Explain why the dependency is necessary.

Prefer built-in capabilities when they are sufficient. For example, prefer `crypto.randomUUID()` over installing a UUID package when the runtime supports it.

Never add a dependency silently.

---

## 9. Communicate Clearly

After making changes, explain:

- What changed
- Why it changed
- Which files were affected
- How the result was verified
- Any remaining limitations or uncertainty

Be precise about uncertainty.

Useful:

> I verified the standard request path, but I have not confirmed that this library supports streaming responses.

Not useful:

> I think this should work.

Do not provide only a block of code without context.

---

## 10. Common Failure Modes

Watch for these patterns:

### The Kitchen Sink

A small task expands into restructuring large parts of the codebase.

**Response:** Stop and reduce the scope.

### The Wrong Abstraction

Repeated code is abstracted before the true pattern is understood.

**Response:** Allow limited duplication until the abstraction is justified.

### The Optimistic Path

Only the happy path is implemented, while realistic failures are ignored.

**Response:** Test important failure behavior and expected error responses.

### The Runaway Refactor

A focused fix cascades into unrelated changes across many files.

**Response:** Return to the original success criterion and keep only necessary changes.

### Plausible but Unverified Code

The code looks correct but has not been run, tested, or checked against the actual codebase.

**Response:** Verify before claiming completion.

---

## 11. Repository-Specific Discipline

Before starting work, inspect the repository for:

- Existing `AGENTS.md` files
- Framework and runtime versions
- Package manager and lockfiles
- Test commands
- Lint and formatting commands
- Build commands
- Environment-variable conventions
- Existing architectural boundaries
- Generated files that should not be edited manually

Use the project’s existing commands and tools rather than inventing replacements.

---

## 12. Completion Checklist

Before declaring a task complete, confirm:

- [ ] I read the relevant code before writing.
- [ ] I identified assumptions and success criteria.
- [ ] I made the smallest necessary change.
- [ ] I avoided unrelated edits.
- [ ] I did not add an unnecessary dependency.
- [ ] I reproduced the bug or verified the requested behavior.
- [ ] I ran the relevant tests or checks.
- [ ] I explained what changed and why.
- [ ] I clearly stated anything I could not verify.

---

## Final Rule

Correctness is more important than speed.

When forced to choose between producing code quickly and understanding the problem accurately, stop, investigate, and verify.
