# Demo site and walkthrough

This directory contains a standalone Astro site and the reproducible product walkthrough embedded in the project README.

## Run the site

From the repository root:

```sh
npm run demo:dev
```

Open the loopback URL printed by Astro. Click the launch-copy paragraph, edit or format it, then use **Save** in the floating editor toolbar. This command runs against `demo/site`, so edits change its Markdown source.

## Record the walkthrough

```sh
npm run demo:record
```

Recording requires Xvfb, FFmpeg with `x11grab`, Python 3, and the X11 and XTest libraries.

The recorder builds the package, copies `demo/site` to a temporary workspace, starts Astro on a temporary loopback port, opens a visible Chromium window on an isolated X11 display, and records that live display while Playwright drives these steps:

1. Click the source-backed paragraph.
2. Replace "rough product updates" with "launch-ready product updates."
3. Select the new phrase and apply **Bold**.
4. Save through the real editor endpoint.
5. Reload and verify the bold result.
6. Check that temporary `src/pages/index.md` contains `**launch-ready product updates**`.

A successful run writes:

- `artwork/demo/astro-wysiwyg-demo.mp4`: 1600x900 H.264 video.
- `artwork/demo/astro-wysiwyg-demo.gif`: 800x450 README preview.
- `artwork/demo/contact-sheet.jpg`: chronological review frames.
- `artwork/demo/outcome.json`: safety, outcome, probe, hash, and review evidence.

The Chromium window, native pointer, Astro site, editor interaction, save request, source mutation, reload, and assertions are real. The intro card, step labels, callouts, synthetic-data badge, and click ring are presentation-only. The workflow uses no model provider, credentials, personal data, customer data, or external service. Failed runs do not replace the last successful artifacts, and the recorder removes its temporary workspace and child processes.
