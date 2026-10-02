# Behavior Rules (SafeSight)
- Address the operator as "anh" and refer to yourself as "em".
- Read relevant project context before making code changes.
- Do not revert user changes unless explicitly requested.
- Do not git push, deploy across environments, run migrations, restart unrelated services, or change production config without explicit approval.
- Prefer structured APIs, parsers, and existing project patterns over ad hoc rewrites.
- When a requested deliverable is actionable but leaves style or implementation details open, choose a sensible default and proceed. Do not ask the operator to choose between style options unless the choice is genuinely blocking, risky, or changes the product contract.

# Coding Behavior Guidelines (Karpathy)
- Think before coding: state assumptions; ask if ambiguous; surface tradeoffs.
- Simplicity first: minimal code; no speculative features; no needless abstractions.
- Surgical changes: touch only requested scope; no drive-by refactors; match style.
- Goal-driven execution: define success criteria; verify with tests/checks.

# Mandatory Workflow Rules
1. Always use Superpowers before any code, review, debug, or feature-build task.
   At the start of EVERY task, state which skills were checked and which is being
   used, or say plainly why none applies. Reading documentation, gathering
   context and "small" mechanical fixes all count as tasks. A task arriving as a
   follow-up in an ongoing conversation is still a new task: re-check, do not
   coast on momentum.
2. Every task must start with scope audit: objective, files likely to be touched, risks, rollback plan.
3. All features must be implemented in dev first. Never edit production directly.
4. Production must run only prebuilt build/image artifacts. Do not copy source to prod to edit live.
5. Prod workflow is mandatory: change in dev → test dev → build prod image/artifact → deploy prod artifact/image.
6. After implementation, review the actual diff/change before claiming done.
7. Run 2 stress-test rounds before reporting completion.
8. If UI is involved, each stress-test round must include desktop and mobile checks.
9. UI must keep dark/light mode consistent, no page-level horizontal overflow, no text overlap, and smooth primary actions.
10. No broad refactor, no unnecessary abstraction, and no out-of-scope file edits.
11. Never regress existing functionality. Before claiming any task complete,
    verify that every previously working feature still works. A change that adds
    something new but removes, disables, or breaks something that already worked
    is a regression, not a completion — report it instead of shipping it. Name
    the specific behaviors checked and the evidence; "nothing else should be
    affected" is an assumption, not a verification. If a regression is genuinely
    unavoidable, say so and get approval before proceeding.

# Ponytail Rulepack
- Skip: Do not build code that does not need to exist.
- Reuse local: Prefer existing helpers, components, patterns, and project conventions.
- Use framework/stdlib: Prefer the current framework or standard library before custom code.
- Use native platform: Prefer browser, shell, database, OS, or runtime primitives when they fit.
- Use installed dependency: Prefer an already-installed dependency before adding anything new.
- Smallest safe change: Keep edits inside the smallest local module boundary that solves the task.
- Add a new abstraction only when it removes real complexity or matches an existing pattern.
- Add a new dependency only with explicit reason, scope, and verification.
- Do not add speculative features.
- Do not rewrite working code just to make it look cleaner.
- Do not remove validation, RBAC, audit, error handling, accessibility, tests, or verification to reduce code size.
- In the final report, state what was reused, whether dependencies were avoided, why the change is the smallest safe one, and what verification ran.

# Superpowers Workflow
- Installed as a Codex plugin under ~/.codex. Current location:
  `~/.codex/plugins/cache/openai-curated-remote/superpowers/<version>/skills`
  (version dir changes on upgrade; 6.3.0 at time of writing).
- Invoke through the Skill tool as `superpowers:<name>`. Do not guess names.
- Available skills: brainstorming, writing-plans, executing-plans,
  systematic-debugging, test-driven-development, verification-before-completion,
  requesting-code-review, receiving-code-review, subagent-driven-development,
  dispatching-parallel-agents, using-git-worktrees,
  finishing-a-development-branch, writing-skills, using-superpowers.
- Routing:
  - Any bug, test failure or unexpected behavior → `systematic-debugging`
    BEFORE proposing a fix. This includes failures you believe are pre-existing.
  - New feature, or any change to behavior or UI → `brainstorming`, then
    `writing-plans`.
  - About to claim done, or about to commit → `verification-before-completion`.
  - Code review → `requesting-code-review`, `receiving-code-review`.
  - Branch cleanup, merges, worktrees → `finishing-a-development-branch`,
    `using-git-worktrees`.

# Design Rules (Frontend & UI/UX)
When doing frontend, UI, UX, visual design, landing pages, dashboards, apps, games, or any user-facing interface work:
- Treat DESIGN.md as the project's visual identity source of truth.
- Follow the google-labs-code/design.md format: https://github.com/google-labs-code/design.md
- If a DESIGN.md exists in or above the project, read it before designing or editing UI. Follow its YAML design tokens and markdown rationale.
- If no DESIGN.md exists and the task creates or materially changes UI, create a concise DESIGN.md first unless the user explicitly asks for a one-off throwaway change.
- Keep DESIGN.md as a plain-text source of truth with optional YAML front matter for tokens and markdown prose for rationale.
- Use specific tokens and rationale for color, typography, spacing, radius, elevation, components, motion, responsive behavior, and accessibility.
- Prefer polished, usable interfaces: clear hierarchy, strong spacing discipline, coherent color contrast, responsive layouts, keyboard/focus states, empty/loading/error states, and text that fits.
- Avoid generic templates, decorative clutter, one-note palettes, fragile viewport-only sizing, overlapping UI, and unexplained design choices.
- After UI work, verify the rendered result when practical with screenshots or browser checks, especially on desktop and mobile widths.

# Coding Convention & Design Principles

## English-Only Code Identifiers

All code identifiers **MUST** use English only.

This applies to:

- File and directory names
- Functions and methods
- Variables and constants
- Classes and interfaces
- Types, enums, and type parameters
- Database fields and persisted properties
- Request/response fields
- Route parameters
- Event names
- Configuration keys
- Environment variable names
- Service, repository, and domain object names
- Test identifiers and fixtures

Do not introduce Vietnamese words, Vietnamese diacritics, or Vietnamese transliterations into code identifiers or **API** contracts.

Vietnamese is allowed only for:

- User-facing copy
- Localization resources
- Project documentation intended for Vietnamese stakeholders
- Comments, docstrings, and commit messages, where the project's existing convention requires Vietnamese

Do not rename existing public APIs, persisted fields, database columns, or established identifiers solely to enforce this rule. Existing identifiers are considered legacy and should be migrated only through a dedicated task with an explicit backward-compatible migration plan and owner approval.

## Object-Oriented Design

Use Object-Oriented Programming (**OOP**) when it provides a clear benefit to the domain or reduces complexity.

Prefer:

- Encapsulation of state and behavior
- Clear class responsibilities
- Small, cohesive classes
- Explicit interfaces for replaceable or externally dependent behavior
- Composition over inheritance when composition is simpler
- Dependency injection for dependencies that need to be replaced, tested, or isolated
- Immutable/value objects where appropriate

Do not introduce classes merely to follow an OOP style. Simple data transformations, stateless utilities, framework-native patterns, and straightforward procedural code should remain simple when **OOP** would add unnecessary complexity.

## **SOLID** Principles

Apply **SOLID** principles pragmatically to production code.

- Single Responsibility Principle (**SRP**): Each class/module should have one clear responsibility and one primary reason to change.
- Open/Closed Principle (**OCP**): Design stable components so new supported behavior can be added without repeatedly modifying fragile core logic when practical.
- Liskov Substitution Principle (**LSP**): Implementations of an abstraction must remain substitutable for that abstraction without violating its expected behavior.
- Interface Segregation Principle (**ISP**): Prefer small, focused interfaces over large interfaces containing unrelated responsibilities.
- Dependency Inversion Principle (**DIP**): High-level business logic should depend on stable abstractions rather than concrete infrastructure details when the dependency needs to be replaceable or isolated.

**SOLID** is a design guideline, not a requirement to create abstractions everywhere. Do not introduce interfaces, base classes, factories, or dependency layers without a concrete design benefit.

## Design Patterns

Use established design patterns when they solve a real, recurring design problem and make the code easier to understand, test, extend, or maintain.

Patterns may include, where appropriate:

- Strategy
- Factory / Abstract Factory
- Adapter
- Repository
- Dependency Injection
- Observer / Event-driven patterns
- Command
- State
- Decorator
- Builder

Before introducing a pattern, identify the problem it solves and verify that the pattern is simpler than the direct implementation.

Do not use design patterns for the sake of using design patterns. A simple implementation is preferred when it adequately solves the requirement.

## Design & Implementation Rules

For every non-trivial implementation:

- Prefer the simplest design that satisfies the requirement.
- Keep responsibilities cohesive and boundaries explicit.
- Prefer composition over inheritance unless inheritance represents a genuine domain relationship.
- Depend on abstractions only where substitution, testing, or decoupling provides real value.
- Reuse existing project architecture, components, services, utilities, and patterns before introducing new ones.
- Follow the existing framework's idiomatic architecture instead of creating parallel abstractions.
- Avoid God classes, God services, deep inheritance hierarchies, circular dependencies, and unnecessary abstraction layers.
- Keep business logic independent from infrastructure concerns when practical.
- Keep domain rules testable without requiring unnecessary external infrastructure.
- Do not introduce a design pattern, abstraction, class, interface, or dependency unless its purpose and benefit are clear.

## Existing Code

Do not refactor existing working code solely to make it conform to these principles.

When working in an existing module:

- Preserve established behavior.
- Reuse existing abstractions and conventions.
- Do not rename legacy identifiers merely because they are not English.
- Do not introduce a new architectural pattern when the existing pattern already solves the problem.
- If existing code violates these principles, fix it only when it is within the requested scope or create a separate refactoring task.

## Code Quality Standard

Code should be:

- Readable
- Maintainable
- Testable
- Cohesive
- Loosely coupled where appropriate
- Explicit rather than unnecessarily clever
- Consistent with the existing project architecture

The goal is clean, maintainable, production-quality code, not maximum abstraction.

Every implementation should balance:

**Simplicity → Cohesion → Testability → Extensibility**

in that order, unless the project's domain requirements clearly justify a different tradeoff.

## Verifying your work

- Build: make build (must finish with "Build succeeded")
- Test: make test (all green; never skip or delete a failing test)
- Lint: make lint (zero warnings)

Run all three before reporting any task complete, and paste the output.
If a test fails, fix the code, not the test.

# Project Workflow (AGENTS.md)
See @AGENTS.md for mandatory project workflow rules including:
- Scope audit requirements
- Development workflow (dev → validation → build → deploy)
- Verification and stress testing rules
- Changelog and documentation requirements

See @RULES.md and @WORKFLOW.md for mandatory project workflow rules.

---

<hard_rules>
L1. BEFORE creating a new file → review the final checklist in rules/core/file-creation.md (F-rules) · ~/.codex/rules/core/file-creation.md
L3. NEVER create files named `.bak`, `.old`, `.orig`, `-v2`, `-v3`, `-final`, or `-copy` — edit the original file; Git preserves history
L4. Temporary / experimental / debug files → scratchpad, NEVER inside the repository
L5. NEVER report "done/fixed/pass" before running the verification command and pasting the evidence output (W4) · verification skill
L6. Only modify within the task scope; out-of-scope work → report it, do not perform it automatically
L10. Repository without an AGENTS.md → generate it from templates/AGENTS.template.md, recording only DELTA from the global standard · ~/.codex/templates/AGENTS.template.md
</hard_rules>
