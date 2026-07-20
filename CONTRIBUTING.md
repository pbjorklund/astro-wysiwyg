# Contributing

## How it works

During `astro dev`, the integration maps rendered elements to their source ranges, loads an in-browser editor, and sends validated changes to a local endpoint that updates those ranges. Production builds do not register the editor or source-write endpoint.

## Start with the demo

Install dependencies, then start the maintained demo site:

```sh
npm ci
npm run dev
```

Open the local URL printed by Astro. The root `demo/` site is the preferred surface for development and manual review. It imports the current package source, so integration changes are available without publishing or linking the package.

The demo navigation covers Astro, Markdown, MDX, block structure, inline formatting, links, lists, image uploads and replacement, native video insertion, frontmatter, keyboard use, ClientRouter navigation, interactive-content guards, and recovery. Focused fault-injection pages live under `/resilience/` so the main examples stay useful to people browsing the site.

When a feature needs a new browser target, add it to `demo/` in the same change. Put user-facing examples in the main navigation. Put deterministic failure or recovery targets under `demo/src/pages/resilience/`. Add image and video samples under `demo/public/assets/`, iframe and content-block routes under `demo/src/pages/`, and content-collection records under `demo/src/content/`.

## Test the package and demo

Run the unit tests, TypeScript build, and production demo check:

```sh
npm run check:unit
```

The production demo check verifies that the static output includes the main routes and omits the editor runtime and write endpoint.

Run the full browser and coverage gate:

```sh
npm run check
```

Playwright never edits the checked-in demo. Before a run, `tests/prepare-e2e.mjs` copies `demo/` to `.tmp/e2e-site`, enables coverage only in that copy, and starts Astro there. The browser tests mutate the temporary source and public assets. `tests/reset-e2e-source.mjs` restores them from the canonical demo before and after each test.

Use semantic roles, names, and labels for browser locators. Add a durable test ID only when the accessible surface cannot identify a target reliably. Every feature change should include its demo target, source assertion, reset coverage when it creates files or assets, and browser coverage for behavior that lower-level tests cannot prove.

## Useful commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the canonical demo against current package source |
| `npm run demo:build` | Build the demo as a production site |
| `npm run test:unit` | Run unit and integration tests |
| `npm run test:e2e` | Build the package and run Playwright against a temporary demo copy |
| `npm run check:unit` | Run fast tests, package build, and production demo checks |
| `npm run check` | Run coverage, all configured browsers, and production demo checks |
