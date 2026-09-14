# Context access and operation contracts

## Objective

Use the existing Source and Strategy implementations to make structured context a reusable public scaffold. Structure includes discovery, navigation, bounded reads, version identity, mutation effects, execution progress and attributed feedback. The original three-tier Starter remains the default composition. Optional product plugins retain their data and workflows.

## Ownership

- Core validates operation semantics, references, execution receipts and composition decisions. It keeps View grants, scope, budgets and generation ownership authoritative.
- Public SDK helpers implement reusable record/resource storage, reviewed changes, operation plans and policy composition. Sources opt into these helpers and retain their own directories, formats and domain validation.
- Source authors declare actual access and mutation mechanisms alongside their existing routes and actions. Domain-specific policies and drivers stay in their plugins.
- Strategy extensions evaluate their own rules and contribute bounded decisions about the offered capabilities. A general Strategy combines decisions without knowing particular product workflows.
- Host adapters retain DSH tool approval, model/session services, authentication and native Skill publication. Shared UI components render public, sanitized capability and decision descriptions.

## Implementation sequence

1. Integrate current main, restore the complete dependency lock, and check the baseline.
2. Add validated access/action descriptors, resource references, execution results and reusable operation helpers. Migrate all official Sources, including the original three, using only mechanisms they implement.
3. Move reusable record/resource helpers into the public SDK with compatible exports. Preserve existing persisted data and revision fences.
4. Add a bounded composition-decision contract and shared composer. Migrate the Workspace Strategy and all its enhancements; keep rule evaluation with the enhancement. Allow third-party Source roles through declared capabilities.
5. Expose scope-safe access summaries and decision explanations in the main workbench and plugin manager. Use common theme, disclosure, resource review and progress components.
6. Verify public consumers, permissions, deterministic decisions, execution outcomes, schema compatibility, default composition and real WebUI workflows. Keep representative screenshots and a factual acceptance report.
7. Commit implementation checkpoints, update the existing PR description for the final implementation, and check CI for the submitted head.

## Acceptance

- A third-party Source with an unfamiliar role participates in the general composition through public capabilities, without adding product names to Core or that Strategy.
- A policy extension can change its trigger, operation selection and projection request without modifying the main Strategy. Replay yields the same decision and View.
- Operation selection cannot grant permission, bypass Source ownership, expose a hidden read grant or exceed the View budget. Read-only scopes suppress mutation-dependent decisions.
- Resource versions, inactive candidates, accepted background work, completed execution and unconfirmed outcomes remain distinguishable in the contract and UI.
- Existing records and native Skill resources remain readable. Their review, publication, execution and feedback paths still work through the actual DSH main WebUI.
- The default three-tier configuration and provider ownership remain unchanged.

## Progress

- Current main integrated; release metadata and shared settings layout reconciled. Root TypeScript baseline passes.
- Core now validates access semantics, operation effects, resource references, continuation routes, execution receipts and late-bound policy decisions.
- Public Source and Client SDKs own reusable mechanics; all official Sources consume these contracts, while the general Workspace Strategy contains no product-role allowlist. Enhancements retain domain rules.
- Focused contract and UI tests pass; integrated and all 38 plugin TypeScript checks pass. A release simulation advances Core and dependent peer ranges to 0.6.0.
- Full regression passes: 1,219 root tests and 470 plugin tests. Packed verification passes for all 38 independent plugin repositories and 39 artifacts, including external Source SDK consumers and real DSH activation.
- Main WebUI acceptance covers operation explanations, frozen View decisions, default and read-only previews, plugin disable/reactivation, actual job cancellation and feedback, native skill validation/publication, file reads and Mnemon relations. It corrected verbose interface presentation, an overly broad journal decision and cancellation copy.
- The [current acceptance report](../context-access-validation-20260915.md) preserves 24 new screenshots and distinguishes manual fixtures from model output. PR CI passed on `999db67`, including Node 22.19 source checks, Node 20 public entries and Node 24 independent artifacts. A fresh Flash generation remains outstanding; timeout retains the active version and unresolved feedback.
