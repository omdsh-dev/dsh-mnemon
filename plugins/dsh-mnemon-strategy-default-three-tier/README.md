# dsh-mnemon-strategy-default-three-tier

One ordinary Cordis Strategy plugin. It consumes public Source facts and proposes
a three-tier View; it imports no Source implementation and grants no authority.

Its own directory is a standalone project: install its declared dependencies,
then run `pnpm verify`. When developing against an unreleased Mnemon, install a
packed `dsh-mnemon` artifact as the peer instead of linking its source tree.

The Starter or a user's Profile explicitly mounts its Entry. This package has
no auto-activation patch; installing it does not override a configured Strategy.
